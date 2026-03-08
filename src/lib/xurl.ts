import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TransportStatus } from "./types";

const execFileAsync = promisify(execFile);

async function hasXurl(): Promise<boolean> {
	try {
		await execFileAsync("xurl", ["version"]);
		return true;
	} catch {
		return false;
	}
}

export async function getTransportStatus(): Promise<TransportStatus> {
	const installed = await hasXurl();
	if (!installed) {
		return {
			installed: false,
			availableTransport: "local",
			statusText: "xurl not installed. local mode active.",
		};
	}

	try {
		const { stdout } = await execFileAsync("xurl", ["auth", "status"]);
		return {
			installed: true,
			availableTransport: "xurl",
			statusText: "xurl available",
			rawStatus: stdout.trim(),
		};
	} catch (error) {
		return {
			installed: true,
			availableTransport: "local",
			statusText: `xurl detected but auth unavailable: ${
				error instanceof Error ? error.message : "unknown error"
			}`,
		};
	}
}

async function runShortcut(
	args: string[],
): Promise<{ ok: boolean; output: string }> {
	try {
		const { stdout, stderr } = await execFileAsync("xurl", args);
		return { ok: true, output: stdout || stderr };
	} catch (error) {
		return {
			ok: false,
			output: error instanceof Error ? error.message : "xurl execution failed",
		};
	}
}

async function runJsonCommand(args: string[]) {
	const { stdout } = await execFileAsync("xurl", args);
	return JSON.parse(stdout) as Record<string, unknown>;
}

export async function lookupUsersByIds(ids: string[]) {
	if (ids.length === 0) {
		return [];
	}

	const query = new URLSearchParams({
		ids: ids.join(","),
		"user.fields":
			"description,public_metrics,profile_image_url,created_at,verified",
	});
	const payload = await runJsonCommand([`/2/users?${query.toString()}`]);
	const data = payload.data;
	return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
}

export async function lookupAuthenticatedUser() {
	const payload = await runJsonCommand(["whoami"]);
	const data = payload.data;
	return data && typeof data === "object"
		? (data as Record<string, unknown>)
		: null;
}

export async function postViaXurl(text: string) {
	return runShortcut(["post", text]);
}

export async function replyViaXurl(tweetId: string, text: string) {
	return runShortcut(["reply", tweetId, text]);
}

export async function dmViaXurl(handle: string, text: string) {
	return runShortcut([
		"dm",
		handle.startsWith("@") ? handle : `@${handle}`,
		text,
	]);
}
