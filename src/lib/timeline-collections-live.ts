import type { Database } from "./sqlite";
import { Effect } from "effect";
import {
	listBookmarkedTweetsViaBirdEffect,
	listLikedTweetsViaBirdEffect,
} from "./bird";
import { getNativeDb } from "./db";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import {
	createLiveTransportAdapter,
	normalizeCacheTtlMs,
	resolveLiveSyncAccount,
	runCachedLiveSyncEffect,
} from "./live-sync-engine";
import type {
	XurlMentionData,
	XurlMentionsResponse,
	XurlMediaItem,
	XurlMentionUser,
} from "./types";
import { ingestTweetPayload } from "./tweet-repository";
import {
	listBookmarkedTweetsViaXurl,
	listLikedTweetsViaXurl,
	lookupUsersByHandles,
} from "./xurl";

export type TimelineCollectionKind = "likes" | "bookmarks";
export type TimelineCollectionMode = "auto" | "xurl" | "bird";
export interface SyncTimelineCollectionOptions {
	kind: TimelineCollectionKind;
	account?: string;
	mode?: TimelineCollectionMode;
	limit?: number;
	all?: boolean;
	maxPages?: number;
	refresh?: boolean;
	cacheTtlMs?: number;
	earlyStop?: boolean;
}

const DEFAULT_COLLECTION_CACHE_TTL_MS = 2 * 60_000;
const DEFAULT_EARLY_STOP_MAX_PAGES = 10;
const MIN_XURL_LIMIT = 5;
const MAX_XURL_LIMIT = 100;

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function trySync<T>(try_: () => T) {
	return Effect.try({
		try: try_,
		catch: toError,
	});
}

function parseMaxPages(value?: number) {
	if (value === undefined) {
		return null;
	}
	if (!Number.isFinite(value) || value < 1) {
		throw new Error("--max-pages must be at least 1");
	}
	return Math.floor(value);
}

function assertLimit(limit: number) {
	if (!Number.isFinite(limit) || limit < 1) {
		throw new Error("--limit must be at least 1");
	}
}

function assertXurlLimit(limit: number) {
	if (limit < MIN_XURL_LIMIT || limit > MAX_XURL_LIMIT) {
		throw new Error("xurl mode requires --limit between 5 and 100");
	}
}

function mergePayloads(pages: XurlMentionsResponse[]): XurlMentionsResponse {
	const tweets: XurlMentionData[] = [];
	const seenTweetIds = new Set<string>();
	const users: XurlMentionUser[] = [];
	const seenUserIds = new Set<string>();
	const media: XurlMediaItem[] = [];
	const seenMediaKeys = new Set<string>();

	for (const page of pages) {
		for (const tweet of page.data) {
			if (seenTweetIds.has(tweet.id)) {
				continue;
			}
			seenTweetIds.add(tweet.id);
			tweets.push(tweet);
		}

		for (const user of page.includes?.users ?? []) {
			if (seenUserIds.has(user.id)) {
				continue;
			}
			seenUserIds.add(user.id);
			users.push(user);
		}

		for (const item of page.includes?.media ?? []) {
			if (seenMediaKeys.has(item.media_key)) {
				continue;
			}
			seenMediaKeys.add(item.media_key);
			media.push(item);
		}
	}

	const lastPage = pages.at(-1);
	const includes = {
		...(users.length > 0 ? { users } : {}),
		...(media.length > 0 ? { media } : {}),
	};
	return {
		data: tweets,
		includes: users.length > 0 || media.length > 0 ? includes : undefined,
		meta: {
			result_count: tweets.length,
			page_count: pages.length,
			next_token: lastPage?.meta?.next_token ?? null,
			...(tweets[0] ? { newest_id: tweets[0].id } : {}),
			...(tweets.at(-1) ? { oldest_id: tweets.at(-1)?.id } : {}),
		},
	};
}

