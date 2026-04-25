import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getBirdCommand } from "./config";
import type { XurlMentionUser } from "./types";

const execFileAsync = promisify(execFile);

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

async function runBirdCommand(args: string[]) {
	const birdCommand = getBirdCommand();
	return execFileAsync(birdCommand, args);
}

async function runBirdJsonCommand(args: string[]) {
	const { stdout } = await runBirdCommand(args);
	return JSON.parse(stripAnsi(stdout)) as Record<string, unknown>;
}

export async function readBirdStatusViaBird(query: string) {
	try {
		const payload = await runBirdJsonCommand(["status", query, "--json"]);
		return payload;
	} catch {
		return null;
	}
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
	return {
		id,
		name:
			typeof user.name === "string" && user.name.trim().length > 0
				? user.name
				: username,
		username,
		description:
			typeof user.description === "string" ? user.description : undefined,
		profile_image_url:
			typeof user.profileImageUrl === "string"
				? user.profileImageUrl
				: undefined,
		public_metrics: {
			followers_count: Number.isFinite(followersCount) ? followersCount : 0,
		},
		created_at: typeof user.createdAt === "string" ? user.createdAt : undefined,
	};
}

export async function lookupProfileViaBird(query: string) {
	try {
		const payload = await runBirdJsonCommand([
			"user",
			query,
			"-n",
			"1",
			"--json",
		]);
		return toBirdLookupUser(payload);
	} catch {
		return null;
	}
}

async function runVerifiedBirdMutation({
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
	if (liveWritesDisabled()) {
		return { ok: true, output: "live writes disabled" };
	}

	let baseOutput = "";
	try {
		const { stdout, stderr } = await runBirdCommand([action, query]);
		baseOutput = normalizeOutput(stdout, stderr);
	} catch (error) {
		return {
			ok: false,
			output: formatExecError(error, `bird ${action} failed`),
		};
	}

	const status = await readBirdStatusViaBird(query);
	if (!status || typeof status[verifyField] !== "boolean") {
		return {
			ok: false,
			output: `${baseOutput}; bird status verify unavailable`,
		};
	}

	const actualValue = Boolean(status[verifyField]);
	if (actualValue !== expectedValue) {
		return {
			ok: false,
			output: `${baseOutput}; bird status verify ${verifyField}=${String(actualValue)}`,
		};
	}

	return {
		ok: true,
		output: `${baseOutput}; verified ${verifyField}=${String(actualValue)}`,
	};
}

export async function blockUserViaBird(query: string) {
	return runVerifiedBirdMutation({
		action: "block",
		query,
		verifyField: "blocking",
		expectedValue: true,
	});
}

export async function unblockUserViaBird(query: string) {
	return runVerifiedBirdMutation({
		action: "unblock",
		query,
		verifyField: "blocking",
		expectedValue: false,
	});
}

export async function muteUserViaBird(query: string) {
	return runVerifiedBirdMutation({
		action: "mute",
		query,
		verifyField: "muting",
		expectedValue: true,
	});
}

export async function unmuteUserViaBird(query: string) {
	return runVerifiedBirdMutation({
		action: "unmute",
		query,
		verifyField: "muting",
		expectedValue: false,
	});
}
