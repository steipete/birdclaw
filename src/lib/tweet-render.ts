import type {
	TweetArticle,
	TweetEntities,
	TweetHashtagEntity,
	TweetMentionEntity,
	TweetUrlEntity,
} from "./types";

type TweetSegment =
	| ({ kind: "mention" } & TweetMentionEntity)
	| ({ kind: "url" } & TweetUrlEntity)
	| ({ kind: "hashtag" } & TweetHashtagEntity);

type UrlExpansion = Pick<TweetUrlEntity, "expandedUrl" | "displayUrl"> &
	Partial<
		Pick<TweetUrlEntity, "title" | "description" | "imageUrl" | "siteName">
	>;

const RAW_URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;
const TRAILING_URL_PUNCTUATION = /[),.;:!?]+$/;

const MARKDOWN_ESCAPE_CHARACTERS = new Set([
	"\\",
	"`",
	"*",
	"_",
	"{",
	"}",
	"[",
	"]",
	"(",
	")",
	"#",
	"+",
	".",
	"!",
	"|",
	">",
	"-",
]);

function escapeMarkdown(text: string) {
	return [...text]
		.map((character) =>
			MARKDOWN_ESCAPE_CHARACTERS.has(character) ? `\\${character}` : character,
		)
		.join("");
}

export function displayUrlForLink(url: string) {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.replace(/^www\./, "");
		const suffix = `${parsed.pathname}${parsed.search}${parsed.hash}`;
		return suffix === "/" ? host : `${host}${suffix}`;
	} catch {
		return url;
	}
}

function comparableUrl(value: string) {
	try {
		const parsed = new URL(value);
		return `${parsed.protocol}//${parsed.hostname.replace(/^www\./, "")}${parsed.pathname}`;
	} catch {
		return value.split("?")[0] ?? value;
	}
}

export function isTweetArticleUrlEntity(
	entry: TweetUrlEntity,
	article: TweetArticle,
) {
	if (comparableUrl(entry.expandedUrl) === comparableUrl(article.url)) {
		return true;
	}
	try {
		const parsed = new URL(entry.expandedUrl);
		const host = parsed.hostname.replace(/^www\./, "");
		return (
			(host === "x.com" || host === "twitter.com") &&
			parsed.pathname.startsWith("/i/article/")
		);
	} catch {
		return false;
	}
}

