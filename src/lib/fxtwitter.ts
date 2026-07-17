import { Buffer } from "node:buffer";
import { Data, Effect } from "effect";
import { getNativeDb } from "./db";
import { runEffectPromise } from "./effect-runtime";
import {
	defaultRuntimeServices,
	type RuntimeServices,
} from "./runtime-services";
import { ingestTweetPayload } from "./tweet-repository";
import type {
	XurlMediaItem,
	XurlMentionUser,
	XurlTweetData,
	XurlTweetsResponse,
} from "./types";

export const FXTWITTER_ORIGIN = "https://api.fxtwitter.com";

const FXTWITTER_TWEET_ID_PATTERN = /^\d{2,20}$/;
const TWITTER_ENTITY_ID_PATTERN = /^\d{1,20}$/;
const FXTWITTER_TIMEOUT_MS = 15_000;
const FXTWITTER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const FXTWITTER_MAX_TWEETS_PER_IMPORT = 20;
const TWITTER_STATUS_HOSTS = new Set([
	"twitter.com",
	"www.twitter.com",
	"x.com",
	"www.x.com",
]);
const TWITTER_IMAGE_HOSTS = new Set(["pbs.twimg.com"]);
const TWITTER_VIDEO_HOSTS = new Set(["video.twimg.com"]);

type JsonRecord = Record<string, unknown>;

export class FxTwitterError extends Data.TaggedError("FxTwitterError")<{
	readonly message: string;
	readonly status?: number;
	readonly cause?: unknown;
}> {}

export interface FxTwitterTweet {
	payload: XurlTweetsResponse;
	provenance: ReadonlyMap<string, string>;
}

export interface FxTwitterImportResult {
	ok: true;
	readOnlyTransport: true;
	source: "fxtwitter";
	endpoint: typeof FXTWITTER_ORIGIN;
	requestedCount: number;
	importedCount: number;
	items: Array<{
		tweetId: string;
		source: "fxtwitter";
		sourceUrl: string;
	}>;
}

function asRecord(value: unknown): JsonRecord | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: null;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function asString(value: unknown) {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown) {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function asCount(value: unknown) {
	return Math.max(0, Math.trunc(asNumber(value) ?? 0));
}

function toIsoDate(value: unknown, field: string) {
	const raw = asString(value);
	const timestamp = raw ? Date.parse(raw) : Number.NaN;
	if (!Number.isFinite(timestamp)) {
		throw new FxTwitterError({
			message: `FxTwitter response has an invalid ${field}`,
		});
	}
	return new Date(timestamp).toISOString();
}

function sourceUrlForTweet(tweetId: string) {
	return `${FXTWITTER_ORIGIN}/2/status/${tweetId}`;
}

export function parseFxTwitterTweetId(value: string) {
	const trimmed = value.trim();
	if (FXTWITTER_TWEET_ID_PATTERN.test(trimmed)) return trimmed;

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new FxTwitterError({
			message: `Invalid public tweet ID or canonical x.com/Twitter status URL: ${trimmed}`,
		});
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		parsed.port ||
		parsed.search ||
		parsed.hash ||
		!TWITTER_STATUS_HOSTS.has(parsed.hostname.toLowerCase())
	) {
		throw new FxTwitterError({
			message:
				"FxTwitter accepts only a tweet ID or canonical HTTPS x.com/Twitter status URL",
		});
	}
	const match = /^\/[A-Za-z0-9_]{1,15}\/status\/(\d{2,20})\/?$/.exec(
		parsed.pathname,
	);
	if (!match?.[1]) {
		throw new FxTwitterError({
			message:
				"FxTwitter accepts only a tweet ID or canonical HTTPS x.com/Twitter status URL",
		});
	}
	return match[1];
}

function safeUrlForHosts(value: unknown, hosts: ReadonlySet<string>) {
	const raw = asString(value);
	if (!raw) return undefined;
	try {
		const parsed = new URL(raw);
		if (
			parsed.protocol !== "https:" ||
			parsed.username ||
			parsed.password ||
			parsed.port ||
			!hosts.has(parsed.hostname.toLowerCase())
		) {
			return undefined;
		}
		return parsed.toString();
	} catch {
		return undefined;
	}
}

function normalizeAuthor(value: unknown): XurlMentionUser {
	const author = asRecord(value);
	const id = asString(author?.id);
	const username = asString(author?.screen_name);
	if (!author || !id || !TWITTER_ENTITY_ID_PATTERN.test(id) || !username) {
		throw new FxTwitterError({
			message: "FxTwitter response is missing a valid tweet author",
		});
	}
	const verification = asRecord(author.verification);
	const website = asRecord(author.website);
	const joined = asString(author.joined);
	const joinedTimestamp = joined ? Date.parse(joined) : Number.NaN;
	return {
		id,
		name: asString(author.name) ?? username,
		username,
		description: asString(author.description),
		location: asString(author.location),
		url: asString(website?.url),
		verified: Boolean(verification?.verified),
		verified_type: asString(verification?.type),
		profile_image_url: safeUrlForHosts(author.avatar_url, TWITTER_IMAGE_HOSTS),
		public_metrics: {
			followers_count: asCount(author.followers),
			following_count: asCount(author.following),
			tweet_count: asCount(author.statuses),
		},
		created_at: Number.isFinite(joinedTimestamp)
			? new Date(joinedTimestamp).toISOString()
			: undefined,
		protected: Boolean(author.protected),
	};
}

