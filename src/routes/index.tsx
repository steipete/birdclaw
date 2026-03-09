import { createFileRoute } from "@tanstack/react-router";
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
	eyebrowClass,
	feedPageClass,
	heroControlsClass,
	heroCopyClass,
	heroShellClass,
	heroTitleClass,
	pageWrapClass,
	segmentActiveClass,
	segmentClass,
	segmentedClass,
	textFieldClass,
	textFieldWideClass,
	timelineLaneClass,
} from "#/lib/ui";

export const Route = createFileRoute("/")({
	component: HomeRoute,
});

function HomeRoute() {
	const [meta, setMeta] = useState<QueryEnvelope | null>(null);
	const [items, setItems] = useState<TimelineItem[]>([]);
	const [replyFilter, setReplyFilter] = useState<ReplyFilter>("all");
	const [search, setSearch] = useState("");
	const [refreshTick, setRefreshTick] = useState(0);

	useEffect(() => {
		fetch("/api/status")
			.then((response) => response.json())
			.then((data: QueryEnvelope) => setMeta(data));
	}, []);

	useEffect(() => {
		const url = new URL("/api/query", window.location.origin);
		url.searchParams.set("resource", "home");
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
		if (!meta) return "Loading local context...";
		return `${meta.stats.home} home items · ${meta.stats.needsReply} waiting on action · ${meta.transport.statusText}`;
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
		<main className={pageWrapClass}>
			<div className={feedPageClass}>
				<section className={heroShellClass}>
					<div>
						<p className={eyebrowClass}>home timeline</p>
						<h2 className={heroTitleClass}>
							Read first. Act only where signal survives.
						</h2>
						<p className={heroCopyClass}>{subtitle}</p>
					</div>
					<div className={heroControlsClass}>
						<input
							className={cx(textFieldClass, textFieldWideClass)}
							onChange={(event) => setSearch(event.target.value)}
							placeholder="Search local timeline"
							value={search}
						/>
						<div className={segmentedClass}>
							{(["all", "replied", "unreplied"] as const).map((value) => (
								<button
									key={value}
									className={cx(
										segmentClass,
										value === replyFilter && segmentActiveClass,
									)}
									onClick={() => setReplyFilter(value)}
									type="button"
								>
									{value}
								</button>
							))}
						</div>
					</div>
				</section>

				<section className={timelineLaneClass}>
					{items.map((item) => (
						<TimelineCard key={item.id} item={item} onReply={replyToTweet} />
					))}
				</section>
			</div>
		</main>
	);
}
