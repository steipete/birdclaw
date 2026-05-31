import { createHash } from "node:crypto";
import { Effect } from "effect";
import { z } from "zod";
import { getNativeDb } from "./db";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import { buildMediaJsonFromIncludes, countTweetMedia } from "./media-includes";
import type { Database } from "./sqlite";
import { readSyncCache, writeSyncCache } from "./sync-cache";
import type {
	ProfileRecord,
	XurlMediaItem,
	XurlMentionUser,
	XurlTweetData,
	XurlTweetsResponse,
	XurlUserTweet,
	XurlUserTweetsResponse,
} from "./types";
import {
	type TweetAccountEdgeKind,
	upsertTweetAccountEdge,
} from "./tweet-account-edges";
import { buildExternalProfileId, upsertProfileFromXUser } from "./x-profile";
import {
	listUserTweetsEffect,
	lookupUsersByHandlesEffect,
	searchRecentByConversationIdEffect,
} from "./xurl";

export interface ProfileAnalysisOptions {
	handle: string;
	account?: string;
	refresh?: boolean;
	maxTweets?: number;
	maxPages?: number;
	maxConversations?: number;
	maxConversationPages?: number;
	conversationDelayMs?: number;
	rateLimitRetryMs?: number;
	rateLimitMaxRetries?: number;
	cacheTtlMs?: number;
	model?: string;
	reasoningEffort?: "minimal" | "low" | "medium" | "high";
	serviceTier?: "default" | "flex" | "priority";
	signal?: AbortSignal;
}

export interface ProfileAnalysisStreamHandlers {
	onDelta?: (delta: string) => void;
	onEvent?: (event: ProfileAnalysisStreamEvent) => void;
}

export interface CompactProfileTweet {
	id: string;
	url: string;
	author: string;
	createdAt: string;
	text: string;
	conversationId?: string;
	replyToId?: string;
	likeCount: number;
	replyCount: number;
	retweetCount: number;
	quoteCount: number;
	bookmarkedCount: number;
}

export interface CompactConversationTweet extends CompactProfileTweet {
	conversationRootId: string;
	profileId: string;
	name: string;
	bio: string;
	followersCount: number;
	avatarUrl?: string;
}

export interface ProfileAnalysisContext {
	handle: string;
	accountId: string;
	accountHandle: string;
	profile: ProfileRecord;
	externalUserId: string;
	tweets: CompactProfileTweet[];
	conversations: CompactConversationTweet[];
	counts: {
		tweets: number;
		tweetPages: number;
		conversationsScanned: number;
		conversationTweets: number;
		conversationPages: number;
	};
	fetchCached: boolean;
	hash: string;
}

const ProfileAnalysisSchema = z.object({
	title: z.string().min(1),
	summary: z.string().min(1),
	voice: z.string().min(1),
	themes: z.array(
		z.object({
			title: z.string().min(1),
			summary: z.string().min(1),
			tweetIds: z.array(z.string()).default([]),
			handles: z.array(z.string()).default([]),
		}),
	),
	conversationStyle: z.string().min(1),
	notableSignals: z.array(z.string()).default([]),
	risks: z.array(z.string()).default([]),
	followUps: z.array(z.string()).default([]),
	sourceTweetIds: z.array(z.string()).default([]),
	sourceHandles: z.array(z.string()).default([]),
});

export type ProfileAnalysis = z.infer<typeof ProfileAnalysisSchema>;

export interface ProfileAnalysisRunResult {
	context: ProfileAnalysisContext;
	analysis: ProfileAnalysis;
	markdown: string;
	model: string;
	reasoningEffort: string;
	serviceTier: string;
	cached: boolean;
	updatedAt: string;
}

export type ProfileAnalysisStreamEvent =
	| { type: "status"; label: string; detail?: string }
	| { type: "start"; context: ProfileAnalysisContext; cached: boolean }
	| { type: "delta"; delta: string }
	| { type: "done"; result: ProfileAnalysisRunResult }
	| { type: "error"; error: string };

const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_REASONING_EFFORT = "medium";
const DEFAULT_SERVICE_TIER = "priority";
const DEFAULT_MAX_TWEETS = 10_000;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_MAX_CONVERSATIONS = 80;
const DEFAULT_MAX_CONVERSATION_PAGES = 3;
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60_000;
const DEFAULT_CONVERSATION_DELAY_MS = 3_100;
const DEFAULT_RATE_LIMIT_RETRY_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX_RETRIES = 1;
const XURL_PAGE_SIZE = 100;
const MAX_PROMPT_DATA_CHARS = 1_200_000;
const DELIMITER_PATTERN = /\n---\s*\n/;

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function isXurlRateLimitError(error: Error) {
	return (
		error.message.includes("Too Many Requests") ||
		error.message.includes('"status":429') ||
		/\b429\b/.test(error.message)
	);
}

