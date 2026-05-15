import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import {
	FeedEmpty,
	FeedError,
	FeedLoading,
	TweetSkeletonRows,
} from "#/components/FeedState";
import { SyncNowButton } from "#/components/SyncNowButton";
import { TimelineCard } from "#/components/TimelineCard";
import { useTimelineRouteData } from "#/components/useTimelineRouteData";
import { ConversationSurfaceScope } from "#/lib/conversation-surface";
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
	const [search, setSearch] = useState("");
	const { meta, items, loading, error, retry, refreshLocalView, replyToTweet } =
		useTimelineRouteData({
			resource: "home",
			search,
			errorFallback: `${TITLES[filter]} unavailable`,
			likedOnly: filter === "liked",
			bookmarkedOnly: filter === "bookmarked",
		});

	const subtitle = useMemo(() => {
		if (!meta) {
			return items.length > 0
				? `${String(items.length)} visible`
				: loadingLabel;
		}
		return `${String(items.length)} visible · ${meta.transport.statusText}`;
	}, [items.length, loadingLabel, meta]);

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
						accounts={meta?.accounts}
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
									onClick={retry}
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
