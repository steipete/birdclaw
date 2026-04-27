import { formatCompactNumber, formatShortTimestamp } from "#/lib/present";
import type { TimelineItem } from "#/lib/types";
import {
	actionButtonClass,
	cardFooterClass,
	cardHeaderClass,
	contentCardClass,
	cx,
	identityBlockClass,
	identityRowClass,
	linkPreviewCardClass,
	metaStackClass,
	metricRowClass,
	mutedDotClass,
	pillAlertClass,
	pillClass,
	pillSoftClass,
	timestampClass,
} from "#/lib/ui";
import { AvatarChip } from "./AvatarChip";
import { EmbeddedTweetCard } from "./EmbeddedTweetCard";
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
		<article className={contentCardClass}>
			<header className={cardHeaderClass}>
				<div className={identityBlockClass}>
					<AvatarChip
						avatarUrl={item.author.avatarUrl}
						hue={item.author.avatarHue}
						name={item.author.displayName}
						profileId={item.author.id}
					/>
					<div>
						<ProfilePreview profile={item.author}>
							<div className={identityRowClass}>
								<strong>{item.author.displayName}</strong>
								<span>@{item.author.handle}</span>
								<span className={mutedDotClass} />
								<span>
									{formatCompactNumber(item.author.followersCount)} followers
								</span>
							</div>
						</ProfilePreview>
					</div>
				</div>
				<div className={metaStackClass}>
					{canReply ? (
						<span
							className={cx(
								pillClass,
								item.isReplied ? pillSoftClass : pillAlertClass,
							)}
						>
							{item.isReplied ? "replied" : "needs reply"}
						</span>
					) : null}
					<span className={timestampClass}>
						{formatShortTimestamp(item.createdAt)}
					</span>
				</div>
			</header>
			<TweetRichText entities={item.entities} text={item.text} />
			<TweetMediaGrid items={item.media} />
			{item.replyToTweet ? (
				<EmbeddedTweetCard item={item.replyToTweet} label="In reply to" />
			) : null}
			{item.quotedTweet ? (
				<EmbeddedTweetCard item={item.quotedTweet} label="Quoted tweet" />
			) : null}
			{getVisibleUrlCards(item).map((entry, index) => (
				<a
					key={`${entry.expandedUrl}-${String(index)}`}
					className={linkPreviewCardClass}
					href={entry.expandedUrl}
					rel="noreferrer"
					target="_blank"
				>
					<strong>{entry.title ?? entry.displayUrl}</strong>
					<span className="text-[var(--ink-soft)]">
						{entry.description ?? entry.displayUrl}
					</span>
					<span className={timestampClass}>{entry.displayUrl}</span>
				</a>
			))}
			<footer className={cardFooterClass}>
				<div className={metricRowClass}>
					<span>{formatCompactNumber(item.likeCount)} likes</span>
					<span>{item.mediaCount} media</span>
					<span>{item.bookmarked ? "bookmarked" : "not bookmarked"}</span>
					<span>{item.accountHandle}</span>
				</div>
				{canReply ? (
					<button
						className={actionButtonClass}
						onClick={() => onReply(item.id)}
						type="button"
					>
						Reply
					</button>
				) : null}
			</footer>
		</article>
	);
}
