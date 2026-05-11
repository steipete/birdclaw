import type {
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

function spansOverlap(
	leftStart: number,
	leftEnd: number,
	rightStart: number,
	rightEnd: number,
) {
	return leftStart < rightEnd && rightStart < leftEnd;
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

function renderTweetText(
	text: string,
	entities: TweetEntities,
	renderSegment: (segment: TweetSegment, fallback: string) => string,
) {
	const segments = collectTweetSegments(entities);
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
