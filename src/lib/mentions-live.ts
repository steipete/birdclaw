import type { Database } from "./sqlite";
import {
	getMentionCursorKey,
	getMentionResultCacheKey,
	getMentionCursorBoundary,
	getMentionRequestBoundary,
	maxNumericTweetId,
	getNewestMentionId,
	addMentionCursorState,
	readMentionHighWaterId,
	writeMentionHighWaterId,
	findNewestMentionId,
	selectMentionScan,
	type MentionScanShape,
	type MentionSyncIntent,
} from "./mentions-cursor";
import { Effect } from "effect";
import { listMentionsViaBirdEffect } from "./bird";
import { verifyBirdAccountMatchesEffect } from "./bird-account";
import type { MentionsDataSource } from "./config";
import { databaseWriteEffect } from "./database-writer";
import { getNativeDb } from "./db";
import { runEffectPromise, trySync } from "./effect-runtime";
import {
	parseLiveSyncMode,
	parseOptionalMaxPages,
	parseLivePageSize,
	resolveLiveSyncAccount,
	type LiveSyncAccount,
	type LiveSyncMode,
} from "./live-sync-engine";
import { serializeMentionItemsAsXurlCompatible } from "./mentions-export";
import { listTimelineItems } from "./timeline-read-model";
import {
	deleteSyncCache,
	inspectSyncCache,
	writeSyncCache,
} from "./sync-cache";
import { runSyncPlanEffect } from "./sync-plan";
import type { ReplyFilter, XurlMentionsResponse } from "./types";
import { ingestTweetPayload } from "./tweet-repository";
import { mergeTweetPages } from "./tweet-page";
import { listMentionsViaXurlEffect, lookupUsersByHandlesEffect } from "./xurl";

export const DEFAULT_MENTIONS_CACHE_TTL_MS = 2 * 60_000;
const MIN_XURL_MENTIONS_LIMIT = 5;
const MAX_XURL_MENTIONS_LIMIT = 100;
type MentionSyncMode = LiveSyncMode;
type MentionLiveSource = Exclude<LiveSyncMode, "auto">;
export interface MentionsProgress {
	source: "bird" | "xurl" | "cache";
	fetched: number;
	total?: number;
	page?: number;
	maxPages?: number;
	pageSize?: number;
	done: boolean;
}
export interface SyncMentionsOptions {
	intent?: MentionSyncIntent;
	account?: string;
	mode?: string;
	limit?: number;
	maxPages?: number;
	refresh?: boolean;
	cacheTtlMs?: number;
	sinceId?: string;
	startTime?: string;
	onProgress?: (progress: MentionsProgress) => void;
}
interface ExportMentionsViaCachedLiveSourceOptions {
	mode: MentionSyncMode;
	account?: string;
	search?: string;
	replyFilter?: ReplyFilter;
	limit?: number;
	all?: boolean;
	maxPages?: number;
	refresh?: boolean;
	cacheTtlMs?: number;
}

function getMentionsExportCacheKey({
	mode,
	accountId,
	pageSize,
	all,
	maxPages,
}: {
	mode: MentionSyncMode;
	accountId: string;
	pageSize: number;
	all: boolean;
	maxPages: number | null;
}) {
	return `mentions:export:${mode}:${accountId}:${String(pageSize)}:${all ? "all" : "single"}:${maxPages === null ? "all-pages" : String(maxPages)}`;
}

function assertXurlLimit(limit: number) {
	parseLivePageSize(limit, {
		min: MIN_XURL_MENTIONS_LIMIT,
		max: MAX_XURL_MENTIONS_LIMIT,
		message: "xurl mode requires --limit between 5 and 100",
	});
}

function assertBirdLimit(limit: number) {
	parseLivePageSize(limit, {
		message: "bird mode requires --limit of at least 1",
	});
}

function parseSyncMode(value?: string): MentionSyncMode {
	return parseLiveSyncMode(value, "auto");
}

function mergeMentionsIntoLocalStore(
	db: Database,
	accountId: string,
	payload: XurlMentionsResponse,
	source: MentionsDataSource,
) {
	ingestTweetPayload(db, {
		accountId,
		payload,
		edgeKind: "mention",
		source,
	});
}

