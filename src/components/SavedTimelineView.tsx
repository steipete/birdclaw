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
import type { QueryEnvelope, QueryResponse, TimelineItem } from "#/lib/types";
import {
	feedClass,
	pageHeaderClass,
	pageHeaderRowClass,
	pageSubtitleClass,
	pageTitleClass,
	searchFieldIconClass,
	searchFieldInputClass,
	searchFieldShellClass,
} from "#/lib/ui";

interface SavedTimelineViewProps {
	filter: "liked" | "bookmarked";
	eyebrow: string;
	title: string;
	loadingLabel: string;
	searchPlaceholder: string;
}

const TITLES: Record<SavedTimelineViewProps["filter"], string> = {
	liked: "Likes",
	bookmarked: "Bookmarks",
};

export function SavedTimelineView({
	filter,
	title,
	loadingLabel,
	searchPlaceholder,
}: SavedTimelineViewProps) {
	const [meta, setMeta] = useState<QueryEnvelope | null>(null);
	const [items, setItems] = useState<TimelineItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
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
		url.searchParams.set(filter, "true");
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
						: `${TITLES[filter]} unavailable`,
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
	}, [filter, refreshTick, search]);

	const subtitle = useMemo(() => {
		if (!meta) {
			return items.length > 0
				? `${String(items.length)} visible`
				: loadingLabel;
		}
		return `${String(items.length)} visible · ${meta.transport.statusText}`;
	}, [items.length, loadingLabel, meta]);

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

	const syncKind = filter === "liked" ? "likes" : "bookmarks";

	return (
		<>
			<header className={pageHeaderClass}>
				<div className={pageHeaderRowClass}>
					<div className="flex min-w-0 flex-col">
						<h1 className={pageTitleClass}>{TITLES[filter]}</h1>
						<p className={pageSubtitleClass}>{title}</p>
						<p className={pageSubtitleClass}>{subtitle}</p>
					</div>
					<SyncNowButton
						kind={syncKind}
						label={filter === "liked" ? "Sync likes" : "Sync bookmarks"}
						onSynced={refreshLocalView}
					/>
				</div>
				<div className="px-4 pb-3">
					<label className={searchFieldShellClass}>
						<Search className={searchFieldIconClass} strokeWidth={2} />
						<input
							className={searchFieldInputClass}
							onChange={(event) => setSearch(event.target.value)}
							placeholder={searchPlaceholder}
							value={search}
						/>
					</label>
				</div>
			</header>
			<ConversationSurfaceScope>
				<section className={feedClass}>
					{loading ? (
						<FeedLoading
							detail={`Reading local ${TITLES[filter].toLowerCase()}`}
							label={loadingLabel}
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
							title={`Could not load ${TITLES[filter].toLowerCase()}`}
						/>
					) : items.length === 0 ? (
						<FeedEmpty
							detail="Sync this collection or broaden the search."
							label="Nothing saved here yet"
						/>
					) : null}
					{items.map((item) => (
						<TimelineCard
							key={item.id}
							item={item}
							onReply={replyToTweet}
							showReplyControls={false}
						/>
					))}
				</section>
			</ConversationSurfaceScope>
		</>
	);
}
