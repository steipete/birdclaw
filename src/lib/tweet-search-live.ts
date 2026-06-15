import { Effect } from "effect";
import { searchTweetsViaBirdEffect } from "./bird";
import type { Database } from "./sqlite";
import { getNativeDb } from "./db";
import { runEffectPromise } from "./effect-runtime";
import {
	normalizeCacheTtlMs,
	resolveLiveSyncAccount,
	runCachedLiveSyncEffect,
} from "./live-sync-engine";
import type { XurlMentionsResponse, XurlTweetsResponse } from "./types";
import { ingestTweetPayload } from "./tweet-repository";
import { searchRecentTweetsEffect } from "./xurl";

export type TweetSearchMode = "auto" | "bird" | "xurl" | "local";

export interface SyncTweetSearchOptions {
	query: string;
	account?: string;
	mode?: TweetSearchMode;
	limit?: number;
	maxPages?: number;
	since?: string;
	until?: string;
	refresh?: boolean;
	cacheTtlMs?: number;
	timeoutMs?: number;
}

export type SyncTweetSearchResult =
	| {
			ok: true;
			source: "bird" | "xurl" | "bird+xurl" | "cache";
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

const DEFAULT_SEARCH_LIMIT = 20_000;
const DEFAULT_MAX_PAGES = 200;
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

function normalizeTime(value: string | undefined, optionName: string) {
	if (!value?.trim()) return undefined;
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) {
		throw new Error(`${optionName} must be a valid date`);
	}
	return date.toISOString();
}

function mergeTweetSearchIntoLocalStore(
	db: Database,
	accountId: string,
	payload: XurlMentionsResponse,
	source: "bird" | "xurl" | "cache",
) {
	return ingestTweetPayload(db, {
		accountId,
		payload,
		kind: "search",
		edgeKind: "search",
		source,
	});
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
	since,
	until,
}: {
	query: string;
	accountId: string;
	mode: Exclude<TweetSearchMode, "auto" | "local">;
	limit: number;
	maxPages: number;
	since?: string;
	until?: string;
}) {
	return `tweet-search:${mode}:${accountId}:${encodeURIComponent(query)}:${String(limit)}:${String(maxPages)}:${since ?? "no-since"}:${until ?? "no-until"}`;
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
	since,
	until,
}: {
	query: string;
	limit: number;
	maxPages: number;
	timeoutMs?: number;
	since?: string;
	until?: string;
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
				startTime: since,
				endTime: until,
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
		username: string;
		limit: number;
		maxPages: number;
		since?: string;
		until?: string;
		refresh: boolean;
		cacheTtlMs: number;
		timeoutMs?: number;
	},
): Effect.Effect<SyncTweetSearchResult, Error> {
	return Effect.gen(function* () {
		const db = getNativeDb();
		const key = cacheKey({ ...options, mode });
		const fetch =
			mode === "bird"
				? fetchBirdSearchEffect(options).pipe(Effect.mapError(toError))
				: fetchXurlSearchEffect(options);
		const syncResult = yield* runCachedLiveSyncEffect({
			db,
			cacheKey: key,
			refresh: options.refresh,
			cacheTtlMs: options.cacheTtlMs,
			transports: [
				{
					source: mode,
					fetch: fetch.pipe(
						Effect.map((response) => limitResponse(response, options.limit)),
					),
				},
			],
			persistLive: (writeDb, payload, source) =>
				mergeTweetSearchIntoLocalStore(
					writeDb,
					options.accountId,
					payload,
					source,
				),
			persistCached: (writeDb, payload) =>
				mergeTweetSearchIntoLocalStore(
					writeDb,
					options.accountId,
					payload,
					"cache",
				),
		});
		const { payload, source } = syncResult;
		const tweetIds = syncResult.persisted ?? [];

		return {
			ok: true,
			source,
			accountId: options.accountId,
			query: options.query,
			count: tweetIds.length,
			pageCount: Number(payload.meta?.page_count ?? 1),
			tweetIds,
		} as const;
	});
}

function combineTweetSearchResults(
	left: SyncTweetSearchResult,
	right: SyncTweetSearchResult,
	limit: number,
): SyncTweetSearchResult {
	if (left.ok && right.ok) {
		const tweetIds = [...new Set([...left.tweetIds, ...right.tweetIds])].slice(
			0,
			limit,
		);
		const liveSources = new Set(
			[left.source, right.source].filter((source) => source !== "cache"),
		);
		return {
			ok: true,
			source:
				liveSources.has("bird") && liveSources.has("xurl")
					? "bird+xurl"
					: liveSources.has("bird")
						? "bird"
						: liveSources.has("xurl")
							? "xurl"
							: "cache",
			accountId: left.accountId,
			query: left.query,
			count: tweetIds.length,
			pageCount: left.pageCount + right.pageCount,
			tweetIds,
		};
	}
	if (left.ok) return left;
	if (right.ok) return right;
	return {
		ok: false,
		source: "auto",
		accountId: left.accountId,
		query: left.query,
		error: `${left.error}; ${right.error}`,
	};
}

export function syncTweetSearchEffect({
	query,
	account,
	mode = "auto",
	limit,
	maxPages,
	since,
	until,
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
		const normalizedSince = yield* trySync(() =>
			normalizeTime(since, "--since"),
		);
		const normalizedUntil = yield* trySync(() =>
			normalizeTime(until, "--until"),
		);
		const ttlMs = normalizeCacheTtlMs(cacheTtlMs, DEFAULT_CACHE_TTL_MS);
		const db = getNativeDb();
		const resolvedAccount = yield* trySync(() =>
			resolveLiveSyncAccount(db, account),
		);
		const accountId = resolvedAccount.accountId;
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
			username: resolvedAccount.username,
			limit: normalizedLimit,
			maxPages: normalizedMaxPages,
			since: normalizedSince,
			until: normalizedUntil,
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

		if (normalizedSince || normalizedUntil) {
			return yield* runModeEffect("xurl", runOptions).pipe(
				Effect.catchAll((error) =>
					Effect.succeed({
						ok: false,
						source: "auto",
						accountId,
						query: normalizedQuery,
						error: error.message,
					} as const),
				),
			);
		}

		const birdResult = yield* runModeEffect("bird", runOptions).pipe(
			Effect.catchAll((error) =>
				Effect.succeed({
					ok: false,
					source: "bird",
					accountId,
					query: normalizedQuery,
					error: error.message,
				} as const),
			),
		);
		const xurlResult = yield* runModeEffect("xurl", runOptions).pipe(
			Effect.catchAll((error) =>
				Effect.succeed({
					ok: false,
					source: "xurl",
					accountId,
					query: normalizedQuery,
					error: error.message,
				} as const),
			),
		);
		return combineTweetSearchResults(birdResult, xurlResult, normalizedLimit);
	});
}

export function syncTweetSearch(options: SyncTweetSearchOptions) {
	return runEffectPromise(syncTweetSearchEffect(options));
}