function getCollectionPageDedupe(
	db: Database,
	accountId: string,
	kind: TimelineCollectionKind,
	tweetIds: string[],
) {
	const uniqueTweetIds = [...new Set(tweetIds)];
	if (uniqueTweetIds.length === 0) {
		return { existingTweetIds: new Set<string>(), uniqueTweetCount: 0 };
	}

	const rows = db
		.prepare(
			`
      select tweet_id
      from tweet_collections
      where account_id = ?
        and kind = ?
        and tweet_id in (${uniqueTweetIds.map(() => "?").join(", ")})
      `,
		)
		.all(accountId, kind, ...uniqueTweetIds) as { tweet_id: string }[];
	return {
		existingTweetIds: new Set(rows.map((row) => row.tweet_id)),
		uniqueTweetCount: uniqueTweetIds.length,
	};
}

function filterExistingCollectionTweets(
	payload: XurlMentionsResponse,
	existingTweetIds: Set<string>,
) {
	if (existingTweetIds.size === 0) {
		return payload;
	}
	return {
		...payload,
		data: payload.data.filter((tweet) => !existingTweetIds.has(tweet.id)),
	};
}

function readSaturatedAtPage(payload: XurlMentionsResponse) {
	const value = payload.meta?.saturated_at_page;
	return typeof value === "number" ? value : undefined;
}

function mergeTimelineCollectionIntoLocalStore(
	db: Database,
	accountId: string,
	kind: TimelineCollectionKind,
	payload: XurlMentionsResponse,
	source: "xurl" | "bird",
) {
	const tweetKind = kind === "likes" ? "like" : "bookmark";
	ingestTweetPayload(db, {
		accountId,
		payload,
		kind: tweetKind,
		collectionKind: kind,
		markRepliesAsReplied: true,
		replaceSecondaryKind: true,
		source,
	});
}

function fetchXurlCollectionEffect({
	db,
	kind,
	accountId,
	username,
	userId,
	limit,
	all,
	maxPages,
	earlyStop,
}: {
	db: Database;
	kind: TimelineCollectionKind;
	accountId: string;
	username: string;
	userId?: string;
	limit: number;
	all: boolean;
	maxPages: number | null;
	earlyStop: boolean;
}) {
	return Effect.gen(function* () {
		let resolvedUserId = userId;
		if (!resolvedUserId) {
			const [accountUser] = yield* tryPromise(() =>
				lookupUsersByHandles([username]),
			);
			if (!accountUser?.id) {
				return yield* Effect.fail(
					new Error(`Could not resolve Twitter user id for @${username}`),
				);
			}
			resolvedUserId = String(accountUser.id);
		}

		const pages: XurlMentionsResponse[] = [];
		let nextToken: string | undefined;
		let pageCount = 0;
		let saturatedAtPage: number | undefined;
		do {
			const payload = yield* tryPromise(() =>
				kind === "likes"
					? listLikedTweetsViaXurl({
							maxResults: limit,
							username,
							userId: resolvedUserId,
							paginationToken: nextToken,
						})
					: listBookmarkedTweetsViaXurl({
							maxResults: limit,
							username,
							userId: resolvedUserId,
							isPaginatedWalk: all,
							paginationToken: nextToken,
						}),
			);
			pageCount += 1;
			if (earlyStop) {
				const tweetIds = payload.data.map((tweet) => tweet.id);
				const { existingTweetIds, uniqueTweetCount } = yield* trySync(() =>
					getCollectionPageDedupe(db, accountId, kind, tweetIds),
				);
				if (tweetIds.length > 0 && existingTweetIds.size === uniqueTweetCount) {
					saturatedAtPage = pageCount;
					console.error(
						`${kind} saturated at page ${pageCount} (100% existing rows)`,
					);
					break;
				}
				pages.push(filterExistingCollectionTweets(payload, existingTweetIds));
			} else {
				pages.push(payload);
			}
			nextToken =
				typeof payload.meta?.next_token === "string"
					? payload.meta.next_token
					: undefined;
		} while (
			(all || earlyStop) &&
			nextToken &&
			(maxPages === null || pageCount < maxPages)
		);

		const merged = mergePayloads(pages);
		// A saturated page may expose another token, but our walk is complete.
		const saturationMeta =
			saturatedAtPage === undefined
				? {}
				: { saturated_at_page: saturatedAtPage, next_token: null };
		merged.meta = {
			...merged.meta,
			page_count: pageCount,
			...saturationMeta,
		};
		return merged;
	});
}

