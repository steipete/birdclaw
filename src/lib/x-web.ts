import { randomUUID } from "node:crypto";
import { getCookies } from "@steipete/sweet-cookie";

const X_WEB_BEARER_TOKEN =
	"AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const X_WEB_USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const X_WEB_COOKIE_NAMES = ["auth_token", "ct0"] as const;
const X_WEB_ORIGINS = ["https://x.com/", "https://twitter.com/"];

type CookieSource = "safari" | "chrome" | "firefox";

function normalizeCookieValue(value: unknown) {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

function buildCookieHeader(authToken: string, ct0: string) {
	return `auth_token=${authToken}; ct0=${ct0}`;
}

function pickCookieValue(
	cookies: Array<{ name?: string; value?: string; domain?: string }>,
	name: (typeof X_WEB_COOKIE_NAMES)[number],
) {
	const matches = cookies.filter(
		(cookie) => cookie?.name === name && typeof cookie.value === "string",
	);
	if (matches.length === 0) {
		return null;
	}

	const xDomain = matches.find((cookie) =>
		(cookie.domain ?? "").endsWith("x.com"),
	);
	if (xDomain?.value) {
		return xDomain.value;
	}

	const twitterDomain = matches.find((cookie) =>
		(cookie.domain ?? "").endsWith("twitter.com"),
	);
	if (twitterDomain?.value) {
		return twitterDomain.value;
	}

	return matches[0]?.value ?? null;
}

async function resolveXWebCookies() {
	const envAuthToken = normalizeCookieValue(
		process.env.AUTH_TOKEN ?? process.env.TWITTER_AUTH_TOKEN,
	);
	const envCt0 = normalizeCookieValue(
		process.env.CT0 ?? process.env.TWITTER_CT0,
	);

	if (envAuthToken && envCt0) {
		return {
			authToken: envAuthToken,
			ct0: envCt0,
			cookieHeader: buildCookieHeader(envAuthToken, envCt0),
			source: "env",
		};
	}

	const cookieResult = await getCookies({
		url: "https://x.com/",
		origins: [...X_WEB_ORIGINS],
		names: [...X_WEB_COOKIE_NAMES],
		browsers: ["safari", "chrome", "firefox"] satisfies CookieSource[],
		mode: "merge",
		timeoutMs: process.platform === "darwin" ? 30_000 : undefined,
	});

	const authToken = pickCookieValue(cookieResult.cookies, "auth_token");
	const ct0 = pickCookieValue(cookieResult.cookies, "ct0");
	if (!authToken || !ct0) {
		return null;
	}

	return {
		authToken,
		ct0,
		cookieHeader: buildCookieHeader(authToken, ct0),
		source: "browser",
	};
}

async function runXWebBlockMutation(
	path: string,
	params: URLSearchParams,
	action: string,
) {
	try {
		const cookies = await resolveXWebCookies();
		if (!cookies) {
			return {
				ok: false,
				output: `x-web ${action} unavailable: missing auth_token/ct0 cookies`,
			};
		}

		const response = await fetch(`https://x.com/i/api/1.1/${path}`, {
			method: "POST",
			headers: {
				accept: "*/*",
				"accept-language": "en-US,en;q=0.9",
				authorization: `Bearer ${X_WEB_BEARER_TOKEN}`,
				"content-type": "application/x-www-form-urlencoded",
				cookie: cookies.cookieHeader,
				origin: "https://x.com",
				referer: "https://x.com/",
				"user-agent": X_WEB_USER_AGENT,
				"x-client-transaction-id": randomUUID().replaceAll("-", ""),
				"x-csrf-token": cookies.ct0,
				"x-twitter-active-user": "yes",
				"x-twitter-auth-type": "OAuth2Session",
				"x-twitter-client-language": "en",
			},
			body: params,
		});

		const text = await response.text();
		if (!response.ok) {
			return {
				ok: false,
				output: `x-web ${action} failed (${response.status}): ${text.slice(0, 240)}`,
			};
		}

		return {
			ok: true,
			output: `x-web ${action} ok via ${cookies.source}`,
		};
	} catch (error) {
		return {
			ok: false,
			output:
				error instanceof Error
					? `x-web ${action} failed: ${error.message}`
					: `x-web ${action} failed`,
		};
	}
}

export async function blockUserViaXWeb(targetUserId: string) {
	return runXWebBlockMutation(
		"blocks/create.json",
		new URLSearchParams({
			user_id: targetUserId,
			skip_status: "true",
		}),
		"block",
	);
}

export async function unblockUserViaXWeb(targetUserId: string) {
	return runXWebBlockMutation(
		"blocks/destroy.json",
		new URLSearchParams({
			user_id: targetUserId,
			skip_status: "true",
		}),
		"unblock",
	);
}