function asRecord(value: unknown) {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

export function tweetEntitiesFromXurl(raw: unknown): TweetEntities {
	const entities = asRecord(raw);
	const rawMentions = Array.isArray(entities.mentions) ? entities.mentions : [];
	const rawUrls = Array.isArray(entities.urls) ? entities.urls : [];
	const rawHashtags = Array.isArray(entities.hashtags) ? entities.hashtags : [];
	const rawArticle = asRecord(entities.article);
	const articleTitle = String(rawArticle.title ?? "").trim();
	const articleUrl = String(rawArticle.url ?? "").trim();

	return {
		...(rawMentions.length
			? {
					mentions: rawMentions.map((mention) => {
						const value = asRecord(mention);
						return {
							username: String(value.username ?? ""),
							id: typeof value.id === "string" ? String(value.id) : undefined,
							start: Number(value.start ?? 0),
							end: Number(value.end ?? 0),
						};
					}),
				}
			: {}),
		...(rawUrls.length
			? {
					urls: rawUrls.map((url) => {
						const value = asRecord(url);
						const expandedUrl = String(
							value.expandedUrl ?? value.expanded_url ?? value.url ?? "",
						);
						return {
							url: String(value.url ?? ""),
							expandedUrl,
							displayUrl: String(
								value.displayUrl ??
									value.display_url ??
									expandedUrl ??
									value.url ??
									"",
							),
							start: Number(value.start ?? 0),
							end: Number(value.end ?? 0),
							...(typeof value.title === "string"
								? { title: value.title }
								: {}),
							...(typeof value.description === "string" ||
							value.description === null
								? { description: value.description }
								: {}),
							...(typeof value.imageUrl === "string"
								? { imageUrl: value.imageUrl }
								: typeof value.image_url === "string"
									? { imageUrl: value.image_url }
									: {}),
							...(typeof value.siteName === "string"
								? { siteName: value.siteName }
								: typeof value.site_name === "string"
									? { siteName: value.site_name }
									: {}),
						};
					}),
				}
			: {}),
		...(rawHashtags.length
			? {
					hashtags: rawHashtags.map((hashtag) => {
						const value = asRecord(hashtag);
						return {
							tag: String(value.tag ?? value.text ?? ""),
							start: Number(value.start ?? 0),
							end: Number(value.end ?? 0),
						};
					}),
				}
			: {}),
		...(articleTitle && articleUrl
			? {
					article: {
						title: articleTitle,
						url: articleUrl,
						...(typeof (rawArticle.previewText ?? rawArticle.preview_text) ===
							"string" &&
						String(rawArticle.previewText ?? rawArticle.preview_text).trim()
							? {
									previewText: String(
										rawArticle.previewText ?? rawArticle.preview_text,
									).trim(),
								}
							: {}),
						...(typeof (
							rawArticle.coverImageUrl ?? rawArticle.cover_image_url
						) === "string" &&
						String(
							rawArticle.coverImageUrl ?? rawArticle.cover_image_url,
						).trim()
							? {
									coverImageUrl: String(
										rawArticle.coverImageUrl ?? rawArticle.cover_image_url,
									).trim(),
								}
							: {}),
					},
				}
			: {}),
	};
}

export function profileDescriptionEntitiesFromXurl(
	raw: unknown,
): TweetEntities {
	const entities = asRecord(raw);
	return tweetEntitiesFromXurl(entities.description);
}

function spansOverlap(
	leftStart: number,
	leftEnd: number,
	rightStart: number,
	rightEnd: number,
) {
	return leftStart < rightEnd && rightStart < leftEnd;
}

function stringIndexFromCodePointIndex(text: string, index: number) {
	if (index <= 0) return 0;
	let stringIndex = 0;
	let codePointIndex = 0;
	for (const character of text) {
		if (codePointIndex >= index) break;
		stringIndex += character.length;
		codePointIndex += 1;
	}
	return stringIndex;
}

function segmentTextMatches(
	text: string,
	segment: TweetSegment,
	start: number,
	end: number,
) {
	const slice = text.slice(start, end);
	if (segment.kind === "mention") {
		return slice.toLowerCase() === `@${segment.username}`.toLowerCase();
	}
	if (segment.kind === "hashtag") {
		return slice.toLowerCase() === `#${segment.tag}`.toLowerCase();
	}
	return slice === segment.url;
}

function normalizeSegmentTextRange(text: string, segment: TweetSegment) {
	if (
		segment.start >= 0 &&
		segment.end > segment.start &&
		segment.end <= text.length &&
		segmentTextMatches(text, segment, segment.start, segment.end)
	) {
		return segment;
	}

	const start = stringIndexFromCodePointIndex(text, segment.start);
	const end = stringIndexFromCodePointIndex(text, segment.end);
	if (
		start >= 0 &&
		end > start &&
		end <= text.length &&
		segmentTextMatches(text, segment, start, end)
	) {
		return { ...segment, start, end };
	}

	return segment;
}

export function normalizeTweetUrlEntityRangeForText(
	text: string,
	entry: TweetUrlEntity,
) {
	const normalized = normalizeSegmentTextRange(text, { ...entry, kind: "url" });
	return { start: normalized.start, end: normalized.end };
}

export function enrichFallbackUrlEntities(
	text: string,
	entities: TweetEntities,
	resolveExpansion?: (rawUrl: string) => UrlExpansion | null | undefined,
): TweetEntities {
	const existingUrls = entities.urls ?? [];
	const enrichedExistingUrls = existingUrls.map((entry) => {
		const expansion = resolveExpansion?.(entry.url);
		if (!expansion) return entry;
		const expandedUrl = expansion.expandedUrl || entry.expandedUrl;
		return {
			...entry,
			expandedUrl,
			displayUrl: expansion.displayUrl || displayUrlForLink(expandedUrl),
			...(expansion.title ? { title: expansion.title } : {}),
			...(expansion && "description" in expansion
				? { description: expansion.description ?? null }
				: {}),
			...(expansion.imageUrl ? { imageUrl: expansion.imageUrl } : {}),
			...(expansion.siteName ? { siteName: expansion.siteName } : {}),
		};
	});
	const fallbackUrls: TweetUrlEntity[] = [];

	for (const match of text.matchAll(RAW_URL_PATTERN)) {
		const rawMatch = match[0];
		const url = rawMatch.replace(TRAILING_URL_PUNCTUATION, "");
		const start = match.index ?? 0;
		const end = start + url.length;
		if (!url) {
			continue;
		}
		if (
			enrichedExistingUrls.some((entry) =>
				spansOverlap(start, end, entry.start, entry.end),
			)
		) {
			continue;
		}

		const expansion = resolveExpansion?.(url);
		const expandedUrl = expansion?.expandedUrl || url;
		fallbackUrls.push({
			url,
			expandedUrl,
			displayUrl: expansion?.displayUrl || displayUrlForLink(expandedUrl),
			start,
			end,
			...(expansion?.title ? { title: expansion.title } : {}),
			...(expansion && "description" in expansion
				? { description: expansion.description ?? null }
				: {}),
			...(expansion?.imageUrl ? { imageUrl: expansion.imageUrl } : {}),
			...(expansion?.siteName ? { siteName: expansion.siteName } : {}),
		});
	}

	if (fallbackUrls.length === 0) {
		return { ...entities, urls: enrichedExistingUrls };
	}

	return {
		...entities,
		urls: [...enrichedExistingUrls, ...fallbackUrls].sort(
			(left, right) => left.start - right.start,
		),
	};
}

export function collectTweetSegments(entities: TweetEntities): TweetSegment[] {
	return [
		...(entities.mentions?.map((entry) => ({
			...entry,
			kind: "mention" as const,
		})) ?? []),
		...(entities.urls?.map((entry) => ({ ...entry, kind: "url" as const })) ??
			[]),
		...(entities.hashtags?.map((entry) => ({
			...entry,
			kind: "hashtag" as const,
		})) ?? []),
	].sort((left, right) => left.start - right.start);
}

export function collectTweetSegmentsForText(
	text: string,
	entities: TweetEntities,
) {
	return collectTweetSegments(entities)
		.map((segment) => normalizeSegmentTextRange(text, segment))
		.sort((left, right) => left.start - right.start);
}

function renderTweetText(
	text: string,
	entities: TweetEntities,
	renderSegment: (segment: TweetSegment, fallback: string) => string,
) {
	const segments = collectTweetSegmentsForText(text, entities);
	let cursor = 0;
	let output = "";

	for (const segment of segments) {
		if (
			segment.start < cursor ||
			segment.end <= segment.start ||
			segment.end > text.length
		) {
			continue;
		}

		output += text.slice(cursor, segment.start);
		const fallback = text.slice(segment.start, segment.end);
		output += renderSegment(segment, fallback);
		cursor = segment.end;
	}

	output += text.slice(cursor);
	return output;
}

export function renderTweetPlainText(text: string, entities: TweetEntities) {
	return renderTweetText(text, entities, (segment, fallback) => {
		if (segment.kind === "url") {
			return segment.expandedUrl;
		}
		if (segment.kind === "mention") {
			return `@${segment.username}`;
		}
		if (segment.kind === "hashtag") {
			return `#${segment.tag}`;
		}
		return fallback;
	});
}

export function renderTweetMarkdown(text: string, entities: TweetEntities) {
	return renderTweetText(text, entities, (segment, fallback) => {
		if (segment.kind === "url") {
			return `[${escapeMarkdown(segment.displayUrl)}](${segment.expandedUrl})`;
		}
		if (segment.kind === "mention") {
			const label = `@${segment.username}`;
			return segment.profile
				? `[${escapeMarkdown(label)}](https://x.com/${segment.username})`
				: escapeMarkdown(label);
		}
		if (segment.kind === "hashtag") {
			return escapeMarkdown(`#${segment.tag}`);
		}
		return escapeMarkdown(fallback);
	});
}