function tryProfileSync<T>(try_: () => T): Effect.Effect<T, Error> {
	return Effect.try({ try: try_, catch: toError });
}

function tryProfilePromise<T>(
	try_: () => PromiseLike<T>,
): Effect.Effect<T, Error> {
	return tryPromise(try_).pipe(Effect.mapError(toError));
}

function normalizeHandle(value: string) {
	const handle = value
		.trim()
		.replace(/^https?:\/\/(x|twitter)\.com\//i, "")
		.replace(/^@/, "")
		.split(/[/?#]/)[0]
		?.trim();
	if (!handle) {
		throw new Error("Profile handle is required");
	}
	return handle;
}

function normalizePositiveInteger(
	value: number | undefined,
	defaultValue: number,
	optionName: string,
) {
	if (value === undefined) return defaultValue;
	if (!Number.isFinite(value) || value < 1) {
		throw new Error(`${optionName} must be at least 1`);
	}
	return Math.floor(value);
}

function normalizeCacheTtlMs(value: number | undefined) {
	if (value === undefined) return DEFAULT_CACHE_TTL_MS;
	if (!Number.isFinite(value) || value < 0) {
		return DEFAULT_CACHE_TTL_MS;
	}
	return Math.floor(value);
}

function normalizeNonNegativeInteger(
	value: number | undefined,
	defaultValue: number,
) {
	if (value === undefined) return defaultValue;
	if (!Number.isFinite(value) || value < 0) return defaultValue;
	return Math.floor(value);
}

function envNonNegativeInteger(name: string) {
	const value = process.env[name];
	if (value === undefined || value.trim() === "") return undefined;
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric < 0) return undefined;
	return Math.floor(numeric);
}

function conversationDelayMsFromOptions(options: ProfileAnalysisOptions) {
	return normalizeNonNegativeInteger(
		options.conversationDelayMs ??
			envNonNegativeInteger("BIRDCLAW_PROFILE_ANALYSIS_CONVERSATION_DELAY_MS"),
		DEFAULT_CONVERSATION_DELAY_MS,
	);
}

function rateLimitRetryMsFromOptions(options: ProfileAnalysisOptions) {
	return normalizeNonNegativeInteger(
		options.rateLimitRetryMs ??
			envNonNegativeInteger("BIRDCLAW_PROFILE_ANALYSIS_RATE_LIMIT_RETRY_MS"),
		DEFAULT_RATE_LIMIT_RETRY_MS,
	);
}

function rateLimitMaxRetriesFromOptions(options: ProfileAnalysisOptions) {
	return normalizeNonNegativeInteger(
		options.rateLimitMaxRetries ??
			envNonNegativeInteger(
				"BIRDCLAW_PROFILE_ANALYSIS_RATE_LIMIT_MAX_RETRIES",
			),
		DEFAULT_RATE_LIMIT_MAX_RETRIES,
	);
}

function resolveAccount(db: Database, accountId?: string) {
	const row = accountId
		? (db
				.prepare("select id, handle from accounts where id = ?")
				.get(accountId) as { id: string; handle: string } | undefined)
		: (db
				.prepare(
					`
          select id, handle
          from accounts
          order by is_default desc, created_at asc
          limit 1
          `,
				)
				.get() as { id: string; handle: string } | undefined);
	if (!row) {
		throw new Error(`Unknown account: ${accountId ?? "default"}`);
	}
	return row;
}

function modelFromOptions(options: ProfileAnalysisOptions) {
	return options.model ?? process.env.BIRDCLAW_AI_MODEL ?? DEFAULT_MODEL;
}

function reasoningEffortFromOptions(options: ProfileAnalysisOptions) {
	return (
		options.reasoningEffort ??
		(process.env.BIRDCLAW_OPENAI_REASONING_EFFORT as
			| ProfileAnalysisOptions["reasoningEffort"]
			| undefined) ??
		DEFAULT_REASONING_EFFORT
	);
}

function serviceTierFromOptions(options: ProfileAnalysisOptions) {
	return (
		options.serviceTier ??
		(process.env.BIRDCLAW_OPENAI_SERVICE_TIER as
			| ProfileAnalysisOptions["serviceTier"]
			| undefined) ??
		DEFAULT_SERVICE_TIER
	);
}

function tweetUrl(handle: string, id: string) {
	return `https://x.com/${handle}/status/${id}`;
}

function replaceTweetFts(db: Database, tweetId: string, text: string) {
	db.prepare("delete from tweets_fts where tweet_id = ?").run(tweetId);
	db.prepare("insert into tweets_fts (tweet_id, text) values (?, ?)").run(
		tweetId,
		text,
	);
}

function refreshTweetFts(
	db: Database,
	tweetId: string,
	text: string,
	previousText: string | null,
) {
	if (previousText === text) return;
	if (previousText !== null) {
		replaceTweetFts(db, tweetId, text);
		return;
	}
	db.prepare("insert into tweets_fts (tweet_id, text) values (?, ?)").run(
		tweetId,
		text,
	);
}

function mergeXurlTweetsIntoLocalStore(
	db: Database,
	accountId: string,
	payload: XurlTweetsResponse,
	tweetKind: "profile" | "thread_context",
	edgeKind: TweetAccountEdgeKind,
	source: "xurl" | "cache",
) {
	const usersById = new Map(
		(payload.includes?.users ?? []).map((user) => [user.id, user]),
	);
	const upsertTweet = db.prepare(
		`
    insert into tweets (
      id, account_id, author_profile_id, kind, text, created_at,
      is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
      entities_json, media_json, quoted_tweet_id
    ) values (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, 0, ?, ?, ?)
    on conflict(id) do update set
      author_profile_id = excluded.author_profile_id,
      kind = tweets.kind,
      text = excluded.text,
      created_at = excluded.created_at,
      reply_to_id = coalesce(tweets.reply_to_id, excluded.reply_to_id),
      like_count = excluded.like_count,
      media_count = max(tweets.media_count, excluded.media_count),
      entities_json = excluded.entities_json,
      media_json = case
        when excluded.media_json not in ('', '[]', 'null') then excluded.media_json
        else tweets.media_json
      end,
      quoted_tweet_id = coalesce(tweets.quoted_tweet_id, excluded.quoted_tweet_id),
      bookmarked = tweets.bookmarked,
      liked = tweets.liked
    `,
	);
	const existingTweet = db.prepare("select text from tweets where id = ?");
	const seenAt = new Date().toISOString();
	db.transaction(() => {
		for (const tweet of payload.data) {
			const authorId = tweet.author_id;
			if (!authorId) continue;
			const author = usersById.get(authorId);
			if (!author) continue;
			const profile = upsertProfileFromXUser(db, author);
			const replyToId =
				tweet.referenced_tweets?.find((item) => item.type === "replied_to")
					?.id ?? null;
			const quotedTweetId =
				tweet.referenced_tweets?.find((item) => item.type === "quoted")?.id ??
				null;
			const previousTweet = existingTweet.get(tweet.id) as
				| { text: string | null }
				| undefined;
			const previousText =
				previousTweet && typeof previousTweet.text === "string"
					? previousTweet.text
					: null;
			upsertTweet.run(
				tweet.id,
				accountId,
				profile.profile.id,
				tweetKind,
				tweet.text,
				tweet.created_at,
				replyToId,
				Number(tweet.public_metrics?.like_count ?? 0),
				countTweetMedia(tweet),
				JSON.stringify(tweet.entities ?? {}),
				buildMediaJsonFromIncludes(tweet, payload.includes?.media),
				quotedTweetId,
			);
			upsertTweetAccountEdge(db, {
				accountId,
				tweetId: tweet.id,
				kind: edgeKind,
				source,
				seenAt,
				rawJson: JSON.stringify(tweet),
			});
			refreshTweetFts(db, tweet.id, tweet.text, previousText);
		}
	})();
}

function toTweetData(
	tweet: XurlUserTweet,
	fallbackAuthorId: string,
): XurlTweetData {
	return {
		...tweet,
		author_id: tweet.author_id ?? fallbackAuthorId,
	};
}

function userTimelineToTweetsResponse(
	response: XurlUserTweetsResponse,
	fallbackAuthorId: string,
): XurlTweetsResponse {
	return {
		data: response.items.map((tweet) => toTweetData(tweet, fallbackAuthorId)),
		includes: response.includes,
		meta: {
			result_count: response.items.length,
			...(response.nextToken ? { next_token: response.nextToken } : {}),
		},
	};
}

function mergeResponses(responses: XurlTweetsResponse[]): XurlTweetsResponse {
	const seenTweetIds = new Set<string>();
	const usersById = new Map<string, XurlMentionUser>();
	const mediaByKey = new Map<string, XurlMediaItem>();
	const data: XurlTweetData[] = [];
	for (const response of responses) {
		for (const user of response.includes?.users ?? []) {
			usersById.set(user.id, user);
		}
		for (const media of response.includes?.media ?? []) {
			mediaByKey.set(media.media_key, media);
		}
		for (const tweet of response.data) {
			if (seenTweetIds.has(tweet.id)) continue;
			seenTweetIds.add(tweet.id);
			data.push(tweet);
		}
	}
	return {
		data,
		includes: {
			users: [...usersById.values()],
			media: [...mediaByKey.values()],
		},
		meta: { result_count: data.length },
	};
}

function compactProfileTweet(
	tweet: XurlTweetData,
	profileHandle: string,
): CompactProfileTweet {
	return {
		id: tweet.id,
		url: tweetUrl(profileHandle, tweet.id),
		author: profileHandle,
		createdAt: tweet.created_at,
		text: tweet.text,
		...(tweet.conversation_id ? { conversationId: tweet.conversation_id } : {}),
		...(tweet.referenced_tweets?.find((item) => item.type === "replied_to")?.id
			? {
					replyToId: tweet.referenced_tweets.find(
						(item) => item.type === "replied_to",
					)?.id,
				}
			: {}),
		likeCount: Number(tweet.public_metrics?.like_count ?? 0),
		replyCount: Number(tweet.public_metrics?.reply_count ?? 0),
		retweetCount: Number(tweet.public_metrics?.retweet_count ?? 0),
		quoteCount: Number(tweet.public_metrics?.quote_count ?? 0),
		bookmarkedCount: Number(tweet.public_metrics?.bookmark_count ?? 0),
	};
}

function compactConversationTweet(
	tweet: XurlTweetData,
	usersById: Map<string, XurlMentionUser>,
	conversationRootId: string,
): CompactConversationTweet | null {
	const user = usersById.get(tweet.author_id);
	if (!user) return null;
	return {
		...compactProfileTweet(tweet, user.username),
		conversationRootId,
		profileId: buildExternalProfileId(user.id),
		name: user.name,
		bio: user.description ?? "",
		followersCount: Number(user.public_metrics?.followers_count ?? 0),
		...(user.profile_image_url ? { avatarUrl: user.profile_image_url } : {}),
	};
}

function contextCacheKey(options: {
	accountId: string;
	handle: string;
	maxTweets: number;
	maxPages: number;
	maxConversations: number;
	maxConversationPages: number;
}) {
	return [
		"profile-analysis:context:v1",
		options.accountId,
		options.handle.toLowerCase(),
		String(options.maxTweets),
		String(options.maxPages),
		String(options.maxConversations),
		String(options.maxConversationPages),
	].join(":");
}

function contextHash(context: Omit<ProfileAnalysisContext, "hash">) {
	return createHash("sha1")
		.update(
			JSON.stringify({
				handle: context.handle,
				accountId: context.accountId,
				accountHandle: context.accountHandle,
				externalUserId: context.externalUserId,
				profile: context.profile,
				counts: context.counts,
				tweets: context.tweets,
				conversations: context.conversations,
			}),
		)
		.digest("hex");
}

function resultCacheKey(
	context: ProfileAnalysisContext,
	options: ProfileAnalysisOptions,
) {
	return [
		"profile-analysis:result:v1",
		modelFromOptions(options),
		reasoningEffortFromOptions(options),
		serviceTierFromOptions(options),
		context.hash,
	].join(":");
}

function topConversationIds(tweets: XurlTweetData[], maxConversations: number) {
	const candidates = new Map<
		string,
		{ id: string; score: number; createdAt: string }
	>();
	for (const tweet of tweets) {
		const id = tweet.conversation_id;
		if (!id) continue;
		const score =
			Number(tweet.public_metrics?.reply_count ?? 0) * 8 +
			Number(tweet.public_metrics?.quote_count ?? 0) * 4 +
			Number(tweet.public_metrics?.like_count ?? 0);
		const existing = candidates.get(id);
		if (!existing || score > existing.score) {
			candidates.set(id, { id, score, createdAt: tweet.created_at });
		}
	}
	return [...candidates.values()]
		.sort(
			(left, right) =>
				right.score - left.score ||
				right.createdAt.localeCompare(left.createdAt),
		)
		.slice(0, maxConversations)
		.map((item) => item.id);
}

function buildContextFromPayloads({
	account,
	handle,
	profile,
	externalUserId,
	tweetResponses,
	conversationResponses,
	conversationRoots,
	tweetPages,
	conversationPages,
	fetchCached,
}: {
	account: { id: string; handle: string };
	handle: string;
	profile: ProfileRecord;
	externalUserId: string;
	tweetResponses: XurlTweetsResponse[];
	conversationResponses: XurlTweetsResponse[];
	conversationRoots: string[];
	tweetPages: number;
	conversationPages: number;
	fetchCached: boolean;
}): ProfileAnalysisContext {
	const tweetPayload = mergeResponses(tweetResponses);
	const conversationPayload = mergeResponses(conversationResponses);
	const profileTweets = tweetPayload.data
		.map((tweet) => compactProfileTweet(tweet, handle))
		.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	const usersById = new Map(
		(conversationPayload.includes?.users ?? []).map((user) => [user.id, user]),
	);
	const conversationSet = new Set(conversationRoots);
	const conversations = conversationPayload.data
		.filter(
			(tweet) =>
				tweet.conversation_id && conversationSet.has(tweet.conversation_id),
		)
		.map((tweet) =>
			compactConversationTweet(tweet, usersById, tweet.conversation_id ?? ""),
		)
		.filter((tweet): tweet is CompactConversationTweet => tweet !== null)
		.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	const withoutHash = {
		handle,
		accountId: account.id,
		accountHandle: account.handle,
		profile,
		externalUserId,
		tweets: profileTweets,
		conversations,
		counts: {
			tweets: profileTweets.length,
			tweetPages,
			conversationsScanned: conversationRoots.length,
			conversationTweets: conversations.length,
			conversationPages,
		},
		fetchCached,
	} satisfies Omit<ProfileAnalysisContext, "hash">;
	return {
		...withoutHash,
		hash: contextHash(withoutHash),
	};
}

function emitStatus(
	handlers: ProfileAnalysisStreamHandlers,
	label: string,
	detail?: string,
) {
	handlers.onEvent?.({
		type: "status",
		label,
		...(detail ? { detail } : {}),
	});
}

function abortIfRequestedEffect(signal: AbortSignal | undefined) {
	return tryProfileSync(() => {
		if (signal?.aborted) {
			throw new Error("Profile analysis aborted");
		}
	});
}

function sleepWithAbortEffect(ms: number, signal: AbortSignal | undefined) {
	if (ms <= 0) return abortIfRequestedEffect(signal);
	return tryProfilePromise(
		() =>
			new Promise<void>((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Profile analysis aborted"));
					return;
				}
				const timer = setTimeout(() => {
					signal?.removeEventListener("abort", onAbort);
					resolve();
				}, ms);
				const onAbort = () => {
					clearTimeout(timer);
					reject(new Error("Profile analysis aborted"));
				};
				signal?.addEventListener("abort", onAbort, { once: true });
			}),
	);
}

export function collectProfileAnalysisContextEffect(
	options: ProfileAnalysisOptions,
	handlers: ProfileAnalysisStreamHandlers = {},
): Effect.Effect<ProfileAnalysisContext, Error> {
	return Effect.gen(function* () {
		const db = getNativeDb();
		const handle = yield* tryProfileSync(() => normalizeHandle(options.handle));
		const account = yield* tryProfileSync(() =>
			resolveAccount(db, options.account),
		);
		const maxTweets = yield* tryProfileSync(() =>
			normalizePositiveInteger(
				options.maxTweets,
				DEFAULT_MAX_TWEETS,
				"--max-tweets",
			),
		);
		const maxPages = yield* tryProfileSync(() =>
			normalizePositiveInteger(
				options.maxPages,
				DEFAULT_MAX_PAGES,
				"--max-pages",
			),
		);
		const maxConversations = yield* tryProfileSync(() =>
			normalizePositiveInteger(
				options.maxConversations,
				DEFAULT_MAX_CONVERSATIONS,
				"--max-conversations",
			),
		);
		const maxConversationPages = yield* tryProfileSync(() =>
			normalizePositiveInteger(
				options.maxConversationPages,
				DEFAULT_MAX_CONVERSATION_PAGES,
				"--max-conversation-pages",
			),
		);
		const conversationDelayMs = conversationDelayMsFromOptions(options);
		const rateLimitRetryMs = rateLimitRetryMsFromOptions(options);
		const rateLimitMaxRetries = rateLimitMaxRetriesFromOptions(options);
		const cacheTtlMs = normalizeCacheTtlMs(options.cacheTtlMs);
		const contextKey = contextCacheKey({
			accountId: account.id,
			handle,
			maxTweets,
			maxPages,
			maxConversations,
			maxConversationPages,
		});
		const cached = yield* tryProfileSync(() =>
			readSyncCache<ProfileAnalysisContext>(contextKey, db),
		);
		const ageMs = cached
			? Date.now() - new Date(cached.updatedAt).getTime()
			: Number.POSITIVE_INFINITY;
		if (!options.refresh && cached && ageMs <= cacheTtlMs) {
			emitStatus(handlers, "Using cached profile backfill", `@${handle}`);
			return { ...cached.value, fetchCached: true };
		}

		emitStatus(handlers, "Resolving profile", `@${handle}`);
		yield* abortIfRequestedEffect(options.signal);
		const [user] = yield* lookupUsersByHandlesEffect([handle], {
			auth: "oauth2",
			username: account.handle,
			signal: options.signal,
		});
		yield* abortIfRequestedEffect(options.signal);
		if (!user) {
			return yield* Effect.fail(new Error(`Could not resolve @${handle}`));
		}
		const resolved = yield* tryProfileSync(() =>
			upsertProfileFromXUser(db, user),
		);

		const tweetResponses: XurlTweetsResponse[] = [];
		let nextToken: string | undefined;
		let tweetPages = 0;
		let fetchedTweets = 0;
		for (
			let page = 0;
			page < maxPages && fetchedTweets < maxTweets;
			page += 1
		) {
			yield* abortIfRequestedEffect(options.signal);
			const remaining = maxTweets - fetchedTweets;
			emitStatus(
				handlers,
				"Fetching profile tweets",
				`page ${String(page + 1)} · ${String(fetchedTweets)} tweets`,
			);
			const response = yield* listUserTweetsEffect(resolved.externalUserId, {
				maxResults: Math.max(5, Math.min(XURL_PAGE_SIZE, remaining)),
				paginationToken: nextToken,
				excludeRetweets: false,
				auth: "oauth2",
				tweetFields: [
					"created_at",
					"conversation_id",
					"entities",
					"public_metrics",
					"referenced_tweets",
					"in_reply_to_user_id",
					"attachments",
				],
				expansions: ["author_id", "attachments.media_keys"],
				userFields: [
					"description",
					"entities",
					"location",
					"public_metrics",
					"profile_image_url",
					"url",
					"created_at",
					"verified",
					"verified_type",
				],
				username: account.handle,
				signal: options.signal,
			});
			yield* abortIfRequestedEffect(options.signal);
			const limitedResponse =
				response.items.length > remaining
					? { ...response, items: response.items.slice(0, remaining) }
					: response;
			tweetPages += 1;
			fetchedTweets += limitedResponse.items.length;
			tweetResponses.push(
				userTimelineToTweetsResponse(limitedResponse, resolved.externalUserId),
			);
			nextToken =
				fetchedTweets < maxTweets
					? (response.nextToken ?? undefined)
					: undefined;
			if (!nextToken || limitedResponse.items.length === 0) break;
		}
		const profilePayload = mergeResponses(tweetResponses);
		yield* tryProfileSync(() =>
			mergeXurlTweetsIntoLocalStore(
				db,
				account.id,
				profilePayload,
				"profile",
				"profile",
				"xurl",
			),
		);

		const conversationRoots = topConversationIds(
			profilePayload.data,
			maxConversations,
		);
		const conversationResponses: XurlTweetsResponse[] = [];
		let conversationPages = 0;
		let conversationRateLimited = false;
		let conversationRequestCount = 0;
		for (const [index, conversationId] of conversationRoots.entries()) {
			if (conversationRateLimited) break;
			let conversationNextToken: string | undefined;
			for (let page = 0; page < maxConversationPages; page += 1) {
				yield* abortIfRequestedEffect(options.signal);
				if (conversationRequestCount > 0 && conversationDelayMs > 0) {
					emitStatus(
						handlers,
						"Throttling conversation fetch",
						`${String(conversationDelayMs)}ms`,
					);
					yield* sleepWithAbortEffect(conversationDelayMs, options.signal);
				}
				emitStatus(
					handlers,
					"Fetching conversations",
					`${String(index + 1)}/${String(conversationRoots.length)} · page ${String(page + 1)}`,
				);
				let response: XurlTweetsResponse | null = null;
				for (let attempt = 0; attempt <= rateLimitMaxRetries; attempt += 1) {
					conversationRequestCount += 1;
					response = yield* searchRecentByConversationIdEffect(
						conversationId,
						{
							maxResults: XURL_PAGE_SIZE,
							paginationToken: conversationNextToken,
							timeoutMs: 30_000,
							auth: "oauth2",
							username: account.handle,
							signal: options.signal,
						},
					).pipe(
						Effect.catchAll((error) => {
							if (!isXurlRateLimitError(error)) {
								return Effect.fail(error);
							}
							if (attempt < rateLimitMaxRetries) {
								emitStatus(
									handlers,
									"Conversation fetch rate limited",
									`retrying in ${String(rateLimitRetryMs)}ms`,
								);
								return sleepWithAbortEffect(
									rateLimitRetryMs,
									options.signal,
								).pipe(Effect.as(null));
							}
							conversationRateLimited = true;
							emitStatus(
								handlers,
								"Conversation fetch rate limited",
								"using partial profile context",
							);
							return Effect.succeed(null);
						}),
					);
					if (response || conversationRateLimited) {
						break;
					}
					if (conversationDelayMs > 0) {
						emitStatus(
							handlers,
							"Throttling conversation retry",
							`${String(conversationDelayMs)}ms`,
						);
						yield* sleepWithAbortEffect(conversationDelayMs, options.signal);
					}
				}
				if (!response) break;
				yield* abortIfRequestedEffect(options.signal);
				conversationPages += 1;
				conversationResponses.push(response);
				conversationNextToken =
					typeof response.meta?.next_token === "string"
						? String(response.meta.next_token)
						: undefined;
				if (!conversationNextToken || response.data.length === 0) break;
			}
		}
		const conversationPayload = mergeResponses(conversationResponses);
		yield* tryProfileSync(() =>
			mergeXurlTweetsIntoLocalStore(
				db,
				account.id,
				conversationPayload,
				"thread_context",
				"thread_context",
				"xurl",
			),
		);

		const context = buildContextFromPayloads({
			account,
			handle: resolved.profile.handle,
			profile: resolved.profile,
			externalUserId: resolved.externalUserId,
			tweetResponses,
			conversationResponses,
			conversationRoots,
			tweetPages,
			conversationPages,
			fetchCached: false,
		});
		if (!conversationRateLimited) {
			yield* tryProfileSync(() => writeSyncCache(contextKey, context, db));
		}
		return context;
	});
}

function fitPromptDataset(context: ProfileAnalysisContext) {
	let tweetCount = context.tweets.length;
	let conversationCount = context.conversations.length;
	const datasetFor = (tweets: number, conversations: number) => ({
		profile: context.profile,
		counts: context.counts,
		tweets: context.tweets.slice(0, tweets),
		conversations: context.conversations.slice(0, conversations),
	});
	const lengthFor = (tweets: number, conversations: number) =>
		JSON.stringify(datasetFor(tweets, conversations)).length;
	const fitCount = (max: number, fits: (count: number) => boolean) => {
		let low = 0;
		let high = max;
		let best = 0;
		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			if (fits(mid)) {
				best = mid;
				low = mid + 1;
			} else {
				high = mid - 1;
			}
		}
		return best;
	};
	if (lengthFor(tweetCount, conversationCount) <= MAX_PROMPT_DATA_CHARS) {
		return {
			dataset: datasetFor(tweetCount, conversationCount),
			tweetCount,
			conversationCount,
		};
	}
	conversationCount = fitCount(
		conversationCount,
		(count) => lengthFor(tweetCount, count) <= MAX_PROMPT_DATA_CHARS,
	);
	if (lengthFor(tweetCount, conversationCount) > MAX_PROMPT_DATA_CHARS) {
		tweetCount = fitCount(
			tweetCount,
			(count) => lengthFor(count, conversationCount) <= MAX_PROMPT_DATA_CHARS,
		);
	}
	return {
		dataset: datasetFor(tweetCount, conversationCount),
		tweetCount,
		conversationCount,
	};
}

