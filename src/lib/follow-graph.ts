import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { getNativeDb } from "./db";
import { runEffectPromise, trySync } from "./effect-runtime";
import { liveTransportGateway } from "./live-transport-gateway";
import type { Database } from "./sqlite";
import { readSyncCache, writeSyncCache } from "./sync-cache";
import { runSyncPlanEffect } from "./sync-plan";
import type {
	FollowEventKind,
	FollowDirection,
	FollowGraphEvent,
	FollowGraphProfile,
	FollowGraphSummary,
	XurlFollowUsersResponse,
	XurlMentionUser,
	XurlPublicMetrics,
} from "./types";
import { upsertProfileFromXUser } from "./x-profile";

const DEFAULT_FOLLOW_CACHE_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_FOLLOW_PAGE_LIMIT = 1000;
const MIN_FOLLOW_PAGE_LIMIT = 1;
const MAX_FOLLOW_PAGE_LIMIT = 1000;
const BIRD_FOLLOW_PAGE_LIMIT = 100;

export interface SyncFollowGraphOptions {
	direction: FollowDirection;
	account?: string;
	mode?: FollowGraphSyncMode;
	limit?: number;
	maxPages?: number;
	maxResources?: number;
	yes?: boolean;
	refresh?: boolean;
	allowPartial?: boolean;
	cacheTtlMs?: number;
}

type FollowGraphSyncMode = "auto" | "bird" | "xurl";
type FollowGraphLiveSource = "bird" | "xurl";

interface ResolvedAccount {
	accountId: string;
	username: string;
	externalUserId?: string;
	birdProfileName?: string;
}

interface MergedFollowPayload {
	data: XurlMentionUser[];
	meta: Record<string, unknown>;
	complete: boolean;
	pageCount: number;
	truncatedByMaxResources: boolean;
}

function parseLimit(value = DEFAULT_FOLLOW_PAGE_LIMIT) {
	if (
		!Number.isFinite(value) ||
		value < MIN_FOLLOW_PAGE_LIMIT ||
		value > MAX_FOLLOW_PAGE_LIMIT
	) {
		throw new Error("--limit must be between 1 and 1000 for follow sync");
	}
	return Math.floor(value);
}

function parseOptionalPositiveInteger(name: string, value?: number) {
	if (value === undefined) {
		return undefined;
	}
	if (!Number.isFinite(value) || value < 1) {
		throw new Error(`${name} must be at least 1`);
	}
	return Math.floor(value);
}

function parseCacheTtlMs(value?: number) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return DEFAULT_FOLLOW_CACHE_TTL_MS;
	}
	return Math.floor(value);
}

