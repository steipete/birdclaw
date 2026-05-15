import { createFileRoute } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
	FeedEmpty,
	FeedError,
	FeedLoading,
	TweetSkeletonRows,
} from "#/components/FeedState";
import { SyncNowButton } from "#/components/SyncNowButton";
import { TimelineCard } from "#/components/TimelineCard";
import { ConversationSurfaceScope } from "#/lib/conversation-surface";
import type {
	QueryEnvelope,
	QueryResponse,
	ReplyFilter,
	TimelineItem,
} from "#/lib/types";
import {
	cx,
	feedClass,
	pageHeaderClass,
	pageHeaderRowClass,
	pageSubtitleClass,
	pageTitleClass,
	searchFieldIconClass,
	searchFieldInputClass,
	searchFieldShellClass,
	tabButtonActiveClass,
	tabButtonClass,
	tabButtonIndicatorClass,
	tabStripClass,
} from "#/lib/ui";

export const Route = createFileRoute("/")({
	component: HomeRoute,
});

const TABS: Array<{ value: ReplyFilter; label: string }> = [
	{ value: "all", label: "All" },
	{ value: "unreplied", label: "Unreplied" },
	{ value: "replied", label: "Replied" },
];

function HomeRoute() {
	const [meta, setMeta] = useState<QueryEnvelope | null>(null);
	const [items, setItems] = useState<TimelineItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [replyFilter, setReplyFilter] = useState<ReplyFilter>("all");
	const [search, setSearch] = useState("");
	const [refreshTick, setRefreshTick] = useState(0);

	async function loadStatus() {
		const response = await fetch("/api/status");
		const data = (await response.json()) as QueryEnvelope;
		setMeta(data);
	}

	useEffect(() => {
		void loadStatus();
	}, []);

	useEffect(() => {
		const url = new URL("/api/query", window.location.origin);
		url.searchParams.set("resource", "home");
		url.searchParams.set("replyFilter", replyFilter);
		url.searchParams.set("refresh", String(refreshTick));
		if (search.trim()) {
			url.searchParams.set("search", search.trim());
		}

		const controller = new AbortController();
		let active = true;
		setError(null);
		setLoading(true);
		fetch(url, { signal: controller.signal })
			.then((response) => response.json())
			.then((data: QueryResponse) => {
				if (active) {
					setItems(data.items as TimelineItem[]);
				}
			})
			.catch((fetchError: unknown) => {
				if (
					fetchError instanceof DOMException &&
					fetchError.name === "AbortError"
				) {
					return;
				}
				if (!active) return;
				setError(
					fetchError instanceof Error
						? fetchError.message
						: "Timeline unavailable",
				);
				setItems([]);
			})
			.finally(() => {
				if (active) {
					setLoading(false);
				}
			});

		return () => {
			active = false;
			controller.abort();
		};
	}, [refreshTick, replyFilter, search]);

	const subtitle = useMemo(() => {
		if (!meta) return "Loading local context...";
		return `${String(meta.stats.home)} items · ${String(meta.stats.needsReply)} waiting · ${meta.transport.statusText}`;
	}, [meta]);

	async function replyToTweet(tweetId: string) {
		const text = window.prompt("Reply text");
		if (!text?.trim()) return;

		await fetch("/api/action", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				kind: "replyTweet",
				accountId: "acct_primary",
				tweetId,
				text,
			}),
		});

		setRefreshTick((value) => value + 1);
	}

	function refreshLocalView() {
		setRefreshTick((value) => value + 1);
		void loadStatus();
	}

	return (
		<>
			<header className={pageHeaderClass}>
				<div className={pageHeaderRowClass}>
					<div className="flex min-w-0 flex-col">
						<h1 className={pageTitleClass}>Home</h1>
						<p className={pageSubtitleClass}>{subtitle}</p>
					</div>
					<SyncNowButton
						kind="timeline"
						label="Sync timeline"
						onSynced={refreshLocalView}
					/>
				</div>
				<div className="px-4 pb-3">
					<label className={searchFieldShellClass}>
						<Search className={searchFieldIconClass} strokeWidth={2} />
						<input
							className={searchFieldInputClass}
							onChange={(event) => setSearch(event.target.value)}
							placeholder="Search local timeline"
							value={search}
						/>
					</label>
				</div>
				<div className={tabStripClass}>
					{TABS.map((tab) => {
						const active = replyFilter === tab.value;
						return (
							<button
								key={tab.value}
								type="button"
								aria-pressed={active}
								className={cx(tabButtonClass, active && tabButtonActiveClass)}
								onClick={() => setReplyFilter(tab.value)}
							>
								<span className="relative inline-flex flex-col items-center justify-center py-1">
									{tab.label}
									{active ? <span className={tabButtonIndicatorClass} /> : null}
								</span>
							</button>
						);
					})}
				</div>
			</header>
			<ConversationSurfaceScope>
				<section className={feedClass}>
					{loading ? (
						<FeedLoading
							detail="Reading the local timeline store"
							label="Loading posts"
						>
							<TweetSkeletonRows />
						</FeedLoading>
					) : error ? (
						<FeedError
							action={
								<button
									className="rounded-full bg-[var(--accent)] px-4 py-1.5 text-[14px] font-bold text-white"
									onClick={() => setRefreshTick((value) => value + 1)}
									type="button"
								>
									Retry
								</button>
							}
							message={error}
							title="Could not load posts"
						/>
					) : items.length === 0 ? (
						<FeedEmpty
							detail="Try a different filter or sync the timeline again."
							label="No posts in this view"
						/>
					) : null}
					{items.map((item) => (
						<TimelineCard key={item.id} item={item} onReply={replyToTweet} />
					))}
				</section>
			</ConversationSurfaceScope>
		</>
	);
}
