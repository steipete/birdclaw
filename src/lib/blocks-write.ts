import { Effect } from "effect";
import { runModerationAction } from "./actions-transport";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import {
	deleteModerationRow,
	type ModerationActionOptions,
	resolveModerationTargetEffect,
	writeModerationRow,
} from "./moderation-write";

function trySync<T>(try_: () => T) {
	return Effect.try({
		try: try_,
		catch: (error) =>
			error instanceof Error ? error : new Error(String(error)),
	});
}

export function addBlockEffect(
	accountId: string,
	query: string,
	options: ModerationActionOptions = {},
) {
	return Effect.gen(function* () {
		const { db, resolved, resolvedAccountId, actionQuery } =
			yield* resolveModerationTargetEffect({
				accountId,
				query,
				selfActionError: "Cannot block the current account",
			});
		const transport = yield* tryPromise(() =>
			runModerationAction({
				action: "block",
				query: actionQuery,
				targetUserId: resolved.externalUserId ?? undefined,
				transport: options.transport,
			}),
		);

		if (!transport.ok) {
			return {
				ok: false,
				action: "block",
				accountId: resolvedAccountId,
				profile: resolved.profile,
				transport,
			};
		}

		const blockedAt = new Date().toISOString();
		yield* trySync(() =>
			writeModerationRow(
				db,
				"blocks",
				resolvedAccountId,
				resolved.profile.id,
				blockedAt,
			),
		);

		return {
			ok: true,
			action: "block",
			accountId: resolvedAccountId,
			blockedAt,
			profile: resolved.profile,
			transport,
		};
	});
}

export function addBlock(
	accountId: string,
	query: string,
	options: ModerationActionOptions = {},
) {
	return runEffectPromise(addBlockEffect(accountId, query, options));
}

export function recordBlockEffect(accountId: string, query: string) {
	return Effect.gen(function* () {
		const { db, resolved, resolvedAccountId } =
			yield* resolveModerationTargetEffect({
				accountId,
				query,
				selfActionError: "Cannot block the current account",
			});

		const blockedAt = new Date().toISOString();
		yield* trySync(() =>
			writeModerationRow(
				db,
				"blocks",
				resolvedAccountId,
				resolved.profile.id,
				blockedAt,
			),
		);

		return {
			ok: true,
			action: "record-block",
			accountId: resolvedAccountId,
			blockedAt,
			profile: resolved.profile,
		};
	});
}

export function recordBlock(accountId: string, query: string) {
	return runEffectPromise(recordBlockEffect(accountId, query));
}

export function removeBlockEffect(
	accountId: string,
	query: string,
	options: ModerationActionOptions = {},
) {
	return Effect.gen(function* () {
		const { db, resolved, resolvedAccountId, actionQuery } =
			yield* resolveModerationTargetEffect({
				accountId,
				query,
				selfActionError: "Cannot block the current account",
			});
		const transport = yield* tryPromise(() =>
			runModerationAction({
				action: "unblock",
				query: actionQuery,
				targetUserId: resolved.externalUserId ?? undefined,
				transport: options.transport,
			}),
		);

		if (!transport.ok) {
			return {
				ok: false,
				action: "unblock",
				accountId: resolvedAccountId,
				profile: resolved.profile,
				transport,
			};
		}

		yield* trySync(() =>
			deleteModerationRow(db, "blocks", resolvedAccountId, resolved.profile.id),
		);

		return {
			ok: true,
			action: "unblock",
			accountId: resolvedAccountId,
			profile: resolved.profile,
			transport,
		};
	});
}

export function removeBlock(
	accountId: string,
	query: string,
	options: ModerationActionOptions = {},
) {
	return runEffectPromise(removeBlockEffect(accountId, query, options));
}
