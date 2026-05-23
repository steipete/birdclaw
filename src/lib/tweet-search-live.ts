import { Effect } from "effect";
import { searchTweetsViaBirdEffect } from "./bird";
import type { Database } from "./sqlite";
import { getNativeDb } from "./db";
import { runEffectPromise } from "./effect-runtime";
import { buildMediaJsonFromIncludes, countTweetMedia } from "./media-includes";
import { readSyncCache, writeSyncCache } from "./sync-cache";
import type { XurlMentionsResponse, XurlTweetsResponse } from "./types";
import { upsertTweetAccountEdge } from "./tweet-account-edges";
import { ensureStubProfileForXUser, upsertProfileFromXUser } from "./x-profile";
import { searchRecentTweetsEffect } from "./xurl";

export type TweetSearchMode = "auto" | "bird" | "xurl" | "local";

export interface SyncTweetSearchOptions {
	query: string;
	account?: string;
	mode?: TweetSearchMode;
	limit?: number;
	maxPages?: number;
	refresh?: boolean;
	cacheTtlMs?: number;
	timeoutMs?: number;
}

export type SyncTweetSearchResult =
	| {
			ok: true;
			source: "bird" | "xurl" | "cache";
			accountId: string;
			query: string;
			count: number;
			pageCount: number;
			tweetIds: string[];
	  }
	| {
			ok: false;
			source: "bird" | "xurl" | "auto";
			accountId: string;
			query: string;
			error: string;
	  };

const DEFAULT_SEARCH_LIMIT = 500;
const DEFAULT_MAX_PAGES = 5;
const DEFAULT_CACHE_TTL_MS = 2 * 60_000;
const XURL_PAGE_SIZE = 100;

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function trySync<T>(try_: () => T) {
	return Effect.try({
		try: try_,
		catch: toError,
	});
}

function normalizeLimit(limit: number | undefined) {
	if (limit === undefined) return DEFAULT_SEARCH_LIMIT;
	if (!Number.isFinite(limit) || limit < 1) {
		throw new Error("--limit must be at least 1");
	}
	return Math.floor(limit);
}

function normalizeMaxPages(maxPages: number | undefined) {
	if (maxPages === undefined) return DEFAULT_MAX_PAGES;
	if (!Number.isFinite(maxPages) || maxPages < 1) {
		throw new Error("--max-pages must be at least 1");
	}
	return Math.floor(maxPages);
}

function normalizeCacheTtlMs(value: number | undefined) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return DEFAULT_CACHE_TTL_MS;
	}
	return Math.floor(value);
}

function resolveAccount(db: Database, accountId?: string) {
	const row = accountId
		? (db.prepare("select id from accounts where id = ?").get(accountId) as
				| { id: string }
				| undefined)
		: (db
				.prepare(
					`
          select id
          from accounts
          order by is_default desc, created_at asc
          limit 1
          `,
				)
				.get() as { id: string } | undefined);

	if (!row) {
		throw new Error(`Unknown account: ${accountId ?? "default"}`);
	}

	return row.id;
}

function replaceTweetFts(db: Database, tweetId: string, text: string) {
	db.prepare("delete from tweets_fts where tweet_id = ?").run(tweetId);
	db.prepare("insert into tweets_fts (tweet_id, text) values (?, ?)").run(
		tweetId,
		text,
	);
}

function mergeTweetSearchIntoLocalStore(
	db: Database,
	accountId: string,
	payload: XurlMentionsResponse,
	source: "bird" | "xurl" | "cache",
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
    ) values (?, ?, ?, 'search', ?, ?, 0, ?, ?, ?, 0, 0, ?, ?, ?)
    on conflict(id) do update set
      account_id = tweets.account_id,
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
	const tweetIds: string[] = [];

	db.transaction(() => {
		const seenAt = new Date().toISOString();
		for (const tweet of payload.data) {
			const author =
				usersById.get(tweet.author_id) ??
				({
					id: tweet.author_id,
					username: `user_${tweet.author_id}`,
					name: `user_${tweet.author_id}`,
				} as const);
			const profile = usersById.has(tweet.author_id)
				? upsertProfileFromXUser(db, author)
				: ensureStubProfileForXUser(db, tweet.author_id);
			const replyToId =
				tweet.referenced_tweets?.find((item) => item.type === "replied_to")
					?.id ?? null;
			const quotedTweetId =
				tweet.referenced_tweets?.find((item) => item.type === "quoted")?.id ??
				null;
			upsertTweet.run(
				tweet.id,
				accountId,
				profile.profile.id,
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
				kind: "search",
				source,
				seenAt,
				rawJson: JSON.stringify(tweet),
			});
			replaceTweetFts(db, tweet.id, tweet.text);
			tweetIds.push(tweet.id);
		}
	})();

	return tweetIds;
}

function toMentionsResponse(payload: XurlTweetsResponse): XurlMentionsResponse {
	return {
		data: payload.data,
		includes: payload.includes,
		meta: payload.meta,
	};
}

function mergeResponses(
	responses: XurlMentionsResponse[],
): XurlMentionsResponse {
	const seenTweetIds = new Set<string>();
	const data = [];
	const usersById = new Map();
	const mediaByKey = new Map();
	let pageCount = 0;

	for (const response of responses) {
		pageCount += Number(response.meta?.page_count ?? 1);
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
		meta: {
			result_count: data.length,
			page_count: pageCount,
		},
	};
}

function limitResponse(
	response: XurlMentionsResponse,
	limit: number,
): XurlMentionsResponse {
	if (response.data.length <= limit) {
		return response;
	}
	return {
		...response,
		data: response.data.slice(0, limit),
		meta: {
			...response.meta,
			result_count: limit,
		},
	};
}

