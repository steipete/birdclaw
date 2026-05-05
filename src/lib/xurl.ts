import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
	TransportStatus,
	XurlMentionsResponse,
	XurlMentionUser,
	XurlTweetsResponse,
	XurlUserTweet,
} from "./types";

const execFileAsync = promisify(execFile);
const TRANSPORT_STATUS_TTL_MS = 5 * 60_000;
const AUTHENTICATED_USER_TTL_MS = 60_000;
const JSON_RETRY_LIMIT = 6;

let transportStatusCache:
	| {
			expiresAt: number;
			pending?: Promise<TransportStatus>;
			value?: TransportStatus;
	  }
	| undefined;
let authenticatedUserCache:
	| {
			expiresAt: number;
			pending?: Promise<Record<string, unknown> | null>;
			value?: Record<string, unknown> | null;
	  }
	| undefined;

function liveWritesDisabled() {
	return process.env.BIRDCLAW_DISABLE_LIVE_WRITES === "1";
}

function getJsonRetryBaseDelayMs() {
	const value = Number(process.env.BIRDCLAW_XURL_RETRY_BASE_MS ?? "2000");
	return Number.isFinite(value) && value >= 0 ? value : 2000;
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

function parseErrorPayload(error: unknown) {
	const stdout =
		typeof error === "object" &&
		error !== null &&
		"stdout" in error &&
		typeof error.stdout === "string"
			? stripAnsi(error.stdout)
			: "";

	const start = stdout.indexOf("{");
	const end = stdout.lastIndexOf("}");
	if (start < 0 || end <= start) {
		return null;
	}

	try {
		return JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function getRetryDelayMs(error: unknown, attempt: number) {
	const payload = parseErrorPayload(error);
	const status = Number(payload?.status ?? 0);
	if (status !== 429) {
		return null;
	}

	const baseDelay = getJsonRetryBaseDelayMs();
	return Math.min(baseDelay * 2 ** attempt, 30_000);
}

async function sleep(ms: number) {
	if (ms <= 0) {
		return;
	}
	await new Promise((resolve) => setTimeout(resolve, ms));
}

export function resetTransportStatusCache() {
	transportStatusCache = undefined;
}

export function resetAuthenticatedUserCache() {
	authenticatedUserCache = undefined;
}

async function hasXurl(): Promise<boolean> {
	try {
		await execFileAsync("xurl", ["version"]);
		return true;
	} catch {
		return false;
	}
}

export async function getTransportStatus(): Promise<TransportStatus> {
	const now = Date.now();
	if (transportStatusCache?.value && transportStatusCache.expiresAt > now) {
		return transportStatusCache.value;
	}

	if (transportStatusCache?.pending) {
		return transportStatusCache.pending;
	}

	const pending: Promise<TransportStatus> = (async () => {
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
	})();

	transportStatusCache = {
		expiresAt: 0,
		pending,
	};

	try {
		const status = await pending;
		transportStatusCache = {
			expiresAt: Date.now() + TRANSPORT_STATUS_TTL_MS,
			value: status,
		};
		return status;
	} catch (error) {
		transportStatusCache = undefined;
		throw error;
	}
}

async function runShortcut(
	args: string[],
): Promise<{ ok: boolean; output: string }> {
	if (liveWritesDisabled()) {
		return { ok: true, output: "live writes disabled" };
	}

	try {
		const { stdout, stderr } = await execFileAsync("xurl", args);
		return { ok: true, output: stdout || stderr };
	} catch (error) {
		return {
			ok: false,
			output: formatExecError(error, "xurl execution failed"),
		};
	}
}

async function runJsonCommand(args: string[], attempt = 0) {
	try {
		const { stdout } = await execFileAsync("xurl", args);
		return JSON.parse(stdout) as Record<string, unknown>;
	} catch (error) {
		const retryDelayMs = getRetryDelayMs(error, attempt);
		if (retryDelayMs === null || attempt >= JSON_RETRY_LIMIT - 1) {
			throw error;
		}

		await sleep(retryDelayMs);
		return runJsonCommand(args, attempt + 1);
	}
}

async function runMutationCommand(args: string[]) {
	if (liveWritesDisabled()) {
		return { ok: true, output: "live writes disabled" };
	}

	try {
		const { stdout, stderr } = await execFileAsync("xurl", args);
		return {
			ok: true,
			output: stdout || stderr || "ok",
		};
	} catch (error) {
		return {
			ok: false,
			output: formatExecError(error, "xurl execution failed"),
		};
	}
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
	return Array.isArray(data) ? (data as XurlMentionUser[]) : [];
}

export async function lookupUsersByHandles(handles: string[]) {
	if (handles.length === 0) {
		return [];
	}

	const query = new URLSearchParams({
		usernames: handles.map((item) => item.replace(/^@/, "")).join(","),
		"user.fields":
			"description,public_metrics,profile_image_url,created_at,verified",
	});
	const payload = await runJsonCommand([`/2/users/by?${query.toString()}`]);
	const data = payload.data;
	return Array.isArray(data) ? (data as XurlMentionUser[]) : [];
}

export async function lookupAuthenticatedUser() {
	const now = Date.now();
	if (
		authenticatedUserCache &&
		"value" in authenticatedUserCache &&
		authenticatedUserCache.expiresAt > now
	) {
		return authenticatedUserCache.value ?? null;
	}

	if (authenticatedUserCache?.pending) {
		return authenticatedUserCache.pending;
	}

	const pending = (async () => {
		const payload = await runJsonCommand(["whoami"]);
		const data = payload.data;
		return data && typeof data === "object"
			? (data as Record<string, unknown>)
			: null;
	})();

	authenticatedUserCache = {
		expiresAt: 0,
		pending,
	};

	try {
		const value = await pending;
		authenticatedUserCache = {
			expiresAt: Date.now() + AUTHENTICATED_USER_TTL_MS,
			value,
		};
		return value;
	} catch (error) {
		authenticatedUserCache = undefined;
		throw error;
	}
}

export async function listMentionsViaXurl({
	maxResults,
	username,
	userId,
	paginationToken,
}: {
	maxResults: number;
	username?: string;
	userId?: string;
	paginationToken?: string;
}): Promise<XurlMentionsResponse> {
	let resolvedUserId = userId;
	if (!resolvedUserId) {
		if (username) {
			const [user] = await lookupUsersByHandles([username]);
			if (!user?.id) {
				throw new Error(`Could not resolve Twitter user id for @${username}`);
			}
			resolvedUserId = String(user.id);
		} else {
			const user = await lookupAuthenticatedUser();
			if (!user?.id) {
				throw new Error("Could not resolve authenticated Twitter user id");
			}
			resolvedUserId = String(user.id);
		}
	}

	const query = new URLSearchParams({
		max_results: String(maxResults),
		expansions: "author_id",
		"tweet.fields": "created_at,conversation_id,entities,public_metrics",
		"user.fields":
			"description,public_metrics,profile_image_url,created_at,verified",
	});
	if (paginationToken) {
		query.set("pagination_token", paginationToken);
	}

	const payload = await runJsonCommand([
		`/2/users/${resolvedUserId}/mentions?${query.toString()}`,
	]);
	return {
		data: Array.isArray(payload.data)
			? (payload.data as XurlMentionsResponse["data"])
			: [],
		includes:
			payload.includes && typeof payload.includes === "object"
				? (payload.includes as XurlMentionsResponse["includes"])
				: undefined,
		meta:
			payload.meta && typeof payload.meta === "object"
				? (payload.meta as XurlMentionsResponse["meta"])
				: undefined,
	};
}

async function listTimelineCollectionViaXurl({
	collection,
	maxResults,
	username,
	userId,
	paginationToken,
}: {
	collection: "liked_tweets" | "bookmarks";
	maxResults: number;
	username?: string;
	userId?: string;
	paginationToken?: string;
}): Promise<XurlMentionsResponse> {
	let resolvedUserId = userId;
	if (!resolvedUserId) {
		if (username) {
			const [user] = await lookupUsersByHandles([username]);
			if (!user?.id) {
				throw new Error(`Could not resolve Twitter user id for @${username}`);
			}
			resolvedUserId = String(user.id);
		} else {
			const user = await lookupAuthenticatedUser();
			if (!user?.id) {
				throw new Error("Could not resolve authenticated Twitter user id");
			}
			resolvedUserId = String(user.id);
		}
	}

	const query = new URLSearchParams({
		max_results: String(maxResults),
		expansions: "author_id",
		"tweet.fields":
			"created_at,conversation_id,entities,public_metrics,referenced_tweets",
		"user.fields":
			"description,public_metrics,profile_image_url,created_at,verified",
	});
	if (paginationToken) {
		query.set("pagination_token", paginationToken);
	}

	const payload = await runJsonCommand([
		"--auth",
		"oauth2",
		`/2/users/${resolvedUserId}/${collection}?${query.toString()}`,
	]);
	return {
		data: Array.isArray(payload.data)
			? (payload.data as XurlMentionsResponse["data"])
			: [],
		includes:
			payload.includes && typeof payload.includes === "object"
				? (payload.includes as XurlMentionsResponse["includes"])
				: undefined,
		meta:
			payload.meta && typeof payload.meta === "object"
				? (payload.meta as XurlMentionsResponse["meta"])
				: undefined,
	};
}

export async function listLikedTweetsViaXurl(options: {
	maxResults: number;
	username?: string;
	userId?: string;
	paginationToken?: string;
}): Promise<XurlMentionsResponse> {
	return listTimelineCollectionViaXurl({
		...options,
		collection: "liked_tweets",
	});
}

export async function listBookmarkedTweetsViaXurl(options: {
	maxResults: number;
	username?: string;
	userId?: string;
	paginationToken?: string;
}): Promise<XurlMentionsResponse> {
	return listTimelineCollectionViaXurl({
		...options,
		collection: "bookmarks",
	});
}

export async function listBlockedUsers(
	userId: string,
	paginationToken?: string,
) {
	const query = new URLSearchParams({
		max_results: "100",
		"user.fields": "description,public_metrics,profile_image_url,created_at",
	});
	if (paginationToken) {
		query.set("pagination_token", paginationToken);
	}

	const payload = await runJsonCommand([
		`/2/users/${userId}/blocking?${query}`,
	]);
	const data = Array.isArray(payload.data)
		? (payload.data as XurlMentionUser[])
		: [];
	const meta =
		payload.meta && typeof payload.meta === "object"
			? (payload.meta as Record<string, unknown>)
			: null;

	return {
		items: data,
		nextToken:
			typeof meta?.next_token === "string" ? String(meta.next_token) : null,
	};
}

export async function listUserTweets(
	userId: string,
	{
		maxResults,
		paginationToken,
		excludeRetweets = true,
	}: {
		maxResults: number;
		paginationToken?: string;
		excludeRetweets?: boolean;
	},
) {
	const query = new URLSearchParams({
		max_results: String(maxResults),
		"tweet.fields":
			"created_at,conversation_id,public_metrics,referenced_tweets",
	});
	if (excludeRetweets) {
		query.set("exclude", "retweets");
	}
	if (paginationToken) {
		query.set("pagination_token", paginationToken);
	}

	const payload = await runJsonCommand([`/2/users/${userId}/tweets?${query}`]);
	const data = Array.isArray(payload.data)
		? (payload.data as XurlUserTweet[])
		: [];
	const meta =
		payload.meta && typeof payload.meta === "object"
			? (payload.meta as Record<string, unknown>)
			: null;

	return {
		items: data,
		nextToken:
			typeof meta?.next_token === "string" ? String(meta.next_token) : null,
	};
}

export async function lookupTweetsByIds(
	ids: string[],
): Promise<XurlTweetsResponse> {
	if (ids.length === 0) {
		return { data: [] };
	}

	const query = new URLSearchParams({
		ids: ids.join(","),
		expansions: "author_id",
		"tweet.fields":
			"created_at,conversation_id,entities,public_metrics,referenced_tweets",
		"user.fields":
			"description,public_metrics,profile_image_url,created_at,verified",
	});

	const payload = await runJsonCommand([`/2/tweets?${query.toString()}`]);
	return {
		data: Array.isArray(payload.data)
			? (payload.data as XurlTweetsResponse["data"])
			: [],
		includes:
			payload.includes && typeof payload.includes === "object"
				? (payload.includes as XurlTweetsResponse["includes"])
				: undefined,
		meta:
			payload.meta && typeof payload.meta === "object"
				? (payload.meta as XurlTweetsResponse["meta"])
				: undefined,
	};
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

export async function blockUserViaXurl(
	sourceUserId: string,
	targetUserId: string,
) {
	return runMutationCommand([
		"-X",
		"POST",
		`/2/users/${sourceUserId}/blocking`,
		"-d",
		JSON.stringify({ target_user_id: targetUserId }),
	]);
}

export async function unblockUserViaXurl(
	sourceUserId: string,
	targetUserId: string,
) {
	return runMutationCommand([
		"-X",
		"DELETE",
		`/2/users/${sourceUserId}/blocking/${targetUserId}`,
	]);
}

export async function muteUserViaXurl(
	sourceUserId: string,
	targetUserId: string,
) {
	return runMutationCommand([
		"-X",
		"POST",
		`/2/users/${sourceUserId}/muting`,
		"-d",
		JSON.stringify({ target_user_id: targetUserId }),
	]);
}

export async function unmuteUserViaXurl(
	sourceUserId: string,
	targetUserId: string,
) {
	return runMutationCommand([
		"-X",
		"DELETE",
		`/2/users/${sourceUserId}/muting/${targetUserId}`,
	]);
}
