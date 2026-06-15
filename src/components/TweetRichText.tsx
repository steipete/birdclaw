import { Fragment } from "react";
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
}: {
	text: string;
	entities: TweetEntities;
	className?: string;
	hiddenUrlRanges?: Array<{ start: number; end: number }>;
	urlLabel?: "display" | "expanded";
	as?: "p" | "span";
}) {
	const richEntities = enrichFallbackUrlEntities(text, entities);
	const segments = collectTweetSegmentsForText(text, richEntities);
	const hiddenRawRangeKeys = new Set(hiddenUrlRanges.map(rangeKey));
	const article = entities.article;
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
			rangeKey(normalizeTweetUrlEntityRangeForText(text, entry)),
		);
	}
	const Wrapper = as;
	let cursor = 0;
	const hideArticleTitle =
		entities.article && text.trim() === entities.article.title.trim();
	const visibleSegments = hideArticleTitle ? [] : segments;

	return (
		<Wrapper className={className === "body-copy" ? bodyCopyClass : className}>
			{visibleSegments.map((segment, index) => {
				if (
					segment.start < cursor ||
					segment.end <= segment.start ||
					segment.end > text.length
				) {
					return null;
				}

				const prefix = text.slice(cursor, segment.start);
				cursor = segment.end;

				let node: ReactNode = (
					<Fragment key={`segment-${String(index)}`}>
						{text.slice(segment.start, segment.end)}
					</Fragment>
				);
				if (segment.kind === "url" && hiddenRangeKeys.has(rangeKey(segment))) {
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
			{hideArticleTitle ? null : text.slice(cursor)}
		</Wrapper>
	);
}
