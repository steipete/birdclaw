import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Effect } from "effect";
import { runEffectPromise } from "./effect-runtime";
import type {
	FollowDirection,
	TransportStatus,
	XurlFollowUsersResponse,
	XurlMentionsResponse,
	XurlMentionUser,
	XurlTweetsResponse,
	XurlUserTweet,
	XurlUserTweetsResponse,
} from "./types";

const execFileAsync = promisify(execFile);
const TRANSPORT_STATUS_TTL_MS = 5 * 60_000;
const AUTHENTICATED_USER_TTL_MS = 60_000;
const JSON_RETRY_LIMIT = 6;
const MEDIA_EXPANSION = "attachments.media_keys";
const AUTHOR_MEDIA_EXPANSIONS = `author_id,${MEDIA_EXPANSION}`;
const MEDIA_FIELDS =
	"variants,preview_image_url,url,duration_ms,alt_text,type,width,height,public_metrics";
const RICH_USER_FIELDS =
	"description,entities,location,public_metrics,profile_image_url,url,created_at,verified,verified_type";
const THREAD_TWEET_FIELDS =
	"created_at,conversation_id,entities,public_metrics,referenced_tweets,in_reply_to_user_id,attachments";
// X bookmarks pagination truncates above 90 until this bug is fixed:
// https://devcommunity.x.com/t/bookmarks-api-v2-stops-paginating-after-3-pages-no-next-token-returned/257339
const BOOKMARKS_MAX_RESULTS_CAP = 90;

type TimelineCollectionEndpoint = "liked_tweets" | "bookmarks";
type JsonCommandOptions = {
	timeoutMs?: number;
	deadlineMs?: number;
};

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

