import type { Database } from "./sqlite";
import { Effect } from "effect";
import {
	listBookmarkedTweetsViaBirdEffect,
	listLikedTweetsViaBirdEffect,
} from "./bird";
import { verifyBirdAccountMatchesEffect } from "./bird-account";
import { getNativeDb } from "./db";
import { runEffectPromise, trySync } from "./effect-runtime";
import {
	createLiveTransportAdapter,
	parseLiveSyncMode,
	parseOptionalMaxPages,
	parseLivePageSize,
	resolveLiveSyncAccount,
	runCachedLiveSyncEffect,
	type LiveSyncMode,
} from "./live-sync-engine";
import { runSyncPlanEffect } from "./sync-plan";
import type { XurlMentionsResponse } from "./types";
import { ingestTweetPayload } from "./tweet-repository";
import { mergeTweetPages } from "./tweet-page";
import {
	listBookmarkedTweetsViaXurlEffect,
	listLikedTweetsViaXurlEffect,
	lookupUsersByHandlesEffect,
} from "./xurl";

import type { TimelineCollectionKind } from "./api-enums";
export type { TimelineCollectionKind } from "./api-enums";
export type TimelineCollectionMode = LiveSyncMode;
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

function readSaturatedAtPage(payload: XurlMentionsResponse) {
	const value = payload.meta?.saturated_at_page;
	return typeof value === "number" ? value : undefined;
}

function mergeTimelineCollectionIntoLocalStore(
	db: Database,
	accountId: string,
	kind: TimelineCollectionKind,
	payload: XurlMentionsResponse,
	collectionTweetIds: readonly string[],
	source: "xurl" | "bird",
) {
	ingestTweetPayload(db, {
		accountId,
		payload,
		collectionKind: kind,
		collectionTweetIds: new Set(collectionTweetIds),
		markRepliesAsReplied: true,
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
			const [accountUser] = yield* lookupUsersByHandlesEffect([username]);
			if (!accountUser?.id) {
				return yield* Effect.fail(
					new Error(`Could not resolve Twitter user id for @${username}`),
				);
			}
			resolvedUserId = String(accountUser.id);
		}

		let saturatedAtPage: number | undefined;
		const result = yield* runSyncPlanEffect({
			fetchPage: ({ cursor, pageIndex }) =>
				Effect.gen(function* () {
					const payload = yield* kind === "likes"
						? listLikedTweetsViaXurlEffect({
								maxResults: limit,
								username,
								userId: resolvedUserId,
								paginationToken: cursor,
							})
						: listBookmarkedTweetsViaXurlEffect({
								maxResults: limit,
								username,
								userId: resolvedUserId,
								isPaginatedWalk: all,
								paginationToken: cursor,
							});
					if (!earlyStop) {
						return {
							payload,
							collectionTweetIds: payload.data.map((tweet) => tweet.id),
							saturated: false,
						};
					}
					const tweetIds = payload.data.map((tweet) => tweet.id);
					const { existingTweetIds, uniqueTweetCount } = yield* trySync(() =>
						getCollectionPageDedupe(db, accountId, kind, tweetIds),
					);
					const saturated =
						tweetIds.length > 0 && existingTweetIds.size === uniqueTweetCount;
					if (saturated) saturatedAtPage = pageIndex + 1;
					return {
						payload,
						collectionTweetIds: tweetIds.filter(
							(tweetId) => !existingTweetIds.has(tweetId),
						),
						saturated,
					};
				}),
			getItemCount: (page) => page.payload.data.length,
			getNextCursor: (page) =>
				typeof page.payload.meta?.next_token === "string"
					? page.payload.meta.next_token
					: undefined,
			maxPages: all || earlyStop ? (maxPages ?? undefined) : 1,
			shouldStop: ({ page }) => page.saturated,
			onPage: ({ page, pageNumber }) => {
				if (page.saturated) {
					console.error(
						`${kind} saturated at page ${pageNumber} (100% existing rows)`,
					);
				}
			},
		});

		const merged = mergeTweetPages(result.pages.map((page) => page.payload));
		const eligibleIds = new Set(
			result.pages.flatMap((page) => page.collectionTweetIds),
		);
		const collectionTweetIds = merged.data
			.filter((tweet) => eligibleIds.has(tweet.id))
			.map((tweet) => tweet.id);
		const saturationMeta =
			saturatedAtPage === undefined
				? {}
				: { saturated_at_page: saturatedAtPage, next_token: null };
		merged.meta = {
			...merged.meta,
			...saturationMeta,
		};
		return {
			payload: merged,
			collectionTweetIds,
		};
	});
}