function shouldReturnFilteredLocalPayload({
	search,
	replyFilter,
}: {
	search?: string;
	replyFilter?: ReplyFilter;
}) {
	return (
		Boolean(search?.trim()) ||
		replyFilter === "replied" ||
		replyFilter === "unreplied"
	);
}

function readLocalXurlCompatiblePayload({
	accountId,
	search,
	replyFilter,
	limit,
}: {
	accountId?: string;
	search?: string;
	replyFilter?: ReplyFilter;
	limit: number;
}) {
	return serializeMentionItemsAsXurlCompatible(
		listTimelineItems({
			resource: "mentions",
			account: accountId,
			search,
			replyFilter,
			limit,
		}),
	);
}

function fetchMentionsViaXurlEffect({
	resolvedAccount,
	limit,
	all,
	parsedMaxPages,
	sinceId,
	startPaginationToken,
	startTime,
	onProgress,
}: {
	resolvedAccount: LiveSyncAccount;
	limit: number;
	all: boolean;
	parsedMaxPages: number | null;
	sinceId?: string;
	startPaginationToken?: string;
	startTime?: string;
	onProgress?: (progress: MentionsProgress) => void;
}) {
	return Effect.gen(function* () {
		const accountUserId =
			resolvedAccount.externalUserId ??
			(yield* lookupUsersByHandlesEffect([resolvedAccount.username]).pipe(
				Effect.map((users) => users[0]?.id),
			));
		if (!accountUserId) {
			return yield* Effect.fail(
				new Error(
					`Could not resolve Twitter user id for @${resolvedAccount.username}`,
				),
			);
		}

		const result = yield* runSyncPlanEffect({
			fetchPage: ({ cursor }) =>
				listMentionsViaXurlEffect({
					maxResults: limit,
					username: resolvedAccount.username,
					userId: String(accountUserId),
					paginationToken: cursor,
					...(sinceId ? { sinceId } : {}),
					...(startTime ? { startTime } : {}),
				}),
			getItemCount: (page) => page.data.length,
			getNextCursor: (page) =>
				typeof page.meta?.next_token === "string"
					? page.meta.next_token
					: undefined,
			initialCursor: startPaginationToken,
			maxPages: all ? (parsedMaxPages ?? undefined) : 1,
			onPage: ({ fetched, pageNumber, done }) =>
				onProgress?.({
					source: "xurl",
					fetched,
					total: parsedMaxPages === null ? undefined : parsedMaxPages * limit,
					page: pageNumber,
					maxPages: parsedMaxPages ?? undefined,
					pageSize: limit,
					done,
				}),
		});

		return {
			payload: mergeTweetPages(result.pages),
			stopReason: result.stopReason,
			nextCursor: result.nextCursor,
			complete: result.complete,
		};
	});
}

function fetchMentionsViaBirdEffect({
	account,
	limit,
}: {
	account: LiveSyncAccount;
	limit: number;
}) {
	return verifyBirdAccountMatchesEffect(account).pipe(
		Effect.flatMap(() => listMentionsViaBirdEffect({ maxResults: limit })),
	);
}

