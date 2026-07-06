import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { Effect } from "effect";
import type { LinkPreviewResponse } from "./api-contracts";
import { getNativeDb } from "./db";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import type { Database } from "./sqlite";
import {
	__test__ as urlSafetyTest,
	assertSafePreviewUrl,
	isBlockedAddress,
} from "./url-safety";
import {
	normalizeUrlExpansionForIndex,
	upsertUrlExpansion,
} from "./url-expansion-store";

const FETCH_TIMEOUT_MS = 12_000;
const MAX_HTML_CHARS = 2_000_000;
const MAX_REDIRECTS = 4;
const NO_BODY_STATUS_CODES = new Set([204, 205, 304]);

export type LinkPreviewMetadata = LinkPreviewResponse["preview"];

export interface GetLinkPreviewOptions {
	shortUrl?: string | null;
	refresh?: boolean;
	fetchImpl?: typeof fetch;
	resolveHost?: (hostname: string) => Promise<string[]>;
	timeoutMs?: number;
	method?: "GET" | "HEAD";
}

interface ResolvedAddress {
	address: string;
	family: 4 | 6;
}

type UrlExpansionPreviewRow = {
	short_url: string;
	expanded_url: string;
	final_url: string;
	status: "hit" | "miss" | "error";
	title: string | null;
	description: string | null;
	image_url: string | null;
	site_name: string | null;
	error: string | null;
	source: string;
	updated_at: string;
};

function cleanText(value: string | null | undefined) {
	if (!value) return null;
	const cleaned = decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
	return cleaned.length > 0 ? cleaned : null;
}

function decodeCodePoint(value: number, fallback: string) {
	try {
		return String.fromCodePoint(value);
	} catch {
		return fallback;
	}
}

function decodeHtmlEntities(value: string) {
	return value
		.replace(/&#(\d+);/g, (entity: string, code: string) =>
			decodeCodePoint(Number(code), entity),
		)
		.replace(/&#x([a-f0-9]+);/gi, (entity: string, code: string) =>
			decodeCodePoint(Number.parseInt(code, 16), entity),
		)
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'");
}

function parseAttributes(tag: string) {
	const attributes = new Map<string, string>();
	for (const match of tag.matchAll(
		/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g,
	)) {
		const key = match[1]?.toLowerCase();
		const value = match[3] ?? match[4] ?? match[5] ?? "";
		if (key) {
			attributes.set(key, value);
		}
	}
	return attributes;
}

function metaContents(html: string) {
	const values = new Map<string, string>();
	for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
		const attributes = parseAttributes(match[0]);
		const key = (
			attributes.get("property") ??
			attributes.get("name") ??
			""
		).toLowerCase();
		const content = cleanText(
			attributes.get("content") ?? attributes.get("value") ?? "",
		);
		if (key && content && !values.has(key)) {
			values.set(key, content);
		}
	}
	return values;
}

function pick(values: Map<string, string>, keys: string[]) {
	for (const key of keys) {
		const value = cleanText(values.get(key));
		if (value) return value;
	}
	return null;
}

function titleFromHtml(html: string) {
	const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
	return cleanText(match?.[1]);
}

function absoluteUrl(value: string | null, baseUrl: string) {
	if (!value) return null;
	try {
		return new URL(value, baseUrl).toString();
	} catch {
		return null;
	}
}

