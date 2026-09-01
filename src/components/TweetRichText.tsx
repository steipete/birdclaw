import { Fragment, useState } from "react";
import type { ReactNode } from "react";
import {
	collectTweetSegmentsForText,
	enrichFallbackUrlEntities,
	isTweetArticleUrlEntity,
	normalizeTweetUrlEntityRangeForText,
} from "#/lib/tweet-render";
import type { TweetEntities } from "#/lib/types";
import {
	bodyCopyClass,
	tweetHashtagClass,
	tweetLinkClass,
	tweetMentionClass,
} from "#/lib/ui";
import { safeHttpUrl } from "#/lib/url-safety";
import { ProfilePreview } from "./ProfilePreview";

const NOTE_TWEET_PREVIEW_LENGTH = 280;

function truncateNoteTweet(text: string) {
	const characters = Array.from(text);
	if (characters.length <= NOTE_TWEET_PREVIEW_LENGTH) return text;
	const preview = characters.slice(0, NOTE_TWEET_PREVIEW_LENGTH).join("");
	return /\s/u.test(characters[NOTE_TWEET_PREVIEW_LENGTH]!)
		? preview.trimEnd()
		: preview.replace(/\s+\S*$/u, "");
}

function entitiesWithinText(
	entities: TweetEntities,
	text: string,
	visibleText: string,
) {
	const segments = collectTweetSegmentsForText(text, entities);
	const fits = (entry: { end: number }) => entry.end <= visibleText.length;
	const mentions = segments
		.filter((entry) => entry.kind === "mention")
		.filter(fits);
	const urls = segments.filter((entry) => entry.kind === "url").filter(fits);
	const hashtags = segments
		.filter((entry) => entry.kind === "hashtag")
		.filter(fits);
	const article = entities.article;
	const articleUrls = article
		? segments
				.filter((entry) => entry.kind === "url")
				.filter((entry) => isTweetArticleUrlEntity(entry, article))
		: [];
	return {
		...entities,
		mentions,
		urls,
		hashtags,
		article:
			articleUrls.length > 0 && !articleUrls.some(fits) ? undefined : article,
	};
}

function rangeKey(range: { start: number; end: number }) {
	return `${range.start}:${range.end}`;
}

function isShortUrl(value: string) {
	try {
		return new URL(value).hostname.replace(/^www\./, "") === "t.co";
	} catch {
		return false;
	}
}

export function TweetRichText({
	text,
	entities,
	className = "body-copy",
	hiddenUrlRanges = [],
	urlLabel = "display",
	as = "p",
	collapsible = false,
}: {
	text: string;
	entities: TweetEntities;
	className?: string;
	hiddenUrlRanges?: Array<{ start: number; end: number }>;
	urlLabel?: "display" | "expanded";
	as?: "p" | "span";
	collapsible?: boolean;
}) {
	const [expanded, setExpanded] = useState(false);
	const previewText = collapsible ? truncateNoteTweet(text) : text;
	const collapsed = previewText !== text && !expanded;
	const visibleText = collapsed ? previewText : text;
	const visibleEntities = collapsed
		? entitiesWithinText(entities, text, visibleText)
		: entities;
	const richEntities = enrichFallbackUrlEntities(visibleText, visibleEntities);
	const segments = collectTweetSegmentsForText(visibleText, richEntities);
	const hiddenRawRangeKeys = new Set(hiddenUrlRanges.map(rangeKey));
	const article = visibleEntities.article;
	if (article) {
		const urlEntries = richEntities.urls ?? [];
		const articleUrlEntries = urlEntries.filter((entry) =>
			isTweetArticleUrlEntity(entry, article),
		);
		const onlyUrlEntry = urlEntries[0];
		if (
			articleUrlEntries.length === 0 &&
			urlEntries.length === 1 &&
			onlyUrlEntry &&
			(isShortUrl(onlyUrlEntry.url) || isShortUrl(onlyUrlEntry.expandedUrl))
		) {
			articleUrlEntries.push(onlyUrlEntry);
		}
		for (const entry of articleUrlEntries) {
			hiddenRawRangeKeys.add(rangeKey(entry));
		}
	}
	const hiddenRangeKeys = new Set(hiddenRawRangeKeys);
	for (const entry of richEntities.urls ?? []) {
		if (!hiddenRawRangeKeys.has(rangeKey(entry))) continue;
		hiddenRangeKeys.add(
			rangeKey(normalizeTweetUrlEntityRangeForText(visibleText, entry)),
		);
	}
	const Wrapper = as;
	let cursor = 0;
	const hideArticleTitle =
		article && visibleText.trim() === article.title.trim();
	const visibleSegments = hideArticleTitle ? [] : segments;

	return (
		<>
			<Wrapper
				className={className === "body-copy" ? bodyCopyClass : className}
			>
				{visibleSegments.map((segment, index) => {
					if (
						segment.start < cursor ||
						segment.end <= segment.start ||
						segment.end > visibleText.length
					) {
						return null;
					}

					const prefix = visibleText.slice(cursor, segment.start);
					cursor = segment.end;

					let node: ReactNode = (
						<Fragment key={`segment-${String(index)}`}>
							{visibleText.slice(segment.start, segment.end)}
						</Fragment>
					);
					if (
						segment.kind === "url" &&
						hiddenRangeKeys.has(rangeKey(segment))
					) {
						node = null;
					} else if (segment.kind === "mention" && segment.profile) {
						node = (
							<ProfilePreview
								key={`segment-${String(index)}`}
								profile={segment.profile}
							>
								<span className={tweetMentionClass}>@{segment.username}</span>
							</ProfilePreview>
						);
					} else if (segment.kind === "mention") {
						node = (
							<a
								key={`segment-${String(index)}`}
								className={tweetMentionClass}
								href={`/profiles/${encodeURIComponent(segment.username)}`}
							>
								@{segment.username}
							</a>
						);
					} else if (segment.kind === "url") {
						const href = safeHttpUrl(segment.expandedUrl);
						if (href) {
							node = (
								<a
									key={`segment-${String(index)}`}
									className={tweetLinkClass}
									href={href}
									rel="noreferrer"
									target="_blank"
								>
									{urlLabel === "expanded"
										? segment.expandedUrl
										: segment.displayUrl}
								</a>
							);
						}
					} else if (segment.kind === "hashtag") {
						node = (
							<span
								className={tweetHashtagClass}
								key={`segment-${String(index)}`}
							>
								#{segment.tag}
							</span>
						);
					}

					return (
						<Fragment key={`piece-${String(index)}`}>
							{prefix}
							{node}
						</Fragment>
					);
				})}
				{hideArticleTitle ? null : visibleText.slice(cursor)}
			</Wrapper>
			{collapsed ? (
				<button
					className="w-fit border-0 bg-transparent p-0 text-[15px] font-medium text-[var(--accent)] hover:underline"
					onClick={() => setExpanded(true)}
					type="button"
				>
					Show more
				</button>
			) : null}
		</>
	);
}
