import {
	blockUserViaBird,
	muteUserViaBird,
	readBirdStatusViaBird,
	unblockUserViaBird,
	unmuteUserViaBird,
} from "./bird-actions";
import { type ActionsTransport, resolveActionsTransport } from "./config";
import { Effect } from "effect";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import type {
	ModerationAction,
	ModerationActionTransportResult,
	ModerationTransportKind,
} from "./types";
import { blockUserViaXWeb, unblockUserViaXWeb } from "./x-web";
import {
	blockUserViaXurl,
	lookupAuthenticatedUser,
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

function runBirdActionEffect(
	action: ModerationAction,
	query: string,
): Effect.Effect<ActionTransportResult, unknown> {
	return Effect.gen(function* () {
		const result = yield* tryPromise(() =>
			action === "block"
				? blockUserViaBird(query)
				: action === "unblock"
					? unblockUserViaBird(query)
					: action === "mute"
						? muteUserViaBird(query)
						: unmuteUserViaBird(query),
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
	targetUserId?: string,
): Effect.Effect<ActionTransportResult, unknown> {
	return Effect.gen(function* () {
		if (!targetUserId) {
			return {
				ok: false,
				output: "missing target user id for xurl transport",
				transport: "xurl",
			};
		}

		const sourceUser = yield* tryPromise(() => lookupAuthenticatedUser());
		const sourceUserId =
			sourceUser && typeof sourceUser.id === "string" ? sourceUser.id : "";
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

		const status = yield* tryPromise(() => readBirdStatusViaBird(query));
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

function runXWebActionEffect(
	action: ModerationAction,
	targetUserId?: string,
): Effect.Effect<ActionTransportResult, unknown> {
	return Effect.gen(function* () {
		if (action !== "block" && action !== "unblock") {
			return {
				ok: false,
				output: `x-web does not support ${action}`,
				transport: "x-web",
			};
		}

		if (!targetUserId) {
			return {
				ok: false,
				output: "missing target user id for x-web transport",
				transport: "x-web",
			};
		}

		const result = yield* tryPromise(() =>
			action === "block"
				? blockUserViaXWeb(targetUserId)
				: unblockUserViaXWeb(targetUserId),
		);

		return {
			...result,
			transport: "x-web",
		};
	});
}

export function runModerationActionEffect({
	action,
	query,
	targetUserId,
	transport,
}: RunActionParams): Effect.Effect<ActionTransportResult, unknown> {
	return Effect.gen(function* () {
		const requestedTransport = yield* trySync(() =>
			resolveActionsTransport(transport),
		);
		if (requestedTransport === "bird") {
			return yield* runBirdActionEffect(action, query);
		}
		if (requestedTransport === "xurl") {
			return yield* runXurlActionEffect(action, query, targetUserId);
		}

		const birdResult = yield* runBirdActionEffect(action, query);
		if (birdResult.ok) {
			return birdResult;
		}

		const xurlResult = yield* runXurlActionEffect(action, query, targetUserId);
		if (xurlResult.ok) {
			return {
				...xurlResult,
				output: `${xurlResult.output}\nfalling back after ${normalizeFailure("bird", birdResult.output)}`,
			};
		}

		if (action === "block" || action === "unblock") {
			const xWebResult = yield* runXWebActionEffect(action, targetUserId);
			if (xWebResult.ok) {
				return {
					...xWebResult,
					output: [
						xWebResult.output,
						`falling back after ${normalizeFailure("bird", birdResult.output)}`,
						`falling back after ${normalizeFailure("xurl", xurlResult.output)}`,
					].join("\n"),
				};
			}

			return {
				ok: false,
				output: [
					normalizeFailure("bird", birdResult.output),
					normalizeFailure("xurl", xurlResult.output),
					normalizeFailure("x-web", xWebResult.output),
				].join("\n"),
				transport: xWebResult.transport,
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