export function syncMentionsEffect({
	intent = "auto",
	account,
	mode,
	limit = 20,
	maxPages,
	refresh = false,
	cacheTtlMs,
	sinceId,
	startTime,
	onProgress,
}: SyncMentionsOptions) {
	return Effect.gen(function* () {
		const parsedMode = yield* trySync(() => parseSyncMode(mode));
		const primaryMode: MentionLiveSource =
			parsedMode === "auto" ? "xurl" : parsedMode;
		const explicitSinceId = sinceId?.trim() || undefined;
		const explicitStartTime = startTime?.trim() || undefined;
		if (!["auto", "latest", "resume"].includes(intent))
			return yield* Effect.fail(new Error("Invalid mentions sync intent"));
		if (intent !== "auto" && (explicitSinceId || explicitStartTime))
			return yield* Effect.fail(
				new Error(
					"--latest and --resume cannot be combined with --since-id or --start-time",
				),
			);
		if (intent === "resume" && primaryMode === "bird")
			return yield* Effect.fail(
				new Error("--resume requires xurl mentions pagination"),
			);
		if (primaryMode === "bird" && (explicitSinceId || explicitStartTime)) {
			return yield* Effect.fail(
				new Error("bird mode does not support --since-id or --start-time"),
			);
		}
		if (primaryMode === "xurl") {
			yield* trySync(() => assertXurlLimit(limit));
		} else {
			yield* trySync(() => assertBirdLimit(limit));
		}
		const parsedMaxPages =
			(yield* trySync(() => parseOptionalMaxPages(maxPages))) ?? null;
		const fetchAll =
			primaryMode === "xurl" &&
			(parsedMaxPages !== null ||
				(intent === "auto" && Boolean(explicitSinceId || explicitStartTime)));
		const db = yield* trySync(() => getNativeDb());
		const resolvedAccount = yield* trySync(() =>
			resolveLiveSyncAccount(db, account),
		);
		const initialShape: MentionScanShape = {
			mode: primaryMode,
			accountId: resolvedAccount.accountId,
			pageSize: limit,
			boundary: getMentionCursorBoundary({
				explicitSinceId,
				explicitStartTime,
			}),
		};
		const { shape: cursorShape, cursor } = yield* trySync(() =>
			selectMentionScan(db, initialShape, intent),
		);
		const cursorKey = getMentionCursorKey(cursorShape);
		const startPaginationToken = cursor?.token;
		const cursorSinceId =
			cursor?.boundary?.kind === "since" ? cursor.boundary.sinceId : undefined;
		const cursorStartTime =
			cursor?.boundary?.kind === "start"
				? cursor.boundary.startTime
				: undefined;
		const committedSinceId =
			primaryMode === "xurl" &&
			cursorShape.boundary.kind === "auto" &&
			!startPaginationToken
				? yield* trySync(() =>
						readMentionHighWaterId(db, primaryMode, resolvedAccount.accountId),
					)
				: undefined;
		const seededSinceId =
			primaryMode === "xurl" &&
			cursorShape.boundary.kind === "auto" &&
			!startPaginationToken
				? (committedSinceId ??
					(yield* trySync(() =>
						findNewestMentionId(db, resolvedAccount.accountId),
					)))
				: undefined;
		const resolvedSinceId = startPaginationToken
			? cursorSinceId
			: cursorShape.boundary.kind === "since"
				? cursorShape.boundary.sinceId
				: seededSinceId;
		const resolvedStartTime = startPaginationToken
			? cursorStartTime
			: !resolvedSinceId
				? cursorShape.boundary.kind === "start"
					? cursorShape.boundary.startTime
					: undefined
				: undefined;
		const resolvedBoundary = getMentionRequestBoundary({
			sinceId: resolvedSinceId,
			startTime: resolvedStartTime,
		});
		const resultShape: MentionScanShape = {
			...cursorShape,
			boundary: resolvedBoundary,
		};
		const resultCacheKey = getMentionResultCacheKey({
			shape: resultShape,
			all: fetchAll,
			maxPages: parsedMaxPages,
		});
		const cache = startPaginationToken
			? { entry: null, fresh: false }
			: yield* trySync(() =>
					inspectSyncCache<XurlMentionsResponse>(
						resultCacheKey,
						{
							ttlMs: cacheTtlMs,
							defaultTtlMs: DEFAULT_MENTIONS_CACHE_TTL_MS,
						},
						db,
					),
				);
		const cached = cache.entry;

		if (
			intent === "auto" &&
			!startPaginationToken &&
			!refresh &&
			cached &&
			cache.fresh
		) {
			yield* databaseWriteEffect((writeDb) =>
				mergeMentionsIntoLocalStore(
					writeDb,
					resolvedAccount.accountId,
					cached.value,
					primaryMode,
				),
			);
			yield* Effect.sync(() =>
				onProgress?.({
					source: "cache",
					fetched: cached.value.data.length,
					total: parsedMaxPages === null ? undefined : parsedMaxPages * limit,
					done: true,
				}),
			);
			return {
				ok: true,
				source: "cache",
				kind: "mentions",
				accountId: resolvedAccount.accountId,
				count: cached.value.data.length,
				partial: false,
				intent,
				position: "head" as const,
				checkedAt: cached.updatedAt,
				payload: cached.value,
			};
		}

		if (
			intent === "auto" &&
			primaryMode === "xurl" &&
			!explicitSinceId &&
			!explicitStartTime &&
			!startPaginationToken &&
			!seededSinceId
		) {
			console.error(
				"No local mention baseline found; syncing mentions from the newest page backwards.",
			);
		}

		let source: MentionLiveSource = primaryMode;
		const canFallbackToBird =
			primaryMode === "xurl" &&
			parsedMode === "auto" &&
			!explicitSinceId &&
			!explicitStartTime &&
			!startPaginationToken;
		const fetched =
			primaryMode === "bird"
				? {
						payload: yield* fetchMentionsViaBirdEffect({
							account: resolvedAccount,
							limit,
						}),
						complete: true,
						stopReason: "exhausted" as const,
						nextCursor: undefined,
					}
				: yield* fetchMentionsViaXurlEffect({
						resolvedAccount,
						limit,
						all: fetchAll,
						parsedMaxPages,
						sinceId: resolvedSinceId,
						startPaginationToken,
						startTime: resolvedStartTime,
						onProgress,
					}).pipe(
						Effect.catchAll((error) => {
							if (!canFallbackToBird) return Effect.fail(error);
							source = "bird";
							return fetchMentionsViaBirdEffect({
								account: resolvedAccount,
								limit,
							}).pipe(
								Effect.map((payload) => ({
									payload,
									complete: true,
									stopReason: "exhausted" as const,
									nextCursor: undefined,
								})),
							);
						}),
					);
		const { payload } = fetched;
		const checkedAt = new Date().toISOString();
		if (source === "bird") {
			yield* Effect.sync(() =>
				onProgress?.({
					source: "bird",
					fetched: payload.data.length,
					total: limit,
					done: true,
				}),
			);
		}
		const resumeToken =
			fetched.stopReason === "page-limit" ? fetched.nextCursor : undefined;
		const newestMentionId = getNewestMentionId(payload);
		yield* databaseWriteEffect((writeDb) => {
			mergeMentionsIntoLocalStore(
				writeDb,
				resolvedAccount.accountId,
				payload,
				source,
			);
			if (source === "xurl") {
				if (resumeToken) {
					deleteSyncCache(resultCacheKey, writeDb);
					writeSyncCache(
						cursorKey,
						addMentionCursorState(
							{
								...payload,
								meta: { ...payload.meta, next_token: resumeToken },
							},
							resolvedBoundary,
							maxNumericTweetId(resolvedSinceId, newestMentionId),
						),
						writeDb,
					);
				} else {
					deleteSyncCache(cursorKey, writeDb);
					if (fetched.complete && cursorShape.boundary.kind === "auto") {
						writeMentionHighWaterId(
							writeDb,
							source,
							resolvedAccount.accountId,
							maxNumericTweetId(
								resolvedSinceId,
								cursor?.pendingNewestId,
								newestMentionId,
							),
						);
					}
				}
			}
			if (fetched.complete) {
				const writeCacheKey =
					source === primaryMode
						? resultCacheKey
						: getMentionResultCacheKey({
								shape: {
									...resultShape,
									mode: source,
								},
								all: false,
								maxPages: null,
							});
				writeSyncCache(writeCacheKey, payload, writeDb);
			}
		});

		return {
			ok: true,
			source,
			kind: "mentions",
			accountId: resolvedAccount.accountId,
			count: payload.data.length,
			partial: !fetched.complete,
			intent,
			position: startPaginationToken
				? ("continuation" as const)
				: ("head" as const),
			checkedAt,
			payload,
		};
	});
}

