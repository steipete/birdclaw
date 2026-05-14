import type { TweetMediaItem, XurlMediaItem } from "./types";

interface TweetWithMediaAttachments {
	attachments?: { media_keys?: string[] };
	entities?: Record<string, unknown>;
}

function mediaKeys(tweet: TweetWithMediaAttachments) {
	return Array.isArray(tweet.attachments?.media_keys)
		? tweet.attachments.media_keys.filter((key) => typeof key === "string")
		: [];
}

export function countTweetMedia(tweet: TweetWithMediaAttachments) {
	const keys = mediaKeys(tweet);
	if (keys.length > 0) {
		return keys.length;
	}

	const urls = Array.isArray(tweet.entities?.urls) ? tweet.entities.urls : [];
	return urls.filter(
		(url) =>
			url &&
			typeof url === "object" &&
			typeof (url as Record<string, unknown>).media_key === "string",
	).length;
}

function localType(media: XurlMediaItem): TweetMediaItem["type"] {
	if (media.type === "photo") {
		return "image";
	}
	if (media.type === "animated_gif") {
		return "gif";
	}
	if (media.type === "video") {
		return "video";
	}
	return "unknown";
}

function mp4Variants(
	media: XurlMediaItem,
): NonNullable<TweetMediaItem["variants"]> {
	return (media.variants ?? [])
		.filter(
			(variant) =>
				variant.content_type === "video/mp4" && typeof variant.url === "string",
		)
		.map((variant) => ({
			url: variant.url,
			contentType: variant.content_type,
			...(Number.isFinite(Number(variant.bit_rate))
				? { bitRate: Number(variant.bit_rate) }
				: {}),
		}))
		.sort(
			(left, right) => Number(right.bitRate ?? 0) - Number(left.bitRate ?? 0),
		);
}

function record(value: unknown) {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function parsedMediaUrl(value: unknown) {
	if (typeof value !== "string" || value.length === 0) return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" ? url : null;
	} catch {
		return null;
	}
}

function isKnownMediaCdn(url: URL) {
	return url.hostname === "pbs.twimg.com" || url.hostname === "video.twimg.com";
}

function directMediaUrl(value: unknown, trustedField = false) {
	const url = parsedMediaUrl(value);
	if (!url || url.hostname === "t.co") return null;
	return trustedField || isKnownMediaCdn(url) ? url.toString() : null;
}

function entityMediaUrl(value: Record<string, unknown>) {
	for (const key of ["media_url_https", "media_url"]) {
		const url = directMediaUrl(value[key], true);
		if (url) return url;
	}

	for (const key of ["expanded_url", "url"]) {
		const url = directMediaUrl(value[key]);
		if (url) return url;
	}

	const images = Array.isArray(value.images) ? value.images : [];
	for (const image of images) {
		const item = record(image);
		const url = directMediaUrl(item?.url);
		if (url) return url;
	}
	return null;
}

function birdEntityMedia(tweet: TweetWithMediaAttachments) {
	const urls = Array.isArray(tweet.entities?.urls) ? tweet.entities.urls : [];
	const seen = new Set<string>();
	const items: TweetMediaItem[] = [];
	for (const url of urls) {
		const item = record(url);
		if (!item || typeof item.media_key !== "string") continue;
		const mediaUrl = entityMediaUrl(item);
		if (!mediaUrl || seen.has(mediaUrl)) continue;
		seen.add(mediaUrl);
		items.push({ url: mediaUrl, type: "image" });
	}
	return items;
}

export function buildMediaJsonFromIncludes(
	tweet: TweetWithMediaAttachments,
	media: XurlMediaItem[] = [],
) {
	const byKey = new Map(media.map((item) => [item.media_key, item]));
	const keys = mediaKeys(tweet);
	const items = keys
		.map((key) => byKey.get(key))
		.filter((item): item is XurlMediaItem => item !== undefined)
		.map((item) => {
			const variants = mp4Variants(item);
			const type = localType(item);
			const url =
				type === "image"
					? (item.url ?? item.preview_image_url ?? "")
					: (item.preview_image_url ?? variants[0]?.url ?? item.url ?? "");
			if (!url) {
				return null;
			}

			return {
				url,
				type,
				...(item.alt_text ? { altText: item.alt_text } : {}),
				...(Number.isFinite(Number(item.width))
					? { width: Number(item.width) }
					: {}),
				...(Number.isFinite(Number(item.height))
					? { height: Number(item.height) }
					: {}),
				...(item.preview_image_url
					? { thumbnailUrl: item.preview_image_url }
					: {}),
				...(Number.isFinite(Number(item.duration_ms))
					? { durationMs: Number(item.duration_ms) }
					: {}),
				...(variants.length > 0 ? { variants } : {}),
			} satisfies TweetMediaItem;
		})
		.filter((item): item is TweetMediaItem => item !== null);

	return JSON.stringify(keys.length > 0 ? items : birdEntityMedia(tweet));
}
