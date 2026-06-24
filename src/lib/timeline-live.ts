import { Effect } from "effect";
import type { Database } from "./sqlite";
import { getNativeDb } from "./db";
import { runEffectPromise } from "./effect-runtime";
import { liveTransportGateway } from "./live-transport-gateway";
import {
	assertLiveAccountMatches,
	createLiveTransportAdapter,
	type LiveSyncAccount,
	normalizeCacheTtlMs,
	resolveLiveSyncAccount,
	runCachedLiveSyncEffect,
} from "./live-sync-engine";
import { runSyncPlanEffect } from "./sync-plan";
import type {
	XurlMediaItem,
	XurlMentionUser,
	XurlMentionsResponse,
} from "./types";
import { ingestTweetPayload } from "./tweet-repository";

const DEFAULT_TIMELINE_CACHE_TTL_MS = 2 * 60_000;
const MAX_XURL_TIMELINE_PAGE_SIZE = 100;

export type HomeTimelineMode = "bird" | "xurl" | "auto";
export interface HomeTimelineProgress {
	source: "bird" | "xurl" | "cache";
	fetched: number;
	total?: number;
	page?: number;
	maxPages?: number;
	pageSize?: number;
	done: boolean;
}
export interface SyncHomeTimelineOptions {
	account?: string;
	mode?: HomeTimelineMode;
	limit?: number;
	maxPages?: number;
	startTime?: string;
	following?: boolean;
	refresh?: boolean;
	cacheTtlMs?: number;
	timeoutMs?: number;
	earlyStop?: boolean;
	onProgress?: (progress: HomeTimelineProgress) => void;
}

function assertLimit(limit: number) {
	if ((!Number.isFinite(limit) && limit !== Infinity) || limit < 1) {
		throw new Error("--limit must be at least 1");
	}
}

function parseMode(mode: HomeTimelineMode | undefined) {
	const parsed = mode ?? "bird";
	if (parsed !== "bird" && parsed !== "xurl" && parsed !== "auto") {
		throw new Error("--mode must be bird, xurl, or auto");
	}
	return parsed;
}

function parseMaxPages(maxPages: number | undefined) {
	if (maxPages === undefined) return 1;
	if (!Number.isFinite(maxPages) || maxPages < 1) {
		throw new Error("--max-pages must be at least 1");
	}
	return Math.floor(maxPages);
}

function parseStartTime(value: string | undefined) {
	if (!value?.trim()) return undefined;
	const time = new Date(value).getTime();
	if (!Number.isFinite(time)) {
		throw new Error("--start-time must be a valid date");
	}
	return { iso: new Date(time).toISOString(), time };
}

function reachedStartTimeBoundary(
	payload: XurlMentionsResponse,
	startTimeMs: number | undefined,
) {
	if (startTimeMs === undefined) return false;
	return payload.data.some((tweet) => {
		const createdAt = new Date(tweet.created_at).getTime();
		return Number.isFinite(createdAt) && createdAt <= startTimeMs;
	});
}

function mergeTimelinePayloads(
	payloads: XurlMentionsResponse[],
	limit: number,
) {
	const data: XurlMentionsResponse["data"] = [];
	const usersById = new Map<string, XurlMentionUser>();
	const mediaByKey = new Map<string, XurlMediaItem>();
	let meta: XurlMentionsResponse["meta"] | undefined;

	for (const payload of payloads) {
		meta = payload.meta;
		for (const tweet of payload.data) {
			if (data.some((existing) => existing.id === tweet.id)) continue;
			data.push(tweet);
			if (data.length >= limit) break;
		}
		for (const user of payload.includes?.users ?? []) {
			usersById.set(user.id, user);
		}
		for (const media of payload.includes?.media ?? []) {
			mediaByKey.set(media.media_key, media);
		}
		if (data.length >= limit) break;
	}

	return {
		data,
		includes: {
			users: [...usersById.values()],
			media: [...mediaByKey.values()],
		},
		meta,
	} satisfies XurlMentionsResponse;
}

function mergeHomeTimelineIntoLocalStore(
	db: Database,
	accountId: string,
	payload: XurlMentionsResponse,
	source: "bird" | "xurl",
) {
	ingestTweetPayload(db, {
		accountId,
		payload,
		edgeKind: "home",
		source,
	});
}

