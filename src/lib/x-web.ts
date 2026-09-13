import { isReadOnlyDeployment } from "./config";
import {
	assertLiveAccountMatches,
	type LiveAccountIdentity,
} from "./live-sync-engine";

const ORIGIN = "https://x.com";
let publicClient:
	| Promise<{ bearer: string; viewerQueryId: string }>
	| undefined;

class XWebHttpError extends Error {
	constructor(readonly status: number) {
		super(`X web request failed (HTTP ${String(status)})`);
	}
}

export function hasXWebCredentials() {
	return Boolean(process.env.AUTH_TOKEN?.trim() && process.env.CT0?.trim());
}

export function webObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

async function readText(response: Response, maximum: number) {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maximum)
				throw new Error("X web response exceeded its size limit");
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function request(url: string, init: RequestInit = {}) {
	let response: Response;
	try {
		const headers = new Headers(init.headers);
		if (!headers.has("user-agent")) headers.set("user-agent", "Mozilla/5.0");
		response = await fetch(url, {
			...init,
			headers,
			redirect: "manual",
			signal: AbortSignal.timeout(15_000),
		});
	} catch {
		throw new Error("X web request failed or timed out");
	}
	if (!response.ok) {
		await response.body?.cancel();
		throw new XWebHttpError(response.status);
	}
	return response;
}