function cacheKey({
	query,
	accountId,
	mode,
	limit,
	maxPages,
}: {
	query: string;
	accountId: string;
	mode: Exclude<TweetSearchMode, "auto" | "local">;
	limit: number;
	maxPages: number;
}) {
	return `tweet-search:${mode}:${accountId}:${encodeURIComponent(query)}:${String(limit)}:${String(maxPages)}`;
}

function fetchBirdSearchEffect({
	query,
	limit,
	maxPages,
}: {
	query: string;
	limit: number;
	maxPages: number;
}) {
	return searchTweetsViaBirdEffect(query, {
		maxResults: Math.min(limit, XURL_PAGE_SIZE),
		all: maxPages > 1 || limit > XURL_PAGE_SIZE,
		maxPages,
	});
}

function fetchXurlSearchEffect({
	query,
	limit,
	maxPages,
	timeoutMs,
}: {
	query: string;
	limit: number;
	maxPages: number;
	timeoutMs?: number;
}): Effect.Effect<XurlMentionsResponse, Error> {
	return Effect.gen(function* () {
		const responses: XurlMentionsResponse[] = [];
		let nextToken: string | undefined;
		for (let page = 0; page < maxPages; page += 1) {
			const remaining =
				limit -
				responses.reduce((total, response) => total + response.data.length, 0);
			if (remaining <= 0) break;
			const response = yield* searchRecentTweetsEffect(query, {
				maxResults: Math.max(10, Math.min(XURL_PAGE_SIZE, remaining)),
				paginationToken: nextToken,
				timeoutMs,
			});
			responses.push(toMentionsResponse(response));
			nextToken =
				typeof response.meta?.next_token === "string"
					? String(response.meta.next_token)
					: undefined;
			if (!nextToken) break;
		}
		return mergeResponses(responses);
	});
}

function runModeEffect(
	mode: Exclude<TweetSearchMode, "auto" | "local">,
	options: {
		query: string;
		accountId: string;
		limit: number;
		maxPages: number;
		refresh: boolean;
		cacheTtlMs: number;
		timeoutMs?: number;
	},
): Effect.Effect<SyncTweetSearchResult, Error> {
	return Effect.gen(function* () {
		const db = getNativeDb();
		const key = cacheKey({ ...options, mode });
		const cached = yield* trySync(() =>
			readSyncCache<XurlMentionsResponse>(key, db),
		);
		const ageMs = cached
			? Date.now() - new Date(cached.updatedAt).getTime()
			: Number.POSITIVE_INFINITY;
		const payload =
			!options.refresh && cached && ageMs <= options.cacheTtlMs
				? cached.value
				: yield* (
						mode === "bird"
							? fetchBirdSearchEffect(options).pipe(Effect.mapError(toError))
							: fetchXurlSearchEffect(options)
					).pipe(
						Effect.map((response) => limitResponse(response, options.limit)),
					);
		if (!cached || options.refresh || ageMs > options.cacheTtlMs) {
			yield* trySync(() => writeSyncCache(key, payload, db));
		}
		const tweetIds = yield* trySync(() =>
			mergeTweetSearchIntoLocalStore(
				db,
				options.accountId,
				payload,
				!options.refresh && cached && ageMs <= options.cacheTtlMs
					? "cache"
					: mode,
			),
		);

		return {
			ok: true,
			source:
				!options.refresh && cached && ageMs <= options.cacheTtlMs
					? "cache"
					: mode,
			accountId: options.accountId,
			query: options.query,
			count: tweetIds.length,
			pageCount: Number(payload.meta?.page_count ?? 1),
			tweetIds,
		} as const;
	});
}

export function syncTweetSearchEffect({
	query,
	account,
	mode = "auto",
	limit,
	maxPages,
	refresh = false,
	cacheTtlMs,
	timeoutMs,
}: SyncTweetSearchOptions): Effect.Effect<SyncTweetSearchResult, Error> {
	return Effect.gen(function* () {
		const normalizedQuery = query.trim();
		if (!normalizedQuery) {
			return yield* Effect.fail(new Error("Search query is required"));
		}
		const normalizedLimit = normalizeLimit(limit);
		const normalizedMaxPages = normalizeMaxPages(maxPages);
		const ttlMs = normalizeCacheTtlMs(cacheTtlMs);
		const db = getNativeDb();
		const accountId = yield* trySync(() => resolveAccount(db, account));
		if (mode === "local") {
			return {
				ok: true,
				source: "cache",
				accountId,
				query: normalizedQuery,
				count: 0,
				pageCount: 0,
				tweetIds: [],
			} as const;
		}

		const runOptions = {
			query: normalizedQuery,
			accountId,
			limit: normalizedLimit,
			maxPages: normalizedMaxPages,
			refresh,
			cacheTtlMs: ttlMs,
			timeoutMs,
		};
		if (mode === "bird" || mode === "xurl") {
			return yield* runModeEffect(mode, runOptions).pipe(
				Effect.catchAll((error) =>
					Effect.succeed({
						ok: false,
						source: mode,
						accountId,
						query: normalizedQuery,
						error: error.message,
					} as const),
				),
			);
		}

		const birdResult = yield* runModeEffect("bird", runOptions).pipe(
			Effect.either,
		);
		if (birdResult._tag === "Right") {
			return birdResult.right;
		}
		return yield* runModeEffect("xurl", runOptions).pipe(
			Effect.catchAll((error) =>
				Effect.succeed({
					ok: false,
					source: "auto",
					accountId,
					query: normalizedQuery,
					error: `${birdResult.left.message}; ${error.message}`,
				} as const),
			),
		);
	});
}

export function syncTweetSearch(options: SyncTweetSearchOptions) {
	return runEffectPromise(syncTweetSearchEffect(options));
}