function fetchBirdCollectionEffect({
	account,
	kind,
	limit,
	all,
	maxPages,
}: {
	account: ReturnType<typeof resolveLiveSyncAccount>;
	kind: TimelineCollectionKind;
	limit: number;
	all: boolean;
	maxPages: number | null;
}) {
	return verifyBirdAccountMatchesEffect(account).pipe(
		Effect.flatMap(() =>
			kind === "likes"
				? listLikedTweetsViaBirdEffect({
						maxResults: limit,
						all,
						maxPages: maxPages ?? undefined,
					})
				: listBookmarkedTweetsViaBirdEffect({
						maxResults: limit,
						all,
						maxPages: maxPages ?? undefined,
					}),
		),
		Effect.map((payload) => ({
			payload,
			collectionTweetIds: payload.data.map((tweet) => tweet.id),
		})),
	);
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
		const parsedMode = yield* trySync(() => parseLiveSyncMode(mode, "auto"));
		yield* trySync(() => parseLivePageSize(limit));
		const parsedMaxPages =
			(yield* trySync(() => parseOptionalMaxPages(maxPages))) ?? null;
		const shouldApplyEarlyStopCap =
			earlyStop && !all && parsedMaxPages === null && parsedMode !== "bird";
		const xurlMaxPages = shouldApplyEarlyStopCap
			? DEFAULT_EARLY_STOP_MAX_PAGES
			: parsedMaxPages;
		if (parsedMode === "xurl" || parsedMode === "auto") {
			yield* trySync(() =>
				parseLivePageSize(limit, {
					min: MIN_XURL_LIMIT,
					max: MAX_XURL_LIMIT,
				}),
			);
		}

		const db = yield* trySync(() => getNativeDb());
		const resolvedAccount = yield* trySync(() =>
			resolveLiveSyncAccount(db, account),
		);
		const cacheMaxPages = parsedMode === "bird" ? parsedMaxPages : xurlMaxPages;
		const cacheKey = `timeline-collection:v2:${kind}:${parsedMode}:${resolvedAccount.accountId}:${String(limit)}:${all ? "all" : "single"}:${cacheMaxPages === null ? "all-pages" : String(cacheMaxPages)}${earlyStop ? ":early-stop" : ""}`;

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
			account: resolvedAccount,
			kind,
			limit,
			all,
			maxPages: parsedMaxPages,
		});
		const transports =
			parsedMode === "bird"
				? [createLiveTransportAdapter("bird", birdFetch)]
				: parsedMode === "xurl"
					? [createLiveTransportAdapter("xurl", xurlFetch)]
					: [
							createLiveTransportAdapter("xurl", xurlFetch),
							createLiveTransportAdapter("bird", birdFetch),
						];
		const syncResult = yield* runCachedLiveSyncEffect({
			db,
			cacheKey,
			refresh,
			cacheTtlMs,
			defaultCacheTtlMs: DEFAULT_COLLECTION_CACHE_TTL_MS,
			transports,
			persistLive: (writeDb, liveResult, liveSource) =>
				mergeTimelineCollectionIntoLocalStore(
					writeDb,
					resolvedAccount.accountId,
					kind,
					liveResult.payload,
					liveResult.collectionTweetIds,
					liveSource,
				),
		});
		const { source } = syncResult;
		const { payload, collectionTweetIds } = syncResult.payload;
		const saturatedAtPage = readSaturatedAtPage(payload);

		return {
			ok: true,
			source,
			kind,
			accountId: resolvedAccount.accountId,
			count: collectionTweetIds.length,
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
