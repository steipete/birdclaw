import {
	BookmarkCheck,
	CheckCircle2,
	Circle,
	Heart,
	Image,
	MessageCircle,
	Repeat2,
	UserSearch,
} from "lucide-react";
import { formatCompactNumber } from "#/lib/present";
import {
	isTweetArticleUrlEntity,
	normalizeTweetUrlEntityRangeForText,
} from "#/lib/tweet-render";
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
} from "#/lib/ui";
import { AvatarChip } from "./AvatarChip";
import { ConversationThread } from "./ConversationThread";
import { EmbeddedTweetCard } from "./EmbeddedTweetCard";
import { LinkPreviewCard } from "./LinkPreviewCard";
import { ProfilePreview } from "./ProfilePreview";
import { SmartTimestamp } from "./SmartTimestamp";
import { TweetArticleCard } from "./TweetArticleCard";
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

function isShortUrl(value: string | null | undefined) {
	if (!value) return false;
	try {
		const candidate = value.includes("://") ? value : `https://${value}`;
		const parsed = new URL(candidate);
		return parsed.hostname.replace(/^www\./, "") === "t.co";
	} catch {
		return false;
	}
}

function isUnresolvedShortUrlEntity(entry: TweetUrlEntity) {
	if (isShortUrl(entry.expandedUrl)) return true;
	if (entry.expandedUrl) return false;
	if (isShortUrl(entry.displayUrl)) return true;
	return !entry.displayUrl && isShortUrl(entry.url);
}

function unresolvedShortUrlRanges(text: string, entities: TweetEntities) {
	return (entities.urls ?? [])
		.filter(isUnresolvedShortUrlEntity)
		.map((entry) => normalizeTweetUrlEntityRangeForText(text, entry));
}

function textOutsideRanges(
	text: string,
	ranges: Array<{ start: number; end: number }>,
) {
	let cursor = 0;
	let output = "";
	for (const range of [...ranges].sort(
		(left, right) => left.start - right.start,
	)) {
		if (
			range.start < cursor ||
			range.end <= range.start ||
			range.end > text.length
		) {
			continue;
		}
		output += text.slice(cursor, range.start);
		cursor = range.end;
	}
	output += text.slice(cursor);
	return output;
}

function shouldHideUnresolvedShortUrls(
	text: string,
	entities: TweetEntities,
	mediaUrls: Set<string>,
) {
	if (mediaUrls.size === 0) return false;
	const ranges = unresolvedShortUrlRanges(text, entities);
	if (ranges.length === 0) return false;
	return textOutsideRanges(text, ranges).trim().length === 0;
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
	text: string,
) {
	const mediaUrls = getMediaUrlSet(media);
	if (mediaUrls.size === 0) return entities;
	const hideUnresolvedShortUrls = shouldHideUnresolvedShortUrls(
		text,
		entities,
		mediaUrls,
	);
	return {
		...entities,
		urls: (entities.urls ?? []).filter(
			(entry) =>
				!isMediaUrlEntity(entry, mediaUrls, tweetId) &&
				!(hideUnresolvedShortUrls && isUnresolvedShortUrlEntity(entry)),
		),
	};
}

function getHiddenMediaUrlRanges(
	entities: TweetEntities,
	media: TweetMediaItem[],
	tweetId: string,
	text: string,
) {
	const mediaUrls = getMediaUrlSet(media);
	if (mediaUrls.size === 0) return [];
	const hideUnresolvedShortUrls = shouldHideUnresolvedShortUrls(
		text,
		entities,
		mediaUrls,
	);
	return (entities.urls ?? [])
		.filter(
			(entry) =>
				isMediaUrlEntity(entry, mediaUrls, tweetId) ||
				(hideUnresolvedShortUrls && isUnresolvedShortUrlEntity(entry)),
		)
		.map((entry) => normalizeTweetUrlEntityRangeForText(text, entry));
}

