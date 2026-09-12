import type { Database } from "./sqlite";
import type { XurlMentionsResponse } from "./types";
import { readSyncCache, writeSyncCache } from "./sync-cache";

type MentionLiveSource = "bird" | "xurl";
export type MentionSyncIntent = "auto" | "latest" | "resume";

export type MentionScanBoundary =
	| { kind: "auto" }
	| { kind: "since"; sinceId: string }
	| { kind: "start"; startTime: string }
	| { kind: "unbounded" };
export interface MentionScanShape {
	mode: MentionLiveSource;
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
		`mode=${shape.mode}`,
		`account=${encodeCacheKeyPart(shape.accountId)}`,
		`page=${String(shape.pageSize)}`,
		`boundary=${getMentionScanBoundaryKey(shape.boundary)}`,
	].join(":");
}

export function getMentionCursorKey(shape: MentionScanShape) {
	return `mentions:sync:cursor:v2:${getMentionScanShapeKey(shape)}`;
}

export function getMentionResultCacheKey({
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
	mode: MentionLiveSource;
	accountId: string;
}) {
	return `mentions:sync:high-water:v1:mode=${mode}:account=${encodeCacheKeyPart(accountId)}`;
}

export function getMentionCursorBoundary({
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

export function getMentionRequestBoundary({
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

function getMentionCursorToken(cached?: { value: MentionCursorValue } | null) {
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

export function addMentionCursorState(
	payload: XurlMentionsResponse,
	boundary: MentionScanBoundary,
	pendingNewestId: string | undefined,
): MentionCursorValue {
	return {
		...payload,
		birdclaw: { boundary, pendingNewestId: pendingNewestId ?? null },
	};
}

export function readMentionCursor(db: Database, shape: MentionScanShape) {
	const cursorKey = getMentionCursorKey(shape);
	const fallbackBoundary =
		shape.boundary.kind === "auto" ? undefined : shape.boundary;
	const current = readSyncCache<MentionCursorValue>(cursorKey, db);
	const currentToken = getMentionCursorToken(current);
	if (current && currentToken) {
		const boundary = parseCachedMentionBoundary(
			current.value,
			fallbackBoundary,
		);
		if (
			shape.boundary.kind !== "auto" &&
			boundary &&
			getMentionScanBoundaryKey(boundary) !==
				getMentionScanBoundaryKey(shape.boundary)
		) {
			throw new Error("Stored mentions cursor boundary disagrees with its key");
		}
		return {
			token: currentToken,
			boundary,
			pendingNewestId: getCachedMentionPendingNewestId(current.value),
		};
	}

	return undefined;
}

function isNumericTweetId(value: string | undefined | null): value is string {
	return typeof value === "string" && /^[0-9]+$/.test(value);
}

export function maxNumericTweetId(...ids: Array<string | undefined | null>) {
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

export function getNewestMentionId(payload: XurlMentionsResponse) {
	return maxNumericTweetId(
		typeof payload.meta?.newest_id === "string"
			? payload.meta.newest_id
			: undefined,
		...payload.data.map((tweet) => tweet.id),
	);
}

export function readMentionHighWaterId(
	db: Database,
	mode: MentionLiveSource,
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

export function writeMentionHighWaterId(
	db: Database,
	mode: MentionLiveSource,
	accountId: string,
	sinceId: string | undefined,
) {
	if (!isNumericTweetId(sinceId)) {
		return;
	}
	writeSyncCache(getMentionHighWaterKey({ mode, accountId }), { sinceId }, db);
}

export function findNewestMentionId(
	db: Database,
	accountId: string,
	source: "archive" | "all" = "archive",
) {
	const row = db
		.prepare(
			`
      select t.id
      from tweets t
      join tweet_account_edges e
        on e.tweet_id = t.id
      where e.account_id = ?
        and e.kind = 'mention'
        and ${source === "archive" ? "e.source in ('archive', 'legacy')" : "1"}
		and t.deleted_at is null
		and t.superseded_at is null
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

function parseStoredBoundary(value: string): MentionScanBoundary {
	if (value === "auto" || value === "unbounded") return { kind: value };
	if (value.startsWith("since=")) {
		const sinceId = decodeURIComponent(value.slice(6));
		if (isNumericTweetId(sinceId)) return { kind: "since", sinceId };
	}
	if (value.startsWith("start=")) {
		const startTime = decodeURIComponent(value.slice(6));
		if (Number.isFinite(Date.parse(startTime)))
			return { kind: "start", startTime };
	}
	throw new Error("Invalid stored mentions cursor boundary");
}

/** Newest-page reads and saved continuations share ingestion, not scan position. */
export function selectMentionScan(
	db: Database,
	initial: MentionScanShape,
	intent: MentionSyncIntent,
) {
	if (initial.mode === "bird") return { shape: initial, cursor: undefined };
	if (intent === "latest") {
		const sinceId = findNewestMentionId(db, initial.accountId, "all");
		const boundary: MentionScanBoundary = sinceId
			? { kind: "since", sinceId }
			: { kind: "unbounded" };
		return { shape: { ...initial, boundary }, cursor: undefined };
	}
	if (intent === "resume") {
		const automatic = getMentionCursorKey({
			...initial,
			boundary: { kind: "auto" },
		});
		const prefix = automatic.slice(0, -"auto".length);
		const rows = db
			.prepare(`
      select cache_key from sync_cache
      where cache_key >= ? and cache_key < ?
      order by case when cache_key = ? then 1 else 0 end, updated_at, cache_key
    `)
			.all(prefix, `${prefix}\uffff`, automatic) as Array<{
			cache_key: string;
		}>;
		for (const row of rows) {
			const shape = {
				...initial,
				boundary: parseStoredBoundary(row.cache_key.slice(prefix.length)),
			};
			if (getMentionCursorKey(shape) !== row.cache_key)
				throw new Error("Noncanonical stored mentions cursor boundary");
			const cursor = readMentionCursor(db, shape);
			if (cursor) return { shape, cursor };
		}
	}
	return { shape: initial, cursor: readMentionCursor(db, initial) };
}
