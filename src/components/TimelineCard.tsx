import {
	Bookmark,
	BookmarkCheck,
	Heart,
	MessageCircle,
	Repeat2,
} from "lucide-react";
import { formatCompactNumber, formatShortTimestamp } from "#/lib/present";
import type { TimelineItem } from "#/lib/types";
import {
	cx,
	embeddedCardClass,
	feedActionButtonClass,
	feedActionIconClass,
	feedActionIconWrapClass,
	feedActionIconWrapLikeClass,
	feedActionLikeClass,
	feedRowActionsClass,
	feedRowBodyClass,
	feedRowClass,
	feedRowDotClass,
	feedRowHandleClass,
	feedRowHeaderClass,
	feedRowNameClass,
	feedRowTextClass,
	feedRowTimestampClass,
	mutedDotClass,
} from "#/lib/ui";
import { AvatarChip } from "./AvatarChip";
import { EmbeddedTweetCard } from "./EmbeddedTweetCard";
import { LinkPreviewCard } from "./LinkPreviewCard";
import { ProfilePreview } from "./ProfilePreview";
import { TweetMediaGrid } from "./TweetMediaGrid";
import { TweetRichText } from "./TweetRichText";

function getVisibleUrlCards(item: TimelineItem) {
	const quotedUrl = item.quotedTweet ? item.quotedTweet.id : null;
	return (item.entities.urls ?? []).filter((entry) => {
		if (!item.quotedTweet) return true;
		return !entry.expandedUrl.includes(quotedUrl ?? "");
	});
}

export function TimelineCard({
	item,
	onReply,
	showReplyControls = true,
}: {
	item: TimelineItem;
	onReply: (tweetId: string) => void;
	showReplyControls?: boolean;
}) {
	const canReply =
		showReplyControls && item.kind !== "like" && item.kind !== "bookmark";

	return (
		<article className={feedRowClass} data-perf="timeline-card">
			<AvatarChip
				avatarUrl={item.author.avatarUrl}
				hue={item.author.avatarHue}
				name={item.author.displayName}
				profileId={item.author.id}
			/>
			<div className={feedRowBodyClass}>
				<header className={feedRowHeaderClass}>
					<ProfilePreview profile={item.author}>
						<span className="flex min-w-0 items-center gap-1.5">
							<span className={feedRowNameClass}>
								{item.author.displayName}
							</span>
							<span className={feedRowHandleClass}>@{item.author.handle}</span>
						</span>
					</ProfilePreview>
					<span className={feedRowDotClass}>·</span>
					<span className={feedRowTimestampClass}>
						{formatShortTimestamp(item.createdAt)}
					</span>
					{canReply ? (
						<span className="ml-auto inline-flex items-center gap-1 text-[12px] text-[var(--ink-soft)]">
							{item.isReplied ? (
								<span className="text-[var(--accent)]">replied</span>
							) : (
								<span className="text-[var(--alert)]">needs reply</span>
							)}
						</span>
					) : null}
				</header>
				<TweetRichText
					className={feedRowTextClass}
					entities={item.entities}
					text={item.text}
				/>
				<TweetMediaGrid items={item.media} />
				{item.replyToTweet ? (
					<div className={embeddedCardClass}>
						<EmbeddedTweetCard item={item.replyToTweet} label="In reply to" />
					</div>
				) : null}
				{item.quotedTweet ? (
					<div className={embeddedCardClass}>
						<EmbeddedTweetCard item={item.quotedTweet} label="Quoted tweet" />
					</div>
				) : null}
				{getVisibleUrlCards(item).map((entry, index) => (
					<LinkPreviewCard
						key={`${entry.expandedUrl}-${String(index)}`}
						entry={entry}
						index={index}
					/>
				))}
				<footer className={feedRowActionsClass}>
					<div className="flex items-center gap-3 text-[13px] text-[var(--ink-soft)]">
						{canReply ? (
							<button
								className={feedActionButtonClass}
								onClick={() => onReply(item.id)}
								type="button"
								aria-label="Reply"
							>
								<span className={feedActionIconWrapClass}>
									<MessageCircle
										className={feedActionIconClass}
										strokeWidth={1.7}
									/>
								</span>
								<span className="text-[13px]">Reply</span>
							</button>
						) : null}
						<span className={cx(feedActionButtonClass, "cursor-default")}>
							<span className={feedActionIconWrapClass}>
								<Repeat2 className={feedActionIconClass} strokeWidth={1.7} />
							</span>
						</span>
						<span
							className={cx(
								feedActionButtonClass,
								feedActionLikeClass,
								"cursor-default",
								item.liked && "text-[var(--like)]",
							)}
						>
							<span
								className={cx(
									feedActionIconWrapClass,
									feedActionIconWrapLikeClass,
								)}
							>
								<Heart
									className={feedActionIconClass}
									strokeWidth={1.7}
									fill={item.liked ? "currentColor" : "none"}
								/>
							</span>
							<span>{formatCompactNumber(item.likeCount)}</span>
						</span>
						<span className={cx(feedActionButtonClass, "cursor-default")}>
							<span className={feedActionIconWrapClass}>
								{item.bookmarked ? (
									<BookmarkCheck
										className={feedActionIconClass}
										strokeWidth={1.7}
									/>
								) : (
									<Bookmark className={feedActionIconClass} strokeWidth={1.7} />
								)}
							</span>
						</span>
					</div>
					<div className="flex items-center gap-2 text-[12px] text-[var(--ink-soft)]">
						<span>{item.mediaCount} media</span>
						<span className={mutedDotClass} />
						<span>{item.bookmarked ? "bookmarked" : "not bookmarked"}</span>
						<span className={mutedDotClass} />
						<span>{item.accountHandle}</span>
					</div>
				</footer>
			</div>
		</article>
	);
}