function hostLabel(url: string) {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

function isInjectedFetchAllowed() {
	return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

function stripAddressBrackets(value: string) {
	return value.replace(/^\[|\]$/g, "");
}

export async function resolvePublicAddresses(
	hostname: string,
): Promise<string[]> {
	const normalized = stripAddressBrackets(hostname);
	if (net.isIP(normalized)) return [normalized];
	const records = await lookup(normalized, { all: true, verbatim: true });
	return records.map((record) => record.address);
}

function validateResolvedAddresses(addresses: string[]) {
	if (addresses.length === 0) {
		throw new Error("Link preview host did not resolve");
	}
	if (addresses.some(isBlockedAddress)) {
		throw new Error("Link preview URL resolves to a private address");
	}
}

const resolveSafeAddressesEffect = Effect.fn(
	"linkPreview.resolveSafeAddresses",
)(
	(
		hostname: string,
		resolveHost: (hostname: string) => Promise<string[]>,
		timeoutMs: number,
	) =>
		tryPromise(() => resolveHost(stripAddressBrackets(hostname))).pipe(
			Effect.timeoutFail({
				duration: timeoutMs,
				onTimeout: () => new Error("Link preview request timed out"),
			}),
			Effect.flatMap((addresses) =>
				Effect.try({
					try: (): ResolvedAddress[] => {
						validateResolvedAddresses(addresses);
						return addresses.map((address) => {
							const normalized = stripAddressBrackets(address);
							const family = net.isIP(normalized);
							if (family !== 4 && family !== 6) {
								throw new Error(
									"Link preview host resolved to an invalid address",
								);
							}
							return { address: normalized, family };
						});
					},
					catch: (error) => error,
				}),
			),
		),
);

function headersFromIncoming(headers: http.IncomingHttpHeaders): HeadersInit {
	const result = new Headers();
	for (const [key, value] of Object.entries(headers)) {
		if (Array.isArray(value)) {
			for (const item of value) result.append(key, item);
		} else if (typeof value === "string") {
			result.set(key, value);
		}
	}
	return result;
}

function decodedResponseBody(response: Response) {
	const body = response.body;
	if (!body) return null;
	const encoding = response.headers
		.get("content-encoding")
		?.split(",")
		.at(-1)
		?.trim()
		.toLowerCase();
	if (!encoding || encoding === "identity") return body;
	const nodeBody = Readable.fromWeb(
		body as Parameters<typeof Readable.fromWeb>[0],
	);
	if (encoding === "gzip" || encoding === "x-gzip") {
		return Readable.toWeb(nodeBody.pipe(createGunzip())) as ReadableStream;
	}
	if (encoding === "br") {
		return Readable.toWeb(
			nodeBody.pipe(createBrotliDecompress()),
		) as ReadableStream;
	}
	if (encoding === "deflate") {
		return Readable.toWeb(nodeBody.pipe(createInflate())) as ReadableStream;
	}
	return body;
}

function cancelResponseBodyEffect(response: Response) {
	return tryPromise(() => response.body?.cancel() ?? Promise.resolve()).pipe(
		Effect.catchAll(() => Effect.void),
	);
}

function respondWithResolvedAddress(
	selected: ResolvedAddress,
	lookupOptions: { all?: boolean } | number | undefined,
	callback: (
		error: Error | null,
		address: string | ResolvedAddress[],
		family?: 4 | 6,
	) => void,
) {
	if (typeof lookupOptions === "object" && lookupOptions?.all) {
		callback(null, [selected]);
		return;
	}
	callback(null, selected.address, selected.family);
}

function nodeSafeFetch(
	url: URL,
	options: {
		addresses: ResolvedAddress[];
		headers: Record<string, string>;
		method: "GET" | "HEAD";
		timeoutMs: number;
	},
) {
	const deadline = Date.now() + options.timeoutMs;

	function fetchAddress(address: ResolvedAddress, attemptTimeoutMs: number) {
		return new Promise<Response>((resolve, reject) => {
			let settled = false;
			const finish = (callback: () => void) => {
				if (settled) return;
				settled = true;
				try {
					callback();
				} catch (error) {
					reject(error);
				}
			};

			const client = url.protocol === "https:" ? https : http;
			let wallClockTimeout: NodeJS.Timeout | null = null;
			const clearWallClockTimeout = () => {
				if (!wallClockTimeout) return;
				clearTimeout(wallClockTimeout);
				wallClockTimeout = null;
			};
			const setWallClockTimeout = (
				ms: number,
				target: { destroy: (error: Error) => void },
			) => {
				clearWallClockTimeout();
				wallClockTimeout = setTimeout(() => {
					target.destroy(new Error("Link preview request timed out"));
				}, ms);
			};
			const request = client.request(
				url,
				{
					headers: options.headers,
					method: options.method,
					lookup: (_hostname, lookupOptions, callback) => {
						respondWithResolvedAddress(address, lookupOptions, callback);
					},
				},
				(incoming) => {
					request.setTimeout(0);
					setWallClockTimeout(Math.max(1, deadline - Date.now()), incoming);
					incoming.once("end", clearWallClockTimeout);
					incoming.once("close", clearWallClockTimeout);
					incoming.once("error", clearWallClockTimeout);
					finish(() => {
						const status = incoming.statusCode ?? 200;
						const response = new Response(
							NO_BODY_STATUS_CODES.has(status)
								? null
								: (Readable.toWeb(incoming) as ReadableStream),
							{
								headers: headersFromIncoming(incoming.headers),
								status,
								statusText: incoming.statusMessage,
							},
						);
						Object.defineProperty(response, "url", {
							value: url.toString(),
						});
						resolve(response);
					});
				},
			);
			setWallClockTimeout(attemptTimeoutMs, request);
			request.setTimeout(attemptTimeoutMs, () => {
				request.destroy(new Error("Link preview request timed out"));
			});
			request.on("error", (error) => {
				clearWallClockTimeout();
				finish(() => reject(error));
			});
			request.end();
		});
	}

	return options.addresses.reduce<Promise<Response>>(
		(previous, address, index) =>
			previous.catch((error: unknown) => {
				const remainingMs = deadline - Date.now();
				if (remainingMs <= 0) throw error;
				const remainingAddresses = options.addresses.length - index;
				const attemptTimeoutMs = Math.max(
					1,
					Math.ceil(remainingMs / remainingAddresses),
				);
				return fetchAddress(address, attemptTimeoutMs);
			}),
		Promise.reject(new Error("Link preview host did not resolve")),
	);
}

export const safePreviewFetchEffect = Effect.fn("linkPreview.safePreviewFetch")(
	function* (
		url: string,
		options: Pick<
			GetLinkPreviewOptions,
			"fetchImpl" | "method" | "resolveHost" | "timeoutMs"
		>,
	) {
		const resolveHost =
			options.resolveHost ??
			(options.fetchImpl
				? null
				: (hostname: string) => resolvePublicAddresses(hostname));
		const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
		const method = options.method ?? "GET";
		const deadline = Date.now() + timeoutMs;
		const remainingTimeoutMs = () => Math.max(1, deadline - Date.now());
		const headers: Record<string, string> = {
			"user-agent":
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 birdclaw/0.4",
			accept:
				"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
			"accept-language": "en-US,en;q=0.9",
		};

		if (options.fetchImpl && !isInjectedFetchAllowed()) {
			return yield* Effect.fail(
				new Error("Custom link preview fetch is only available in tests"),
			);
		}

		let currentUrl = url;
		for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
			if (Date.now() >= deadline) {
				return yield* Effect.fail(new Error("Link preview request timed out"));
			}
			const parsed = yield* Effect.try({
				try: () => assertSafePreviewUrl(currentUrl),
				catch: (error) => error,
			});
			if (options.fetchImpl && resolveHost) {
				yield* resolveSafeAddressesEffect(
					parsed.hostname,
					resolveHost,
					remainingTimeoutMs(),
				);
			}
			if (Date.now() >= deadline) {
				return yield* Effect.fail(new Error("Link preview request timed out"));
			}

			const response = options.fetchImpl
				? yield* tryPromise(
						() =>
							options.fetchImpl?.(parsed.toString(), {
								headers,
								method,
								redirect: "manual",
								signal: AbortSignal.timeout(remainingTimeoutMs()),
							}) as Promise<Response>,
					)
				: yield* resolveSafeAddressesEffect(
						parsed.hostname,
						options.resolveHost ?? resolvePublicAddresses,
						remainingTimeoutMs(),
					).pipe(
						Effect.filterOrFail(
							() => Date.now() < deadline,
							() => new Error("Link preview request timed out"),
						),
						Effect.flatMap((addresses) =>
							tryPromise(() =>
								nodeSafeFetch(parsed, {
									addresses,
									headers,
									method,
									timeoutMs: remainingTimeoutMs(),
								}),
							),
						),
					);
			if (response.status < 300 || response.status >= 400) return response;

			const location = response.headers.get("location");
			if (!location) return response;
			yield* cancelResponseBodyEffect(response);
			if (redirect === MAX_REDIRECTS) {
				return yield* Effect.fail(
					new Error("Link preview redirected too many times"),
				);
			}
			const nextUrl = yield* Effect.try({
				try: () => new URL(location, parsed).toString(),
				catch: (error) => error,
			});
			currentUrl = nextUrl;
		}
		return yield* Effect.fail(
			new Error("Link preview redirected too many times"),
		);
	},
);

function readResponseTextEffect(response: Response) {
	const contentLength = Number(response.headers.get("content-length") ?? 0);
	if (Number.isFinite(contentLength) && contentLength > MAX_HTML_CHARS) {
		return tryPromise(() => response.body?.cancel() ?? Promise.resolve()).pipe(
			Effect.flatMap(() =>
				Effect.fail(new Error("Link preview response is too large")),
			),
		);
	}
	const reader = decodedResponseBody(response)?.getReader();
	if (!reader) return tryPromise(() => response.text());
	const decoder = new TextDecoder();
	let total = 0;
	let text = "";
	return Effect.gen(function* () {
		for (;;) {
			const { done, value } = yield* tryPromise(() => reader.read());
			if (done) break;
			total += value.byteLength;
			if (total > MAX_HTML_CHARS) {
				yield* tryPromise(() =>
					reader.cancel(new Error("Link preview response is too large")),
				);
				return yield* Effect.fail(
					new Error("Link preview response is too large"),
				);
			}
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	}).pipe(
		Effect.ensuring(
			Effect.sync(() => {
				reader.releaseLock();
			}),
		),
	);
}

function youtubeThumbnail(url: string) {
	try {
		const parsed = new URL(url);
		let videoId: string | null = null;
		if (parsed.hostname === "youtu.be") {
			videoId = parsed.pathname.split("/").filter(Boolean)[0] ?? null;
		}
		if (
			parsed.hostname.endsWith("youtube.com") ||
			parsed.hostname.endsWith("youtube-nocookie.com")
		) {
			videoId = parsed.searchParams.get("v");
			if (!videoId && parsed.pathname.startsWith("/shorts/")) {
				videoId = parsed.pathname.split("/").filter(Boolean)[1] ?? null;
			}
			if (!videoId && parsed.pathname.startsWith("/embed/")) {
				videoId = parsed.pathname.split("/").filter(Boolean)[1] ?? null;
			}
		}
		if (!videoId || !/^[\w-]{6,}$/.test(videoId)) return null;
		return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
	} catch {
		return null;
	}
}

export function extractLinkPreviewMetadata(
	html: string,
	url: string,
): LinkPreviewMetadata {
	const meta = metaContents(html);
	const title =
		pick(meta, ["og:title", "twitter:title"]) ??
		titleFromHtml(html) ??
		hostLabel(url);
	const description = pick(meta, [
		"og:description",
		"twitter:description",
		"description",
	]);
	const siteName =
		pick(meta, ["og:site_name", "application-name"]) ?? hostLabel(url);
	const image =
		pick(meta, [
			"og:image:secure_url",
			"og:image:url",
			"og:image",
			"twitter:image:src",
			"twitter:image",
		]) ?? youtubeThumbnail(url);

	return {
		url,
		title,
		description,
		imageUrl: absoluteUrl(image, url),
		siteName,
	};
}

export const fetchLinkPreviewMetadataEffect = Effect.fn(
	"linkPreview.fetchMetadata",
)(
	function* (
		url: string,
		_options: Pick<
			GetLinkPreviewOptions,
			"fetchImpl" | "resolveHost" | "timeoutMs"
		> = {},
	): Effect.fn.Return<LinkPreviewMetadata, unknown> {
		const response = yield* safePreviewFetchEffect(url, _options);
		const finalUrl = response.url || url;
		const contentType = response.headers.get("content-type") ?? "";
		if (!response.ok) {
			yield* cancelResponseBodyEffect(response);
			return yield* Effect.fail(new Error(`HTTP ${response.status}`));
		}
		if (contentType.toLowerCase().startsWith("image/")) {
			yield* cancelResponseBodyEffect(response);
			return {
				url: finalUrl,
				title: hostLabel(finalUrl),
				description: null,
				imageUrl: finalUrl,
				siteName: hostLabel(finalUrl),
			} satisfies LinkPreviewMetadata;
		}
		const content = yield* readResponseTextEffect(response);
		return yield* Effect.try({
			try: () =>
				extractLinkPreviewMetadata(content.slice(0, MAX_HTML_CHARS), finalUrl),
			catch: (error) => error,
		});
	},
	// Any failure degrades to a host-label preview carrying the error message.
	(effect, url) =>
		Effect.catchAll(effect, (error) =>
			Effect.succeed({
				url,
				title: hostLabel(url),
				description: null,
				imageUrl: youtubeThumbnail(url),
				siteName: hostLabel(url),
				error: error instanceof Error ? error.message : String(error),
			} satisfies LinkPreviewMetadata),
		),
);

export function fetchLinkPreviewMetadata(
	url: string,
	options: Pick<
		GetLinkPreviewOptions,
		"fetchImpl" | "resolveHost" | "timeoutMs"
	> = {},
): Promise<LinkPreviewMetadata> {
	return runEffectPromise(fetchLinkPreviewMetadataEffect(url, options));
}

function readCachedPreview(
	db: Database,
	url: string,
	shortUrl: string | null | undefined,
) {
	return db
		.prepare(
			`
      select short_url, expanded_url, final_url, status, title, description,
        image_url, site_name, error, source, updated_at
      from url_expansions
      where short_url in (?, ?)
        or expanded_url in (?, ?)
        or final_url in (?, ?)
      order by
        case
          when short_url = ? then 0
          when final_url = ? then 1
          else 2
        end
      limit 1
      `,
		)
		.get(
			shortUrl ?? url,
			url,
			shortUrl ?? url,
			url,
			shortUrl ?? url,
			url,
			shortUrl ?? url,
			url,
		) as UrlExpansionPreviewRow | undefined;
}

function hasUsefulPreview(row: UrlExpansionPreviewRow) {
	if (row.status !== "hit") return false;
	try {
		assertSafePreviewUrl(row.final_url || row.expanded_url || row.short_url);
		if (row.image_url) assertSafePreviewUrl(row.image_url);
	} catch {
		return false;
	}
	return Boolean(
		row.title || row.description || row.image_url || row.site_name,
	);
}

function rowToPreview(row: UrlExpansionPreviewRow): LinkPreviewMetadata {
	const url = assertSafePreviewUrl(
		row.final_url || row.expanded_url || row.short_url,
	).toString();
	return {
		url,
		title: row.title ?? null,
		description: row.description ?? null,
		imageUrl: row.image_url
			? assertSafePreviewUrl(row.image_url).toString()
			: null,
		siteName: row.site_name ?? null,
		...(row.error ? { error: row.error } : {}),
	};
}

function persistPreview(
	db: Database,
	url: string,
	shortUrl: string | null | undefined,
	cached: UrlExpansionPreviewRow | undefined,
	preview: LinkPreviewMetadata,
) {
	const now = new Date().toISOString();
	upsertUrlExpansion(
		db,
		normalizeUrlExpansionForIndex({
			url: cached?.short_url ?? shortUrl ?? url,
			expandedUrl: cached?.expanded_url ?? preview.url,
			finalUrl: preview.url,
			status: preview.error ? "error" : "hit",
			title: preview.title,
			description: preview.description,
			imageUrl: preview.imageUrl,
			siteName: preview.siteName,
			...(preview.error ? { error: preview.error } : {}),
			source: "metadata",
			updatedAt: now,
		}),
	);
}

export const getOrFetchLinkPreviewEffect = Effect.fn("linkPreview.getOrFetch")(
	function* (url: string, options: GetLinkPreviewOptions = {}) {
		const db = getNativeDb({ seedDemoData: false });
		const cached = readCachedPreview(db, url, options.shortUrl);
		if (cached && hasUsefulPreview(cached) && !options.refresh) {
			return rowToPreview(cached);
		}

		const preview = yield* fetchLinkPreviewMetadataEffect(
			cached?.final_url || cached?.expanded_url || url,
			options,
		);
		persistPreview(db, url, options.shortUrl, cached, preview);
		return preview;
	},
);

export function getOrFetchLinkPreview(
	url: string,
	options: GetLinkPreviewOptions = {},
): Promise<LinkPreviewMetadata> {
	return runEffectPromise(getOrFetchLinkPreviewEffect(url, options));
}

export const __test__ = {
	...urlSafetyTest,
	decodeHtmlEntities,
	respondWithResolvedAddress,
	youtubeThumbnail,
};