function getHomePageExistingTweetIds(
	db: Database,
	accountId: string,
	tweetIds: string[],
) {
	const uniqueTweetIds = [...new Set(tweetIds)];
	if (uniqueTweetIds.length === 0) return new Set<string>();
	const rows = db
		.prepare(
			`
      select tweet_id
      from tweet_account_edges
      where account_id = ?
        and kind = 'home'
        and tweet_id in (${uniqueTweetIds.map(() => "?").join(", ")})
      `,
		)
		.all(accountId, ...uniqueTweetIds) as { tweet_id: string }[];
	return new Set(rows.map((row) => row.tweet_id));
}

function filterExistingTimelineTweets(
	payload: XurlMentionsResponse,
	existingTweetIds: Set<string>,
) {
	if (existingTweetIds.size === 0) return payload;
	return {
		...payload,
		data: payload.data.filter((tweet) => !existingTweetIds.has(tweet.id)),
	};
}

function verifyBirdTimelineAccountEffect(account: LiveSyncAccount) {
	return Effect.gen(function* () {
		const profileName = account.birdProfileName;
		if (!profileName) {
			return yield* Effect.fail(
				new Error("bird_profile_name is required to use bird"),
			);
		}
		const authenticated =
			yield* liveTransportGateway.bird.getAuthenticatedAccount(profileName);
		yield* Effect.try({
			try: () =>
				assertLiveAccountMatches({
					source: "bird",
					account,
					liveUsername: authenticated.username,
					liveExternalUserId: authenticated.id,
				}),
			catch: (error) =>
				error instanceof Error ? error : new Error(String(error)),
		});
		return profileName;
	});
}

export function syncHomeTimelineEffect({
	account,
	mode,
	limit,
	maxPages,
	startTime,
	following = true,
	refresh = false,
	cacheTtlMs,
	timeoutMs,
	earlyStop = false,
	onProgress,
}: SyncHomeTimelineOptions = {}): Effect.Effect<
	{
		ok: true;
		source: "bird" | "xurl" | "cache";
		kind: "timeline";
		accountId: string;
		feed: "following" | "for-you";
		count: number;
		payload: XurlMentionsResponse;
	},
	unknown
