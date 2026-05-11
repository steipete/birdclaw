import { createFileRoute } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { TimelineCard } from "#/components/TimelineCard";
import type {
	QueryEnvelope,
	QueryResponse,
	ReplyFilter,
	TimelineItem,
} from "#/lib/types";
import {
	cx,
	emptyStateClass,
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

export const Route = createFileRoute("/mentions")({
	component: MentionsRoute,
});

const TABS: Array<{ value: ReplyFilter; label: string }> = [
	{ value: "all", label: "All" },
	{ value: "unreplied", label: "Unreplied" },
	{ value: "replied", label: "Replied" },
];

function MentionsRoute() {
	const [meta, setMeta] = useState<QueryEnvelope | null>(null);
	const [items, setItems] = useState<TimelineItem[]>([]);
	const [replyFilter, setReplyFilter] = useState<ReplyFilter>("unreplied");
	const [search, setSearch] = useState("");
	const [refreshTick, setRefreshTick] = useState(0);

	useEffect(() => {
		fetch("/api/status")
			.then((response) => response.json())
			.then((data: QueryEnvelope) => setMeta(data));
	}, []);

	useEffect(() => {
		const url = new URL("/api/query", window.location.origin);
		url.searchParams.set("resource", "mentions");
		url.searchParams.set("replyFilter", replyFilter);
		url.searchParams.set("refresh", String(refreshTick));
		if (search.trim()) {
			url.searchParams.set("search", search.trim());
		}

		fetch(url)
			.then((response) => response.json())
			.then((data: QueryResponse) => setItems(data.items as TimelineItem[]));
	}, [refreshTick, replyFilter, search]);

	const subtitle = useMemo(() => {
		if (!meta) return "Loading mentions...";
		return `${String(meta.stats.mentions)} mention/reply items in local store`;
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

	return (
		<>
			<header className={pageHeaderClass}>
				<div className={pageHeaderRowClass}>
					<div className="flex min-w-0 flex-col">
						<h1 className={pageTitleClass}>Mentions</h1>
						<p className={pageSubtitleClass}>{subtitle}</p>
					</div>
				</div>
				<div className="px-4 pb-3">
					<label className={searchFieldShellClass}>
						<Search className={searchFieldIconClass} strokeWidth={2} />
						<input
							className={searchFieldInputClass}
							onChange={(event) => setSearch(event.target.value)}
							placeholder="Search mentions"
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
									{tab.value}
									{active ? <span className={tabButtonIndicatorClass} /> : null}
								</span>
							</button>
						);
					})}
				</div>
			</header>
			<section className={feedClass}>
				{items.length === 0 ? (
					<div className={emptyStateClass}>No mentions in view.</div>
				) : null}
				{items.map((item) => (
					<TimelineCard key={item.id} item={item} onReply={replyToTweet} />
				))}
			</section>
		</>
	);
}
