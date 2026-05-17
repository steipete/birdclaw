import { Effect } from "effect";
import type { Database } from "./sqlite";
import { getNativeDb } from "./db";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import {
	getAccountHandle,
	getDefaultAccountId,
	toProfile,
} from "./moderation-target";
import type { BlockItem, BlockListResponse, BlockSearchItem } from "./types";
import { upsertProfileFromXUser } from "./x-profile";
import { listBlockedUsers, lookupAuthenticatedUserFresh } from "./xurl";

export {
	addBlock,
	addBlockEffect,
	recordBlock,
	recordBlockEffect,
	removeBlock,
	removeBlockEffect,
} from "./blocks-write";

function remoteBlockSyncDisabled() {
	return process.env.BIRDCLAW_DISABLE_LIVE_WRITES === "1";
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

function upsertRemoteBlock(
	db: Database,
	accountId: string,
	profileId: string,
	blockedAt: string,
) {
	db.prepare(
		`
    insert into blocks (account_id, profile_id, source, created_at)
    values (?, ?, 'remote', ?)
    on conflict(account_id, profile_id) do update set
      source = excluded.source,
      created_at = blocks.created_at
    `,
	).run(accountId, profileId, blockedAt);
}

function pruneRemoteBlocks(
	db: Database,
	accountId: string,
	profileIds: string[],
) {
	if (profileIds.length === 0) {
		db.prepare(
			"delete from blocks where account_id = ? and source = 'remote'",
		).run(accountId);
		return;
	}

	const placeholders = profileIds.map(() => "?").join(", ");
	db.prepare(
		`
    delete from blocks
    where account_id = ?
      and source = 'remote'
      and profile_id not in (${placeholders})
    `,
	).run(accountId, ...profileIds);
}

export function listBlocks({
	account,
	search,
	limit = 50,
}: {
	account?: string;
	search?: string;
	limit?: number;
} = {}): BlockItem[] {
	const db = getNativeDb();
	const params: Array<string | number> = [];
	let where = "where 1 = 1";

	if (account && account !== "all") {
		where += " and b.account_id = ?";
		params.push(account);
	}

	if (search?.trim()) {
		where += " and (p.handle like ? or p.display_name like ? or p.bio like ?)";
		params.push(
			`%${search.trim()}%`,
			`%${search.trim()}%`,
			`%${search.trim()}%`,
		);
	}

	params.push(limit);

	const rows = db
		.prepare(
			`
      select
        b.account_id,
        a.handle as account_handle,
        b.source,
        b.created_at as blocked_at,
        p.id,
        p.handle,
        p.display_name,
        p.bio,
        p.followers_count,
        p.avatar_hue,
        p.avatar_url,
        p.created_at
      from blocks b
      join accounts a on a.id = b.account_id
      join profiles p on p.id = b.profile_id
      ${where}
      order by b.created_at desc
      limit ?
      `,
		)
		.all(...params) as Array<Record<string, unknown>>;

	return rows.map((row) => ({
		accountId: String(row.account_id),
		accountHandle: String(row.account_handle),
		source: String(row.source),
		blockedAt: String(row.blocked_at),
		profile: toProfile(row),
	}));
}

export function searchBlockCandidates({
	accountId,
	search,
	limit = 8,
}: {
	accountId: string;
	search?: string;
	limit?: number;
}): BlockSearchItem[] {
	const db = getNativeDb();
	if (!search?.trim()) {
		return [];
	}

	const accountHandle = getAccountHandle(db, accountId);
	const rows = db
		.prepare(
			`
      select
        p.id,
        p.handle,
        p.display_name,
        p.bio,
        p.followers_count,
        p.avatar_hue,
        p.avatar_url,
        p.created_at,
        b.created_at as blocked_at
      from profiles p
      left join blocks b
        on b.profile_id = p.id
       and b.account_id = ?
      where p.id != 'profile_me'
        and p.handle != ?
        and (
          p.handle like ?
          or p.display_name like ?
          or p.bio like ?
        )
      order by
        case when b.created_at is null then 1 else 0 end,
        b.created_at desc,
        p.followers_count desc,
        p.display_name asc
      limit ?
      `,
		)
		.all(
			accountId,
			accountHandle,
			`%${search.trim()}%`,
			`%${search.trim()}%`,
			`%${search.trim()}%`,
			limit,
		) as Array<Record<string, unknown>>;

	return rows.map((row) => ({
		profile: toProfile(row),
		isBlocked: Boolean(row.blocked_at),
		blockedAt:
			typeof row.blocked_at === "string" ? String(row.blocked_at) : undefined,
	}));
}

export function getBlocksResponse({
	accountId,
	search,
	limit,
}: {
	accountId?: string;
	search?: string;
	limit?: number;
}): BlockListResponse {
	const db = getNativeDb();
	const resolvedAccountId =
		accountId && accountId !== "all" ? accountId : getDefaultAccountId(db);

	return {
		items: listBlocks({ account: accountId, search, limit }),
		matches: searchBlockCandidates({
			accountId: resolvedAccountId,
			search,
			limit: Math.min(limit ?? 8, 12),
		}),
	};
}

export function syncBlocksEffect(accountId: string) {
	return Effect.gen(function* () {
		const db = yield* trySync(() => getNativeDb());
		const resolvedAccountId = accountId || getDefaultAccountId(db);
		const accountHandle = getAccountHandle(db, resolvedAccountId);
		if (!accountHandle) {
			return yield* Effect.fail(
				new Error(`Unknown account: ${resolvedAccountId}`),
			);
		}
		const account = yield* trySync(
			() =>
				db
					.prepare("select handle, external_user_id from accounts where id = ?")
					.get(resolvedAccountId) as
					| { handle: string; external_user_id: string | null }
					| undefined,
		);
		const blockedAt = new Date().toISOString();
		const remoteProfileIds: string[] = [];

		if (remoteBlockSyncDisabled()) {
			return {
				ok: true,
				accountId: resolvedAccountId,
				synced: false,
				syncedCount: 0,
				transport: {
					ok: true,
					output: "remote block sync disabled in test mode",
				},
			};
		}

		return yield* Effect.gen(function* () {
			const me = yield* tryPromise(() => lookupAuthenticatedUserFresh()).pipe(
				Effect.mapError(toError),
			);
			const sourceUserId =
				typeof me?.id === "string" && me.id.length > 0 ? me.id : null;
			const sourceUsername =
				typeof me?.username === "string" ? me.username.replace(/^@/, "") : "";
			const accountExternalUserId = account?.external_user_id?.trim() ?? "";
			if (!sourceUserId) {
				return {
					ok: false,
					accountId: resolvedAccountId,
					synced: false,
					syncedCount: 0,
					transport: {
						ok: false,
						output:
							"xurl block sync unavailable without an authenticated account",
					},
				};
			}

			if (accountExternalUserId && sourceUserId !== accountExternalUserId) {
				return {
					ok: false,
					accountId: resolvedAccountId,
					synced: false,
					syncedCount: 0,
					transport: {
						ok: false,
						output: `xurl is authenticated as user ${sourceUserId}, not account ${resolvedAccountId}`,
					},
				};
			}

			if (
				!accountExternalUserId &&
				(!sourceUsername || accountHandle !== sourceUsername)
			) {
				return {
					ok: false,
					accountId: resolvedAccountId,
					synced: false,
					syncedCount: 0,
					transport: {
						ok: false,
						output: sourceUsername
							? `xurl is authenticated as @${sourceUsername}, not @${accountHandle}`
							: "xurl authenticated username unavailable",
					},
				};
			}

			let nextToken: string | null = null;
			let pageCount = 0;
			let completed = false;

			do {
				const page = yield* tryPromise(() =>
					listBlockedUsers(sourceUserId, nextToken ?? undefined),
				).pipe(Effect.mapError(toError));
				yield* trySync(() => {
					const mergeRemotePage = db.transaction(() => {
						for (const user of page.items) {
							const resolved = upsertProfileFromXUser(db, user);
							remoteProfileIds.push(resolved.profile.id);
							upsertRemoteBlock(
								db,
								resolvedAccountId,
								resolved.profile.id,
								blockedAt,
							);
						}
					});
					mergeRemotePage();
				});
				nextToken = page.nextToken;
				pageCount += 1;
			} while (nextToken && pageCount < 20);

			completed = !nextToken;
			if (completed) {
				yield* trySync(() => {
					const pruneMergedBlocks = db.transaction(() => {
						pruneRemoteBlocks(db, resolvedAccountId, remoteProfileIds);
					});
					pruneMergedBlocks();
				});
			}

			return {
				ok: true,
				accountId: resolvedAccountId,
				synced: true,
				syncedCount: remoteProfileIds.length,
				partial: !completed,
				transport: {
					ok: true,
					output: completed
						? `synced ${remoteProfileIds.length} remote blocks`
						: `synced ${remoteProfileIds.length} remote blocks (partial; skipped pruning)`,
				},
			};
		}).pipe(
			Effect.catchAll((error) =>
				Effect.succeed({
					ok: false,
					accountId: resolvedAccountId,
					synced: remoteProfileIds.length > 0,
					syncedCount: remoteProfileIds.length,
					transport: {
						ok: false,
						output:
							remoteProfileIds.length > 0
								? `partial block sync after ${remoteProfileIds.length} profiles: ${error.message}`
								: error.message,
					},
				}),
			),
		);
	});
}

export function syncBlocks(accountId: string) {
	return runEffectPromise(syncBlocksEffect(accountId));
}
