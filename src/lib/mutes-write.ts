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

export function addMuteEffect(
	accountId: string,
	query: string,
	options: ModerationActionOptions = {},
) {
	return Effect.gen(function* () {
		const { db, resolved, resolvedAccountId, accountIdentity, actionQuery } =
			yield* resolveModerationTargetEffect({
				accountId,
				query,
				selfActionError: "Cannot mute the current account",
			});
		const transport = yield* tryPromise(() =>
			runModerationAction({
				action: "mute",
				query: actionQuery,
				targetUserId: resolved.externalUserId ?? undefined,
				transport: options.transport,
				expectedAccount: accountIdentity,
			}),
		);

		if (!transport.ok) {
			return {
				ok: false,
				action: "mute",
				accountId: resolvedAccountId,
				profile: resolved.profile,
				transport,
			};
		}

		const mutedAt = new Date().toISOString();
		yield* trySync(() =>
			writeModerationRow(
				db,
				"mutes",
				resolvedAccountId,
				resolved.profile.id,
				mutedAt,
			),
		);

		return {
			ok: true,
			action: "mute",
			accountId: resolvedAccountId,
			mutedAt,
			profile: resolved.profile,
			transport,
		};
	});
}

export function addMute(
	accountId: string,
	query: string,
	options: ModerationActionOptions = {},
) {
	return runEffectPromise(addMuteEffect(accountId, query, options));
}

export function recordMuteEffect(accountId: string, query: string) {
	return Effect.gen(function* () {
		const { db, resolved, resolvedAccountId } =
			yield* resolveModerationTargetEffect({
				accountId,
				query,
				selfActionError: "Cannot mute the current account",
			});

		const mutedAt = new Date().toISOString();
		yield* trySync(() =>
			writeModerationRow(
				db,
				"mutes",
				resolvedAccountId,
				resolved.profile.id,
				mutedAt,
			),
		);

		return {
			ok: true,
			action: "record-mute",
			accountId: resolvedAccountId,
			mutedAt,
			profile: resolved.profile,
		};
	});
}

export function recordMute(accountId: string, query: string) {
	return runEffectPromise(recordMuteEffect(accountId, query));
}

export function removeMuteEffect(
	accountId: string,
	query: string,
	options: ModerationActionOptions = {},
) {
	return Effect.gen(function* () {
		const { db, resolved, resolvedAccountId, accountIdentity, actionQuery } =
			yield* resolveModerationTargetEffect({
				accountId,
				query,
				selfActionError: "Cannot mute the current account",
			});
		const transport = yield* tryPromise(() =>
			runModerationAction({
				action: "unmute",
				query: actionQuery,
				targetUserId: resolved.externalUserId ?? undefined,
				transport: options.transport,
				expectedAccount: accountIdentity,
			}),
		);

		if (!transport.ok) {
			return {
				ok: false,
				action: "unmute",
				accountId: resolvedAccountId,
				profile: resolved.profile,
				transport,
			};
		}

		yield* trySync(() =>
			deleteModerationRow(db, "mutes", resolvedAccountId, resolved.profile.id),
		);

		return {
			ok: true,
			action: "unmute",
			accountId: resolvedAccountId,
			profile: resolved.profile,
			transport,
		};
	});
}

export function removeMute(
	accountId: string,
	query: string,
	options: ModerationActionOptions = {},
) {
	return runEffectPromise(removeMuteEffect(accountId, query, options));
}