function buildPrompt(context: ProfileAnalysisContext) {
	const { dataset, tweetCount, conversationCount } = fitPromptDataset(context);
	return `Profile: @${context.handle}
Account cache: ${context.accountId} (${context.accountHandle})
Fetched profile tweets: ${String(context.counts.tweets)} across ${String(context.counts.tweetPages)} pages
Fetched conversation tweets: ${String(context.counts.conversationTweets)} across ${String(context.counts.conversationPages)} pages
Prompt tweets: ${String(tweetCount)} of ${String(context.tweets.length)}
Prompt conversation tweets: ${String(conversationCount)} of ${String(context.conversations.length)}

Write a high-signal Markdown profile analysis from X/Twitter API data.

Requirements:
- Summarize who this person appears to be, what they care about, and what kind of attention they attract.
- Separate authored profile evidence from conversation/reply evidence.
- Cover recurring topics, tone, technical interests, social graph hints, interaction style, and likely follow-up angles.
- Cite claims with tweet ids at sentence ends, e.g. (1234567890). Cite handles only when they are in the dataset.
- Do not overstate beyond the supplied data.
- If conversation context is sparse, say so.
- After Markdown, output a blank line, a line containing only three hyphens, then one compact JSON object.
- JSON shape: { "title": string, "summary": string, "voice": string, "themes": [{ "title": string, "summary": string, "tweetIds": string[], "handles": string[] }], "conversationStyle": string, "notableSignals": string[], "risks": string[], "followUps": string[], "sourceTweetIds": string[], "sourceHandles": string[] }

Dataset:
${JSON.stringify(dataset)}`;
}

