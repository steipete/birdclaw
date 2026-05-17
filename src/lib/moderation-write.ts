import type { Database } from "./sqlite";
import { Effect } from "effect";
import type { ActionsTransport } from "./config";
import { getNativeDb } from "./db";
import { runEffectPromise } from "./effect-runtime";
import {
	getAccountHandle,
	getDefaultAccountId,
	normalizeProfileQuery,
	resolveProfileEffect,
} from "./moderation-target";
import { getExternalUserId } from "./x-profile";

export interface ModerationActionOptions {
	transport?: ActionsTransport;
}

interface ResolveModerationTargetParams {
	accountId: string;
	query: string;
	selfActionError: string;
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

export function resolveModerationTargetEffect({
	accountId,
	query,
	selfActionError,
}: ResolveModerationTargetParams) {
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

		const resolved = yield* resolveProfileEffect(query);
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
						.get(account.handle.replace(/^@/, "")) as
						| { id: string }
						| undefined)
				: undefined,
		);
		const accountExternalUserId =
			account?.external_user_id ?? getExternalUserId(accountProfile?.id ?? "");
		if (
			resolved.profile.handle.toLowerCase() === accountHandle.toLowerCase() ||
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

export function resolveModerationTarget(params: ResolveModerationTargetParams) {
	return runEffectPromise(resolveModerationTargetEffect(params));
}

export function writeModerationRow(
	db: Database,
	table: "blocks" | "mutes",
	accountId: string,
	profileId: string,
	createdAt: string,
) {
	db.prepare(
		`
    insert into ${table} (account_id, profile_id, source, created_at)
    values (?, ?, 'manual', ?)
    on conflict(account_id, profile_id) do update set
      source = excluded.source,
      created_at = excluded.created_at
    `,
	).run(accountId, profileId, createdAt);
}

export function deleteModerationRow(
	db: Database,
	table: "blocks" | "mutes",
	accountId: string,
	profileId: string,
) {
	db.prepare(
		`delete from ${table} where account_id = ? and profile_id = ?`,
	).run(accountId, profileId);
}