function normalizeMedia(tweetId: string, value: unknown) {
	const media = asRecord(value);
	const items = asArray(media?.all);
	const normalized: XurlMediaItem[] = [];
	for (const [index, rawItem] of items.entries()) {
		const item = asRecord(rawItem);
		const type = asString(item?.type);
		if (!item || !type) continue;
		const providerId = asString(item.id) ?? String(index + 1);
		const mediaKey = `fxtwitter:${tweetId}:${providerId}`;
		if (type === "photo") {
			const url = safeUrlForHosts(item.url, TWITTER_IMAGE_HOSTS);
			if (!url) continue;
			normalized.push({
				media_key: mediaKey,
				type: "photo",
				url,
				width: asNumber(item.width),
				height: asNumber(item.height),
				alt_text: asString(item.altText) ?? asString(item.alt_text),
			});
			continue;
		}
		if (type !== "video" && type !== "gif") continue;
		const previewImageUrl = safeUrlForHosts(
			item.thumbnail_url ?? item.thumbnailUrl ?? item.poster,
			TWITTER_IMAGE_HOSTS,
		);
		const variantRows = [...asArray(item.variants), ...asArray(item.formats)];
		const variants = variantRows.flatMap((rawVariant) => {
			const variant = asRecord(rawVariant);
			const url = safeUrlForHosts(variant?.url, TWITTER_VIDEO_HOSTS);
			if (!variant || !url) return [];
			return [
				{
					url,
					content_type:
						asString(variant.content_type) ??
						asString(variant.contentType) ??
						"video/mp4",
					bit_rate: asNumber(variant.bit_rate) ?? asNumber(variant.bitrate),
				},
			];
		});
		if (!previewImageUrl && variants.length === 0) continue;
		normalized.push({
			media_key: mediaKey,
			type: type === "gif" ? "animated_gif" : "video",
			preview_image_url: previewImageUrl,
			duration_ms: asNumber(item.duration_ms) ?? asNumber(item.durationMillis),
			width: asNumber(item.width),
			height: asNumber(item.height),
			alt_text: asString(item.altText) ?? asString(item.alt_text),
			variants,
		});
	}
	return normalized;
}

function normalizeStatusTree(primaryValue: unknown, requestedId: string) {
	const tweets = new Map<string, XurlTweetData>();
	const users = new Map<string, XurlMentionUser>();
	const media = new Map<string, XurlMediaItem>();
	const provenance = new Map<string, string>();

	const visit = (value: unknown, depth: number): XurlTweetData => {
		const status = asRecord(value);
		const id = asString(status?.id);
		if (
			!status ||
			status.type !== "status" ||
			!id ||
			!FXTWITTER_TWEET_ID_PATTERN.test(id)
		) {
			throw new FxTwitterError({
				message:
					"FxTwitter response does not contain an available public tweet",
			});
		}
		const author = normalizeAuthor(status.author);
		users.set(author.id, author);
		const tweetMedia = normalizeMedia(id, status.media);
		for (const item of tweetMedia) media.set(item.media_key, item);

		const referencedTweets: Array<{ type: string; id: string }> = [];
		const replyingTo = asRecord(status.replying_to);
		const repliedToId = asString(replyingTo?.status);
		if (repliedToId && FXTWITTER_TWEET_ID_PATTERN.test(repliedToId)) {
			referencedTweets.push({ type: "replied_to", id: repliedToId });
		}
		const quote = asRecord(status.quote);
		if (quote?.type === "status" && depth < 2) {
			const quotedTweet = visit(quote, depth + 1);
			referencedTweets.push({ type: "quoted", id: quotedTweet.id });
		}

		const tweet: XurlTweetData = {
			id,
			author_id: author.id,
			text: asString(status.text) ?? "",
			created_at: toIsoDate(status.created_at, "tweet creation date"),
			conversation_id: id,
			in_reply_to_user_id: asString(replyingTo?.user_id),
			attachments:
				tweetMedia.length > 0
					? { media_keys: tweetMedia.map((item) => item.media_key) }
					: undefined,
			referenced_tweets:
				referencedTweets.length > 0 ? referencedTweets : undefined,
			public_metrics: {
				reply_count: asCount(status.replies),
				retweet_count: asCount(status.reposts),
				like_count: asCount(status.likes),
				quote_count: asCount(status.quotes),
				bookmark_count: asCount(status.bookmarks),
				impression_count: asCount(status.views),
			},
		};
		tweets.set(id, tweet);
		provenance.set(id, sourceUrlForTweet(requestedId));
		return tweet;
	};

	const primary = visit(primaryValue, 0);
	if (primary.id !== requestedId) {
		throw new FxTwitterError({
			message: `FxTwitter returned tweet ${primary.id} for requested tweet ${requestedId}`,
		});
	}
	return {
		payload: {
			data: [primary],
			includes: {
				users: [...users.values()],
				tweets: [...tweets.values()].filter((tweet) => tweet.id !== primary.id),
				media: [...media.values()],
			},
			meta: {
				source: "fxtwitter",
				endpoint: FXTWITTER_ORIGIN,
				read_only: true,
			},
		},
		provenance,
	};
}