async function discoverPublicClient() {
	// The web application's public bearer is discovered from its own assets;
	// no account credential or copied bearer is embedded in the package.
	const html = await readText(await request(ORIGIN), 2 * 1024 * 1024);
	const queue = [
		...new Set(html.match(/https:\/\/abs\.twimg\.com\/[^"'<>\s]+\.js/g)),
	];
	const seen = new Set<string>();
	let remainingBytes = 16 * 1024 * 1024;
	let bearer: string | undefined;
	let viewerQueryId: string | undefined;
	for (
		let inspected = 0;
		queue.length && inspected < 12 && remainingBytes > 0;
		inspected++
	) {
		queue.sort(
			(a, b) =>
				Number(!/auth|token|headers|viewer/.test(a)) -
				Number(!/auth|token|headers|viewer/.test(b)),
		);
		const script = queue.shift()!;
		if (seen.has(script)) continue;
		seen.add(script);
		const url = new URL(script);
		if (
			url.origin !== "https://abs.twimg.com" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			!/^\/(?:x-web|responsive-web)\/.+\.js$/.test(url.pathname)
		)
			continue;
		const source = await readText(
			await request(script),
			Math.min(8 * 1024 * 1024, remainingBytes),
		);
		remainingBytes -= Buffer.byteLength(source);
		const match = source.match(/\bAAAAA[A-Za-z0-9%]{40,250}/);
		if (match) {
			const token = match[0];
			if (/^(?:[A-Za-z0-9]|%[0-9a-fA-F]{2})+$/.test(token)) bearer = token;
		}
		viewerQueryId ??= source.match(
			/params:\{id:["'`]([A-Za-z0-9_-]{10,100})["'`][\s\S]{0,200}?name:["'`]viewerQuery["'`]/,
		)?.[1];
		if (bearer && viewerQueryId) return { bearer, viewerQueryId };
		for (const dependency of source.matchAll(
			/\b(?:from\s*|import\s*\(?\s*)["'`]([^"'`]+\.js)["'`]/g,
		)) {
			try {
				queue.push(new URL(dependency[1], url).href);
			} catch {
				/* Ignore invalid module specifiers. */
			}
		}
	}
	throw new Error(
		"Could not discover X web authentication; the web client may have changed",
	);
}

function getPublicClient() {
	publicClient ??= discoverPublicClient().catch((error) => {
		publicClient = undefined;
		throw error;
	});
	return publicClient;
}

export class XWebSession {
	readonly #cookie: string;
	readonly #csrf: string;
	#verifiedAccountId: string | undefined;
	private responseBytes = 0;

	constructor() {
		if (isReadOnlyDeployment())
			throw new Error(
				"X web access is disabled in a read-only archive deployment",
			);
		const auth = process.env.AUTH_TOKEN?.trim() ?? "";
		const csrf = process.env.CT0?.trim() ?? "";
		if (
			![auth, csrf].every((value) => /^[A-Za-z0-9._~%+-]{20,2048}$/.test(value))
		) {
			throw new Error(
				"Native X web access requires valid AUTH_TOKEN and CT0 session cookies",
			);
		}
		this.#cookie = `auth_token=${auth}; ct0=${csrf}`;
		this.#csrf = csrf;
	}

	async json(
		path: string,
		form?: URLSearchParams,
		allowEmpty = false,
	): Promise<Record<string, unknown>> {
		if (
			!path.startsWith("/i/api/") ||
			path.includes("#") ||
			path.includes("\\")
		)
			throw new Error("Invalid X web endpoint");
		if (isReadOnlyDeployment())
			throw new Error(
				"X web access is disabled in a read-only archive deployment",
			);
		if (form && process.env.BIRDCLAW_DISABLE_LIVE_WRITES === "1")
			throw new Error("live writes disabled");
		if ((form || path.startsWith("/i/api/1.1/dm/")) && !this.#verifiedAccountId)
			throw new Error(
				"Verify the X web account before accessing DMs or writing",
			);
		const response = await request(ORIGIN + path, {
			method: form ? "POST" : "GET",
			headers: {
				authorization: `Bearer ${(await getPublicClient()).bearer}`,
				cookie: this.#cookie,
				"x-csrf-token": this.#csrf,
				"x-twitter-auth-type": "OAuth2Session",
				"x-twitter-active-user": "yes",
				accept: "application/json",
				referer: `${ORIGIN}/messages`,
				...(form
					? { "content-type": "application/x-www-form-urlencoded" }
					: {}),
			},
			...(form ? { body: form.toString() } : {}),
		}).catch((error) => {
			if (
				error instanceof XWebHttpError &&
				(error.status === 401 ||
					(error.status === 404 && path.startsWith("/i/api/graphql/")))
			)
				publicClient = undefined;
			throw error;
		});
		const text = await readText(response, 32 * 1024 * 1024);
		this.responseBytes += Buffer.byteLength(text);
		if (this.responseBytes > 128 * 1024 * 1024)
			throw new Error("X web operation exceeded its response budget");
		if (allowEmpty && (!text.trim() || text.trim() === "OK")) return {};
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			throw new Error("X web returned invalid JSON");
		}
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("X web returned an invalid response");
		const payload = webObject(value);
		if (
			payload.success === false ||
			payload.ok === false ||
			(payload.errors != null &&
				(!Array.isArray(payload.errors) || payload.errors.length > 0))
		)
			throw new Error("X web rejected the request");
		return payload;
	}

	async verifyAccount(account: LiveAccountIdentity) {
		if (isReadOnlyDeployment())
			throw new Error(
				"X web access is disabled in a read-only archive deployment",
			);
		const { viewerQueryId } = await getPublicClient();
		const variables = new URLSearchParams({
			variables: JSON.stringify({
				__relay_internal__pv__appviewerisloggedinprovider: true,
			}),
		});
		const payload = await this.json(
			`/i/api/graphql/${viewerQueryId}/viewerQuery?${variables}`,
		);
		const data = webObject(payload.data);
		const viewer = webObject(data.viewer ?? data.viewer_v2);
		const result = webObject(webObject(viewer.user_results).result);
		const user = webObject(result.user ?? result);
		const core = webObject(user.core);
		const id = user.rest_id;
		const username = core.screen_name;
		if (
			typeof id !== "string" ||
			!/^\d+$/.test(id) ||
			typeof username !== "string" ||
			!/^[A-Za-z0-9_]{1,15}$/.test(username)
		)
			throw new Error(
				"X web did not confirm the authenticated account identity",
			);
		assertLiveAccountMatches({
			source: "web",
			account,
			liveUsername: username,
			liveExternalUserId: id,
		});
		this.#verifiedAccountId = id;
		return {
			id,
			username,
			name: typeof core.name === "string" ? core.name : username,
		};
	}
}
