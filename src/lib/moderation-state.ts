import { Effect } from "effect";
import {
	type ActionTransportResult,
	runModerationAction,
} from "./actions-transport";
import type { ActionsTransport } from "./config";
import { getNativeDb } from "./db";
import { databaseWriteEffect } from "./database-writer";
import { runEffectPromise, tryPromise, trySync } from "./effect-runtime";
import {
	getAccountHandle,
	getDefaultAccountId,
	normalizeProfileQuery,
	resolveProfileEffect,
} from "./moderation-target";
import {
	normalizeProfileHandle,
	profileFromDbRow,
	profileHandleKey,
} from "./profile-row";
import type { Database } from "./sqlite";
import type { ModerationAction, ProfileRecord } from "./types";
import { getExternalUserId } from "./x-profile";

export type ModerationKind = "block" | "mute";

const moderationDescriptors = {
	block: {
		table: "blocks",
		addAction: "block",
		removeAction: "unblock",
		recordAction: "record-block",
		timestampKey: "blockedAt",
		predicateKey: "isBlocked",
		selfActionError: "Cannot block the current account",
	},
	mute: {
		table: "mutes",
		addAction: "mute",
		removeAction: "unmute",
		recordAction: "record-mute",
		timestampKey: "mutedAt",
		predicateKey: "isMuted",
		selfActionError: "Cannot mute the current account",
	},
} as const satisfies Record<
	ModerationKind,
	{
		table: "blocks" | "mutes";
		addAction: ModerationAction;
		removeAction: ModerationAction;
		recordAction: `record-${ModerationKind}`;
		timestampKey: "blockedAt" | "mutedAt";
		predicateKey: "isBlocked" | "isMuted";
		selfActionError: string;
	}
>;

type ModerationDescriptor<K extends ModerationKind> =
	(typeof moderationDescriptors)[K];

export interface ModerationActionOptions {
	transport?: ActionsTransport;
}

export interface ModerationListOptions {
	account?: string;
	search?: string;
	limit?: number;
}

interface ModerationItemBase {
	accountId: string;
	accountHandle: string;
	source: string;
	profile: ProfileRecord;
}

export type ModerationItem<K extends ModerationKind> = ModerationItemBase & {
	[P in ModerationDescriptor<K>["timestampKey"]]: string;
};

interface ModerationSearchItemBase {
	profile: ProfileRecord;
}

export type ModerationSearchItem<K extends ModerationKind> =
	ModerationSearchItemBase & {
		[P in ModerationDescriptor<K>["predicateKey"]]: boolean;
	} & {
		[P in ModerationDescriptor<K>["timestampKey"]]?: string;
	};

type AddAction<K extends ModerationKind> = K extends "block" ? "block" : "mute";
type RemoveAction<K extends ModerationKind> = K extends "block"
	? "unblock"
	: "unmute";
type RecordAction<K extends ModerationKind> = `record-${K}`;

interface ModerationActionResultBase {
	accountId: string;
	profile: ProfileRecord;
}

type ModerationAddSuccess<K extends ModerationKind> =
	ModerationActionResultBase & {
		ok: true;
		action: AddAction<K>;
		transport: ActionTransportResult;
	} & {
		[P in ModerationDescriptor<K>["timestampKey"]]: string;
	};

type ModerationAddFailure<K extends ModerationKind> =
	ModerationActionResultBase & {
		ok: false;
		action: AddAction<K>;
		transport: ActionTransportResult;
	};

type ModerationRecordResult<K extends ModerationKind> =
	ModerationActionResultBase & {
		ok: true;
		action: RecordAction<K>;
	} & {
		[P in ModerationDescriptor<K>["timestampKey"]]: string;
	};

type ModerationRemoveResult<K extends ModerationKind> =
	ModerationActionResultBase & {
		ok: boolean;
		action: RemoveAction<K>;
		transport: ActionTransportResult;
	};