function fallbackAnalysis(
	context: ProfileAnalysisContext,
	markdown: string,
): ProfileAnalysis {
	return {
		title: `Profile analysis: @${context.handle}`,
		summary:
			markdown.replaceAll(/\s+/g, " ").trim().slice(0, 320) ||
			"No model summary was returned.",
		voice: "Not enough structured output was returned to classify voice.",
		themes: [],
		conversationStyle: "Not enough structured output was returned.",
		notableSignals: [],
		risks: [],
		followUps: [],
		sourceTweetIds: context.tweets.slice(0, 20).map((tweet) => tweet.id),
		sourceHandles: [context.handle],
	};
}

function parseAnalysisFromHybridText(
	context: ProfileAnalysisContext,
	rawText: string,
): { analysis: ProfileAnalysis; markdown: string } {
	const [markdownPart, jsonPart] = rawText.split(DELIMITER_PATTERN);
	const markdown = (markdownPart ?? rawText).trim();
	const candidate = jsonPart?.slice(
		jsonPart.indexOf("{"),
		jsonPart.lastIndexOf("}") + 1,
	);
	if (candidate?.startsWith("{")) {
		try {
			return {
				markdown,
				analysis: ProfileAnalysisSchema.parse(JSON.parse(candidate)),
			};
		} catch {
			return { markdown, analysis: fallbackAnalysis(context, markdown) };
		}
	}
	return { markdown, analysis: fallbackAnalysis(context, markdown) };
}