function e2eFakeLiveWritesEnabled() {
	return (
		process.env.BIRDCLAW_E2E === "1" &&
		process.env.BIRDCLAW_E2E_FAKE_LIVE_WRITES === "1"
	);
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

function formatXurlCommandError(error: unknown, args: string[]) {
	return new Error(formatExecError(error, `xurl ${args.join(" ")} failed`));
}

function normalizeError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
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

function capTimelineCollectionMaxResults(
	collection: TimelineCollectionEndpoint,
	maxResults: number,
	isPaginatedWalk: boolean,
) {
	return collection === "bookmarks" && isPaginatedWalk
		? Math.min(maxResults, BOOKMARKS_MAX_RESULTS_CAP)
		: maxResults;
}

export function resetTransportStatusCache() {
	transportStatusCache = undefined;
}

export function resetAuthenticatedUserCache() {
	authenticatedUserCache = undefined;
}

function hasXurlEffect() {
	return Effect.tryPromise({
		try: () => execFileAsync("xurl", ["version"]),
		catch: normalizeError,
	}).pipe(
		Effect.as(true),
		Effect.catchAll(() => Effect.succeed(false)),
	);
}

function isUnauthenticatedXurlStatus(status: string) {
	return /no apps registered|no authenticated user|not authenticated|not logged in/i.test(
		status,
	);
}

function readTransportStatusEffect(): Effect.Effect<TransportStatus, never> {
	return Effect.gen(function* () {
		const installed = yield* hasXurlEffect();
		if (!installed) {
			return {
				installed: false,
				availableTransport: "local" as const,
				statusText: "xurl not installed. local mode active.",
			};
		}

		return yield* Effect.tryPromise({
			try: () => execFileAsync("xurl", ["auth", "status"]),
			catch: (cause) => cause,
		}).pipe(
			Effect.map(({ stdout }) => {
				const rawStatus = stdout.trim();

				if (isUnauthenticatedXurlStatus(rawStatus)) {
					return {
						installed: true,
						availableTransport: "local" as const,
						statusText:
							"xurl installed but not authenticated. local (bird) mode active.",
						rawStatus,
					};
				}

				return {
					installed: true,
					availableTransport: "xurl" as const,
					statusText: "xurl available",
					rawStatus,
				};
			}),
			Effect.catchAll((error) =>
				Effect.succeed({
					installed: true,
					availableTransport: "local" as const,
					statusText: `xurl detected but auth unavailable: ${
						error instanceof Error ? error.message : "unknown error"
					}`,
				}),
			),
		);
	});
}

export function getTransportStatusEffect() {
	return Effect.gen(function* () {
		const now = Date.now();
		if (transportStatusCache?.value && transportStatusCache.expiresAt > now) {
			return transportStatusCache.value;
		}

		if (transportStatusCache?.pending) {
			const status = yield* Effect.tryPromise({
				try: () => transportStatusCache?.pending ?? Promise.resolve(undefined),
				catch: normalizeError,
			});
			if (status) return status;
		}

		const pending = runEffectPromise(readTransportStatusEffect());

		transportStatusCache = {
			expiresAt: 0,
			pending,
		};

		const status = yield* Effect.tryPromise({
			try: () => pending,
			catch: normalizeError,
		}).pipe(
			Effect.catchAll((error) =>
				Effect.sync(() => {
					transportStatusCache = undefined;
				}).pipe(Effect.flatMap(() => Effect.fail(error))),
			),
		);
		transportStatusCache = {
			expiresAt: Date.now() + TRANSPORT_STATUS_TTL_MS,
			value: status,
		};
		return status;
	});
}

export function getTransportStatus(): Promise<TransportStatus> {
	return runEffectPromise(getTransportStatusEffect());
}

function runShortcutEffect(args: string[]) {
	return Effect.gen(function* () {
		if (liveWritesDisabled()) {
			if (e2eFakeLiveWritesEnabled()) {
				return { ok: true, output: "e2e fake live write" };
			}
			return { ok: false, output: "live writes disabled" };
		}

		return yield* Effect.tryPromise({
			try: () => execFileAsync("xurl", args),
			catch: normalizeError,
		}).pipe(
			Effect.map(({ stdout, stderr }) => ({
				ok: true,
				output: stdout || stderr,
			})),
			Effect.catchAll((error) =>
				Effect.succeed({
					ok: false,
					output: formatExecError(error, "xurl execution failed"),
				}),
			),
		);
	});
}

function execXurlJsonEffect(
	args: string[],
	timeoutMs?: number,
): Effect.Effect<{ stdout: string; stderr: string }, Error> {
	return Effect.tryPromise({
		try: () => {
			const controller =
				typeof timeoutMs === "number" &&
				Number.isFinite(timeoutMs) &&
				timeoutMs > 0
					? new AbortController()
					: undefined;
			const timeout = controller
				? setTimeout(() => controller.abort(), timeoutMs)
				: undefined;
			const result = controller
				? execFileAsync("xurl", args, { signal: controller.signal })
				: execFileAsync("xurl", args);
			return result.finally(() => {
				if (timeout) {
					clearTimeout(timeout);
				}
			});
		},
		catch: normalizeError,
	});
}

function parseJsonPayloadEffect(
	stdout: string,
	args: string[],
): Effect.Effect<Record<string, unknown>, Error> {
	return Effect.try({
		try: () => JSON.parse(stdout) as Record<string, unknown>,
		catch: (error) => formatXurlCommandError(error, args),
	});
}

function runJsonCommandEffect(
	args: string[],
	options: JsonCommandOptions = {},
	attempt = 0,
): Effect.Effect<Record<string, unknown>, Error> {
	return Effect.gen(function* () {
		const deadlineMs =
			options.deadlineMs ??
			(typeof options.timeoutMs === "number" &&
			Number.isFinite(options.timeoutMs) &&
			options.timeoutMs > 0
				? Date.now() + options.timeoutMs
				: undefined);
		const timeoutMs = deadlineMs
			? Math.max(0, deadlineMs - Date.now())
			: undefined;
		return yield* execXurlJsonEffect(args, timeoutMs).pipe(
			Effect.flatMap(({ stdout }) => parseJsonPayloadEffect(stdout, args)),
			Effect.catchAll((error) => {
				const retryDelayMs = getRetryDelayMs(error, attempt);
				if (retryDelayMs === null || attempt >= JSON_RETRY_LIMIT - 1) {
					return Effect.fail(formatXurlCommandError(error, args));
				}
				const remainingMs = deadlineMs
					? Math.max(0, deadlineMs - Date.now())
					: undefined;
				if (remainingMs !== undefined && retryDelayMs >= remainingMs) {
					return Effect.fail(formatXurlCommandError(error, args));
				}

				return Effect.sleep(retryDelayMs).pipe(
					Effect.flatMap(() =>
						runJsonCommandEffect(args, { ...options, deadlineMs }, attempt + 1),
					),
				);
			}),
		);
	});
}

function runMutationCommandEffect(args: string[]) {
	return Effect.gen(function* () {
		if (liveWritesDisabled()) {
			if (e2eFakeLiveWritesEnabled()) {
				return { ok: true, output: "e2e fake live write" };
			}
			return { ok: false, output: "live writes disabled" };
		}

		return yield* Effect.tryPromise({
			try: () => execFileAsync("xurl", args),
			catch: normalizeError,
		}).pipe(
			Effect.map(({ stdout, stderr }) => ({
				ok: true,
				output: stdout || stderr || "ok",
			})),
			Effect.catchAll((error) =>
				Effect.succeed({
					ok: false,
					output: formatExecError(error, "xurl execution failed"),
				}),
			),
		);
	});
}

export function lookupUsersByIdsEffect(ids: string[]) {
	if (ids.length === 0) {
		return Effect.succeed([]);
	}

	const query = new URLSearchParams({
		ids: ids.join(","),
		"user.fields":
			"description,entities,location,public_metrics,profile_image_url,url,created_at,verified,verified_type",
	});
	return runJsonCommandEffect([`/2/users?${query.toString()}`]).pipe(
		Effect.map((payload) =>
			Array.isArray(payload.data) ? (payload.data as XurlMentionUser[]) : [],
		),
	);
}

export function lookupUsersByIds(ids: string[]) {
	return runEffectPromise(lookupUsersByIdsEffect(ids));
}

export function lookupUsersByHandlesEffect(handles: string[]) {
	if (handles.length === 0) {
		return Effect.succeed([]);
	}

	const query = new URLSearchParams({
		usernames: handles.map((item) => item.replace(/^@/, "")).join(","),
		"user.fields":
			"description,entities,location,public_metrics,profile_image_url,url,created_at,verified,verified_type",
	});
	return runJsonCommandEffect([`/2/users/by?${query.toString()}`]).pipe(
		Effect.map((payload) =>
			Array.isArray(payload.data) ? (payload.data as XurlMentionUser[]) : [],
		),
	);
}

export function lookupUsersByHandles(handles: string[]) {
	return runEffectPromise(lookupUsersByHandlesEffect(handles));
}

function authenticatedUserFromPayload(payload: Record<string, unknown>) {
	const data = payload.data;
	return data && typeof data === "object"
		? (data as Record<string, unknown>)
		: null;
}

export function lookupAuthenticatedUserFreshEffect() {
	return runJsonCommandEffect(["whoami"]).pipe(
		Effect.map(authenticatedUserFromPayload),
	);
}

export function lookupAuthenticatedUserEffect() {
	return Effect.gen(function* () {
		const now = Date.now();
		if (
			authenticatedUserCache &&
			"value" in authenticatedUserCache &&
			authenticatedUserCache.expiresAt > now
		) {
			return authenticatedUserCache.value ?? null;
		}

		if (authenticatedUserCache?.pending) {
			return yield* Effect.tryPromise({
				try: () => authenticatedUserCache?.pending ?? Promise.resolve(null),
				catch: normalizeError,
			});
		}

		const pending = runEffectPromise(lookupAuthenticatedUserFreshEffect());

		authenticatedUserCache = {
			expiresAt: 0,
			pending,
		};

		const value = yield* Effect.tryPromise({
			try: () => pending,
			catch: normalizeError,
		}).pipe(
			Effect.catchAll((error) =>
				Effect.sync(() => {
					authenticatedUserCache = undefined;
				}).pipe(Effect.flatMap(() => Effect.fail(error))),
			),
		);
		authenticatedUserCache = {
			expiresAt: Date.now() + AUTHENTICATED_USER_TTL_MS,
			value,
		};
		return value;
	});
}

export function lookupAuthenticatedUser() {
	return runEffectPromise(lookupAuthenticatedUserEffect());
}

export function lookupAuthenticatedUserFresh() {
	return runEffectPromise(lookupAuthenticatedUserFreshEffect());
}

function resolveUserIdEffect({
	username,
	userId,
}: {
	username?: string;
	userId?: string;
}) {
	return Effect.gen(function* () {
		if (userId) return userId;
		if (username) {
			const [user] = yield* lookupUsersByHandlesEffect([username]);
			if (!user?.id) {
				return yield* Effect.fail(
					new Error(`Could not resolve Twitter user id for @${username}`),
				);
			}
			return String(user.id);
		}
		const user = yield* lookupAuthenticatedUserEffect();
		if (!user?.id) {
			return yield* Effect.fail(
				new Error("Could not resolve authenticated Twitter user id"),
			);
		}
		return String(user.id);
	});
}

export function listMentionsViaXurlEffect({
	maxResults,
	username,
	userId,
	paginationToken,
	sinceId,
	startTime,
}: {
	maxResults: number;
	username?: string;
	userId?: string;
	paginationToken?: string;
	sinceId?: string;
	startTime?: string;
}): Effect.Effect<XurlMentionsResponse, Error> {
	return Effect.gen(function* () {
		const resolvedUserId = yield* resolveUserIdEffect({ username, userId });
		const query = new URLSearchParams({
			max_results: String(maxResults),
			expansions: AUTHOR_MEDIA_EXPANSIONS,
			"tweet.fields": "created_at,conversation_id,entities,public_metrics",
			"media.fields": MEDIA_FIELDS,
			"user.fields":
				"description,entities,location,public_metrics,profile_image_url,url,created_at,verified,verified_type",
		});
		if (paginationToken) {
			query.set("pagination_token", paginationToken);
		}
		if (sinceId) {
			query.set("since_id", sinceId);
		}
		if (startTime) {
			query.set("start_time", startTime);
		}

		const payload = yield* runJsonCommandEffect([
			`/2/users/${resolvedUserId}/mentions?${query.toString()}`,
		]);
		return toXurlMentionsResponse(payload);
	});
}

export function listMentionsViaXurl(options: {
	maxResults: number;
	username?: string;
	userId?: string;
	paginationToken?: string;
	sinceId?: string;
	startTime?: string;
}): Promise<XurlMentionsResponse> {
	return runEffectPromise(listMentionsViaXurlEffect(options));
}

function toXurlMentionsResponse(
	payload: Record<string, unknown>,
): XurlMentionsResponse {
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

function listTimelineCollectionViaXurlEffect({
	collection,
	maxResults,
	username,
	userId,
	isPaginatedWalk = false,
	paginationToken,
}: {
	collection: TimelineCollectionEndpoint;
	maxResults: number;
	username?: string;
	userId?: string;
	isPaginatedWalk?: boolean;
	paginationToken?: string;
}): Effect.Effect<XurlMentionsResponse, Error> {
	return Effect.gen(function* () {
		const resolvedUserId = yield* resolveUserIdEffect({ username, userId });
		const requestMaxResults = capTimelineCollectionMaxResults(
			collection,
			maxResults,
			isPaginatedWalk,
		);
		const query = new URLSearchParams({
			max_results: String(requestMaxResults),
			expansions: AUTHOR_MEDIA_EXPANSIONS,
			"tweet.fields":
				"created_at,conversation_id,entities,public_metrics,referenced_tweets",
			"media.fields": MEDIA_FIELDS,
			"user.fields":
				"description,entities,location,public_metrics,profile_image_url,url,created_at,verified,verified_type",
		});
		if (paginationToken) {
			query.set("pagination_token", paginationToken);
		}

		const payload = yield* runJsonCommandEffect([
			"--auth",
			"oauth2",
			`/2/users/${resolvedUserId}/${collection}?${query.toString()}`,
		]);
		return toXurlMentionsResponse(payload);
	});
}

export function listLikedTweetsViaXurlEffect(options: {
	maxResults: number;
	username?: string;
	userId?: string;
	paginationToken?: string;
}) {
	return listTimelineCollectionViaXurlEffect({
		...options,
		collection: "liked_tweets",
	});
}

export function listLikedTweetsViaXurl(options: {
	maxResults: number;
	username?: string;
	userId?: string;
	paginationToken?: string;
}): Promise<XurlMentionsResponse> {
	return runEffectPromise(listLikedTweetsViaXurlEffect(options));
}

export function listBookmarkedTweetsViaXurlEffect(options: {
	maxResults: number;
	username?: string;
	userId?: string;
	isPaginatedWalk?: boolean;
	paginationToken?: string;
}) {
	return listTimelineCollectionViaXurlEffect({
		...options,
		collection: "bookmarks",
	});
}

export function listBookmarkedTweetsViaXurl(options: {
	maxResults: number;
	username?: string;
	userId?: string;
	isPaginatedWalk?: boolean;
	paginationToken?: string;
}): Promise<XurlMentionsResponse> {
	return runEffectPromise(listBookmarkedTweetsViaXurlEffect(options));
}

export function listFollowUsersViaXurlEffect({
	direction,
	maxResults,
	username,
	userId,
	paginationToken,
}: {
	direction: FollowDirection;
	maxResults: number;
	username?: string;
	userId?: string;
	paginationToken?: string;
}): Effect.Effect<XurlFollowUsersResponse, Error> {
	return Effect.gen(function* () {
		const resolvedUserId = yield* resolveUserIdEffect({ username, userId });
		const query = new URLSearchParams({
			max_results: String(maxResults),
			"user.fields":
				"id,username,name,description,verified,protected,public_metrics,profile_image_url,created_at",
		});
		if (paginationToken) {
			query.set("pagination_token", paginationToken);
		}

		const payload = yield* runJsonCommandEffect([
			"--auth",
			"oauth2",
			`/2/users/${resolvedUserId}/${direction}?${query.toString()}`,
		]);
		return {
			data: Array.isArray(payload.data)
				? (payload.data as XurlMentionUser[])
				: [],
			meta:
				payload.meta && typeof payload.meta === "object"
					? (payload.meta as Record<string, unknown>)
					: undefined,
		};
	});
}

export function listFollowUsersViaXurl(options: {
	direction: FollowDirection;
	maxResults: number;
	username?: string;
	userId?: string;
	paginationToken?: string;
}): Promise<XurlFollowUsersResponse> {
	return runEffectPromise(listFollowUsersViaXurlEffect(options));
}

export function listBlockedUsersEffect(
	userId: string,
	paginationToken?: string,
) {
	const query = new URLSearchParams({
		max_results: "100",
		"user.fields":
			"description,entities,location,public_metrics,profile_image_url,url,created_at,verified,verified_type",
	});
	if (paginationToken) {
		query.set("pagination_token", paginationToken);
	}

	return runJsonCommandEffect([`/2/users/${userId}/blocking?${query}`]).pipe(
		Effect.map((payload) => {
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
		}),
	);
}

export function listBlockedUsers(userId: string, paginationToken?: string) {
	return runEffectPromise(listBlockedUsersEffect(userId, paginationToken));
}

export function listUserTweetsEffect(
	userId: string,
	{
		maxResults,
		paginationToken,
		excludeRetweets = true,
		sinceId,
		untilId,
		tweetFields,
		expansions,
		userFields,
		mediaFields,
		auth,
	}: {
		maxResults: number;
		paginationToken?: string;
		excludeRetweets?: boolean;
		sinceId?: string;
		untilId?: string;
		tweetFields?: string[];
		expansions?: string[];
		userFields?: string[];
		mediaFields?: string[];
		auth?: "oauth2";
	},
): Effect.Effect<XurlUserTweetsResponse, Error> {
	const query = new URLSearchParams({
		max_results: String(maxResults),
		expansions: MEDIA_EXPANSION,
		"tweet.fields":
			tweetFields?.join(",") ??
			"created_at,conversation_id,public_metrics,referenced_tweets",
		"media.fields": MEDIA_FIELDS,
	});
	if (expansions && expansions.length > 0) {
		query.set("expansions", expansions.join(","));
	}
	if (userFields && userFields.length > 0) {
		query.set("user.fields", userFields.join(","));
	}
	if (mediaFields && mediaFields.length > 0) {
		query.set("media.fields", mediaFields.join(","));
	}
	if (sinceId) {
		query.set("since_id", sinceId);
	}
	if (untilId) {
		query.set("until_id", untilId);
	}
	if (excludeRetweets) {
		query.set("exclude", "retweets");
	}
	if (paginationToken) {
		query.set("pagination_token", paginationToken);
	}

	const endpoint = `/2/users/${userId}/tweets?${query}`;
	return runJsonCommandEffect(
		auth === "oauth2" ? ["--auth", "oauth2", endpoint] : [endpoint],
	).pipe(
		Effect.map((payload) => {
			const data = Array.isArray(payload.data)
				? (payload.data as XurlUserTweet[])
				: [];
			const meta =
				payload.meta && typeof payload.meta === "object"
					? (payload.meta as Record<string, unknown>)
					: null;
			const includes =
				payload.includes && typeof payload.includes === "object"
					? (payload.includes as XurlUserTweetsResponse["includes"])
					: undefined;

			return {
				items: data,
				nextToken:
					typeof meta?.next_token === "string" ? String(meta.next_token) : null,
				...(includes ? { includes } : {}),
			};
		}),
	);
}

export function listUserTweets(
	userId: string,
	options: {
		maxResults: number;
		paginationToken?: string;
		excludeRetweets?: boolean;
		sinceId?: string;
		untilId?: string;
		tweetFields?: string[];
		expansions?: string[];
		userFields?: string[];
		mediaFields?: string[];
		auth?: "oauth2";
	},
): Promise<XurlUserTweetsResponse> {
	return runEffectPromise(listUserTweetsEffect(userId, options));
}

function toXurlTweetsResponse(
	payload: Record<string, unknown>,
): XurlTweetsResponse {
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

export function lookupTweetsByIdsEffect(
	ids: string[],
): Effect.Effect<XurlTweetsResponse, Error> {
	if (ids.length === 0) {
		return Effect.succeed({ data: [] });
	}

	const query = new URLSearchParams({
		ids: ids.join(","),
		expansions: AUTHOR_MEDIA_EXPANSIONS,
		"tweet.fields":
			"created_at,conversation_id,entities,public_metrics,referenced_tweets",
		"media.fields": MEDIA_FIELDS,
		"user.fields":
			"description,entities,location,public_metrics,profile_image_url,url,created_at,verified,verified_type",
	});

	return runJsonCommandEffect([`/2/tweets?${query.toString()}`]).pipe(
		Effect.map(toXurlTweetsResponse),
	);
}

export function lookupTweetsByIds(ids: string[]): Promise<XurlTweetsResponse> {
	return runEffectPromise(lookupTweetsByIdsEffect(ids));
}

export function searchRecentByConversationIdEffect(
	conversationId: string,
	{
		maxResults,
		paginationToken,
		timeoutMs,
	}: {
		maxResults: number;
		paginationToken?: string;
		timeoutMs?: number;
	},
): Effect.Effect<XurlTweetsResponse, Error> {
	const query = new URLSearchParams({
		query: `conversation_id:${conversationId}`,
		max_results: String(maxResults),
		expansions: AUTHOR_MEDIA_EXPANSIONS,
		"tweet.fields": THREAD_TWEET_FIELDS,
		"media.fields": MEDIA_FIELDS,
		"user.fields": RICH_USER_FIELDS,
	});
	if (paginationToken) {
		query.set("pagination_token", paginationToken);
	}

	return runJsonCommandEffect([`/2/tweets/search/recent?${query.toString()}`], {
		timeoutMs,
	}).pipe(Effect.map(toXurlTweetsResponse));
}

export function searchRecentByConversationId(
	conversationId: string,
	options: {
		maxResults: number;
		paginationToken?: string;
		timeoutMs?: number;
	},
): Promise<XurlTweetsResponse> {
	return runEffectPromise(
		searchRecentByConversationIdEffect(conversationId, options),
	);
}

export function getTweetByIdEffect(
	id: string,
	{ timeoutMs }: { timeoutMs?: number } = {},
): Effect.Effect<XurlTweetsResponse, Error> {
	const query = new URLSearchParams({
		expansions: AUTHOR_MEDIA_EXPANSIONS,
		"tweet.fields": THREAD_TWEET_FIELDS,
		"media.fields": MEDIA_FIELDS,
		"user.fields": RICH_USER_FIELDS,
	});

	return runJsonCommandEffect([`/2/tweets/${id}?${query.toString()}`], {
		timeoutMs,
	}).pipe(
		Effect.map((payload) => {
			const data =
				payload.data &&
				typeof payload.data === "object" &&
				!Array.isArray(payload.data)
					? [payload.data as XurlTweetsResponse["data"][number]]
					: Array.isArray(payload.data)
						? (payload.data as XurlTweetsResponse["data"])
						: [];

			return {
				data,
				includes:
					payload.includes && typeof payload.includes === "object"
						? (payload.includes as XurlTweetsResponse["includes"])
						: undefined,
				meta:
					payload.meta && typeof payload.meta === "object"
						? (payload.meta as XurlTweetsResponse["meta"])
						: undefined,
			};
		}),
	);
}

export function getTweetById(
	id: string,
	options: { timeoutMs?: number } = {},
): Promise<XurlTweetsResponse> {
	return runEffectPromise(getTweetByIdEffect(id, options));
}

export function postViaXurlEffect(text: string) {
	return runShortcutEffect(["post", text]);
}

export function postViaXurl(text: string) {
	return runEffectPromise(postViaXurlEffect(text));
}

export function replyViaXurlEffect(tweetId: string, text: string) {
	return runShortcutEffect(["reply", tweetId, text]);
}

export function replyViaXurl(tweetId: string, text: string) {
	return runEffectPromise(replyViaXurlEffect(tweetId, text));
}

export function dmViaXurlEffect(handle: string, text: string) {
	return runShortcutEffect([
		"dm",
		handle.startsWith("@") ? handle : `@${handle}`,
		text,
	]);
}

export function dmViaXurl(handle: string, text: string) {
	return runEffectPromise(dmViaXurlEffect(handle, text));
}

export function blockUserViaXurlEffect(
	sourceUserId: string,
	targetUserId: string,
) {
	return runMutationCommandEffect([
		"-X",
		"POST",
		`/2/users/${sourceUserId}/blocking`,
		"-d",
		JSON.stringify({ target_user_id: targetUserId }),
	]);
}

export function blockUserViaXurl(sourceUserId: string, targetUserId: string) {
	return runEffectPromise(blockUserViaXurlEffect(sourceUserId, targetUserId));
}

export function unblockUserViaXurlEffect(
	sourceUserId: string,
	targetUserId: string,
) {
	return runMutationCommandEffect([
		"-X",
		"DELETE",
		`/2/users/${sourceUserId}/blocking/${targetUserId}`,
	]);
}

export function unblockUserViaXurl(sourceUserId: string, targetUserId: string) {
	return runEffectPromise(unblockUserViaXurlEffect(sourceUserId, targetUserId));
}

export function muteUserViaXurlEffect(
	sourceUserId: string,
	targetUserId: string,
) {
	return runMutationCommandEffect([
		"-X",
		"POST",
		`/2/users/${sourceUserId}/muting`,
		"-d",
		JSON.stringify({ target_user_id: targetUserId }),
	]);
}

export function muteUserViaXurl(sourceUserId: string, targetUserId: string) {
	return runEffectPromise(muteUserViaXurlEffect(sourceUserId, targetUserId));
}

export function unmuteUserViaXurlEffect(
	sourceUserId: string,
	targetUserId: string,
) {
	return runMutationCommandEffect([
		"-X",
		"DELETE",
		`/2/users/${sourceUserId}/muting/${targetUserId}`,
	]);
}

export function unmuteUserViaXurl(sourceUserId: string, targetUserId: string) {
	return runEffectPromise(unmuteUserViaXurlEffect(sourceUserId, targetUserId));
}
