import type { Database } from "./sqlite";
import { Effect } from "effect";
import { listMentionsViaBirdEffect } from "./bird";
import type { MentionsDataSource } from "./config";
import { getNativeDb } from "./db";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import { buildMediaJsonFromIncludes, countTweetMedia } from "./media-includes";
import { serializeMentionItemsAsXurlCompatible } from "./mentions-export";
import { listTimelineItems } from "./queries";
import { deleteSyncCache, readSyncCache, writeSyncCache } from "./sync-cache";
import type {
	ReplyFilter,
	TweetEntities,
	XurlMentionData,
	XurlMentionsResponse,
	XurlMediaItem,
	XurlMentionUser,
} from "./types";
import { upsertTweetAccountEdge } from "./tweet-account-edges";
import { ensureStubProfileForXUser, upsertProfileFromXUser } from "./x-profile";
import { listMentionsViaXurl, lookupUsersByHandles } from "./xurl";

export const DEFAULT_MENTIONS_CACHE_TTL_MS = 2 * 60_000;
const MIN_XURL_MENTIONS_LIMIT = 5;
const MAX_XURL_MENTIONS_LIMIT = 100;
type MentionSyncMode = Exclude<MentionsDataSource, "birdclaw">;
export interface SyncMentionsOptions {
	account?: string;
	mode?: string;
	limit?: number;
	maxPages?: number;
	refresh?: boolean;
	cacheTtlMs?: number;
	sinceId?: string;
	startTime?: string;
}
interface ExportMentionsViaCachedLiveSourceOptions {
	mode: MentionsDataSource;
	account?: string;
	search?: string;
	replyFilter?: ReplyFilter;
	limit?: number;
	all?: boolean;
	maxPages?: number;
	refresh?: boolean;
	cacheTtlMs?: number;
}
type MentionScanBoundary =
	| { kind: "auto" }
	| { kind: "since"; sinceId: string }
	| { kind: "start"; startTime: string }
	| { kind: "unbounded" };
interface MentionScanShape {
	endpoint: "mentions";
	mode: MentionSyncMode;
	accountId: string;
	pageSize: number;
	boundary: MentionScanBoundary;
}
interface MentionCursorValue extends XurlMentionsResponse {
	birdclaw?: {
		boundary?: MentionScanBoundary;
		pendingNewestId?: string | null;
	};
}
interface MentionHighWaterValue {
	sinceId: string;
}

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function trySync<T>(try_: () => T) {
	return Effect.try({
		try: try_,
		catch: toError,
	});
}

function getMentionsFetchModeKey({
	scope,
	mode,
	accountId,
	pageSize,
	all,
	maxPages,
	sinceId,
	startTime,
}: {
	scope: "sync" | "export";
	mode: MentionsDataSource;
	accountId: string;
	pageSize: number;
	all: boolean;
	maxPages: number | null;
	sinceId: string | null;
	startTime: string | null;
}) {
	return `mentions:${scope}:${mode}:${accountId}:${String(pageSize)}:${all ? "all" : "single"}:${maxPages === null ? "all-pages" : String(maxPages)}:${sinceId ?? "no-since"}:${startTime ?? "no-start"}`;
}

function getLegacyMentionsFetchModeKeyWithoutStart({
	scope,
	mode,
	accountId,
	pageSize,
	all,
	maxPages,
	sinceId,
}: {
	scope: "sync" | "export";
	mode: MentionsDataSource;
	accountId: string;
	pageSize: number;
	all: boolean;
	maxPages: number | null;
	sinceId: string | null;
}) {
	return `mentions:${scope}:${mode}:${accountId}:${String(pageSize)}:${all ? "all" : "single"}:${maxPages === null ? "all-pages" : String(maxPages)}:${sinceId ?? "no-since"}`;
}

function encodeCacheKeyPart(value: string) {
	return encodeURIComponent(value);
}

