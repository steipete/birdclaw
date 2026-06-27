import { Effect } from "effect";
import { runEffectPromise } from "./effect-runtime";
import { runSubprocessEffect, SubprocessError } from "./subprocess";
import type {
	FollowDirection,
	LiveDataSourceAccount,
	TransportStatus,
	XurlDmEventsResponse,
	XurlFollowUsersResponse,
	XurlMentionsResponse,
	XurlMentionUser,
	XurlTweetsResponse,
	XurlUserTweet,
	XurlUserTweetsResponse,
} from "./types";

const TRANSPORT_STATUS_TTL_MS = 5 * 60_000;
const AUTHENTICATED_USER_TTL_MS = 60_000;
const JSON_RETRY_LIMIT = 6;
const MEDIA_EXPANSION = "attachments.media_keys";
const AUTHOR_MEDIA_EXPANSIONS = `author_id,${MEDIA_EXPANSION}`;
const MEDIA_FIELDS =
	"variants,preview_image_url,url,duration_ms,alt_text,type,width,height,public_metrics";
const RICH_USER_FIELDS =
	"description,entities,location,public_metrics,profile_image_url,url,created_at,verified,verified_type";
const DM_EVENT_FIELDS =
	"attachments,created_at,dm_conversation_id,entities,event_type,id,participant_ids,referenced_tweets,sender_id,text";
const THREAD_TWEET_FIELDS =
	"created_at,conversation_id,entities,public_metrics,referenced_tweets,in_reply_to_user_id,attachments";
// X bookmarks pagination truncates above 90 until this bug is fixed:
// https://devcommunity.x.com/t/bookmarks-api-v2-stops-paginating-after-3-pages-no-next-token-returned/257339
const BOOKMARKS_MAX_RESULTS_CAP = 90;

