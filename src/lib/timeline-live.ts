import { Effect } from "effect";
import type { Database } from "./sqlite";
import { listHomeTimelineViaBirdEffect } from "./bird";
import { verifyBirdAccountMatchesEffect } from "./bird-account";
import { getNativeDb } from "./db";
import { runEffectPromise } from "./effect-runtime";
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
import { listHomeTimelineViaXurlEffect } from "./xurl";

const DEFAULT_TIMELINE_CACHE_TTL_MS = 2 * 60_000;
const MAX_XURL_TIMELINE_PAGE_SIZE = 100;

export type HomeTimelineMode = LiveSyncMode;
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
	onProgress?: (progress: HomeTimelineProgress) => void;
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
		const parsedMode = parseLiveSyncMode(mode, "bird");
		if (limit !== undefined) parseLivePageSize(limit);
		const requestedMaxPages = parseOptionalMaxPages(maxPages);
		const finiteFallbackLimit = limit ?? (parsedStartTime ? 300 : 100);
		const effectiveLimit =
			limit ??
			(parsedStartTime && (parsedMode === "xurl" || parsedMode === "auto")
				? Infinity
				: finiteFallbackLimit);
		const parsedMaxPages =
			maxPages === undefined && parsedStartTime
				? Infinity
				: (requestedMaxPages ?? 1);
		const db = getNativeDb();
		const resolvedAccount = resolveLiveSyncAccount(db, account);
		const accountId = resolvedAccount.accountId;
		const effectiveMode =
			parsedMode === "auto" &&
			account !== undefined &&
			!resolvedAccount.isDefault
				? "xurl"
				: parsedMode;
		const cacheKey = `timeline:${effectiveMode}:${accountId}:${following ? "following" : "for-you"}:${Number.isFinite(effectiveLimit) ? String(effectiveLimit) : "all"}:${Number.isFinite(parsedMaxPages) ? String(parsedMaxPages) : "all-pages"}:${parsedStartTime?.iso ?? "no-start"}`;
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
					return listHomeTimelineViaXurlEffect({
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
			return mergeTweetPages(result.pages, { itemLimit: effectiveLimit });
		});
		const fetchViaBird = verifyBirdAccountMatchesEffect(resolvedAccount).pipe(
			Effect.flatMap(() =>
				listHomeTimelineViaBirdEffect({
					maxResults: finiteFallbackLimit,
					following,
				}),
			),
		);
		const transports =
			effectiveMode === "xurl"
				? [createLiveTransportAdapter("xurl", fetchViaXurl)]
				: effectiveMode === "bird"
					? [createLiveTransportAdapter("bird", fetchViaBird)]
					: [
							createLiveTransportAdapter("xurl", fetchViaXurl),
							createLiveTransportAdapter("bird", fetchViaBird),
						];
		const syncResult = yield* runCachedLiveSyncEffect({
			db,
			cacheKey,
			refresh,
			cacheTtlMs,
			defaultCacheTtlMs: DEFAULT_TIMELINE_CACHE_TTL_MS,
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
		if (source === "bird") {
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