function fetchBirdCollectionEffect({
	kind,
	limit,
	all,
	maxPages,
}: {
	kind: TimelineCollectionKind;
	limit: number;
	all: boolean;
	maxPages: number | null;
}) {
	return kind === "likes"
		? listLikedTweetsViaBirdEffect({
				maxResults: limit,
				all,
				maxPages: maxPages ?? undefined,
			})
		: listBookmarkedTweetsViaBirdEffect({
				maxResults: limit,
				all,
				maxPages: maxPages ?? undefined,
			});
}

export function syncTimelineCollectionEffect({
	kind,
	account,
	mode = "auto",
	limit = 20,
	all = false,
	maxPages,
	refresh = false,
	cacheTtlMs,
	earlyStop = false,
}: SyncTimelineCollectionOptions) {
	return Effect.gen(function* () {
		yield* trySync(() => assertLimit(limit));
		const parsedMaxPages = yield* trySync(() => parseMaxPages(maxPages));
		const shouldApplyEarlyStopCap =
			earlyStop && !all && parsedMaxPages === null && mode !== "bird";
		const xurlMaxPages = shouldApplyEarlyStopCap
			? DEFAULT_EARLY_STOP_MAX_PAGES
			: parsedMaxPages;
		if (mode === "xurl" || mode === "auto") {
			yield* trySync(() => assertXurlLimit(limit));
		}

		const db = yield* trySync(() => getNativeDb());
		const resolvedAccount = yield* trySync(() =>
			resolveLiveSyncAccount(db, account),
		);
		const cacheMaxPages = mode === "bird" ? parsedMaxPages : xurlMaxPages;
		const cacheKey = `${kind}:${mode}:${resolvedAccount.accountId}:${String(limit)}:${all ? "all" : "single"}:${cacheMaxPages === null ? "all-pages" : String(cacheMaxPages)}${earlyStop ? ":early-stop" : ""}`;

		if (shouldApplyEarlyStopCap) {
			console.error(
				`${kind} early-stop capped at ${DEFAULT_EARLY_STOP_MAX_PAGES} pages by default; pass --max-pages or --all to override`,
			);
		}

		const xurlFetch = fetchXurlCollectionEffect({
			db,
			kind,
			accountId: resolvedAccount.accountId,
			username: resolvedAccount.username,
			userId: resolvedAccount.externalUserId,
			limit,
			all,
			maxPages: xurlMaxPages,
			earlyStop,
		});
		const birdFetch = fetchBirdCollectionEffect({
			kind,
			limit,
			all,
			maxPages: parsedMaxPages,
		});
		const transports =
			mode === "bird"
				? [createLiveTransportAdapter("bird", birdFetch)]
				: mode === "xurl"
					? [createLiveTransportAdapter("xurl", xurlFetch)]
					: [
							createLiveTransportAdapter("xurl", xurlFetch),
							createLiveTransportAdapter("bird", birdFetch),
						];
		const syncResult = yield* runCachedLiveSyncEffect({
			db,
			cacheKey,
			refresh,
			cacheTtlMs: normalizeCacheTtlMs(
				cacheTtlMs,
				DEFAULT_COLLECTION_CACHE_TTL_MS,
			),
			transports,
			persistLive: (writeDb, livePayload, liveSource) =>
				mergeTimelineCollectionIntoLocalStore(
					writeDb,
					resolvedAccount.accountId,
					kind,
					livePayload,
					liveSource,
				),
		});
		const { source, payload } = syncResult;
		const saturatedAtPage = readSaturatedAtPage(payload);

		return {
			ok: true,
			source,
			kind,
			accountId: resolvedAccount.accountId,
			count: payload.data.length,
			payload,
			...(saturatedAtPage === undefined
				? {}
				: { saturated_at_page: saturatedAtPage }),
		};
	});
}

export function syncTimelineCollection(options: SyncTimelineCollectionOptions) {
	return runEffectPromise(syncTimelineCollectionEffect(options));
}