async function readBoundedJson(response: Response) {
	const contentLength = Number(response.headers.get("content-length"));
	if (
		Number.isFinite(contentLength) &&
		contentLength > FXTWITTER_MAX_RESPONSE_BYTES
	) {
		throw new FxTwitterError({ message: "FxTwitter response is too large" });
	}
	if (!response.body) return null;
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > FXTWITTER_MAX_RESPONSE_BYTES) {
			await reader.cancel();
			throw new FxTwitterError({ message: "FxTwitter response is too large" });
		}
		chunks.push(value);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} catch (cause) {
		throw new FxTwitterError({
			message: "FxTwitter returned invalid JSON",
			cause,
		});
	}
}

function toFxTwitterError(cause: unknown) {
	if (cause instanceof FxTwitterError) return cause;
	if (cause instanceof DOMException && cause.name === "AbortError") {
		return new FxTwitterError({
			message: "FxTwitter request timed out",
			cause,
		});
	}
	return new FxTwitterError({
		message:
			cause instanceof Error ? cause.message : "FxTwitter request failed",
		cause,
	});
}

export function getTweetByIdViaFxTwitterEffect(
	input: string,
	runtime: RuntimeServices = defaultRuntimeServices,
): Effect.Effect<FxTwitterTweet, FxTwitterError> {
	return Effect.tryPromise({
		try: async () => {
			const tweetId = parseFxTwitterTweetId(input);
			const controller = new AbortController();
			const timeout = setTimeout(
				() => controller.abort(),
				FXTWITTER_TIMEOUT_MS,
			);
			try {
				const response = await runtime.fetch(sourceUrlForTweet(tweetId), {
					method: "GET",
					headers: {
						Accept: "application/json",
						"User-Agent": "birdclaw/fxtwitter-read-only",
					},
					redirect: "error",
					signal: controller.signal,
				});
				const body = await readBoundedJson(response);
				const root = asRecord(body);
				const providerCode = asNumber(root?.code);
				if (!response.ok || providerCode !== 200) {
					throw new FxTwitterError({
						message: `FxTwitter lookup failed with status ${String(providerCode ?? response.status)}`,
						status: response.status,
					});
				}
				return normalizeStatusTree(root?.status, tweetId);
			} finally {
				clearTimeout(timeout);
			}
		},
		catch: toFxTwitterError,
	});
}

export function importTweetsViaFxTwitterEffect(
	inputs: readonly string[],
	runtime: RuntimeServices = defaultRuntimeServices,
): Effect.Effect<FxTwitterImportResult, FxTwitterError> {
	return Effect.gen(function* () {
		const tweetIds = yield* Effect.try({
			try: () => [...new Set(inputs.map(parseFxTwitterTweetId))],
			catch: toFxTwitterError,
		});
		if (tweetIds.length === 0) {
			return yield* Effect.fail(
				new FxTwitterError({ message: "Pass at least one public tweet ID" }),
			);
		}
		if (tweetIds.length > FXTWITTER_MAX_TWEETS_PER_IMPORT) {
			return yield* Effect.fail(
				new FxTwitterError({
					message: `FxTwitter import accepts at most ${String(FXTWITTER_MAX_TWEETS_PER_IMPORT)} tweets per invocation`,
				}),
			);
		}
		const fetched = yield* Effect.forEach(
			tweetIds,
			(tweetId) => getTweetByIdViaFxTwitterEffect(tweetId, runtime),
			{ concurrency: 1 },
		);
		return yield* Effect.try({
			try: () => {
				const db = getNativeDb({ seedDemoData: false });
				const importedIds = new Set<string>();
				for (const result of fetched) {
					for (const tweetId of ingestTweetPayload(db, {
						accountId: "public",
						payload: result.payload,
						source: "fxtwitter",
						provenance: { sourceUrlByTweetId: result.provenance },
					})) {
						importedIds.add(tweetId);
					}
				}
				return {
					ok: true,
					readOnlyTransport: true,
					source: "fxtwitter",
					endpoint: FXTWITTER_ORIGIN,
					requestedCount: tweetIds.length,
					importedCount: importedIds.size,
					items: tweetIds.map((tweetId) => ({
						tweetId,
						source: "fxtwitter" as const,
						sourceUrl: sourceUrlForTweet(tweetId),
					})),
				} satisfies FxTwitterImportResult;
			},
			catch: toFxTwitterError,
		});
	});
}

export function importTweetsViaFxTwitter(
	inputs: readonly string[],
	runtime: RuntimeServices = defaultRuntimeServices,
) {
	return runEffectPromise(importTweetsViaFxTwitterEffect(inputs, runtime));
}