function getMentionScanBoundaryKey(boundary: MentionScanBoundary) {
	switch (boundary.kind) {
		case "auto":
			return "auto";
		case "since":
			return `since=${encodeCacheKeyPart(boundary.sinceId)}`;
		case "start":
			return `start=${encodeCacheKeyPart(boundary.startTime)}`;
		case "unbounded":
			return "unbounded";
	}
}

function getMentionScanShapeKey(shape: MentionScanShape) {
	return [
		`endpoint=${shape.endpoint}`,
		`mode=${shape.mode}`,
		`account=${encodeCacheKeyPart(shape.accountId)}`,
		`page=${String(shape.pageSize)}`,
		`boundary=${getMentionScanBoundaryKey(shape.boundary)}`,
	].join(":");
}

function getMentionCursorKey(shape: MentionScanShape) {
	return `mentions:sync:cursor:v2:${getMentionScanShapeKey(shape)}`;
}

function getMentionResultCacheKey({
	shape,
	all,
	maxPages,
}: {
	shape: MentionScanShape;
	all: boolean;
	maxPages: number | null;
}) {
	return `mentions:sync:result:v2:${getMentionScanShapeKey(shape)}:${all ? "all" : "single"}:${maxPages === null ? "all-pages" : String(maxPages)}`;
}

function getMentionHighWaterKey({
	mode,
	accountId,
}: {
	mode: MentionSyncMode;
	accountId: string;
}) {
	return `mentions:sync:high-water:v1:mode=${mode}:account=${encodeCacheKeyPart(accountId)}`;
}

function getMentionCursorBoundary({
	explicitSinceId,
	explicitStartTime,
}: {
	explicitSinceId?: string;
	explicitStartTime?: string;
}): MentionScanBoundary {
	if (explicitSinceId) {
		return { kind: "since", sinceId: explicitSinceId };
	}
	if (explicitStartTime) {
		return { kind: "start", startTime: explicitStartTime };
	}
	return { kind: "auto" };
}

function getMentionRequestBoundary({
	sinceId,
	startTime,
}: {
	sinceId?: string;
	startTime?: string;
}): MentionScanBoundary {
	if (sinceId) {
		return { kind: "since", sinceId };
	}
	if (startTime) {
		return { kind: "start", startTime };
	}
	return { kind: "unbounded" };
}

function getLegacyMentionCursorKeys(shape: MentionScanShape) {
	const sinceId =
		shape.boundary.kind === "since" ? shape.boundary.sinceId : null;
	const startTime =
		shape.boundary.kind === "start" ? shape.boundary.startTime : null;
	const keys = [
		getMentionsFetchModeKey({
			scope: "sync",
			mode: shape.mode,
			accountId: shape.accountId,
			pageSize: shape.pageSize,
			all: false,
			maxPages: null,
			sinceId,
			startTime,
		}),
	];
	if (!startTime) {
		keys.push(
			getLegacyMentionsFetchModeKeyWithoutStart({
				scope: "sync",
				mode: shape.mode,
				accountId: shape.accountId,
				pageSize: shape.pageSize,
				all: false,
				maxPages: null,
				sinceId,
			}),
		);
	}
	return [...new Set(keys)];
}

function parseCacheTtlMs(value?: number) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return DEFAULT_MENTIONS_CACHE_TTL_MS;
	}
	return Math.floor(value);
}

function assertXurlLimit(limit: number) {
	if (limit < MIN_XURL_MENTIONS_LIMIT || limit > MAX_XURL_MENTIONS_LIMIT) {
		throw new Error("xurl mode requires --limit between 5 and 100");
	}
}

