import { Effect } from "effect";
import {
	BirdCommandExecutionError,
	runBirdCommandEffect,
} from "./bird-command";
import { runEffectPromise } from "./effect-runtime";
import type { XurlMentionUser } from "./types";

function liveWritesDisabled() {
	return process.env.BIRDCLAW_DISABLE_LIVE_WRITES === "1";
}

function stripAnsi(value: string) {
	// ANSI escape parsing needs a constructor to avoid literal control characters.
	return value.replace(new RegExp("\\u001b\\[[0-9;]*m", "g"), "");
}

function formatExecError(error: unknown, fallback: string) {
	if (!(error instanceof Error)) {
		return fallback;
	}
	if (error instanceof BirdCommandExecutionError && error.useFallbackMessage) {
		return fallback;
	}

	const parts = [error.message];
	if (
		"stdout" in error &&
		typeof error.stdout === "string" &&
		error.stdout.trim().length > 0
	) {
		parts.push(stripAnsi(error.stdout).trim());
	}
	if (
		"stderr" in error &&
		typeof error.stderr === "string" &&
		error.stderr.trim().length > 0
	) {
		parts.push(stripAnsi(error.stderr).trim());
	}

	return parts.join("\n");
}

function normalizeOutput(stdout?: string, stderr?: string) {
	return stripAnsi(stdout || stderr || "ok").trim();
}

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function runBirdJsonCommandEffect(args: string[]) {
	return Effect.gen(function* () {
		const { stdout } = yield* runBirdCommandEffect(args);
		return yield* Effect.try({
			try: () => JSON.parse(stripAnsi(stdout)) as Record<string, unknown>,
			catch: toError,
		});
	});
}

export function readBirdStatusViaBirdEffect(query: string) {
	return runBirdJsonCommandEffect(["status", query, "--json"]).pipe(
		Effect.catchAll(() => Effect.succeed(null)),
	);
}

export function readBirdStatusViaBird(query: string) {
	return runEffectPromise(readBirdStatusViaBirdEffect(query));
}

function toBirdLookupUser(payload: Record<string, unknown>): XurlMentionUser {
	const user =
		payload.user && typeof payload.user === "object"
			? (payload.user as Record<string, unknown>)
			: null;
	if (!user) {
		throw new Error("bird user payload missing user object");
	}

	const id = typeof user.id === "string" ? user.id : "";
	const username =
		typeof user.username === "string"
			? user.username.replace(/^@/, "").trim()
			: "";
	if (!id || !username) {
		throw new Error("bird user payload missing id or username");
	}

	const followersCount = Number(user.followersCount ?? 0);
	const followingCount = Number(user.followingCount);
	return {
		id,
		name:
			typeof user.name === "string" && user.name.trim().length > 0
				? user.name
				: username,
		username,
		description:
			typeof user.description === "string" ? user.description : undefined,
		location: typeof user.location === "string" ? user.location : undefined,
		url: typeof user.url === "string" ? user.url : undefined,
		verified: typeof user.verified === "boolean" ? user.verified : undefined,
		verified_type:
			typeof user.verifiedType === "string"
				? user.verifiedType
				: typeof user.verified_type === "string"
					? user.verified_type
					: undefined,
		profile_image_url:
			typeof user.profileImageUrl === "string"
				? user.profileImageUrl
				: undefined,
		entities:
			user.entities && typeof user.entities === "object"
				? (user.entities as Record<string, unknown>)
				: undefined,
		affiliation:
			user.affiliation && typeof user.affiliation === "object"
				? (user.affiliation as Record<string, unknown>)
				: undefined,
		public_metrics: {
			followers_count: Number.isFinite(followersCount) ? followersCount : 0,
			...(Number.isFinite(followingCount)
				? { following_count: followingCount }
				: {}),
		},
		created_at: typeof user.createdAt === "string" ? user.createdAt : undefined,
	};
}

export function lookupProfileViaBirdEffect(query: string) {
	return Effect.gen(function* () {
		const payload = yield* runBirdJsonCommandEffect([
			"user",
			query,
			"-n",
			"1",
			"--json",
		]);
		return yield* Effect.try({
			try: () => toBirdLookupUser(payload),
			catch: toError,
		});
	}).pipe(Effect.catchAll(() => Effect.succeed(null)));
}

export function lookupProfileViaBird(query: string) {
	return runEffectPromise(lookupProfileViaBirdEffect(query));
}

function runVerifiedBirdMutationEffect({
	action,
	query,
	verifyField,
	expectedValue,
}: {
	action: "block" | "unblock" | "mute" | "unmute";
	query: string;
	verifyField: "blocking" | "muting";
	expectedValue: boolean;
}) {
	return Effect.gen(function* () {
		if (liveWritesDisabled()) {
			return { ok: true, output: "live writes disabled" };
		}

		const mutationResult = yield* runBirdCommandEffect([action, query]).pipe(
			Effect.map(({ stdout, stderr }) => ({
				ok: true as const,
				output: normalizeOutput(stdout, stderr),
			})),
			Effect.catchAll((error) =>
				Effect.succeed({
					ok: false as const,
					output: formatExecError(error, `bird ${action} failed`),
				}),
			),
		);
		if (!mutationResult.ok) {
			return mutationResult;
		}

		const status = yield* readBirdStatusViaBirdEffect(query);
		if (!status || typeof status[verifyField] !== "boolean") {
			return {
				ok: false,
				output: `${mutationResult.output}; bird status verify unavailable`,
			};
		}

		const actualValue = Boolean(status[verifyField]);
		if (actualValue !== expectedValue) {
			return {
				ok: false,
				output: `${mutationResult.output}; bird status verify ${verifyField}=${String(actualValue)}`,
			};
		}

		return {
			ok: true,
			output: `${mutationResult.output}; verified ${verifyField}=${String(actualValue)}`,
		};
	});
}

export function blockUserViaBirdEffect(query: string) {
	return runVerifiedBirdMutationEffect({
		action: "block",
		query,
		verifyField: "blocking",
		expectedValue: true,
	});
}

export function blockUserViaBird(query: string) {
	return runEffectPromise(blockUserViaBirdEffect(query));
}

export function unblockUserViaBirdEffect(query: string) {
	return runVerifiedBirdMutationEffect({
		action: "unblock",
		query,
		verifyField: "blocking",
		expectedValue: false,
	});
}

export function unblockUserViaBird(query: string) {
	return runEffectPromise(unblockUserViaBirdEffect(query));
}

export function muteUserViaBirdEffect(query: string) {
	return runVerifiedBirdMutationEffect({
		action: "mute",
		query,
		verifyField: "muting",
		expectedValue: true,
	});
}

export function muteUserViaBird(query: string) {
	return runEffectPromise(muteUserViaBirdEffect(query));
}

export function unmuteUserViaBirdEffect(query: string) {
	return runVerifiedBirdMutationEffect({
		action: "unmute",
		query,
		verifyField: "muting",
		expectedValue: false,
	});
}

export function unmuteUserViaBird(query: string) {
	return runEffectPromise(unmuteUserViaBirdEffect(query));
}
