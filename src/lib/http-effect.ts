import { Effect } from "effect";
import { runEffectPromise, tryPromise } from "./effect-runtime";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function jsonResponse(data: unknown, init?: ResponseInit) {
	const headers = new Headers(init?.headers);
	headers.set("content-type", "application/json");
	return new Response(JSON.stringify(data), {
		...init,
		headers,
	});
}

export function requestJsonEffect<T = Record<string, unknown>>(
	request: Request,
	fallback?: T,
): Effect.Effect<T, unknown> {
	return tryPromise(() => request.json() as Promise<T>).pipe(
		Effect.catchAll((error) =>
			fallback === undefined ? Effect.fail(error) : Effect.succeed(fallback),
		),
	);
}

export function runRouteEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
	return runEffectPromise(effect);
}

function normalizedHost(value: string) {
	return value.toLowerCase().replace(/^\[|\]$/g, "");
}

function isTestEnvironment() {
	return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

function requestCookie(request: Request, name: string) {
	const cookie = request.headers.get("cookie");
	if (!cookie) return { found: false, value: null };
	for (const part of cookie.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) {
			try {
				return { found: true, value: decodeURIComponent(rest.join("=")) };
			} catch {
				return { found: true, value: null };
			}
		}
	}
	return { found: false, value: null };
}

function configuredWebToken() {
	const token = process.env.BIRDCLAW_WEB_TOKEN?.trim();
	return token || null;
}

function requestWebTokenStatus(request: Request) {
	const token = configuredWebToken();
	if (!token)
		return {
			configured: false,
			valid: false,
			fromCookie: false,
			provided: false,
		};
	const headerToken = request.headers.get("x-birdclaw-token");
	const cookieToken = requestCookie(request, "birdclaw_token");
	const provided = headerToken !== null || cookieToken.found;
	const cookieValue = cookieToken.value;
	const valid = headerToken === token || cookieValue === token;
	return {
		configured: true,
		valid,
		fromCookie: cookieValue === token && headerToken !== token,
		provided,
	};
}

function isLocalWebHost(value: string) {
	const host = normalizedHost(value);
	return LOCAL_HOSTS.has(host) || host.endsWith(".localhost");
}

function allowsUnauthenticatedLocalWeb() {
	return process.env.BIRDCLAW_LOCAL_WEB === "1";
}

function hasForwardedRequestHeaders(request: Request) {
	return (
		request.headers.has("forwarded") ||
		request.headers.has("x-forwarded-for") ||
		request.headers.has("x-forwarded-proto") ||
		request.headers.has("x-forwarded-host") ||
		request.headers.has("x-real-ip")
	);
}

function firstForwardedValue(value: string | null) {
	return value?.split(",")[0]?.trim() || null;
}

function forwardedHeaderPair(request: Request, key: "host" | "proto") {
	const forwarded = firstForwardedValue(request.headers.get("forwarded"));
	if (!forwarded) return null;
	for (const part of forwarded.split(";")) {
		const [name, ...rest] = part.trim().split("=");
		if (name?.toLowerCase() !== key) continue;
		const value = rest.join("=").trim().replace(/^"|"$/g, "");
		return value || null;
	}
	return null;
}

function forwardedOrigin(request: Request) {
	const proto =
		firstForwardedValue(request.headers.get("x-forwarded-proto")) ??
		forwardedHeaderPair(request, "proto");
	const host =
		firstForwardedValue(request.headers.get("x-forwarded-host")) ??
		forwardedHeaderPair(request, "host");
	if (!proto || !host) return null;
	const normalizedProto = proto.toLowerCase();
	if (normalizedProto !== "http" && normalizedProto !== "https") return null;
	return `${normalizedProto}://${host}`;
}

function sameRequestOrigin(request: Request, origin: string, url: URL) {
	return origin === url.origin || origin === forwardedOrigin(request);
}

export function sensitiveRequestErrorResponse(request: Request) {
	const url = new URL(request.url);
	const token = requestWebTokenStatus(request);
	const isLocalRequest =
		allowsUnauthenticatedLocalWeb() &&
		isLocalWebHost(url.hostname) &&
		!hasForwardedRequestHeaders(request);
	const fetchSite = request.headers.get("sec-fetch-site");
	const origin = request.headers.get("origin");
	const allowRemoteEnv = process.env.BIRDCLAW_ALLOW_REMOTE_WEB === "1";
	const allowTrustedRemote = allowRemoteEnv && !token.configured;

	if (isTestEnvironment() && !token.valid) return null;

	if (origin && !sameRequestOrigin(request, origin, url)) {
		return jsonResponse(
			{ ok: false, message: "Cross-origin web API access is disabled" },
			{ status: 403 },
		);
	}

	if (fetchSite === "cross-site") {
		return jsonResponse(
			{ ok: false, message: "Cross-site web API access is disabled" },
			{ status: 403 },
		);
	}

	if (
		!isTestEnvironment() &&
		!token.configured &&
		!isLocalRequest &&
		!allowTrustedRemote
	) {
		return jsonResponse(
			{
				ok: false,
				message:
					"Remote API access requires BIRDCLAW_ALLOW_REMOTE_WEB=1 for a trusted private proxy, or BIRDCLAW_WEB_TOKEN for tokened access",
			},
			{ status: 403 },
		);
	}

	if (token.configured && !token.valid && (token.provided || !isLocalRequest)) {
		return jsonResponse(
			{ ok: false, message: "Invalid web token" },
			{ status: 403 },
		);
	}

	const allowRemote = allowRemoteEnv && (token.valid || allowTrustedRemote);
	if (!allowRemote && !isLocalRequest) {
		return jsonResponse(
			{ ok: false, message: "Remote web API access is disabled" },
			{ status: 403 },
		);
	}

	if (
		token.fromCookie &&
		fetchSite !== "same-origin" &&
		fetchSite !== "same-site"
	) {
		return jsonResponse(
			{ ok: false, message: "Same-origin browser request required" },
			{ status: 403 },
		);
	}

	return null;
}

export function parseBoundedInteger(
	value: number | string | null | undefined,
	{
		defaultValue,
		min = 1,
		max,
	}: { defaultValue?: number; min?: number; max: number },
) {
	if (value === null || value === undefined || value === "")
		return defaultValue;
	if (typeof value === "string" && !/^\d+$/.test(value.trim())) {
		return defaultValue;
	}
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isSafeInteger(parsed)) return defaultValue;
	return Math.min(max, Math.max(min, parsed));
}