type TimelineCollectionEndpoint = "liked_tweets" | "bookmarks";
type JsonCommandOptions = {
	timeoutMs?: number;
	deadlineMs?: number;
	signal?: AbortSignal;
	onAttempt?: (attempt: XurlJsonCommandAttempt) => void;
};
export interface XurlJsonCommandAttempt {
	args: readonly string[];
	attempt: number;
	status: "ok" | "rate_limited" | "error";
	error?: Error;
}
type OAuth2UsernameCandidate = {
	app?: string;
	username?: string;
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
const oauth2CandidateCache = new Map<
	string,
	{ expiresAt: number; value: OAuth2UsernameCandidate }
>();

function liveWritesDisabled() {
	return process.env.BIRDCLAW_DISABLE_LIVE_WRITES === "1";
}

function e2eFakeLiveWritesEnabled() {
	return (
		process.env.BIRDCLAW_E2E === "1" &&
		process.env.BIRDCLAW_E2E_FAKE_LIVE_WRITES === "1"
	);
}

function getBearerToken() {
	if (process.env.BIRDCLAW_DISABLE_BEARER_TRANSPORT === "1") {
		return undefined;
	}
	return (
		process.env.BIRDCLAW_X_BEARER_TOKEN?.trim() ||
		process.env.X_BEARER_TOKEN?.trim() ||
		process.env.TWITTER_BEARER_TOKEN?.trim() ||
		undefined
	);
}

function getDefaultUserId() {
	return process.env.BIRDCLAW_X_USER_ID?.trim() || undefined;
}

function getEndpointArg(args: string[]) {
	return args.find((arg) => arg.startsWith("/2/"));
}

function isDirectBearerSupported(args: string[]) {
	const endpoint = getEndpointArg(args);
	return Boolean(endpoint && getBearerToken());
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

function emitJsonCommandAttempt(
	options: JsonCommandOptions,
	attempt: XurlJsonCommandAttempt,
) {
	try {
		options.onAttempt?.(attempt);
	} catch {
		// Telemetry observers must not affect xurl command behavior.
	}
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

export function resetAuthenticatedUserCache() {
	authenticatedUserCache = undefined;
	oauth2CandidateCache.clear();
}

function hasXurlEffect() {
	return runSubprocessEffect({ command: "xurl", args: ["version"] }).pipe(
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
		if (getBearerToken()) {
			return {
				installed: true,
				availableTransport: "xurl" as const,
				statusText: "X API bearer token available",
				rawStatus: "bearer-token",
			};
		}

		const installed = yield* hasXurlEffect();
		if (!installed) {
			return {
				installed: false,
				availableTransport: "local" as const,
				statusText: "xurl not installed. local mode active.",
			};
		}

		return yield* runSubprocessEffect({
			command: "xurl",
			args: ["auth", "status"],
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
						error instanceof Error &&
						!(error instanceof SubprocessError && !error.causeWasError)
							? error.message
							: "unknown error"
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

		return yield* runSubprocessEffect({ command: "xurl", args }).pipe(
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
	signal?: AbortSignal,
): Effect.Effect<{ stdout: string; stderr: string }, Error> {
	return runSubprocessEffect({
		command: "xurl",
		args,
		timeoutMs,
		signal,
	});
}

function getRemainingTimeoutMs(deadlineMs?: number) {
	if (deadlineMs === undefined) return undefined;
	const timeoutMs = Math.max(0, deadlineMs - Date.now());
	if (timeoutMs <= 0) {
		throw new Error("xurl OAuth2 fallback timed out");
	}
	return timeoutMs;
}

function execXurlTextEffect(
	args: string[],
	deadlineMs?: number,
): Effect.Effect<{ stdout: string; stderr: string }, Error> {
	return Effect.suspend(() => {
		try {
			return runSubprocessEffect({
				command: "xurl",
				args,
				timeoutMs: getRemainingTimeoutMs(deadlineMs),
			});
		} catch (error) {
			return Effect.fail(normalizeError(error));
		}
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

function runBearerJsonCommandEffect(
	args: string[],
	attempt: number,
): Effect.Effect<Record<string, unknown>, Error> {
	return Effect.gen(function* () {
		const endpoint = getEndpointArg(args);
		const token = getBearerToken();
		if (!endpoint || !token) {
			return yield* Effect.fail(
				new Error("X bearer token transport is not configured"),
			);
		}

		const response = yield* Effect.tryPromise({
			try: () =>
				fetch(`https://api.x.com${endpoint}`, {
					headers: { Authorization: `Bearer ${token}` },
				}),
			catch: normalizeError,
		});
		const text = yield* Effect.tryPromise({
			try: () => response.text(),
			catch: normalizeError,
		});
		let payload: Record<string, unknown>;
		try {
			payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
		} catch {
			payload = { error: text };
		}
		if (!response.ok) {
			const error = new Error(
				`X API request failed with HTTP ${response.status}`,
			) as Error & { stdout?: string };
			error.stdout = JSON.stringify({ ...payload, status: response.status });
			const retryDelayMs = getRetryDelayMs(error, attempt);
			if (retryDelayMs !== null && attempt < JSON_RETRY_LIMIT - 1) {
				return yield* Effect.sleep(retryDelayMs).pipe(
					Effect.flatMap(() => runBearerJsonCommandEffect(args, attempt + 1)),
				);
			}
			return yield* Effect.fail(error);
		}
		return payload;
	});
}

function runJsonCommandEffect(
	args: string[],
	options: JsonCommandOptions = {},
	attempt = 0,
): Effect.Effect<Record<string, unknown>, Error> {
	return Effect.gen(function* () {
		if (isDirectBearerSupported(args)) {
			return yield* runBearerJsonCommandEffect(args, attempt);
		}

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
		return yield* execXurlJsonEffect(args, timeoutMs, options.signal).pipe(
			Effect.flatMap(({ stdout }) => parseJsonPayloadEffect(stdout, args)),
			Effect.tap(() =>
				Effect.sync(() =>
					emitJsonCommandAttempt(options, { args, attempt, status: "ok" }),
				),
			),
			Effect.catchAll((error) => {
				const retryDelayMs = getRetryDelayMs(error, attempt);
				emitJsonCommandAttempt(options, {
					args,
					attempt,
					status: retryDelayMs === null ? "error" : "rate_limited",
					error,
				});
				if (retryDelayMs === null || attempt >= JSON_RETRY_LIMIT - 1) {
					return Effect.fail(formatXurlCommandError(error, args));
				}
				if (options.signal?.aborted) {
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

function cleanXurlUsernameLabel(username?: string) {
	const label = username?.trim().replace(/^@/, "");
	return label &&
		label !== "-" &&
		label !== "–" &&
		label !== "(none)" &&
		label.toLowerCase() !== "none" &&
		label.toLowerCase() !== "unknown" &&
		/^[^\s]{1,128}$/.test(label)
		? label
		: undefined;
}

function comparableXurlUsername(username?: string) {
	return cleanXurlUsernameLabel(username)?.toLowerCase();
}

function cleanXurlAppLabel(app?: string) {
	const label = app?.trim();
	return label && /^[^\s]{1,128}$/.test(label) ? label : undefined;
}

function parseOAuth2UsernamesFromStatus(rawStatus: string) {
	const seen = new Set<string>();
	const usernames: OAuth2UsernameCandidate[] = [];
	let currentApp: string | undefined;
	for (const line of rawStatus.split(/\r?\n/)) {
		const appMatch = line.match(/^\s*(?:▸\s*)?([^\s]+)\s+\[client_id:/);
		if (appMatch) {
			currentApp = cleanXurlAppLabel(appMatch[1]);
			continue;
		}
		const oauthMatch = line.match(/\boauth2:\s*([^\s]+)/);
		if (oauthMatch) {
			const username = cleanXurlUsernameLabel(oauthMatch[1]);
			const key = username
				? `${currentApp ?? "default"}:${username}`
				: undefined;
			if (username && key && !seen.has(key)) {
				seen.add(key);
				usernames.push({ app: currentApp, username });
			}
		}
	}
	return usernames;
}

function readOAuth2UsernameCandidatesEffect(
	deadlineMs?: number,
): Effect.Effect<OAuth2UsernameCandidate[], never> {
	return execXurlTextEffect(["auth", "status"], deadlineMs).pipe(
		Effect.map(({ stdout }) => parseOAuth2UsernamesFromStatus(stdout)),
		Effect.catchAll(() => Effect.succeed([])),
	);
}

export function readXurlOAuth2AccountsEffect(): Effect.Effect<
	LiveDataSourceAccount[],
	never
> {
	return readOAuth2UsernameCandidatesEffect().pipe(
		Effect.map((candidates) =>
			candidates.map((candidate) => ({
				...(candidate.app ? { app: candidate.app } : {}),
				...(candidate.username ? { username: candidate.username } : {}),
			})),
		),
	);
}

function lookupOAuth2UsernameForAccountEffect(
	expectedUsername: string,
	attemptedUsernames: Set<string>,
	deadlineMs?: number,
	knownCandidates?: OAuth2UsernameCandidate[],
) {
	return Effect.gen(function* () {
		const expected = comparableXurlUsername(expectedUsername);
		if (!expected) return undefined;

		const candidates =
			knownCandidates ??
			(yield* readOAuth2UsernameCandidatesEffect(deadlineMs));
		for (const candidate of candidates) {
			const candidateKey = `${candidate.app ?? "default"}:${candidate.username}`;
			if (attemptedUsernames.has(candidateKey)) continue;
			const payload = yield* runJsonCommandEffect(
				oauth2ArgsForCandidate(candidate, ["/2/users/me"]),
				{ deadlineMs },
			).pipe(Effect.catchAll(() => Effect.succeed(null)));
			const user = payload ? authenticatedUserFromPayload(payload) : null;
			const actual = comparableXurlUsername(String(user?.username ?? ""));
			if (actual === expected) {
				return candidate;
			}
		}

		return undefined;
	});
}

function oauth2ArgsForCandidate(
	candidate: OAuth2UsernameCandidate | undefined,
	args: string[],
) {
	return [
		...(candidate?.app ? ["--app", candidate.app] : []),
		"--auth",
		"oauth2",
		...(candidate?.username ? ["--username", candidate.username] : []),
		...args,
	];
}

function configuredOAuth2Candidate(primaryUsername: string | undefined) {
	const app = cleanXurlAppLabel(process.env.BIRDCLAW_XURL_OAUTH2_APP);
	const username = cleanXurlUsernameLabel(
		process.env.BIRDCLAW_XURL_OAUTH2_USERNAME,
	);
	if (!app && !username) return undefined;
	const effectiveUsername = username ?? primaryUsername;
	if (!app && !effectiveUsername) return undefined;
	return {
		...(app ? { app } : {}),
		...(effectiveUsername ? { username: effectiveUsername } : {}),
	};
}

function runOAuth2JsonCommandEffect({
	args,
	username,
	options,
	useConfiguredCandidate = true,
}: {
	args: string[];
	username?: string;
	options?: JsonCommandOptions;
	useConfiguredCandidate?: boolean;
}) {
	const primaryUsername = cleanXurlUsernameLabel(username);
	return Effect.gen(function* () {
		const deadlineMs =
			options?.deadlineMs ??
			(typeof options?.timeoutMs === "number" &&
			Number.isFinite(options.timeoutMs) &&
			options.timeoutMs > 0
				? Date.now() + options.timeoutMs
				: undefined);
		const scopedOptions = { ...options, deadlineMs };
		let authCandidate: OAuth2UsernameCandidate | undefined = primaryUsername
			? { username: primaryUsername }
			: undefined;
		const configuredCandidate = useConfiguredCandidate
			? configuredOAuth2Candidate(primaryUsername)
			: undefined;
		if (configuredCandidate) {
			authCandidate = configuredCandidate;
		} else if (primaryUsername) {
			const cacheKey = primaryUsername.toLowerCase();
			const cachedCandidate = oauth2CandidateCache.get(cacheKey);
			if (cachedCandidate && cachedCandidate.expiresAt > Date.now()) {
				authCandidate = cachedCandidate.value;
			} else {
				const candidates =
					yield* readOAuth2UsernameCandidatesEffect(deadlineMs);
				const primaryCandidates = candidates.filter(
					(candidate) => candidate.username === primaryUsername,
				);
				if (primaryCandidates.length === 1) {
					authCandidate = primaryCandidates[0];
				} else if (primaryCandidates.length > 1) {
					const verifiedUsername = yield* lookupOAuth2UsernameForAccountEffect(
						primaryUsername,
						new Set(),
						deadlineMs,
						candidates,
					);
					authCandidate = verifiedUsername ??
						primaryCandidates[0] ?? { username: primaryUsername };
				} else {
					const fallbackUsername = yield* lookupOAuth2UsernameForAccountEffect(
						primaryUsername,
						new Set(),
						deadlineMs,
						candidates,
					);
					if (fallbackUsername) {
						authCandidate = fallbackUsername;
					}
				}
				if (authCandidate) {
					oauth2CandidateCache.set(cacheKey, {
						expiresAt: Date.now() + AUTHENTICATED_USER_TTL_MS,
						value: authCandidate,
					});
				}
			}
		}

		if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
			return yield* Effect.fail(new Error("xurl OAuth2 fallback timed out"));
		}

		return yield* runJsonCommandEffect(
			oauth2ArgsForCandidate(authCandidate, args),
			scopedOptions,
		).pipe(
			Effect.catchAll((error) => {
				if (!primaryUsername) {
					return Effect.fail(error);
				}
				oauth2CandidateCache.delete(primaryUsername.toLowerCase());
				const attempted = new Set([
					authCandidate
						? `${authCandidate.app ?? "default"}:${authCandidate.username}`
						: `default:${primaryUsername}`,
				]);
				if (authCandidate?.username !== primaryUsername) {
					attempted.add(`default:${primaryUsername}`);
				}
				return lookupOAuth2UsernameForAccountEffect(
					primaryUsername,
					attempted,
					deadlineMs,
				).pipe(
					Effect.flatMap((fallbackUsername) => {
						if (!fallbackUsername) {
							return Effect.fail(error);
						}
						oauth2CandidateCache.set(primaryUsername.toLowerCase(), {
							expiresAt: Date.now() + AUTHENTICATED_USER_TTL_MS,
							value: fallbackUsername,
						});
						return runJsonCommandEffect(
							oauth2ArgsForCandidate(fallbackUsername, args),
							scopedOptions,
						);
					}),
					Effect.catchAll(() => Effect.fail(error)),
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

		return yield* runSubprocessEffect({ command: "xurl", args }).pipe(
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

export function lookupUsersByHandlesEffect(
	handles: string[],
	options: {
		auth?: "oauth2";
		username?: string;
		signal?: AbortSignal;
		useConfiguredCandidate?: boolean;
	} = {},
) {
	if (handles.length === 0) {
		return Effect.succeed([]);
	}

	const query = new URLSearchParams({
		usernames: handles.map((item) => item.replace(/^@/, "")).join(","),
		"user.fields":
			"description,entities,location,public_metrics,profile_image_url,url,created_at,verified,verified_type",
	});
	const args = [`/2/users/by?${query.toString()}`];
	const command =
		options.auth === "oauth2"
			? runOAuth2JsonCommandEffect({
					args,
					username: options.username,
					options: { signal: options.signal },
					useConfiguredCandidate: options.useConfiguredCandidate,
				})
			: runJsonCommandEffect(args, { signal: options.signal });
	return command.pipe(
		Effect.map((payload) =>
			Array.isArray(payload.data) ? (payload.data as XurlMentionUser[]) : [],
		),
	);
}

export function lookupUsersByHandles(
	handles: string[],
	options: {
		auth?: "oauth2";
		username?: string;
		signal?: AbortSignal;
		useConfiguredCandidate?: boolean;
	} = {},
) {
	return runEffectPromise(lookupUsersByHandlesEffect(handles, options));
}

function authenticatedUserFromPayload(payload: Record<string, unknown>) {
	const data = payload.data;
	return data && typeof data === "object"
		? (data as Record<string, unknown>)
		: null;
}

export function lookupAuthenticatedUserFreshEffect() {
	const defaultUserId = getDefaultUserId();
	return (
		defaultUserId
			? runJsonCommandEffect([
					`/2/users/${defaultUserId}?user.fields=${RICH_USER_FIELDS}`,
				])
			: runJsonCommandEffect(["whoami"])
	).pipe(Effect.map(authenticatedUserFromPayload));
}

export function lookupAuthenticatedOAuth2UserEffect(username?: string) {
	return runOAuth2JsonCommandEffect({
		args: ["whoami"],
		username,
	}).pipe(Effect.map(authenticatedUserFromPayload));
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

		const payload = yield* runOAuth2JsonCommandEffect({
			args: [`/2/users/${resolvedUserId}/mentions?${query.toString()}`],
			username,
		});
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

export function listHomeTimelineViaXurlEffect({
	maxResults,
	username,
	userId,
	paginationToken,
	timeoutMs,
}: {
	maxResults: number;
	username?: string;
	userId?: string;
	paginationToken?: string;
	timeoutMs?: number;
}): Effect.Effect<XurlMentionsResponse, Error> {
	return Effect.gen(function* () {
		const resolvedUserId = yield* resolveUserIdEffect({ username, userId });
		const query = new URLSearchParams({
			max_results: String(maxResults),
			expansions: AUTHOR_MEDIA_EXPANSIONS,
			"tweet.fields":
				"created_at,conversation_id,entities,public_metrics,referenced_tweets",
			"media.fields": MEDIA_FIELDS,
			"user.fields": RICH_USER_FIELDS,
		});
		if (paginationToken) {
			query.set("pagination_token", paginationToken);
		}

		const payload = yield* runOAuth2JsonCommandEffect({
			args: [
				`/2/users/${resolvedUserId}/timelines/reverse_chronological?${query.toString()}`,
			],
			username,
			options: { timeoutMs },
		});
		return toXurlMentionsResponse(payload);
	});
}

export function listHomeTimelineViaXurl(options: {
	maxResults: number;
	username?: string;
	userId?: string;
	paginationToken?: string;
	timeoutMs?: number;
}): Promise<XurlMentionsResponse> {
	return runEffectPromise(listHomeTimelineViaXurlEffect(options));
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

		const payload = yield* runOAuth2JsonCommandEffect({
			args: [`/2/users/${resolvedUserId}/${collection}?${query.toString()}`],
			username,
		});
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

export function listDirectMessageEventsViaXurlEffect({
	maxResults,
	username,
	paginationToken,
}: {
	maxResults: number;
	username?: string;
	paginationToken?: string;
}): Effect.Effect<XurlDmEventsResponse, Error> {
	const query = new URLSearchParams({
		max_results: String(maxResults),
		event_types: "MessageCreate",
		"dm_event.fields": DM_EVENT_FIELDS,
		expansions: "sender_id,participant_ids",
		"user.fields": RICH_USER_FIELDS,
	});
	if (paginationToken) {
		query.set("pagination_token", paginationToken);
	}

	return runOAuth2JsonCommandEffect({
		args: [`/2/dm_events?${query.toString()}`],
		username,
	}).pipe(
		Effect.map((payload) => ({
			data: Array.isArray(payload.data)
				? (payload.data as XurlDmEventsResponse["data"])
				: [],
			includes:
				payload.includes && typeof payload.includes === "object"
					? (payload.includes as XurlDmEventsResponse["includes"])
					: undefined,
			meta:
				payload.meta && typeof payload.meta === "object"
					? (payload.meta as Record<string, unknown>)
					: undefined,
		})),
	);
}

export function listDirectMessageEventsViaXurl(options: {
	maxResults: number;
	username?: string;
	paginationToken?: string;
}): Promise<XurlDmEventsResponse> {
	return runEffectPromise(listDirectMessageEventsViaXurlEffect(options));
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

		const payload = yield* runOAuth2JsonCommandEffect({
			args: [`/2/users/${resolvedUserId}/${direction}?${query.toString()}`],
			username,
		});
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
		username,
		signal,
		onAttempt,
		useConfiguredCandidate,
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
		username?: string;
		signal?: AbortSignal;
		onAttempt?: JsonCommandOptions["onAttempt"];
		useConfiguredCandidate?: boolean;
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
	const command =
		auth === "oauth2"
			? runOAuth2JsonCommandEffect({
					args: [endpoint],
					username,
					options: { signal, onAttempt },
					useConfiguredCandidate,
				})
			: runJsonCommandEffect([endpoint], { signal, onAttempt });
	return command.pipe(
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
		username?: string;
		signal?: AbortSignal;
		onAttempt?: JsonCommandOptions["onAttempt"];
		useConfiguredCandidate?: boolean;
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
		auth,
		username,
		signal,
		onAttempt,
	}: {
		maxResults: number;
		paginationToken?: string;
		timeoutMs?: number;
		auth?: "oauth2";
		username?: string;
		signal?: AbortSignal;
		onAttempt?: JsonCommandOptions["onAttempt"];
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

	const args = [`/2/tweets/search/recent?${query.toString()}`];
	const command =
		auth === "oauth2"
			? runOAuth2JsonCommandEffect({
					args,
					username,
					options: { timeoutMs, signal, onAttempt },
					useConfiguredCandidate: false,
				})
			: runJsonCommandEffect(args, { timeoutMs, signal, onAttempt });
	return command.pipe(Effect.map(toXurlTweetsResponse));
}

export function searchRecentByConversationId(
	conversationId: string,
	options: {
		maxResults: number;
		paginationToken?: string;
		timeoutMs?: number;
		auth?: "oauth2";
		username?: string;
		signal?: AbortSignal;
		onAttempt?: JsonCommandOptions["onAttempt"];
	},
): Promise<XurlTweetsResponse> {
	return runEffectPromise(
		searchRecentByConversationIdEffect(conversationId, options),
	);
}

export function searchRecentTweetsEffect(
	searchQuery: string,
	{
		maxResults,
		paginationToken,
		startTime,
		endTime,
		username,
		timeoutMs,
	}: {
		maxResults: number;
		paginationToken?: string;
		startTime?: string;
		endTime?: string;
		username?: string;
		timeoutMs?: number;
	},
): Effect.Effect<XurlTweetsResponse, Error> {
	const query = new URLSearchParams({
		query: searchQuery,
		max_results: String(maxResults),
		expansions: AUTHOR_MEDIA_EXPANSIONS,
		"tweet.fields": THREAD_TWEET_FIELDS,
		"media.fields": MEDIA_FIELDS,
		"user.fields": RICH_USER_FIELDS,
	});
	if (paginationToken) {
		query.set("pagination_token", paginationToken);
	}
	if (startTime) {
		query.set("start_time", startTime);
	}
	if (endTime) {
		query.set("end_time", endTime);
	}

	return runOAuth2JsonCommandEffect({
		args: [`/2/tweets/search/recent?${query.toString()}`],
		username,
		options: { timeoutMs },
		useConfiguredCandidate: false,
	}).pipe(Effect.map(toXurlTweetsResponse));
}

export function searchRecentTweets(
	searchQuery: string,
	options: {
		maxResults: number;
		paginationToken?: string;
		startTime?: string;
		endTime?: string;
		username?: string;
		timeoutMs?: number;
	},
): Promise<XurlTweetsResponse> {
	return runEffectPromise(searchRecentTweetsEffect(searchQuery, options));
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