function extractResponseText(payload: Record<string, unknown>) {
	if (typeof payload.output_text === "string") {
		return payload.output_text;
	}
	const output = Array.isArray(payload.output) ? payload.output : [];
	const parts: string[] = [];
	for (const item of output) {
		if (!item || typeof item !== "object") continue;
		const content = (item as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const record = block as Record<string, unknown>;
			if (typeof record.text === "string") parts.push(record.text);
		}
	}
	return parts.join("");
}

function createOpenAIRequestBody(
	context: ProfileAnalysisContext,
	options: ProfileAnalysisOptions,
) {
	return {
		model: modelFromOptions(options),
		reasoning: { effort: reasoningEffortFromOptions(options) },
		service_tier: serviceTierFromOptions(options),
		store: false,
		max_output_tokens: 7000,
		input: [
			{
				role: "system",
				content:
					"You are a precise X/Twitter profile analyst. Use only supplied data. Return Markdown plus the requested JSON after the delimiter.",
			},
			{
				role: "user",
				content: buildPrompt(context),
			},
		],
	};
}

export function streamProfileAnalysisEffect(
	options: ProfileAnalysisOptions,
	handlers: ProfileAnalysisStreamHandlers = {},
): Effect.Effect<ProfileAnalysisRunResult, Error> {
	return Effect.gen(function* () {
		const context = yield* collectProfileAnalysisContextEffect(
			options,
			handlers,
		);
		const cached = options.refresh
			? null
			: yield* tryProfileSync(() =>
					readSyncCache<{
						analysis: ProfileAnalysis;
						markdown: string;
						model: string;
						reasoningEffort: string;
						serviceTier: string;
					}>(resultCacheKey(context, options)),
				);
		if (cached) {
			const result: ProfileAnalysisRunResult = yield* tryProfileSync(() => ({
				context,
				analysis: ProfileAnalysisSchema.parse(cached.value.analysis),
				markdown: cached.value.markdown,
				model: cached.value.model,
				reasoningEffort: cached.value.reasoningEffort,
				serviceTier: cached.value.serviceTier,
				cached: true,
				updatedAt: cached.updatedAt,
			}));
			handlers.onEvent?.({ type: "start", context, cached: true });
			handlers.onDelta?.(result.markdown);
			handlers.onEvent?.({ type: "delta", delta: result.markdown });
			handlers.onEvent?.({ type: "done", result });
			return result;
		}

		const apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) {
			return yield* Effect.fail(new Error("OPENAI_API_KEY is not set"));
		}
		handlers.onEvent?.({ type: "start", context, cached: false });
		emitStatus(handlers, "Summarizing with AI", modelFromOptions(options));
		const response = yield* tryProfilePromise(() =>
			fetch("https://api.openai.com/v1/responses", {
				method: "POST",
				signal: options.signal,
				headers: {
					authorization: `Bearer ${apiKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(createOpenAIRequestBody(context, options)),
			}),
		);
		if (!response.ok) {
			const text = yield* tryProfilePromise(() => response.text());
			return yield* Effect.fail(
				new Error(
					`OpenAI request failed: ${String(response.status)} ${text.slice(
						0,
						400,
					)}`,
				),
			);
		}
		const payload = (yield* tryProfilePromise(() => response.json())) as Record<
			string,
			unknown
		>;
		const rawText = extractResponseText(payload);
		if (!rawText) {
			return yield* Effect.fail(new Error("OpenAI returned no output text"));
		}
		const parsed = yield* tryProfileSync(() =>
			parseAnalysisFromHybridText(context, rawText),
		);
		const updatedAt = yield* tryProfileSync(() =>
			writeSyncCache(resultCacheKey(context, options), {
				analysis: parsed.analysis,
				markdown: parsed.markdown,
				model: modelFromOptions(options),
				reasoningEffort: reasoningEffortFromOptions(options),
				serviceTier: serviceTierFromOptions(options),
			}),
		);
		const result: ProfileAnalysisRunResult = {
			context,
			analysis: parsed.analysis,
			markdown: parsed.markdown,
			model: modelFromOptions(options),
			reasoningEffort: reasoningEffortFromOptions(options),
			serviceTier: serviceTierFromOptions(options),
			cached: false,
			updatedAt,
		};
		handlers.onDelta?.(result.markdown);
		handlers.onEvent?.({ type: "delta", delta: result.markdown });
		handlers.onEvent?.({ type: "done", result });
		return result;
	});
}

export function streamProfileAnalysis(
	options: ProfileAnalysisOptions,
	handlers: ProfileAnalysisStreamHandlers = {},
) {
	return runEffectPromise(streamProfileAnalysisEffect(options, handlers));
}

export const __test__ = {
	ProfileAnalysisSchema,
	buildPrompt,
	extractResponseText,
	parseAnalysisFromHybridText,
};
