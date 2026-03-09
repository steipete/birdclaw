import type Database from "better-sqlite3";
import { getNativeDb } from "./db";
import type {
	BlockItem,
	BlockListResponse,
	BlockSearchItem,
	ProfileRecord,
	XurlMentionUser,
} from "./types";
import { getExternalUserId, upsertProfileFromXUser } from "./x-profile";
import {
	blockUserViaXurl,
	listBlockedUsers,
	lookupAuthenticatedUser,
	lookupUsersByHandles,
	lookupUsersByIds,
	unblockUserViaXurl,
} from "./xurl";

interface ResolvedProfile {
	profile: ProfileRecord;
	externalUserId: string | null;
}

function remoteBlockSyncDisabled() {
	return process.env.BIRDCLAW_DISABLE_LIVE_WRITES === "1";
}

function toProfile(row: Record<string, unknown>): ProfileRecord {
	return {
		id: String(row.id),
		handle: String(row.handle),
		displayName: String(row.display_name),
		bio: String(row.bio),
		followersCount: Number(row.followers_count),
		avatarHue: Number(row.avatar_hue),
		avatarUrl:
			typeof row.avatar_url === "string" ? String(row.avatar_url) : undefined,
		createdAt: String(row.created_at),
	};
}

function normalizeProfileQuery(value: string) {
	const trimmed = value.trim();
	if (!trimmed) return "";

	const withoutPrefix = trimmed.replace(/^@/, "");
	const urlMatch = withoutPrefix.match(
		/^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([^/?#]+)/i,
	);
	return (urlMatch?.[1] ?? withoutPrefix).replace(/^@/, "").trim();
}

function getDefaultAccountId(db: Database.Database) {
	const row = db
		.prepare(
			`
      select id
      from accounts
      order by is_default desc, created_at asc
      limit 1
      `,
		)
		.get() as { id: string } | undefined;
	return row?.id ?? "acct_primary";
}

function getAccountHandle(db: Database.Database, accountId: string) {
	const row = db
		.prepare("select handle from accounts where id = ?")
		.get(accountId) as { handle: string } | undefined;
	return row?.handle.replace(/^@/, "") ?? "";
}

function resolveLocalProfile(
	db: Database.Database,
	normalizedQuery: string,
): ResolvedProfile | null {
	const row = db
		.prepare(
			`
      select id, handle, display_name, bio, followers_count, avatar_hue, avatar_url, created_at
      from profiles
      where id = ? or handle = ?
      limit 1
      `,
		)
		.get(normalizedQuery, normalizedQuery) as
		| Record<string, unknown>
		| undefined;

	if (!row) {
		return null;
	}

	const profile = toProfile(row);
	return {
		profile,
		externalUserId: getExternalUserId(profile.id),
	};
}

async function resolveProfile(query: string): Promise<ResolvedProfile> {
	const db = getNativeDb();
	const normalizedQuery = normalizeProfileQuery(query);
	if (!normalizedQuery) {
		throw new Error("Missing profile handle or id");
	}

	const local = resolveLocalProfile(db, normalizedQuery);
	if (
		local &&
		!local.profile.id.startsWith("profile_group_") &&
		local.externalUserId
	) {
		return local;
	}

	let user: Record<string, unknown> | undefined;
	try {
		if (/^\d+$/.test(normalizedQuery)) {
			[user] = await lookupUsersByIds([normalizedQuery]);
		} else {
			[user] = await lookupUsersByHandles([
				local?.profile.handle ?? normalizedQuery,
			]);
		}
	} catch (error) {
		if (local) {
			return local;
		}
		throw error;
	}

	if (!user) {
		if (local) {
			return local;
		}
		throw new Error(`Profile not found: ${query}`);
	}

	if (local) {
		return upsertProfileFromXUser(db, user as XurlMentionUser);
	}

	const username = String(user.username ?? "").replace(/^@/, "");
	if (username) {
		const localByHandle = resolveLocalProfile(db, username);
		if (localByHandle) {
			return upsertProfileFromXUser(db, user as XurlMentionUser);
		}
	}

	return upsertProfileFromXUser(db, user as XurlMentionUser);
}

async function getAuthenticatedUserId() {
	try {
		const me = await lookupAuthenticatedUser();
		const id = me?.id;
		return typeof id === "string" && id.length > 0 ? id : null;
	} catch {
		return null;
	}
}

function upsertRemoteBlock(
	db: Database.Database,
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
	db: Database.Database,
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

export async function addBlock(accountId: string, query: string) {
	const db = getNativeDb();
	const resolvedAccountId = accountId || getDefaultAccountId(db);
	const accountHandle = getAccountHandle(db, resolvedAccountId);
	if (normalizeProfileQuery(query) === accountHandle) {
		throw new Error("Cannot block the current account");
	}
	const resolved = await resolveProfile(query);

	const blockedAt = new Date().toISOString();
	db.prepare(
		`
    insert into blocks (account_id, profile_id, source, created_at)
    values (?, ?, 'manual', ?)
    on conflict(account_id, profile_id) do update set
      source = excluded.source,
      created_at = excluded.created_at
    `,
	).run(resolvedAccountId, resolved.profile.id, blockedAt);

	const sourceUserId = await getAuthenticatedUserId();
	const transport =
		sourceUserId && resolved.externalUserId
			? await blockUserViaXurl(sourceUserId, resolved.externalUserId)
			: {
					ok: false,
					output: "xurl block transport unavailable for this profile",
				};

	return {
		ok: true,
		action: "block",
		accountId: resolvedAccountId,
		blockedAt,
		profile: resolved.profile,
		transport,
	};
}

export async function removeBlock(accountId: string, query: string) {
	const db = getNativeDb();
	const resolvedAccountId = accountId || getDefaultAccountId(db);
	const resolved = await resolveProfile(query);

	db.prepare("delete from blocks where account_id = ? and profile_id = ?").run(
		resolvedAccountId,
		resolved.profile.id,
	);

	const sourceUserId = await getAuthenticatedUserId();
	const transport =
		sourceUserId && resolved.externalUserId
			? await unblockUserViaXurl(sourceUserId, resolved.externalUserId)
			: {
					ok: false,
					output: "xurl unblock transport unavailable for this profile",
				};

	return {
		ok: true,
		action: "unblock",
		accountId: resolvedAccountId,
		profile: resolved.profile,
		transport,
	};
}

export async function syncBlocks(accountId: string) {
	const db = getNativeDb();
	const resolvedAccountId = accountId || getDefaultAccountId(db);
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

	try {
		const me = await lookupAuthenticatedUser();
		const sourceUserId =
			typeof me?.id === "string" && me.id.length > 0 ? me.id : null;
		const sourceUsername =
			typeof me?.username === "string" ? me.username.replace(/^@/, "") : "";
		const accountHandle = getAccountHandle(db, resolvedAccountId);

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

		if (accountHandle && sourceUsername && accountHandle !== sourceUsername) {
			return {
				ok: false,
				accountId: resolvedAccountId,
				synced: false,
				syncedCount: 0,
				transport: {
					ok: false,
					output: `xurl is authenticated as @${sourceUsername}, not @${accountHandle}`,
				},
			};
		}

		let nextToken: string | null = null;
		let pageCount = 0;

		do {
			const page = await listBlockedUsers(sourceUserId, nextToken ?? undefined);
			const mergeRemotePage = db.transaction(() => {
				for (const user of page.items) {
					const resolved = upsertProfileFromXUser(db, user as XurlMentionUser);
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
			nextToken = page.nextToken;
			pageCount += 1;
		} while (nextToken && pageCount < 20);

		const pruneMergedBlocks = db.transaction(() => {
			pruneRemoteBlocks(db, resolvedAccountId, remoteProfileIds);
		});
		pruneMergedBlocks();

		return {
			ok: true,
			accountId: resolvedAccountId,
			synced: true,
			syncedCount: remoteProfileIds.length,
			transport: {
				ok: true,
				output: `synced ${remoteProfileIds.length} remote blocks`,
			},
		};
	} catch (error) {
		return {
			ok: false,
			accountId: resolvedAccountId,
			synced: remoteProfileIds.length > 0,
			syncedCount: remoteProfileIds.length,
			transport: {
				ok: false,
				output:
					remoteProfileIds.length > 0
						? `partial block sync after ${remoteProfileIds.length} profiles: ${
								error instanceof Error
									? error.message
									: "xurl block sync failed"
							}`
						: error instanceof Error
							? error.message
							: "xurl block sync failed",
			},
		};
	}
}