function getVisibleUrlCards(
	entities: TweetEntities,
	quotedTweetId: string | null,
) {
	return (entities.urls ?? []).filter((entry) => {
		if (isUnresolvedShortUrlEntity(entry)) return false;
		if (entities.article && isTweetArticleUrlEntity(entry, entities.article)) {
			return false;
		}
		if (!quotedTweetId) return true;
		return !entry.expandedUrl.includes(quotedTweetId);
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
	const displayTweet = item.retweetedTweet ?? item;
	const displayTweetId = displayTweet.id;
	const interactionTweetId =
		item.retweetedTweet && displayTweetId === `${item.id}:retweeted`
			? item.id
			: displayTweetId;
	const displayAuthor = displayTweet.author;
	const conversation = useConversationSurface(item.id, interactionTweetId);
	const visibleEntities = getVisibleEntities(
		displayTweet.entities,
		displayTweet.media,
		displayTweet.id,
		displayTweet.text,
	);
	const hiddenMediaUrlRanges = getHiddenMediaUrlRanges(
		displayTweet.entities,
		displayTweet.media,
		displayTweet.id,
		displayTweet.text,
	);
	const visibleUrlCards = getVisibleUrlCards(
		visibleEntities,
		item.retweetedTweet ? null : (item.quotedTweet?.id ?? null),
	);
	const displayMediaCount = item.retweetedTweet
		? (displayTweet.mediaCount ?? displayTweet.media.length)
		: item.mediaCount;
	const displayIsReplied = displayTweet.isReplied ?? item.isReplied;
	const displayLikeCount = displayTweet.likeCount ?? item.likeCount;
	const displayBookmarked = displayTweet.bookmarked ?? item.bookmarked;
	const displayLiked = displayTweet.liked ?? item.liked;
	const showLikeIndicator = displayLiked || displayLikeCount > 0;
	const showMediaIndicator = displayMediaCount > 0;
	const hasConversation = Boolean(
		item.retweetedTweet
			? displayTweet.replyToId
			: item.replyToTweet || item.replyToId,
	);

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
				avatarUrl={displayAuthor.avatarUrl}
				hue={displayAuthor.avatarHue}
				name={displayAuthor.displayName}
				profileId={displayAuthor.id}
			/>
			<div className={feedRowBodyClass}>
				{item.retweetedTweet ? (
					<div className="inline-flex items-center gap-2 text-[13px] font-medium text-[var(--ink-soft)]">
						<Repeat2 className="size-4" strokeWidth={1.8} />
						<ProfilePreview profile={item.author}>
							<span>{item.author.displayName} reposted</span>
						</ProfilePreview>
					</div>
				) : null}
				<header className={feedRowHeaderClass}>
					<ProfilePreview profile={displayAuthor}>
						<span className="flex min-w-0 items-center gap-1.5">
							<span className={feedRowNameClass}>
								{displayAuthor.displayName}
							</span>
							<span className={feedRowHandleClass}>
								@{displayAuthor.handle}
							</span>
						</span>
					</ProfilePreview>
					<span className={feedRowDotClass}>·</span>
					<SmartTimestamp
						className={feedRowTimestampClass}
						value={displayTweet.createdAt}
					/>
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
									aria-label={displayIsReplied ? "We replied" : "Reply open"}
									className={cx(
										feedRowStatePillClass,
										displayIsReplied
											? feedRowStatePillActiveClass
											: feedRowStatePillOpenClass,
									)}
									title={displayIsReplied ? "We replied" : "Reply open"}
								>
									{displayIsReplied ? (
										<CheckCircle2 className="size-3.5" strokeWidth={2} />
									) : (
										<Circle className="size-3" strokeWidth={2.2} />
									)}
									{displayIsReplied ? "replied" : "open"}
								</span>
							) : null}
						</span>
					) : null}
				</header>
				{item.retweetedTweet ? (
					<>
						<TweetRichText
							className={feedRowTextClass}
							entities={displayTweet.entities}
							hiddenUrlRanges={hiddenMediaUrlRanges}
							text={displayTweet.text}
						/>
						<TweetMediaGrid items={displayTweet.media} />
						{displayTweet.entities.article ? (
							<TweetArticleCard article={displayTweet.entities.article} />
						) : null}
						{visibleUrlCards.map((entry, index) => (
							<LinkPreviewCard
								key={`${entry.expandedUrl}-${String(index)}`}
								entry={entry}
								index={index}
							/>
						))}
					</>
				) : (
					<>
						<TweetRichText
							className={feedRowTextClass}
							entities={item.entities}
							hiddenUrlRanges={hiddenMediaUrlRanges}
							text={item.text}
						/>
						<TweetMediaGrid items={item.media} />
						{item.entities.article ? (
							<TweetArticleCard article={item.entities.article} />
						) : null}
						{item.replyToTweet ? (
							<div className={embeddedCardClass}>
								<EmbeddedTweetCard
									item={item.replyToTweet}
									label="In reply to"
								/>
							</div>
						) : null}
						{item.quotedTweet ? (
							<div className={embeddedCardClass}>
								<EmbeddedTweetCard
									item={item.quotedTweet}
									label="Quoted tweet"
								/>
							</div>
						) : null}
						{visibleUrlCards.map((entry, index) => (
							<LinkPreviewCard
								key={`${entry.expandedUrl}-${String(index)}`}
								entry={entry}
								index={index}
							/>
						))}
					</>
				)}
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
									onReply(interactionTweetId);
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
						<a
							aria-label={`Analyse @${displayAuthor.handle}`}
							className={feedActionButtonClass}
							href={`/profiles/${encodeURIComponent(displayAuthor.handle)}`}
							onClick={(event) => {
								event.stopPropagation();
							}}
							title={`Analyse @${displayAuthor.handle}`}
						>
							<span className={feedActionIconWrapClass}>
								<UserSearch className={feedActionIconClass} strokeWidth={1.7} />
							</span>
							<span className="text-[13px]">Analyse</span>
						</a>
						{showLikeIndicator ? (
							<span
								aria-label={`${formatCompactNumber(displayLikeCount)} likes`}
								className={cx(
									"inline-flex items-center gap-1 px-2 py-1 text-[13px]",
									displayLiked && "text-[var(--like)]",
								)}
								title={`${formatCompactNumber(displayLikeCount)} likes`}
							>
								<Heart
									className={feedActionIconClass}
									strokeWidth={1.7}
									fill={displayLiked ? "currentColor" : "none"}
								/>
								<span>{formatCompactNumber(displayLikeCount)}</span>
							</span>
						) : null}
						{displayBookmarked ? (
							<span
								aria-label="Bookmarked"
								className="inline-flex items-center px-2 py-1"
								title="Bookmarked"
							>
								<BookmarkCheck
									className={feedActionIconClass}
									strokeWidth={1.7}
								/>
							</span>
						) : null}
						{showMediaIndicator ? (
							<span
								aria-label={`${String(displayMediaCount)} media attachments`}
								className="inline-flex items-center gap-1 px-2 py-1 text-[13px]"
								title={`${String(displayMediaCount)} media attachments`}
							>
								<Image className={feedActionIconClass} strokeWidth={1.7} />
								<span>{displayMediaCount}</span>
							</span>
						) : null}
					</div>
				</footer>
				{conversation.isOpen ? (
					<ConversationThread
						anchorId={interactionTweetId}
						error={conversation.error}
						items={conversation.items}
						loading={conversation.loading}
					/>
				) : null}
			</div>
		</article>
	);
}
