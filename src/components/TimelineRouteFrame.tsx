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
import { ConversationSurfaceScope } from "#/lib/conversation-surface";
import type { QueryEnvelope, ReplyFilter } from "#/lib/types";
import type { WebSyncKind } from "#/lib/web-sync";
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
import { useTimelineRouteData } from "./useTimelineRouteData";

const TABS: Array<{ value: ReplyFilter; label: string }> = [
	{ value: "all", label: "All" },
	{ value: "unreplied", label: "Unreplied" },
	{ value: "replied", label: "Replied" },
];

interface TimelineRouteFrameProps {
	title: string;
	resource: "home" | "mentions";
	initialReplyFilter: ReplyFilter;
	searchPlaceholder: string;
	syncKind: WebSyncKind;
	syncLabel: string;
	loadingLabel: string;
	loadingDetail: string;
	errorTitle: string;
	errorFallback: string;
	emptyLabel: string;
	emptyDetail: string;
	subtitle: (meta: QueryEnvelope | null) => string;
}

export function TimelineRouteFrame({
	title,
	resource,
	initialReplyFilter,
	searchPlaceholder,
	syncKind,
	syncLabel,
	loadingLabel,
	loadingDetail,
	errorTitle,
	errorFallback,
	emptyLabel,
	emptyDetail,
	subtitle,
}: TimelineRouteFrameProps) {
	const [replyFilter, setReplyFilter] =
		useState<ReplyFilter>(initialReplyFilter);
	const [search, setSearch] = useState("");
	const { meta, items, loading, error, retry, refreshLocalView, replyToTweet } =
		useTimelineRouteData({
			resource,
			replyFilter,
			search,
			errorFallback,
		});
	const subtitleText = useMemo(() => subtitle(meta), [meta, subtitle]);

	return (
		<>
			<header className={pageHeaderClass}>
				<div className={pageHeaderRowClass}>
					<div className="flex min-w-0 flex-col">
						<h1 className={pageTitleClass}>{title}</h1>
						<p className={pageSubtitleClass}>{subtitleText}</p>
					</div>
					<SyncNowButton
						accounts={syncKind === "mentions" ? meta?.accounts : undefined}
						kind={syncKind}
						label={syncLabel}
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
						<FeedLoading detail={loadingDetail} label={loadingLabel}>
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
							title={errorTitle}
						/>
					) : items.length === 0 ? (
						<FeedEmpty detail={emptyDetail} label={emptyLabel} />
					) : null}
					{items.map((item) => (
						<TimelineCard key={item.id} item={item} onReply={replyToTweet} />
					))}
				</section>
			</ConversationSurfaceScope>
		</>
	);
}
