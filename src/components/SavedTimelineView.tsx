import { useEffect, useMemo, useState } from "react";
import { TimelineCard } from "#/components/TimelineCard";
import type { QueryEnvelope, QueryResponse, TimelineItem } from "#/lib/types";
import {
	cx,
	eyebrowClass,
	feedPageClass,
	heroControlsClass,
	heroCopyClass,
	heroShellClass,
	heroTitleClass,
	pageWrapClass,
	textFieldClass,
	textFieldWideClass,
	timelineLaneClass,
} from "#/lib/ui";

interface SavedTimelineViewProps {
	filter: "liked" | "bookmarked";
	eyebrow: string;
	title: string;
	loadingLabel: string;
	searchPlaceholder: string;
}

export function SavedTimelineView({
	filter,
	eyebrow,
	title,
	loadingLabel,
	searchPlaceholder,
}: SavedTimelineViewProps) {
	const [meta, setMeta] = useState<QueryEnvelope | null>(null);
	const [items, setItems] = useState<TimelineItem[]>([]);
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
		url.searchParams.set(filter, "true");
		url.searchParams.set("refresh", String(refreshTick));
		if (search.trim()) {
			url.searchParams.set("search", search.trim());
		}

		fetch(url)
			.then((response) => response.json())
			.then((data: QueryResponse) => setItems(data.items as TimelineItem[]));
	}, [filter, refreshTick, search]);

	const subtitle = useMemo(() => {
		if (!meta) {
			return items.length > 0 ? `${items.length} visible` : loadingLabel;
		}
		return `${items.length} visible · ${meta.transport.statusText}`;
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

	return (
		<main className={pageWrapClass}>
			<div className={feedPageClass}>
				<section className={heroShellClass}>
					<div>
						<p className={eyebrowClass}>{eyebrow}</p>
						<h2 className={heroTitleClass}>{title}</h2>
						<p className={heroCopyClass}>{subtitle}</p>
					</div>
					<div className={heroControlsClass}>
						<input
							className={cx(textFieldClass, textFieldWideClass)}
							onChange={(event) => setSearch(event.target.value)}
							placeholder={searchPlaceholder}
							value={search}
						/>
					</div>
				</section>

				<section className={timelineLaneClass}>
					{items.map((item) => (
						<TimelineCard
							key={item.id}
							item={item}
							onReply={replyToTweet}
							showReplyControls={false}
						/>
					))}
				</section>
			</div>
		</main>
	);
}
