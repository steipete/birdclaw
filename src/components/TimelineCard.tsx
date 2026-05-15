import {
	Bookmark,
	BookmarkCheck,
	CheckCircle2,
	Circle,
	Heart,
	MessageCircle,
	Repeat2,
} from "lucide-react";
import { formatCompactNumber, formatShortTimestamp } from "#/lib/present";
import type {
	TimelineItem,
	TweetEntities,
	TweetMediaItem,
	TweetUrlEntity,
} from "#/lib/types";
import { useConversationSurface } from "#/lib/conversation-surface";
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
	feedRowStatePillActiveClass,
	feedRowStatePillClass,
	feedRowStatePillOpenClass,
	feedRowTextClass,
	feedRowTimestampClass,
	mutedDotClass,
} from "#/lib/ui";
import { AvatarChip } from "./AvatarChip";
import { ConversationThread } from "./ConversationThread";
import { EmbeddedTweetCard } from "./EmbeddedTweetCard";
import { LinkPreviewCard } from "./LinkPreviewCard";
import { ProfilePreview } from "./ProfilePreview";
import { TweetMediaGrid } from "./TweetMediaGrid";
import { TweetRichText } from "./TweetRichText";

function comparableUrl(value: string | null | undefined) {
	if (!value) return null;
	try {
		const parsed = new URL(value);
		return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
	} catch {
		return value.split("?")[0] ?? value;
	}
}

function getMediaUrlSet(media: TweetMediaItem[]) {
	const urls = new Set<string>();
	for (const item of media) {
		for (const url of [item.url, item.thumbnailUrl]) {
			const comparable = comparableUrl(url);
			if (comparable) urls.add(comparable);
		}
	}
	return urls;
}

function isMediaUrlEntity(
	entry: TweetUrlEntity,
	mediaUrls: Set<string>,
	tweetId: string,
) {
	if (mediaUrls.size > 0 && isOwnStatusMediaUrl(entry.expandedUrl, tweetId)) {
		return true;
	}
	for (const url of [entry.url, entry.expandedUrl, entry.displayUrl]) {
		const comparable = comparableUrl(url);
		if (comparable && mediaUrls.has(comparable)) {
			return true;
		}
	}
	return false;
}

function isOwnStatusMediaUrl(
	value: string | null | undefined,
	tweetId: string,
) {
	if (!value) return false;
	try {
		const parsed = new URL(value);
		const host = parsed.hostname.replace(/^www\./, "");
		if (host !== "x.com" && host !== "twitter.com") return false;
		const segments = parsed.pathname.split("/").filter(Boolean);
		const statusIndex = segments.indexOf("status");
		if (statusIndex < 0 || segments[statusIndex + 1] !== tweetId) {
			return false;
		}
		const mediaSegment = segments[statusIndex + 2];
		return mediaSegment === "photo" || mediaSegment === "video";
	} catch {
		return false;
	}
}

function getVisibleEntities(
	entities: TweetEntities,
	media: TweetMediaItem[],
	tweetId: string,
) {
	const mediaUrls = getMediaUrlSet(media);
	if (mediaUrls.size === 0) return entities;
	return {
		...entities,
		urls: (entities.urls ?? []).filter(
			(entry) => !isMediaUrlEntity(entry, mediaUrls, tweetId),
		),
	};
}

function getHiddenMediaUrlRanges(
	entities: TweetEntities,
	media: TweetMediaItem[],
	tweetId: string,
) {
	const mediaUrls = getMediaUrlSet(media);
	if (mediaUrls.size === 0) return [];
	return (entities.urls ?? [])
		.filter((entry) => isMediaUrlEntity(entry, mediaUrls, tweetId))
		.map((entry) => ({ start: entry.start, end: entry.end }));
}

function getVisibleUrlCards(item: TimelineItem, entities: TweetEntities) {
	const quotedUrl = item.quotedTweet ? item.quotedTweet.id : null;
	return (entities.urls ?? []).filter((entry) => {
		if (!item.quotedTweet) return true;
		return !entry.expandedUrl.includes(quotedUrl ?? "");
	});
}

function isInteractiveTarget(target: EventTarget | null) {
	return (
		target instanceof Element &&
		Boolean(target.closest("a,button,input,textarea,select,[role='button']"))
	);
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
	const conversation = useConversationSurface(item.id);
	const visibleEntities = getVisibleEntities(
		item.entities,
		item.media,
		item.id,
	);
	const hiddenMediaUrlRanges = getHiddenMediaUrlRanges(
		item.entities,
		item.media,
		item.id,
	);
	const hasConversation = Boolean(item.replyToTweet || item.replyToId);

	return (
		<article
			className={cx(feedRowClass, "cursor-pointer")}
			data-perf="timeline-card"
			onFocus={conversation.prefetch}
			onMouseEnter={conversation.prefetch}
			onClick={(event) => {
				if (isInteractiveTarget(event.target)) return;
				conversation.toggle();
			}}
		>
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
					{canReply || hasConversation ? (
						<span className="ml-auto inline-flex items-center gap-1">
							{hasConversation ? (
								<span
									aria-label="Part of a conversation"
									className={cx(
										feedRowStatePillClass,
										feedRowStatePillActiveClass,
									)}
									title="Part of a conversation"
								>
									<MessageCircle className="size-3.5" strokeWidth={2} />
									thread
								</span>
							) : null}
							{canReply ? (
								<span
									aria-label={item.isReplied ? "We replied" : "Reply open"}
									className={cx(
										feedRowStatePillClass,
										item.isReplied
											? feedRowStatePillActiveClass
											: feedRowStatePillOpenClass,
									)}
									title={item.isReplied ? "We replied" : "Reply open"}
								>
									{item.isReplied ? (
										<CheckCircle2 className="size-3.5" strokeWidth={2} />
									) : (
										<Circle className="size-3" strokeWidth={2.2} />
									)}
									{item.isReplied ? "replied" : "open"}
								</span>
							) : null}
						</span>
					) : null}
				</header>
				<TweetRichText
					className={feedRowTextClass}
					entities={item.entities}
					hiddenUrlRanges={hiddenMediaUrlRanges}
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
				{getVisibleUrlCards(item, visibleEntities).map((entry, index) => (
					<LinkPreviewCard
						key={`${entry.expandedUrl}-${String(index)}`}
						entry={entry}
						index={index}
					/>
				))}
				<footer className={feedRowActionsClass}>
					<div className="flex items-center gap-3 text-[13px] text-[var(--ink-soft)]">
						<button
							aria-expanded={conversation.isOpen}
							aria-label={
								conversation.isOpen ? "Hide conversation" : "Show conversation"
							}
							className={feedActionButtonClass}
							onClick={(event) => {
								event.stopPropagation();
								conversation.toggle();
							}}
							type="button"
						>
							<span className={feedActionIconWrapClass}>
								<MessageCircle
									className={feedActionIconClass}
									strokeWidth={1.7}
								/>
							</span>
							<span className="text-[13px]">
								{conversation.isOpen ? "Hide thread" : "Thread"}
							</span>
						</button>
						{canReply ? (
							<button
								className={feedActionButtonClass}
								onClick={(event) => {
									event.stopPropagation();
									onReply(item.id);
								}}
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
				{conversation.isOpen ? (
					<ConversationThread
						anchorId={item.id}
						error={conversation.error}
						items={conversation.items}
						loading={conversation.loading}
					/>
				) : null}
			</div>
		</article>
	);
}