> {
	return Effect.gen(function* () {
		const parsedStartTime = yield* Effect.try({
			try: () => parseStartTime(startTime),
			catch: (error) => error,
		});
		const parsedMode = parseMode(mode);
		if (parsedStartTime && parsedMode !== "xurl") {
			return yield* Effect.fail(
				new Error(
					"bird home timeline mode does not support --start-time; use --mode xurl",
				),
			);
		}
		const finiteFallbackLimit = limit ?? (parsedStartTime ? 300 : 100);
		const effectiveLimit =
			limit ?? (parsedStartTime ? Infinity : finiteFallbackLimit);
		assertLimit(effectiveLimit);
		const parsedMaxPages =
			maxPages === undefined && parsedStartTime
				? Infinity
				: parseMaxPages(maxPages);
		const db = getNativeDb();
		const resolvedAccount = resolveLiveSyncAccount(db, account);
		const accountId = resolvedAccount.accountId;
		const effectiveMode = parsedMode === "auto" ? "bird" : parsedMode;
		const useBirdEarlyStop =
			effectiveMode === "bird" && earlyStop && following && !parsedStartTime;
		const cacheKey = `timeline:${effectiveMode}:${accountId}:${following ? "following" : "for-you"}:${Number.isFinite(effectiveLimit) ? String(effectiveLimit) : "all"}:${Number.isFinite(parsedMaxPages) ? String(parsedMaxPages) : "all-pages"}:${parsedStartTime?.iso ?? "no-start"}${useBirdEarlyStop ? ":early-stop" : ""}`;
		const fetchViaXurl = Effect.gen(function* () {
			if (!following) {
				return yield* Effect.fail(
					new Error("xurl home timeline mode does not support --for-you"),
				);
			}
			const pageSizes = new Map<number, number>();
			const result = yield* runSyncPlanEffect({
				fetchPage: ({ cursor, fetched, pageIndex }) => {
					const remaining = Number.isFinite(effectiveLimit)
						? Math.max(1, effectiveLimit - fetched)
						: Infinity;
					const pageSize = Math.min(
						MAX_XURL_TIMELINE_PAGE_SIZE,
						Math.max(5, remaining),
					);
					pageSizes.set(pageIndex, pageSize);
					return liveTransportGateway.xurl.listHomeTimeline({
						maxResults: pageSize,
						userId: resolvedAccount.externalUserId,
						username: resolvedAccount.username,
						...(cursor ? { paginationToken: cursor } : {}),
						timeoutMs,
					});
				},
				getItemCount: (page) => page.data.length,
				getNextCursor: (page) =>
					typeof page.meta?.next_token === "string"
						? page.meta.next_token
						: undefined,
				maxItems: effectiveLimit,
				maxPages: parsedMaxPages,
				shouldStop: ({ page }) =>
					reachedStartTimeBoundary(page, parsedStartTime?.time),
				onPage: ({ fetched, pageIndex, pageNumber, done }) =>
					onProgress?.({
						source: "xurl",
						fetched,
						total: Number.isFinite(effectiveLimit) ? effectiveLimit : undefined,
						page: pageNumber,
						maxPages: Number.isFinite(parsedMaxPages)
							? parsedMaxPages
							: undefined,
						pageSize: pageSizes.get(pageIndex),
						done,
					}),
			});
			return mergeTimelinePayloads(result.pages, effectiveLimit);
		});
		const fetchViaBird = useBirdEarlyStop
			? Effect.gen(function* () {
					const profileName =
						yield* verifyBirdTimelineAccountEffect(resolvedAccount);
					const result = yield* runSyncPlanEffect({
						fetchPage: ({ cursor }) =>
							liveTransportGateway.bird
								.listHomeTimeline({
									maxResults: finiteFallbackLimit,
									following,
									all: true,
									maxPages: 1,
									...(cursor ? { cursor } : {}),
									profileName,
								})
								.pipe(
									Effect.map((payload) => {
										const existingTweetIds = getHomePageExistingTweetIds(
											db,
											accountId,
											payload.data.map((tweet) => tweet.id),
										);
										return {
											payload,
											persistedPayload: filterExistingTimelineTweets(
												payload,
												existingTweetIds,
											),
											boundary: existingTweetIds.size > 0,
										};
									}),
								),
						getItemCount: (page) => page.payload.data.length,
						getNextCursor: (page) =>
							typeof page.payload.meta?.next_token === "string"
								? page.payload.meta.next_token
								: undefined,
						maxPages: parsedMaxPages,
						shouldStop: ({ page }) => page.boundary,
						onPage: ({ fetched, pageNumber, done }) =>
							onProgress?.({
								source: "bird",
								fetched,
								total: finiteFallbackLimit,
								page: pageNumber,
								maxPages: parsedMaxPages,
								done,
							}),
					});
					return mergeTimelinePayloads(
						result.pages.map((page) => page.persistedPayload),
						finiteFallbackLimit,
					);
				})
			: Effect.gen(function* () {
					const profileName =
						yield* verifyBirdTimelineAccountEffect(resolvedAccount);
					return yield* liveTransportGateway.bird.listHomeTimeline({
						maxResults: finiteFallbackLimit,
						following,
						profileName,
					});
				});
		const transports =
			effectiveMode === "xurl"
				? [createLiveTransportAdapter("xurl", fetchViaXurl)]
				: [createLiveTransportAdapter("bird", fetchViaBird)];
		const syncResult = yield* runCachedLiveSyncEffect({
			db,
			cacheKey,
			refresh,
			cacheTtlMs: normalizeCacheTtlMs(
				cacheTtlMs,
				DEFAULT_TIMELINE_CACHE_TTL_MS,
			),
			transports,
			persistLive: (writeDb, livePayload, liveSource) =>
				mergeHomeTimelineIntoLocalStore(
					writeDb,
					accountId,
					livePayload,
					liveSource,
				),
		});
		const { source, payload } = syncResult;
		if (source === "cache") {
			yield* Effect.sync(() =>
				onProgress?.({
					source: "cache",
					fetched: payload.data.length,
					total: Number.isFinite(effectiveLimit) ? effectiveLimit : undefined,
					done: true,
				}),
			);
		}
		if (source === "bird" && !useBirdEarlyStop) {
			yield* Effect.sync(() =>
				onProgress?.({
					source: "bird",
					fetched: payload.data.length,
					total: finiteFallbackLimit,
					done: true,
				}),
			);
		}
		return {
			ok: true,
			source,
			kind: "timeline",
			accountId,
			feed: following ? "following" : "for-you",
			count: payload.data.length,
			payload,
		} as const;
	});
}

export function syncHomeTimeline(options: SyncHomeTimelineOptions = {}) {
	return runEffectPromise(syncHomeTimelineEffect(options));
}