function parseJsonField<T>(value: unknown, fallback: T): T {
	if (typeof value !== "string" || value.length === 0) {
		return fallback;
	}
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function resolveAccount(db: Database, accountId?: string): ResolvedAccount {
	const row = accountId
		? (db
				.prepare(
					"select id, handle, external_user_id, bird_profile_name from accounts where id = ?",
				)
				.get(accountId) as
				| {
						id: string;
						handle: string;
						external_user_id: string | null;
						bird_profile_name: string | null;
				  }
				| undefined)
		: (db
				.prepare(
					`
          select id, handle, external_user_id, bird_profile_name
          from accounts
          order by is_default desc, created_at asc
          limit 1
          `,
				)
				.get() as
				| {
						id: string;
						handle: string;
						external_user_id: string | null;
						bird_profile_name: string | null;
				  }
				| undefined);

	if (!row) {
		throw new Error(`Unknown account: ${accountId ?? "default"}`);
	}

	return {
		accountId: row.id,
		username: row.handle.replace(/^@/, ""),
		externalUserId:
			typeof row.external_user_id === "string" &&
			row.external_user_id.length > 0
				? row.external_user_id
				: undefined,
		birdProfileName:
			typeof row.bird_profile_name === "string" &&
			row.bird_profile_name.length > 0
				? row.bird_profile_name
				: undefined,
	};
}

function buildCacheKey({
	direction,
	accountId,
	mode,
	limit,
	maxPages,
	maxResources,
}: {
	direction: FollowDirection;
	accountId: string;
	mode: FollowGraphSyncMode;
	limit: number;
	maxPages?: number;
	maxResources?: number;
}) {
	return [
		"follow-graph",
		direction,
		accountId,
		`mode:${mode}`,
		`limit:${String(limit)}`,
		`pages:${maxPages === undefined ? "all" : String(maxPages)}`,
		`resources:${maxResources === undefined ? "all" : String(maxResources)}`,
	].join(":");
}

function readCurrentCount(
	db: Database,
	accountId: string,
	direction: FollowDirection,
) {
	const row = db
		.prepare(
			`
      select count(*) as count
      from follow_edges
      where account_id = ? and direction = ? and current = 1
      `,
		)
		.get(accountId, direction) as { count: number };
	return Number(row.count);
}

function getLastSnapshot(
	db: Database,
	accountId: string,
	direction: FollowDirection,
	status: "complete" | "incomplete",
) {
	const row = db
		.prepare(
			`
      select completed_at
      from follow_snapshots
      where account_id = ? and direction = ? and status = ?
      order by completed_at desc
      limit 1
      `,
		)
		.get(accountId, direction, status) as { completed_at: string } | undefined;
	return row?.completed_at;
}

function mergePages(
	pages: XurlFollowUsersResponse[],
	nextToken: string | undefined,
	maxResources?: number,
): MergedFollowPayload {
	const users: XurlMentionUser[] = [];
	const seen = new Set<string>();
	let truncatedByMaxResources = false;

	for (const page of pages) {
		for (const user of page.data) {
			if (seen.has(user.id)) {
				continue;
			}
			if (maxResources !== undefined && users.length >= maxResources) {
				truncatedByMaxResources = true;
				break;
			}
			seen.add(user.id);
			users.push(user);
		}
		if (truncatedByMaxResources) {
			break;
		}
	}

	const lastPage = pages.at(-1);
	const payloadPageCount = Number(lastPage?.meta?.page_count);
	const pageCount =
		Number.isFinite(payloadPageCount) && payloadPageCount > pages.length
			? payloadPageCount
			: pages.length;
	return {
		data: users,
		meta: {
			...lastPage?.meta,
			result_count: users.length,
			page_count: pageCount,
			next_token: nextToken ?? null,
			truncated_by_max_resources: truncatedByMaxResources,
		},
		complete: !nextToken && !truncatedByMaxResources,
		pageCount,
		truncatedByMaxResources,
	};
}

function fetchFollowGraphViaXurlEffect({
	direction,
	username,
	userId,
	limit,
	maxPages,
	maxResources,
}: {
	direction: FollowDirection;
	username: string;
	userId?: string;
	limit: number;
	maxPages?: number;
	maxResources?: number;
}): Effect.Effect<MergedFollowPayload, unknown> {
	return Effect.gen(function* () {
		const result = yield* runSyncPlanEffect({
			fetchPage: ({ cursor }) =>
				liveTransportGateway.xurl.listFollowUsers({
					direction,
					username,
					userId,
					maxResults: limit,
					...(cursor ? { paginationToken: cursor } : {}),
				}),
			getItemCount: (page) => page.data.length,
			getNextCursor: (page) =>
				typeof page.meta?.next_token === "string"
					? String(page.meta.next_token)
					: undefined,
			maxItems: maxResources,
			maxPages,
		});

		return mergePages(result.pages, result.nextCursor, maxResources);
	});
}

function fetchFollowGraphViaBirdEffect({
	direction,
	userId,
	limit,
	maxPages,
	maxResources,
	profileName,
}: {
	direction: FollowDirection;
	userId?: string;
	limit: number;
	maxPages?: number;
	maxResources?: number;
	profileName: string;
}): Effect.Effect<MergedFollowPayload, unknown> {
	return Effect.gen(function* () {
		const birdLimit = Math.min(limit, BIRD_FOLLOW_PAGE_LIMIT);
		const cappedMaxPages =
			maxResources === undefined
				? maxPages
				: Math.min(
						maxPages ?? Number.POSITIVE_INFINITY,
						Math.ceil(maxResources / birdLimit),
					);
		const payload = yield* liveTransportGateway.bird.listFollowUsers({
			direction,
			userId,
			maxResults: Math.min(birdLimit, maxResources ?? birdLimit),
			all: true,
			maxPages: Number.isFinite(cappedMaxPages) ? cappedMaxPages : undefined,
			profileName,
		});
		return mergePages(
			[payload],
			typeof payload.meta?.next_token === "string"
				? String(payload.meta.next_token)
				: undefined,
			maxResources,
		);
	});
}

function fetchFollowGraphEffect({
	mode,
	direction,
	username,
	userId,
	limit,
	maxPages,
	maxResources,
	profileName,
}: {
	mode: FollowGraphSyncMode;
	direction: FollowDirection;
	username: string;
	userId?: string;
	limit: number;
	maxPages?: number;
	maxResources?: number;
	profileName: string;
}): Effect.Effect<
	{ source: FollowGraphLiveSource; payload: MergedFollowPayload },
	unknown
> {
	return Effect.gen(function* () {
		if (mode === "bird") {
			return {
				source: "bird",
				payload: yield* fetchFollowGraphViaBirdEffect({
					direction,
					userId,
					limit,
					maxPages,
					maxResources,
					profileName,
				}),
			};
		}
		if (mode === "xurl") {
			return {
				source: "xurl",
				payload: yield* fetchFollowGraphViaXurlEffect({
					direction,
					username,
					userId,
					limit,
					maxPages,
					maxResources,
				}),
			};
		}

		const birdResult = yield* fetchFollowGraphViaBirdEffect({
			direction,
			userId,
			limit,
			maxPages,
			maxResources,
			profileName,
		}).pipe(
			Effect.map((payload) => ({ ok: true as const, payload })),
			Effect.catchAll((error) => Effect.succeed({ ok: false as const, error })),
		);
		if (birdResult.ok) {
			return {
				source: "bird",
				payload: birdResult.payload,
			};
		}

		const xurlResult = yield* fetchFollowGraphViaXurlEffect({
			direction,
			username,
			userId,
			limit,
			maxPages,
			maxResources,
		}).pipe(
			Effect.map((payload) => ({ ok: true as const, payload })),
			Effect.catchAll((error) => Effect.succeed({ ok: false as const, error })),
		);
		if (xurlResult.ok) {
			return {
				source: "xurl",
				payload: xurlResult.payload,
			};
		}

		return yield* Effect.fail(
			new Error(
				`follow graph sync failed via bird and xurl: bird: ${errorMessage(
					birdResult.error,
				)}; xurl: ${errorMessage(xurlResult.error)}`,
			),
		);
	});
}

function getExistingEdges(
	db: Database,
	accountId: string,
	direction: FollowDirection,
) {
	const rows = db
		.prepare(
			`
      select profile_id, external_user_id, current
      from follow_edges
      where account_id = ? and direction = ?
      `,
		)
		.all(accountId, direction) as Array<{
		profile_id: string;
		external_user_id: string;
		current: number;
	}>;
	return new Map(rows.map((row) => [row.profile_id, row]));
}

function mergeFollowPayloadIntoLocalStore({
	db,
	accountId,
	direction,
	payload,
	source,
}: {
	db: Database;
	accountId: string;
	direction: FollowDirection;
	payload: MergedFollowPayload;
	source: FollowGraphLiveSource | "cache";
}) {
	const now = new Date().toISOString();
	const snapshotId = `follow_snapshot_${randomUUID()}`;
	const status = payload.complete ? "complete" : "incomplete";

	const insertSnapshot = db.prepare(`
    insert into follow_snapshots (
      id, account_id, direction, source, status, page_count, result_count,
      started_at, completed_at, raw_meta_json
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
	const insertMember = db.prepare(`
    insert into follow_snapshot_members (
      snapshot_id, profile_id, external_user_id, position
    ) values (?, ?, ?, ?)
  `);
	const insertEdge = db.prepare(`
    insert into follow_edges (
      account_id, direction, profile_id, external_user_id, source, current,
      first_seen_at, last_seen_at, ended_at, updated_at
    ) values (?, ?, ?, ?, ?, 1, ?, ?, null, ?)
    on conflict(account_id, direction, profile_id) do update set
      external_user_id = excluded.external_user_id,
      source = excluded.source,
      current = 1,
      last_seen_at = excluded.last_seen_at,
      ended_at = null,
      updated_at = excluded.updated_at
  `);
	const endEdge = db.prepare(`
    update follow_edges
    set current = 0, ended_at = ?, updated_at = ?
    where account_id = ? and direction = ? and profile_id = ?
  `);
	const insertEvent = db.prepare(`
    insert into follow_events (
      id, account_id, direction, profile_id, external_user_id, kind, event_at, snapshot_id
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
  `);

	return db.transaction(() => {
		const existingEdges = getExistingEdges(db, accountId, direction);
		const currentProfileIds = new Set<string>();

		insertSnapshot.run(
			snapshotId,
			accountId,
			direction,
			source,
			status,
			payload.pageCount,
			payload.data.length,
			now,
			now,
			JSON.stringify(payload.meta),
		);

		payload.data.forEach((user, index) => {
			const resolved = upsertProfileFromXUser(db, user);
			currentProfileIds.add(resolved.profile.id);
			insertMember.run(
				snapshotId,
				resolved.profile.id,
				resolved.externalUserId,
				index,
			);

			if (!payload.complete) {
				return;
			}

			const previous = existingEdges.get(resolved.profile.id);
			insertEdge.run(
				accountId,
				direction,
				resolved.profile.id,
				resolved.externalUserId,
				source,
				now,
				now,
				now,
			);
			if (!previous || previous.current === 0) {
				insertEvent.run(
					`follow_event_${randomUUID()}`,
					accountId,
					direction,
					resolved.profile.id,
					resolved.externalUserId,
					"started",
					now,
					snapshotId,
				);
			}
		});

		if (payload.complete) {
			for (const [profileId, previous] of existingEdges) {
				if (previous.current === 1 && !currentProfileIds.has(profileId)) {
					endEdge.run(now, now, accountId, direction, profileId);
					insertEvent.run(
						`follow_event_${randomUUID()}`,
						accountId,
						direction,
						profileId,
						previous.external_user_id,
						"ended",
						now,
						snapshotId,
					);
				}
			}
		}

		return {
			snapshotId,
			status,
			count: payload.data.length,
			pageCount: payload.pageCount,
		};
	})();
}

function makeDryRunResponse({
	db,
	account,
	direction,
	mode,
	limit,
	maxPages,
	maxResources,
	cacheKey,
	cacheTtlMs,
}: {
	db: Database;
	account: ResolvedAccount;
	direction: FollowDirection;
	mode: FollowGraphSyncMode;
	limit: number;
	maxPages?: number;
	maxResources?: number;
	cacheKey: string;
	cacheTtlMs: number;
}) {
	const cached = readSyncCache<MergedFollowPayload>(cacheKey, db);
	const cacheAgeMs = cached
		? Date.now() - new Date(cached.updatedAt).getTime()
		: Number.POSITIVE_INFINITY;
	const wouldCallLive = !cached || cacheAgeMs > cacheTtlMs;
	return {
		ok: true,
		dryRun: true,
		direction,
		accountId: account.accountId,
		mode,
		wouldCallLive,
		wouldCallX: mode === "bird" ? false : wouldCallLive,
		requiredFlag: "--yes",
		estimate: {
			maxResultsPerPage: limit,
			maxPages: maxPages ?? null,
			maxResources: maxResources ?? null,
			cacheTtlSeconds: Math.floor(cacheTtlMs / 1000),
		},
		cache: {
			key: cacheKey,
			hit: Boolean(cached),
			fresh: Boolean(cached && cacheAgeMs <= cacheTtlMs),
			updatedAt: cached?.updatedAt ?? null,
			ageSeconds: Number.isFinite(cacheAgeMs)
				? Math.floor(cacheAgeMs / 1000)
				: null,
			count: cached?.value.data.length ?? 0,
		},
		currentCount: readCurrentCount(db, account.accountId, direction),
		message:
			"Dry run only. Pass --yes to use a fresh cache or perform live follow graph sync.",
	};
}

function parseMode(value?: FollowGraphSyncMode) {
	if (!value || value === "auto" || value === "bird" || value === "xurl") {
		return value ?? "auto";
	}
	throw new Error("--mode must be auto, bird, or xurl");
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export function syncFollowGraphEffect(options: SyncFollowGraphOptions) {
	return Effect.gen(function* () {
		const db = yield* trySync(() => getNativeDb());
		const mode = yield* trySync(() => parseMode(options.mode));
		const limit = yield* trySync(() => parseLimit(options.limit));
		const maxPages = yield* trySync(() =>
			parseOptionalPositiveInteger("--max-pages", options.maxPages),
		);
		const maxResources = yield* trySync(() =>
			parseOptionalPositiveInteger("--max-resources", options.maxResources),
		);
		const cacheTtlMs = parseCacheTtlMs(options.cacheTtlMs);
		const account = yield* trySync(() => resolveAccount(db, options.account));
		const cacheKey = buildCacheKey({
			direction: options.direction,
			accountId: account.accountId,
			mode,
			limit,
			maxPages,
			maxResources,
		});

		if (!options.yes) {
			return yield* trySync(() =>
				makeDryRunResponse({
					db,
					account,
					direction: options.direction,
					mode,
					limit,
					maxPages,
					maxResources,
					cacheKey,
					cacheTtlMs,
				}),
			);
		}

		const cached = yield* trySync(() =>
			readSyncCache<MergedFollowPayload>(cacheKey, db),
		);
		const cacheAgeMs = cached
			? Date.now() - new Date(cached.updatedAt).getTime()
			: Number.POSITIVE_INFINITY;
		const useCache = Boolean(
			!options.refresh && cached && cacheAgeMs <= cacheTtlMs,
		);
		const birdProfileName = account.birdProfileName;
		if (!birdProfileName && mode !== "xurl") {
			return yield* Effect.fail(
				new Error("bird_profile_name is required to use bird"),
			);
		}

		const liveResult = useCache
			? undefined
			: yield* fetchFollowGraphEffect({
					mode,
					direction: options.direction,
					username: account.username,
					userId: account.externalUserId,
					limit,
					maxPages,
					maxResources,
					profileName: birdProfileName!,
				});
		const payload = useCache ? cached!.value : liveResult!.payload;

		if (!useCache) {
			yield* trySync(() => writeSyncCache(cacheKey, payload, db));
		}

		const mergeResult = yield* trySync(() =>
			mergeFollowPayloadIntoLocalStore({
				db,
				accountId: account.accountId,
				direction: options.direction,
				payload,
				source: useCache ? "cache" : liveResult!.source,
			}),
		);

		return {
			ok: true,
			dryRun: false,
			source: useCache ? "cache" : liveResult!.source,
			mode,
			direction: options.direction,
			accountId: account.accountId,
			status: mergeResult.status,
			count: mergeResult.count,
			pageCount: mergeResult.pageCount,
			snapshotId: mergeResult.snapshotId,
			partial: mergeResult.status === "incomplete",
			cache: {
				key: cacheKey,
				reused: useCache,
				updatedAt: useCache ? cached?.updatedAt : new Date().toISOString(),
			},
			warning:
				mergeResult.status === "incomplete" && !options.allowPartial
					? "Snapshot is incomplete because a page/resource cap stopped pagination. It was recorded but not used for churn events."
					: undefined,
		};
	});
}

export function syncFollowGraph(options: SyncFollowGraphOptions) {
	return runEffectPromise(syncFollowGraphEffect(options));
}

function toGraphProfile(row: Record<string, unknown>): FollowGraphProfile {
	return {
		id: String(row.profile_id ?? row.id),
		externalUserId: String(row.external_user_id),
		handle: String(row.handle),
		displayName: String(row.display_name),
		bio: String(row.bio ?? ""),
		followersCount: Number(row.followers_count ?? 0),
		publicMetrics: parseJsonField<XurlPublicMetrics>(
			row.public_metrics_json,
			{},
		),
		avatarUrl:
			typeof row.avatar_url === "string" && row.avatar_url.length > 0
				? String(row.avatar_url)
				: undefined,
	};
}

export function listTopFollowers({
	account,
	limit = 20,
}: {
	account?: string;
	limit?: number;
} = {}) {
	const db = getNativeDb();
	const resolved = resolveAccount(db, account);
	const rows = db
		.prepare(
			`
      select
        e.profile_id,
        e.external_user_id,
        p.handle,
        p.display_name,
        p.bio,
        p.followers_count,
        p.public_metrics_json,
        p.avatar_url
      from follow_edges e
      join profiles p on p.id = e.profile_id
      where e.account_id = ? and e.direction = 'followers' and e.current = 1
      order by p.followers_count desc, lower(p.handle) asc
      limit ?
      `,
		)
		.all(resolved.accountId, limit) as Array<Record<string, unknown>>;
	return {
		accountId: resolved.accountId,
		items: rows.map(toGraphProfile),
	};
}

export function listMutuals({
	account,
	limit = 100,
}: {
	account?: string;
	limit?: number;
} = {}) {
	const db = getNativeDb();
	const resolved = resolveAccount(db, account);
	const rows = db
		.prepare(
			`
      select
        following.profile_id,
        following.external_user_id,
        p.handle,
        p.display_name,
        p.bio,
        p.followers_count,
        p.public_metrics_json,
        p.avatar_url
      from follow_edges following
      join follow_edges followers
        on followers.account_id = following.account_id
        and followers.profile_id = following.profile_id
        and followers.direction = 'followers'
        and followers.current = 1
      join profiles p on p.id = following.profile_id
      where
        following.account_id = ?
        and following.direction = 'following'
        and following.current = 1
      order by p.followers_count desc, lower(p.handle) asc
      limit ?
      `,
		)
		.all(resolved.accountId, limit) as Array<Record<string, unknown>>;
	return {
		accountId: resolved.accountId,
		items: rows.map(toGraphProfile),
	};
}

export function listNonMutualFollowing({
	account,
	sort = "followers",
	limit = 100,
}: {
	account?: string;
	sort?: "followers" | "handle";
	limit?: number;
} = {}) {
	const db = getNativeDb();
	const resolved = resolveAccount(db, account);
	const orderBy =
		sort === "handle"
			? "lower(p.handle) asc"
			: "p.followers_count desc, lower(p.handle) asc";
	const rows = db
		.prepare(
			`
      select
        following.profile_id,
        following.external_user_id,
        p.handle,
        p.display_name,
        p.bio,
        p.followers_count,
        p.public_metrics_json,
        p.avatar_url
      from follow_edges following
      left join follow_edges followers
        on followers.account_id = following.account_id
        and followers.profile_id = following.profile_id
        and followers.direction = 'followers'
        and followers.current = 1
      join profiles p on p.id = following.profile_id
      where
        following.account_id = ?
        and following.direction = 'following'
        and following.current = 1
        and followers.profile_id is null
      order by ${orderBy}
      limit ?
      `,
		)
		.all(resolved.accountId, limit) as Array<Record<string, unknown>>;
	return {
		accountId: resolved.accountId,
		items: rows.map(toGraphProfile),
	};
}

export function listUnfollowedSince({
	account,
	date,
	direction = "followers",
	limit = 100,
}: {
	account?: string;
	date: string;
	direction?: FollowDirection;
	limit?: number;
}) {
	const db = getNativeDb();
	const resolved = resolveAccount(db, account);
	const since = date.includes("T") ? date : `${date}T00:00:00.000Z`;
	const rows = db
		.prepare(
			`
      select
        ev.event_at,
        ev.profile_id,
        ev.external_user_id,
        p.handle,
        p.display_name,
        p.bio,
        p.followers_count,
        p.public_metrics_json,
        p.avatar_url
      from follow_events ev
      join profiles p on p.id = ev.profile_id
      where
        ev.account_id = ?
        and ev.direction = ?
        and ev.kind = 'ended'
        and ev.event_at >= ?
      order by ev.event_at desc, p.followers_count desc
      limit ?
      `,
		)
		.all(resolved.accountId, direction, since, limit) as Array<
		Record<string, unknown>
	>;
	return {
		accountId: resolved.accountId,
		direction,
		since,
		items: rows.map((row) => ({
			eventAt: String(row.event_at),
			profile: toGraphProfile(row),
		})),
	};
}

export function listFollowEvents({
	account,
	direction,
	kind,
	since,
	until,
	limit = 100,
}: {
	account?: string;
	direction?: FollowDirection;
	kind?: FollowEventKind;
	since?: string;
	until?: string;
	limit?: number;
} = {}) {
	const db = getNativeDb();
	const resolved = resolveAccount(db, account);
	const where = ["ev.account_id = ?"];
	const params: unknown[] = [resolved.accountId];

	if (direction) {
		where.push("ev.direction = ?");
		params.push(direction);
	}
	if (kind) {
		where.push("ev.kind = ?");
		params.push(kind);
	}
	if (since) {
		where.push("ev.event_at >= ?");
		params.push(since.includes("T") ? since : `${since}T00:00:00.000Z`);
	}
	if (until) {
		where.push("ev.event_at < ?");
		params.push(until.includes("T") ? until : `${until}T00:00:00.000Z`);
	}

	params.push(limit);
	const rows = db
		.prepare(
			`
      select
        ev.event_at,
        ev.direction,
        ev.kind,
        ev.snapshot_id,
        ev.profile_id,
        ev.external_user_id,
        p.handle,
        p.display_name,
        p.bio,
        p.followers_count,
        p.public_metrics_json,
        p.avatar_url
      from follow_events ev
      join profiles p on p.id = ev.profile_id
      where ${where.join(" and ")}
      order by ev.event_at desc, p.followers_count desc, lower(p.handle) asc
      limit ?
      `,
		)
		.all(...params) as Array<Record<string, unknown>>;

	return {
		accountId: resolved.accountId,
		items: rows.map(
			(row): FollowGraphEvent => ({
				eventAt: String(row.event_at),
				direction: row.direction as FollowDirection,
				kind: row.kind as FollowEventKind,
				snapshotId: String(row.snapshot_id),
				profile: toGraphProfile(row),
			}),
		),
	};
}

export function getFollowGraphSummary({
	account,
}: { account?: string } = {}): FollowGraphSummary {
	const db = getNativeDb();
	const resolved = resolveAccount(db, account);
	const followers = readCurrentCount(db, resolved.accountId, "followers");
	const following = readCurrentCount(db, resolved.accountId, "following");
	const mutualsRow = db
		.prepare(
			`
      select count(*) as count
      from follow_edges following
      join follow_edges followers
        on followers.account_id = following.account_id
        and followers.profile_id = following.profile_id
        and followers.direction = 'followers'
        and followers.current = 1
      where
        following.account_id = ?
        and following.direction = 'following'
        and following.current = 1
      `,
		)
		.get(resolved.accountId) as { count: number };

	return {
		accountId: resolved.accountId,
		followers,
		following,
		mutuals: Number(mutualsRow.count),
		nonMutualFollowing: following - Number(mutualsRow.count),
		lastCompleteSnapshots: {
			followers: getLastSnapshot(
				db,
				resolved.accountId,
				"followers",
				"complete",
			),
			following: getLastSnapshot(
				db,
				resolved.accountId,
				"following",
				"complete",
			),
		},
		lastIncompleteSnapshots: {
			followers: getLastSnapshot(
				db,
				resolved.accountId,
				"followers",
				"incomplete",
			),
			following: getLastSnapshot(
				db,
				resolved.accountId,
				"following",
				"incomplete",
			),
		},
	};
}
