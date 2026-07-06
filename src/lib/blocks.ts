import { Effect } from "effect";
import { getNativeDb } from "./db";
import { databaseWriteEffect } from "./database-writer";
import { runEffectPromise } from "./effect-runtime";
import { getAccountHandle, getDefaultAccountId } from "./moderation-target";
import {
	createModerationActions,
	listModerationState,
	pruneRemoteModerationRows,
	recordRemoteModerationRow,
	searchModerationCandidates,
} from "./moderation-state";
import type { BlockListResponse } from "./api-contracts";
import type { BlockItem, BlockSearchItem, XurlMentionUser } from "./types";
import { upsertProfileFromXUser } from "./x-profile";
import {
	listBlockedUsersEffect,
	lookupAuthenticatedUserFreshEffect,
} from "./xurl";

const blockActions = createModerationActions("block");

export function addBlock(...args: Parameters<typeof blockActions.add>) {
	return blockActions.add(...args);
}

export function addBlockEffect(
	...args: Parameters<typeof blockActions.addEffect>
) {
	return blockActions.addEffect(...args);
}

export function recordBlock(...args: Parameters<typeof blockActions.record>) {
	return blockActions.record(...args);
}

export function removeBlock(...args: Parameters<typeof blockActions.remove>) {
	return blockActions.remove(...args);
}

export function removeBlockEffect(
	...args: Parameters<typeof blockActions.removeEffect>
) {
	return blockActions.removeEffect(...args);
}

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

export function listBlocks({
	account,
	search,
	limit = 50,
}: {
	account?: string;
	search?: string;
	limit?: number;
} = {}): BlockItem[] {
	return listModerationState("block", { account, search, limit });
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
	return searchModerationCandidates("block", { accountId, search, limit });
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
			const me = yield* lookupAuthenticatedUserFreshEffect();
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
				const page: {
					items: XurlMentionUser[];
					nextToken: string | null;
				} = yield* listBlockedUsersEffect(sourceUserId, nextToken ?? undefined);
				const pageProfileIds = yield* databaseWriteEffect((writeDb) => {
					return page.items.map((user) => {
						const resolved = upsertProfileFromXUser(writeDb, user);
						recordRemoteModerationRow(
							writeDb,
							"block",
							resolvedAccountId,
							resolved.profile.id,
							blockedAt,
						);
						return resolved.profile.id;
					});
				}, db);
				remoteProfileIds.push(...pageProfileIds);
				nextToken = page.nextToken;
				pageCount += 1;
			} while (nextToken && pageCount < 20);

			completed = !nextToken;
			if (completed) {
				yield* databaseWriteEffect(
					(writeDb) =>
						pruneRemoteModerationRows(
							writeDb,
							"block",
							resolvedAccountId,
							remoteProfileIds,
						),
					db,
				);
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