export function listModerationState<K extends ModerationKind>(
	kind: K,
	{ account, search, limit = 50 }: ModerationListOptions = {},
): ModerationItem<K>[] {
	const descriptor = moderationDescriptors[kind];
	const db = getNativeDb();
	const params: Array<string | number> = [];
	let where = "where 1 = 1";

	if (account && account !== "all") {
		where += " and state.account_id = ?";
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
        state.account_id,
        a.handle as account_handle,
        state.source,
        state.created_at as moderated_at,
        p.id,
        p.handle,
        p.display_name,
        p.bio,
        p.followers_count,
        p.avatar_hue,
        p.avatar_url,
        p.created_at
      from ${descriptor.table} state
      join accounts a on a.id = state.account_id
      join profiles p on p.id = state.profile_id
      ${where}
      order by state.created_at desc
      limit ?
      `,
		)
		.all(...params) as Array<Record<string, unknown>>;

	return rows.map(
		(row) =>
			({
				accountId: String(row.account_id),
				accountHandle: String(row.account_handle),
				source: String(row.source),
				[descriptor.timestampKey]: String(row.moderated_at),
				profile: profileFromDbRow(row),
			}) as unknown as ModerationItem<K>,
	);
}

export function searchModerationCandidates<K extends ModerationKind>(
	kind: K,
	{
		accountId,
		search,
		limit = 8,
	}: {
		accountId: string;
		search?: string;
		limit?: number;
	},
): ModerationSearchItem<K>[] {
	const descriptor = moderationDescriptors[kind];
	const db = getNativeDb();
	if (!search?.trim()) return [];

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
        state.created_at as moderated_at
      from profiles p
      left join ${descriptor.table} state
        on state.profile_id = p.id
       and state.account_id = ?
      where p.id != 'profile_me'
        and p.handle != ?
        and (
          p.handle like ?
          or p.display_name like ?
          or p.bio like ?
        )
      order by
        case when state.created_at is null then 1 else 0 end,
        state.created_at desc,
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

	return rows.map(
		(row) =>
			({
				profile: profileFromDbRow(row),
				[descriptor.predicateKey]: Boolean(row.moderated_at),
				...(typeof row.moderated_at === "string"
					? { [descriptor.timestampKey]: row.moderated_at }
					: {}),
			}) as unknown as ModerationSearchItem<K>,
	);
}

function upsertModerationRow(
	db: Database,
	kind: ModerationKind,
	accountId: string,
	profileId: string,
	source: "manual" | "remote",
	createdAt: string,
	preserveCreatedAt: boolean,
) {
	const { table } = moderationDescriptors[kind];
	db.prepare(
		`
    insert into ${table} (account_id, profile_id, source, created_at)
    values (?, ?, ?, ?)
    on conflict(account_id, profile_id) do update set
      source = excluded.source,
      created_at = ${preserveCreatedAt ? `${table}.created_at` : "excluded.created_at"}
    `,
	).run(accountId, profileId, source, createdAt);
}

export function recordModerationRow(
	db: Database,
	kind: ModerationKind,
	accountId: string,
	profileId: string,
	createdAt: string,
) {
	upsertModerationRow(
		db,
		kind,
		accountId,
		profileId,
		"manual",
		createdAt,
		false,
	);
}

export function recordRemoteModerationRow(
	db: Database,
	kind: ModerationKind,
	accountId: string,
	profileId: string,
	createdAt: string,
) {
	upsertModerationRow(
		db,
		kind,
		accountId,
		profileId,
		"remote",
		createdAt,
		true,
	);
}

export function removeModerationRow(
	db: Database,
	kind: ModerationKind,
	accountId: string,
	profileId: string,
) {
	const { table } = moderationDescriptors[kind];
	db.prepare(
		`delete from ${table} where account_id = ? and profile_id = ?`,
	).run(accountId, profileId);
}

export function pruneRemoteModerationRows(
	db: Database,
	kind: ModerationKind,
	accountId: string,
	profileIds: string[],
) {
	const { table } = moderationDescriptors[kind];
	if (profileIds.length === 0) {
		db.prepare(
			`delete from ${table} where account_id = ? and source = 'remote'`,
		).run(accountId);
		return;
	}

	const placeholders = profileIds.map(() => "?").join(", ");
	db.prepare(
		`
    delete from ${table}
    where account_id = ?
      and source = 'remote'
      and profile_id not in (${placeholders})
    `,
	).run(accountId, ...profileIds);
}

export function resolveModerationTargetEffect({
	accountId,
	query,
	selfActionError,
}: {
	accountId: string;
	query: string;
	selfActionError: string;
}) {
	return Effect.gen(function* () {
		const db = yield* trySync(() => getNativeDb());
		const resolvedAccountId = accountId || getDefaultAccountId(db);
		const accountHandle = yield* trySync(() =>
			getAccountHandle(db, resolvedAccountId),
		);
		if (!accountHandle) {
			return yield* Effect.fail(
				new Error(`Unknown account: ${resolvedAccountId}`),
			);
		}
		const normalizedQuery = normalizeProfileQuery(query);
		if (normalizedQuery.toLowerCase() === accountHandle.toLowerCase()) {
			return yield* Effect.fail(new Error(selfActionError));
		}

		const resolved = yield* resolveProfileEffect(query, db);
		const account = yield* trySync(
			() =>
				db
					.prepare("select handle, external_user_id from accounts where id = ?")
					.get(resolvedAccountId) as
					| { handle: string; external_user_id: string | null }
					| undefined,
		);
		const accountProfile = yield* trySync(() =>
			account
				? (db
						.prepare("select id from profiles where handle = ? limit 1")
						.get(normalizeProfileHandle(account.handle)) as
						| { id: string }
						| undefined)
				: undefined,
		);
		const accountExternalUserId =
			account?.external_user_id ?? getExternalUserId(accountProfile?.id ?? "");
		if (
			profileHandleKey(resolved.profile.handle) ===
				profileHandleKey(accountHandle) ||
			(accountProfile?.id && resolved.profile.id === accountProfile.id) ||
			(accountExternalUserId &&
				resolved.externalUserId === accountExternalUserId)
		) {
			return yield* Effect.fail(new Error(selfActionError));
		}

		return {
			db,
			resolved,
			resolvedAccountId,
			accountIdentity: {
				id: resolvedAccountId,
				handle: account?.handle ?? accountHandle,
				externalUserId: accountExternalUserId || null,
			},
			actionQuery:
				resolved.externalUserId ?? resolved.profile.handle ?? normalizedQuery,
		};
	});
}

export function addModerationEffect<K extends ModerationKind>(
	kind: K,
	accountId: string,
	query: string,
	options: ModerationActionOptions = {},
) {
	const descriptor = moderationDescriptors[kind];
	return Effect.gen(function* () {
		const { db, resolved, resolvedAccountId, accountIdentity, actionQuery } =
			yield* resolveModerationTargetEffect({
				accountId,
				query,
				selfActionError: descriptor.selfActionError,
			});
		const transport = yield* tryPromise(() =>
			runModerationAction({
				action: descriptor.addAction,
				query: actionQuery,
				targetUserId: resolved.externalUserId ?? undefined,
				transport: options.transport,
				expectedAccount: accountIdentity,
			}),
		);

		if (!transport.ok) {
			return {
				ok: false as const,
				action: descriptor.addAction,
				accountId: resolvedAccountId,
				profile: resolved.profile,
				transport,
			} as ModerationAddFailure<K>;
		}

		const createdAt = new Date().toISOString();
		yield* databaseWriteEffect(
			(writeDb) =>
				recordModerationRow(
					writeDb,
					kind,
					resolvedAccountId,
					resolved.profile.id,
					createdAt,
				),
			db,
		);

		return {
			ok: true as const,
			action: descriptor.addAction,
			accountId: resolvedAccountId,
			[descriptor.timestampKey]: createdAt,
			profile: resolved.profile,
			transport,
		} as unknown as ModerationAddSuccess<K>;
	});
}

export function addModeration<K extends ModerationKind>(
	kind: K,
	accountId: string,
	query: string,
	options: ModerationActionOptions = {},
) {
	return runEffectPromise(addModerationEffect(kind, accountId, query, options));
}

export function recordModerationEffect<K extends ModerationKind>(
	kind: K,
	accountId: string,
	query: string,
) {
	const descriptor = moderationDescriptors[kind];
	return Effect.gen(function* () {
		const { db, resolved, resolvedAccountId } =
			yield* resolveModerationTargetEffect({
				accountId,
				query,
				selfActionError: descriptor.selfActionError,
			});

		const createdAt = new Date().toISOString();
		yield* databaseWriteEffect(
			(writeDb) =>
				recordModerationRow(
					writeDb,
					kind,
					resolvedAccountId,
					resolved.profile.id,
					createdAt,
				),
			db,
		);

		return {
			ok: true as const,
			action: descriptor.recordAction,
			accountId: resolvedAccountId,
			[descriptor.timestampKey]: createdAt,
			profile: resolved.profile,
		} as unknown as ModerationRecordResult<K>;
	});
}

export function recordModeration<K extends ModerationKind>(
	kind: K,
	accountId: string,
	query: string,
) {
	return runEffectPromise(recordModerationEffect(kind, accountId, query));
}

export function removeModerationEffect<K extends ModerationKind>(
	kind: K,
	accountId: string,
	query: string,
	options: ModerationActionOptions = {},
) {
	const descriptor = moderationDescriptors[kind];
	return Effect.gen(function* () {
		const { db, resolved, resolvedAccountId, accountIdentity, actionQuery } =
			yield* resolveModerationTargetEffect({
				accountId,
				query,
				selfActionError: descriptor.selfActionError,
			});
		const transport = yield* tryPromise(() =>
			runModerationAction({
				action: descriptor.removeAction,
				query: actionQuery,
				targetUserId: resolved.externalUserId ?? undefined,
				transport: options.transport,
				expectedAccount: accountIdentity,
			}),
		);

		if (!transport.ok) {
			return {
				ok: false as const,
				action: descriptor.removeAction,
				accountId: resolvedAccountId,
				profile: resolved.profile,
				transport,
			} as ModerationRemoveResult<K>;
		}

		yield* databaseWriteEffect(
			(writeDb) =>
				removeModerationRow(
					writeDb,
					kind,
					resolvedAccountId,
					resolved.profile.id,
				),
			db,
		);

		return {
			ok: true as const,
			action: descriptor.removeAction,
			accountId: resolvedAccountId,
			profile: resolved.profile,
			transport,
		} as ModerationRemoveResult<K>;
	});
}

export function removeModeration<K extends ModerationKind>(
	kind: K,
	accountId: string,
	query: string,
	options: ModerationActionOptions = {},
) {
	return runEffectPromise(
		removeModerationEffect(kind, accountId, query, options),
	);
}

export function createModerationActions<K extends ModerationKind>(kind: K) {
	return {
		addEffect: (
			accountId: string,
			query: string,
			options: ModerationActionOptions = {},
		) => addModerationEffect(kind, accountId, query, options),
		add: (
			accountId: string,
			query: string,
			options: ModerationActionOptions = {},
		) => addModeration(kind, accountId, query, options),
		recordEffect: (accountId: string, query: string) =>
			recordModerationEffect(kind, accountId, query),
		record: (accountId: string, query: string) =>
			recordModeration(kind, accountId, query),
		removeEffect: (
			accountId: string,
			query: string,
			options: ModerationActionOptions = {},
		) => removeModerationEffect(kind, accountId, query, options),
		remove: (
			accountId: string,
			query: string,
			options: ModerationActionOptions = {},
		) => removeModeration(kind, accountId, query, options),
	};
}