function assertBirdLimit(limit: number) {
	if (!Number.isFinite(limit) || limit < 1) {
		throw new Error("bird mode requires --limit of at least 1");
	}
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

function parseSyncMode(value?: string): MentionSyncMode {
	const mode = value ?? "xurl";
	if (mode !== "bird" && mode !== "xurl") {
		throw new Error("--mode must be bird or xurl");
	}
	return mode;
}

function getCachedPaginationToken(
	cached?: { value: XurlMentionsResponse } | null,
) {
	return typeof cached?.value.meta?.next_token === "string" &&
		cached.value.meta.next_token.length > 0
		? cached.value.meta.next_token
		: undefined;
}

function parseCachedMentionBoundary(
	value: MentionCursorValue | XurlMentionsResponse,
	fallbackBoundary?: MentionScanBoundary,
) {
	const boundary = (value as MentionCursorValue).birdclaw?.boundary;
	if (!boundary || typeof boundary !== "object") {
		return fallbackBoundary;
	}
	if (boundary.kind === "unbounded" || boundary.kind === "auto") {
		return boundary;
	}
	if (boundary.kind === "since" && typeof boundary.sinceId === "string") {
		return boundary;
	}
	if (boundary.kind === "start" && typeof boundary.startTime === "string") {
		return boundary;
	}
	return fallbackBoundary;
}

function getCachedMentionPendingNewestId(
	value: MentionCursorValue | XurlMentionsResponse | undefined,
) {
	const pendingNewestId = (value as MentionCursorValue | undefined)?.birdclaw
		?.pendingNewestId;
	return isNumericTweetId(pendingNewestId) ? pendingNewestId : undefined;
}

function addMentionCursorState(
	payload: XurlMentionsResponse,
	boundary: MentionScanBoundary,
	pendingNewestId: string | undefined,
): MentionCursorValue {
	return {
		...payload,
		birdclaw: { boundary, pendingNewestId: pendingNewestId ?? null },
	};
}

function readMentionCursor({
	db,
	shape,
	cursorKey,
	legacyCursorKeys,
}: {
	db: Database;
	shape: MentionScanShape;
	cursorKey: string;
	legacyCursorKeys: string[];
}) {
	const fallbackBoundary =
		shape.boundary.kind === "auto" ? undefined : shape.boundary;
	const current = readSyncCache<MentionCursorValue>(cursorKey, db);
	const currentToken = getCachedPaginationToken(current);
	if (current && currentToken) {
		return {
			key: cursorKey,
			token: currentToken,
			boundary: parseCachedMentionBoundary(current.value, fallbackBoundary),
			pendingNewestId: getCachedMentionPendingNewestId(current.value),
			legacyKeys: [] as string[],
		};
	}

	for (const legacyKey of legacyCursorKeys) {
		const legacy = readSyncCache<MentionCursorValue>(legacyKey, db);
		const legacyToken = getCachedPaginationToken(legacy);
		if (legacy && legacyToken) {
			return {
				key: legacyKey,
				token: legacyToken,
				boundary: parseCachedMentionBoundary(legacy.value, fallbackBoundary),
				pendingNewestId: getCachedMentionPendingNewestId(legacy.value),
				legacyKeys: [legacyKey],
			};
		}
	}

	return undefined;
}

function isNumericTweetId(value: string | undefined | null): value is string {
	return typeof value === "string" && /^[0-9]+$/.test(value);
}

function maxNumericTweetId(...ids: Array<string | undefined | null>) {
	return ids.filter(isNumericTweetId).reduce<string | undefined>((max, id) => {
		if (!max) {
			return id;
		}
		if (id.length !== max.length) {
			return id.length > max.length ? id : max;
		}
		return id > max ? id : max;
	}, undefined);
}

function getNewestMentionId(payload: XurlMentionsResponse) {
	return maxNumericTweetId(
		typeof payload.meta?.newest_id === "string"
			? payload.meta.newest_id
			: undefined,
		...payload.data.map((tweet) => tweet.id),
	);
}

function readMentionHighWaterId(
	db: Database,
	mode: MentionSyncMode,
	accountId: string,
) {
	const cached = readSyncCache<MentionHighWaterValue>(
		getMentionHighWaterKey({ mode, accountId }),
		db,
	);
	return isNumericTweetId(cached?.value.sinceId)
		? cached.value.sinceId
		: undefined;
}

function writeMentionHighWaterId(
	db: Database,
	mode: MentionSyncMode,
	accountId: string,
	sinceId: string | undefined,
) {
	if (!isNumericTweetId(sinceId)) {
		return;
	}
	writeSyncCache(getMentionHighWaterKey({ mode, accountId }), { sinceId }, db);
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

	return {
		accountId: row.id,
		username: row.handle.replace(/^@/, ""),
	};
}

function findNewestArchiveMentionId(db: Database, accountId: string) {
	const row = db
		.prepare(
			`
      select t.id
      from tweets t
      join tweet_account_edges e
        on e.tweet_id = t.id
      where e.account_id = ?
        and e.kind = 'mention'
        and e.source in ('archive', 'legacy')
        and length(t.id) > 0
        and t.id glob '[0-9]*'
        and t.id not glob '*[^0-9]*'
      order by length(t.id) desc, t.id desc
      limit 1
      `,
		)
		.get(accountId) as { id: string } | undefined;
	return row?.id;
}

function toLocalEntities(tweet: XurlMentionData): TweetEntities {
	const raw = tweet.entities;
	if (!raw || typeof raw !== "object") {
		return {};
	}

	const entities = raw as Record<string, unknown>;
	const rawMentions = Array.isArray(entities.mentions) ? entities.mentions : [];
	const rawUrls = Array.isArray(entities.urls) ? entities.urls : [];

	return {
		...(rawMentions.length
			? {
					mentions: rawMentions.map((mention) => {
						const value =
							mention && typeof mention === "object"
								? (mention as Record<string, unknown>)
								: {};
						return {
							username: String(value.username ?? ""),
							id: typeof value.id === "string" ? String(value.id) : undefined,
							start: Number(value.start ?? 0),
							end: Number(value.end ?? 0),
						};
					}),
				}
			: {}),
		...(rawUrls.length
			? {
					urls: rawUrls.map((url) => {
						const value =
							url && typeof url === "object"
								? (url as Record<string, unknown>)
								: {};
						return {
							url: String(value.url ?? ""),
							expandedUrl: String(value.expanded_url ?? value.url ?? ""),
							displayUrl: String(
								value.display_url ?? value.expanded_url ?? value.url ?? "",
							),
							start: Number(value.start ?? 0),
							end: Number(value.end ?? 0),
						};
					}),
				}
			: {}),
	};
}

function replaceTweetFts(db: Database, tweetId: string, text: string) {
	db.prepare("delete from tweets_fts where tweet_id = ?").run(tweetId);
	db.prepare("insert into tweets_fts (tweet_id, text) values (?, ?)").run(
		tweetId,
		text,
	);
}

function mergeMentionsIntoLocalStore(
	db: Database,
	accountId: string,
	payload: XurlMentionsResponse,
	source: MentionsDataSource,
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
    ) values (?, ?, ?, 'mention', ?, ?, 0, null, ?, ?, 0, 0, ?, ?, null)
    on conflict(id) do update set
      account_id = tweets.account_id,
      author_profile_id = excluded.author_profile_id,
      kind = case
        when tweets.kind in ('authored', 'home', 'mention') then tweets.kind
        when excluded.kind in ('authored', 'home', 'mention') then excluded.kind
        else excluded.kind
      end,
      text = excluded.text,
      created_at = excluded.created_at,
      like_count = excluded.like_count,
      media_count = max(tweets.media_count, excluded.media_count),
      entities_json = excluded.entities_json,
      media_json = case
        when excluded.media_json not in ('', '[]', 'null') then excluded.media_json
        else tweets.media_json
      end,
      is_replied = max(tweets.is_replied, excluded.is_replied),
      bookmarked = max(tweets.bookmarked, excluded.bookmarked),
      liked = max(tweets.liked, excluded.liked)
    `,
	);

	const writePayload = db.transaction(() => {
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
			upsertTweet.run(
				tweet.id,
				accountId,
				profile.profile.id,
				tweet.text,
				tweet.created_at,
				Number(tweet.public_metrics?.like_count ?? 0),
				countTweetMedia(tweet),
				JSON.stringify(toLocalEntities(tweet)),
				buildMediaJsonFromIncludes(tweet, payload.includes?.media),
			);
			upsertTweetAccountEdge(db, {
				accountId,
				tweetId: tweet.id,
				kind: "mention",
				source,
				seenAt,
				rawJson: JSON.stringify(tweet),
			});
			replaceTweetFts(db, tweet.id, tweet.text);
		}
	});

	writePayload();
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

function mergeMentionPayloads(
	pages: XurlMentionsResponse[],
): XurlMentionsResponse {
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

	const lastMeta = pages.at(-1)?.meta;
	const includes = {
		...(users.length > 0 ? { users } : {}),
		...(media.length > 0 ? { media } : {}),
	};
	return {
		data: tweets,
		includes: users.length > 0 || media.length > 0 ? includes : undefined,
		meta: {
			...lastMeta,
			result_count: tweets.length,
			page_count: pages.length,
			next_token:
				typeof lastMeta?.next_token === "string" ? lastMeta.next_token : null,
		},
	};
}

function fetchMentionsViaXurlEffect({
	resolvedAccount,
	limit,
	all,
	parsedMaxPages,
	sinceId,
	startPaginationToken,
	startTime,
}: {
	resolvedAccount: ReturnType<typeof resolveAccount>;
	limit: number;
	all: boolean;
	parsedMaxPages: number | null;
	sinceId?: string;
	startPaginationToken?: string;
	startTime?: string;
}) {
	return Effect.gen(function* () {
		const [accountUser] = yield* tryPromise(() =>
			lookupUsersByHandles([resolvedAccount.username]),
		);
		if (!accountUser?.id) {
			return yield* Effect.fail(
				new Error(
					`Could not resolve Twitter user id for @${resolvedAccount.username}`,
				),
			);
		}

		const pages: XurlMentionsResponse[] = [];
		let nextToken: string | undefined = startPaginationToken;
		let pageCount = 0;
		do {
			const payload = yield* tryPromise(() =>
				listMentionsViaXurl({
					maxResults: limit,
					username: resolvedAccount.username,
					userId: String(accountUser.id),
					paginationToken: nextToken,
					...(sinceId ? { sinceId } : {}),
					...(startTime ? { startTime } : {}),
				}),
			);
			pages.push(payload);
			const metaNextToken =
				typeof payload.meta?.next_token === "string"
					? payload.meta.next_token
					: undefined;
			nextToken = metaNextToken;
			pageCount += 1;
		} while (
			all &&
			nextToken &&
			(parsedMaxPages === null || pageCount < parsedMaxPages)
		);

		return mergeMentionPayloads(pages);
	});
}

function fetchMentionsViaBirdEffect({ limit }: { limit: number }) {
	return listMentionsViaBirdEffect({ maxResults: limit });
}

function isMaxPagesPartial({
	payload,
	maxPages,
}: {
	payload: XurlMentionsResponse;
	maxPages: number | null;
}) {
	return (
		maxPages !== null &&
		typeof payload.meta?.next_token === "string" &&
		payload.meta.next_token.length > 0
	);
}

export function syncMentionsEffect({
	account,
	mode,
	limit = 20,
	maxPages,
	refresh = false,
	cacheTtlMs,
	sinceId,
	startTime,
}: SyncMentionsOptions) {
	return Effect.gen(function* () {
		const parsedMode = yield* trySync(() => parseSyncMode(mode));
		const explicitSinceId = sinceId?.trim() || undefined;
		const explicitStartTime = startTime?.trim() || undefined;
		if (parsedMode === "bird" && (explicitSinceId || explicitStartTime)) {
			return yield* Effect.fail(
				new Error("bird mode does not support --since-id or --start-time"),
			);
		}
		if (parsedMode === "xurl") {
			yield* trySync(() => assertXurlLimit(limit));
		} else {
			yield* trySync(() => assertBirdLimit(limit));
		}
		const parsedMaxPages = yield* trySync(() => parseMaxPages(maxPages));
		const fetchAll = parsedMode === "xurl" && parsedMaxPages !== null;
		const db = yield* trySync(() => getNativeDb());
		const resolvedAccount = yield* trySync(() => resolveAccount(db, account));
		const cursorShape: MentionScanShape = {
			endpoint: "mentions",
			mode: parsedMode,
			accountId: resolvedAccount.accountId,
			pageSize: limit,
			boundary: getMentionCursorBoundary({
				explicitSinceId,
				explicitStartTime,
			}),
		};
		const cursorKey = getMentionCursorKey(cursorShape);
		const legacyCursorKeys = getLegacyMentionCursorKeys(cursorShape);
		const cursor =
			parsedMode === "xurl"
				? yield* trySync(() =>
						readMentionCursor({
							db,
							shape: cursorShape,
							cursorKey,
							legacyCursorKeys,
						}),
					)
				: undefined;
		const startPaginationToken = cursor?.token;
		const cursorSinceId =
			cursor?.boundary?.kind === "since" ? cursor.boundary.sinceId : undefined;
		const cursorStartTime =
			cursor?.boundary?.kind === "start"
				? cursor.boundary.startTime
				: undefined;
		const committedSinceId =
			parsedMode === "xurl" &&
			cursorShape.boundary.kind === "auto" &&
			!startPaginationToken
				? yield* trySync(() =>
						readMentionHighWaterId(db, parsedMode, resolvedAccount.accountId),
					)
				: undefined;
		const seededSinceId =
			parsedMode === "xurl" &&
			!explicitSinceId &&
			!explicitStartTime &&
			!startPaginationToken
				? (committedSinceId ??
					(yield* trySync(() =>
						findNewestArchiveMentionId(db, resolvedAccount.accountId),
					)))
				: undefined;
		const resolvedSinceId = startPaginationToken
			? cursorSinceId
			: (explicitSinceId ?? seededSinceId);
		const resolvedStartTime = startPaginationToken
			? cursorStartTime
			: !resolvedSinceId
				? explicitStartTime
				: undefined;
		const resultShape: MentionScanShape = {
			endpoint: "mentions",
			mode: parsedMode,
			accountId: resolvedAccount.accountId,
			pageSize: limit,
			boundary: getMentionRequestBoundary({
				sinceId: resolvedSinceId,
				startTime: resolvedStartTime,
			}),
		};
		const resultCacheKey = getMentionResultCacheKey({
			shape: resultShape,
			all: fetchAll,
			maxPages: parsedMaxPages,
		});
		const ttlMs = parseCacheTtlMs(cacheTtlMs);
		const cached = startPaginationToken
			? null
			: yield* trySync(() =>
					readSyncCache<XurlMentionsResponse>(resultCacheKey, db),
				);
		const cachedPaginationToken = getCachedPaginationToken(cached);
		const cacheAgeMs = cached
			? Date.now() - new Date(cached.updatedAt).getTime()
			: Number.POSITIVE_INFINITY;

		if (
			!startPaginationToken &&
			!cachedPaginationToken &&
			!refresh &&
			cached &&
			cacheAgeMs <= ttlMs
		) {
			yield* trySync(() =>
				mergeMentionsIntoLocalStore(
					db,
					resolvedAccount.accountId,
					cached.value,
					parsedMode,
				),
			);
			return {
				ok: true,
				source: "cache",
				kind: "mentions",
				accountId: resolvedAccount.accountId,
				count: cached.value.data.length,
				partial: isMaxPagesPartial({
					payload: cached.value,
					maxPages: parsedMaxPages,
				}),
				payload: cached.value,
			};
		}

		if (
			parsedMode === "xurl" &&
			!explicitSinceId &&
			!explicitStartTime &&
			!startPaginationToken &&
			!seededSinceId
		) {
			console.error(
				"No local mention baseline found; syncing mentions from the newest page backwards.",
			);
		}

		const payload =
			parsedMode === "bird"
				? yield* fetchMentionsViaBirdEffect({ limit })
				: yield* fetchMentionsViaXurlEffect({
						resolvedAccount,
						limit,
						all: fetchAll,
						parsedMaxPages,
						sinceId: resolvedSinceId,
						startPaginationToken,
						startTime: resolvedStartTime,
					});
		yield* trySync(() =>
			mergeMentionsIntoLocalStore(
				db,
				resolvedAccount.accountId,
				payload,
				parsedMode,
			),
		);
		const payloadPaginationToken = getCachedPaginationToken({ value: payload });
		if (parsedMode === "xurl") {
			if (payloadPaginationToken) {
				yield* trySync(() => {
					writeSyncCache(
						cursorKey,
						addMentionCursorState(
							payload,
							getMentionRequestBoundary({
								sinceId: resolvedSinceId,
								startTime: resolvedStartTime,
							}),
							maxNumericTweetId(resolvedSinceId, getNewestMentionId(payload)),
						),
						db,
					);
					deleteSyncCache(resultCacheKey, db);
					deleteSyncCache(
						getMentionResultCacheKey({
							shape: cursorShape,
							all: fetchAll,
							maxPages: parsedMaxPages,
						}),
						db,
					);
					for (const legacyKey of cursor?.legacyKeys ?? []) {
						deleteSyncCache(legacyKey, db);
					}
				});
			} else {
				yield* trySync(() => {
					deleteSyncCache(cursorKey, db);
					for (const legacyKey of legacyCursorKeys) {
						deleteSyncCache(legacyKey, db);
					}
					if (cursorShape.boundary.kind === "auto") {
						writeMentionHighWaterId(
							db,
							parsedMode,
							resolvedAccount.accountId,
							maxNumericTweetId(
								resolvedSinceId,
								cursor?.pendingNewestId,
								getNewestMentionId(payload),
							),
						);
					}
				});
			}
		}
		if (!payloadPaginationToken && !startPaginationToken) {
			yield* trySync(() => writeSyncCache(resultCacheKey, payload, db));
		}

		return {
			ok: true,
			source: parsedMode,
			kind: "mentions",
			accountId: resolvedAccount.accountId,
			count: payload.data.length,
			partial: isMaxPagesPartial({ payload, maxPages: parsedMaxPages }),
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
		if (mode === "xurl") {
			yield* trySync(() => assertXurlLimit(limit));
		} else {
			yield* trySync(() => assertBirdLimit(limit));
		}
		const parsedMaxPages = yield* trySync(() => parseMaxPages(maxPages));
		const fetchAll = mode === "xurl" && (all || parsedMaxPages !== null);

		const db = yield* trySync(() => getNativeDb());
		const resolvedAccount = yield* trySync(() => resolveAccount(db, account));
		const cacheKey = getMentionsFetchModeKey({
			scope: "export",
			mode,
			accountId: resolvedAccount.accountId,
			pageSize: limit,
			all: fetchAll,
			maxPages: parsedMaxPages,
			sinceId: null,
			startTime: null,
		});
		const ttlMs = parseCacheTtlMs(cacheTtlMs);
		const cached = yield* trySync(() =>
			readSyncCache<XurlMentionsResponse>(cacheKey, db),
		);
		const cacheAgeMs = cached
			? Date.now() - new Date(cached.updatedAt).getTime()
			: Number.POSITIVE_INFINITY;
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

		if (!refresh && cached && cacheAgeMs <= ttlMs) {
			return yield* trySync(() => readFilteredOrRaw(cached.value));
		}

		const liveResult = yield* (
			mode === "bird"
				? fetchMentionsViaBirdEffect({ limit })
				: fetchMentionsViaXurlEffect({
						resolvedAccount,
						limit,
						all: fetchAll,
						parsedMaxPages,
					})
		).pipe(
			Effect.flatMap((payload) =>
				trySync(() => {
					mergeMentionsIntoLocalStore(
						db,
						resolvedAccount.accountId,
						payload,
						mode,
					);
					writeSyncCache(cacheKey, payload, db);
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