export function syncMentions(options: SyncMentionsOptions) {
	return runEffectPromise(syncMentionsEffect(options));
}

function exportMentionsViaCachedLiveSourceEffect({
	mode,
	account,
	search,
	replyFilter = "all",
	limit = 20,
	all = false,
	maxPages,
	refresh = false,
	cacheTtlMs,
}: ExportMentionsViaCachedLiveSourceOptions) {
	return Effect.gen(function* () {
		const primaryMode: MentionLiveSource = mode === "auto" ? "xurl" : mode;
		if (primaryMode === "xurl") {
			yield* trySync(() => assertXurlLimit(limit));
		} else {
			yield* trySync(() => assertBirdLimit(limit));
		}
		const parsedMaxPages =
			(yield* trySync(() => parseOptionalMaxPages(maxPages))) ?? null;
		const fetchAll = primaryMode === "xurl" && (all || parsedMaxPages !== null);

		const db = yield* trySync(() => getNativeDb());
		const resolvedAccount = yield* trySync(() =>
			resolveLiveSyncAccount(db, account),
		);
		const cacheKey = getMentionsExportCacheKey({
			mode,
			accountId: resolvedAccount.accountId,
			pageSize: limit,
			all: fetchAll,
			maxPages: parsedMaxPages,
		});
		const cache = yield* trySync(() =>
			inspectSyncCache<XurlMentionsResponse>(
				cacheKey,
				{
					ttlMs: cacheTtlMs,
					defaultTtlMs: DEFAULT_MENTIONS_CACHE_TTL_MS,
				},
				db,
			),
		);
		const cached = cache.entry;
		const readFilteredOrRaw = (payload: XurlMentionsResponse) => {
			if (
				shouldReturnFilteredLocalPayload({
					search,
					replyFilter,
				})
			) {
				return readLocalXurlCompatiblePayload({
					accountId: resolvedAccount.accountId,
					search,
					replyFilter,
					limit: fetchAll ? payload.data.length : limit,
				});
			}
			return payload;
		};

		if (!refresh && cached && cache.fresh) {
			return yield* trySync(() => readFilteredOrRaw(cached.value));
		}

		let source: MentionLiveSource = primaryMode;
		const liveResult = yield* (
			primaryMode === "bird"
				? fetchMentionsViaBirdEffect({
						account: resolvedAccount,
						limit,
					}).pipe(Effect.map((payload) => ({ payload })))
				: fetchMentionsViaXurlEffect({
						resolvedAccount,
						limit,
						all: fetchAll,
						parsedMaxPages,
					})
		).pipe(
			Effect.catchAll((error) => {
				if (mode !== "auto" || fetchAll) return Effect.fail(error);
				source = "bird";
				return fetchMentionsViaBirdEffect({
					account: resolvedAccount,
					limit,
				}).pipe(Effect.map((payload) => ({ payload })));
			}),
			Effect.flatMap(({ payload }) =>
				databaseWriteEffect((writeDb) => {
					mergeMentionsIntoLocalStore(
						writeDb,
						resolvedAccount.accountId,
						payload,
						source,
					);
					writeSyncCache(cacheKey, payload, writeDb);
					return readFilteredOrRaw(payload);
				}),
			),
			Effect.map((payload) => ({ ok: true as const, payload })),
			Effect.catchAll((error) => {
				if (!refresh && cached) {
					return Effect.succeed({ ok: false as const });
				}
				return Effect.fail(error);
			}),
		);

		if (!liveResult.ok) {
			if (!cached) {
				return yield* Effect.fail(
					new Error("Mention export failed without cache"),
				);
			}
			return yield* trySync(() => readFilteredOrRaw(cached.value));
		}

		return liveResult.payload;
	});
}

export function exportMentionsViaCachedXurl(
	options: Omit<ExportMentionsViaCachedLiveSourceOptions, "mode">,
) {
	return runEffectPromise(
		exportMentionsViaCachedLiveSourceEffect({
			...options,
			mode: "xurl",
		}),
	);
}

export function exportMentionsViaCachedBird(
	options: Omit<ExportMentionsViaCachedLiveSourceOptions, "mode">,
) {
	return runEffectPromise(
		exportMentionsViaCachedLiveSourceEffect({
			...options,
			mode: "bird",
		}),
	);
}

export function exportMentionsViaCachedAuto(
	options: Omit<ExportMentionsViaCachedLiveSourceOptions, "mode">,
) {
	return runEffectPromise(
		exportMentionsViaCachedLiveSourceEffect({
			...options,
			mode: "auto",
		}),
	);
}
