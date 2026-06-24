import {
	blockUserViaBird,
	muteUserViaBird,
	readBirdStatusViaBird,
	unblockUserViaBird,
	unmuteUserViaBird,
} from "./bird-actions";
import { type ActionsTransport, resolveActionsTransport } from "./config";
import { Effect } from "effect";
import { getNativeDb } from "./db";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import { profileHandleKey } from "./profile-row";
import type {
	ModerationAction,
	ModerationActionTransportResult,
	ModerationTransportKind,
} from "./types";
import {
	blockUserViaXurl,
	lookupAuthenticatedUserFresh,
	muteUserViaXurl,
	unblockUserViaXurl,
	unmuteUserViaXurl,
} from "./xurl";

export type ActionTransportResult = ModerationActionTransportResult;

interface RunActionParams {
	action: ModerationAction;
	query: string;
	targetUserId?: string;
	transport?: string;
	expectedAccount?: ExpectedActionAccount;
}

export interface ExpectedActionAccount {
	id: string;
	handle: string;
	externalUserId?: string | null;
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

function normalizeFailure(transport: ModerationTransportKind, output: string) {
	return `${transport}: ${output}`;
}

function liveWritesDisabled() {
	return process.env.BIRDCLAW_DISABLE_LIVE_WRITES === "1";
}

function readBirdProfileName(accountId: string) {
	const db = getNativeDb();
	const row = db
		.prepare("select bird_profile_name from accounts where id = ?")
		.get(accountId) as { bird_profile_name: string | null } | undefined;
	const profileName = row?.bird_profile_name?.trim();
	return profileName && profileName.length > 0 ? profileName : null;
}

function verifyExpectedAccountEffect(
	expectedAccount: ExpectedActionAccount | undefined,
) {
	return Effect.gen(function* () {
		if (!expectedAccount) return null;
		if (liveWritesDisabled()) return null;

		const sourceUser = yield* tryPromise(() => lookupAuthenticatedUserFresh());
		const sourceUserId =
			sourceUser && typeof sourceUser.id === "string" ? sourceUser.id : "";
		const sourceUsername =
			sourceUser && typeof sourceUser.username === "string"
				? profileHandleKey(sourceUser.username)
				: "";
		const expectedExternalUserId = expectedAccount.externalUserId?.trim() ?? "";
		const expectedHandle = profileHandleKey(expectedAccount.handle);

		if (expectedExternalUserId) {
			if (sourceUserId === expectedExternalUserId) return sourceUserId;
			return yield* Effect.fail(
				new Error(
					`xurl is authenticated as user ${sourceUserId || "unknown"}, not account ${expectedAccount.id}`,
				),
			);
		}

		if (expectedHandle && sourceUsername === expectedHandle)
			return sourceUserId;
		return yield* Effect.fail(
			new Error(
				sourceUsername
					? `xurl is authenticated as @${sourceUsername}, not @${expectedHandle}`
					: "xurl authenticated user unavailable",
			),
		);
	});
}

function runBirdActionEffect(
	action: ModerationAction,
	query: string,
	profileName: string,
): Effect.Effect<ActionTransportResult, unknown> {
	return Effect.gen(function* () {
		const result = yield* tryPromise(() =>
			action === "block"
				? blockUserViaBird(query, profileName)
				: action === "unblock"
					? unblockUserViaBird(query, profileName)
					: action === "mute"
						? muteUserViaBird(query, profileName)
						: unmuteUserViaBird(query, profileName),
		);

		return {
			...result,
			transport: "bird",
		};
	});
}

function getVerifyExpectation(action: ModerationAction) {
	return action === "block" || action === "unblock"
		? {
				field: "blocking" as const,
				expected: action === "block",
			}
		: {
				field: "muting" as const,
				expected: action === "mute",
			};
}

function runXurlActionEffect(
	action: ModerationAction,
	query: string,
	profileName: string,
	targetUserId?: string,
	verifiedSourceUserId?: string | null,
): Effect.Effect<ActionTransportResult, unknown> {
	return Effect.gen(function* () {
		if (!targetUserId) {
			return {
				ok: false,
				output: "missing target user id for xurl transport",
				transport: "xurl",
			};
		}

		let sourceUserId = verifiedSourceUserId ?? "";
		if (!sourceUserId) {
			const sourceUser = yield* tryPromise(() =>
				lookupAuthenticatedUserFresh(),
			);
			sourceUserId =
				sourceUser && typeof sourceUser.id === "string" ? sourceUser.id : "";
		}
		if (!sourceUserId) {
			return {
				ok: false,
				output: "xurl authenticated user unavailable",
				transport: "xurl",
			};
		}

		const result = yield* tryPromise(() =>
			action === "block"
				? blockUserViaXurl(sourceUserId, targetUserId)
				: action === "unblock"
					? unblockUserViaXurl(sourceUserId, targetUserId)
					: action === "mute"
						? muteUserViaXurl(sourceUserId, targetUserId)
						: unmuteUserViaXurl(sourceUserId, targetUserId),
		);

		if (!result.ok) {
			return {
				...result,
				transport: "xurl",
			};
		}

		const status = yield* tryPromise(() =>
			readBirdStatusViaBird(query, profileName),
		);
		const { field: verifyField, expected: expectedValue } =
			getVerifyExpectation(action);
		const actualValue =
			status && typeof status[verifyField] === "boolean"
				? Boolean(status[verifyField])
				: null;

		if (actualValue === null) {
			return {
				ok: false,
				output: `${result.output}\nxurl verify unavailable from bird status`,
				transport: "xurl",
			};
		}

		if (actualValue !== expectedValue) {
			return {
				ok: false,
				output: `${result.output}\nxurl verify mismatch ${verifyField}=${String(actualValue)}`,
				transport: "xurl",
			};
		}

		return {
			ok: true,
			output: `${result.output}\nverified ${verifyField}=${String(actualValue)}`,
			transport: "xurl",
		};
	});
}

export function runModerationActionEffect({
	action,
	query,
	targetUserId,
	transport,
	expectedAccount,
}: RunActionParams): Effect.Effect<ActionTransportResult, unknown> {
	return Effect.gen(function* () {
		const requestedTransport = yield* trySync(() =>
			resolveActionsTransport(transport),
		);

		const verifyXurlAccount = () =>
			verifyExpectedAccountEffect(expectedAccount).pipe(
				Effect.catchAll((error) =>
					Effect.succeed({
						ok: false as const,
						output: error instanceof Error ? error.message : String(error),
						transport: "xurl" as const,
					}),
				),
			);

		if (requestedTransport === "bird") {
			const profileName = expectedAccount?.id
				? readBirdProfileName(expectedAccount.id)
				: null;
			if (!profileName) {
				return {
					ok: false,
					output: "bird_profile_name is required to use bird",
					transport: "bird",
				};
			}
			return yield* runBirdActionEffect(action, query, profileName);
		}
		if (requestedTransport === "xurl") {
			const accountCheck = yield* verifyXurlAccount();
			if (accountCheck && typeof accountCheck === "object") {
				return accountCheck;
			}
			const profileName = expectedAccount?.id
				? readBirdProfileName(expectedAccount.id)
				: null;
			if (!profileName) {
				return {
					ok: false,
					output: "bird_profile_name is required to verify bird status",
					transport: "xurl",
				};
			}
			return yield* runXurlActionEffect(
				action,
				query,
				profileName,
				targetUserId,
				typeof accountCheck === "string" ? accountCheck : null,
			);
		}

		const profileName = expectedAccount?.id
			? readBirdProfileName(expectedAccount.id)
			: null;
		if (!profileName) {
			return {
				ok: false,
				output: "bird_profile_name is required to use bird",
				transport: "bird",
			};
		}

		const birdResult = yield* runBirdActionEffect(action, query, profileName);
		if (birdResult.ok) {
			return birdResult;
		}

		const accountCheck = yield* verifyXurlAccount();
		if (accountCheck && typeof accountCheck === "object") {
			return {
				ok: false,
				output: [
					normalizeFailure("bird", birdResult.output),
					normalizeFailure("xurl", accountCheck.output),
				].join("\n"),
				transport: "xurl",
			};
		}
		const xurlResult = yield* runXurlActionEffect(
			action,
			query,
			profileName!,
			targetUserId,
			typeof accountCheck === "string" ? accountCheck : null,
		);
		if (xurlResult.ok) {
			return {
				...xurlResult,
				output: `${xurlResult.output}\nfalling back after ${normalizeFailure("bird", birdResult.output)}`,
			};
		}

		return {
			ok: false,
			output: [
				normalizeFailure("bird", birdResult.output),
				normalizeFailure("xurl", xurlResult.output),
			].join("\n"),
			transport: xurlResult.transport,
		};
	});
}

export function runModerationAction(
	params: RunActionParams,
): Promise<ActionTransportResult> {
	return runEffectPromise(runModerationActionEffect(params));
}

export type { ActionsTransport };
