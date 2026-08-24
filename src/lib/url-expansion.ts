import { Effect } from "effect";
import { getNativeDb } from "./db";
import { runEffectPromise, tryPromise, trySync } from "./effect-runtime";
import {
	resolvePublicAddresses,
	safePreviewFetchEffect,
} from "./link-preview-metadata";
import { readSyncCache, writeSyncCache } from "./sync-cache";
import type { UrlExpansionItem } from "./types";
import { assertSafePreviewUrl } from "./url-safety";
import {
	normalizeUrlExpansionForIndex,
	upsertUrlExpansion,
} from "./url-expansion-store";

const SUCCESS_CACHE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const FAILURE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 4;
const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g;

interface CachedUrlExpansion {
	expandedUrl: string;
	finalUrl: string;
	status: UrlExpansionItem["status"];
	title?: string;
	description?: string | null;
	error?: string;
}

export interface ExpandUrlsOptions {
	refresh?: boolean;
	successMaxAgeMs?: number;
	failureMaxAgeMs?: number;
	fetchImpl?: typeof fetch;
	resolveHost?: (hostname: string) => Promise<string[]>;
	timeoutMs?: number;
}

function cacheKeyForUrl(url: string) {
	return `url:expand:${url}`;
}

function isFresh(updatedAt: string, maxAgeMs: number) {
	return Date.now() - new Date(updatedAt).getTime() <= maxAgeMs;
}

function trimTrailingPunctuation(url: string) {
	return url.replace(/[.,;:!?]+$/g, "");
}

function cancelBodyEffect(response: Response) {
	return tryPromise(() => response.body?.cancel() ?? Promise.resolve()).pipe(
		Effect.catchAll(() => Effect.void),
	);
}

export function extractUrls(text: string) {
	return Array.from(
		new Set(
			Array.from(text.matchAll(URL_REGEX), (match) =>
				trimTrailingPunctuation(match[0]),
			),
		),
	).filter((url) => url.length > 0);
}

function toExpansionItem(
	url: string,
	value: CachedUrlExpansion,
	source: UrlExpansionItem["source"],
	updatedAt: string,
): UrlExpansionItem {
	return {
		url,
		expandedUrl: value.expandedUrl,
		finalUrl: value.finalUrl,
		status: value.status,
		source,
		...(value.title ? { title: value.title } : {}),
		...(value.description !== undefined
			? { description: value.description }
			: {}),
		...(value.error ? { error: value.error } : {}),
		updatedAt,
	};
}

function persistExpansion(item: UrlExpansionItem) {
	const db = getNativeDb({ seedDemoData: false });
	upsertUrlExpansion(db, normalizeUrlExpansionForIndex(item));
}

function fetchExpansionEffect(
	url: string,
	fetchImpl: typeof fetch,
	usesInjectedFetch: boolean,
	timeoutMs: number,
	resolveHost: ((hostname: string) => Promise<string[]>) | null,
): Effect.Effect<CachedUrlExpansion, never> {
	const requestInit = {
		redirect: "manual",
		headers: { "user-agent": "birdclaw/0.3 url-expander" },
		signal: AbortSignal.timeout(timeoutMs),
	} satisfies RequestInit;

	return Effect.gen(function* () {
		if (resolveHost) {
			const headResponse = yield* safePreviewFetchEffect(url, {
				...(usesInjectedFetch ? { fetchImpl } : {}),
				resolveHost,
				method: "HEAD",
				timeoutMs,
			});
			yield* cancelBodyEffect(headResponse);
			const headFinalUrl = headResponse.url || url;
			if (headFinalUrl !== url && headResponse.status < 400) {
				yield* Effect.try({
					try: () => assertSafePreviewUrl(headFinalUrl),
					catch: (error) => error,
				});
				return {
					expandedUrl: headFinalUrl,
					finalUrl: headFinalUrl,
					status: "hit",
				} satisfies CachedUrlExpansion;
			}

			const response = yield* safePreviewFetchEffect(headFinalUrl, {
				...(usesInjectedFetch ? { fetchImpl } : {}),
				resolveHost,
				method: "GET",
				timeoutMs,
			});
			yield* cancelBodyEffect(response);
			const finalUrl = response.url || headFinalUrl;
			if (finalUrl !== url) {
				yield* Effect.try({
					try: () => assertSafePreviewUrl(finalUrl),
					catch: (error) => error,
				});
			}
			return {
				expandedUrl: finalUrl,
				finalUrl,
				status: response.ok || finalUrl !== url ? "hit" : "miss",
				...(response.ok ? {} : { error: `HTTP ${response.status}` }),
			} satisfies CachedUrlExpansion;
		}

		let currentUrl = url;
		let response: Response | null = null;

		for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
			yield* Effect.try({
				try: () => assertSafePreviewUrl(currentUrl),
				catch: (error) => error,
			});

			response = yield* tryPromise(() =>
				fetchImpl(currentUrl, {
					...requestInit,
					method: "HEAD",
				}),
			);

			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get("location");
				if (!location) break;
				if (redirect >= MAX_REDIRECTS) {
					return yield* Effect.fail(
						new Error("URL expansion redirected too many times"),
					);
				}
				currentUrl = yield* Effect.try({
					try: () => new URL(location, currentUrl).toString(),
					catch: (error) => error,
				});
				continue;
			}

			if (
				!response.url ||
				response.url === currentUrl ||
				response.status >= 400
			) {
				response = yield* tryPromise(() =>
					fetchImpl(currentUrl, {
						...requestInit,
						method: "GET",
					}),
				);
				if (response.status >= 300 && response.status < 400) {
					const location = response.headers.get("location");
					if (!location) break;
					if (redirect >= MAX_REDIRECTS) {
						return yield* Effect.fail(
							new Error("URL expansion redirected too many times"),
						);
					}
					currentUrl = yield* Effect.try({
						try: () => new URL(location, currentUrl).toString(),
						catch: (error) => error,
					});
					continue;
				}
			}

			break;
		}

		if (!response) {
			return yield* Effect.fail(new Error("URL expansion failed"));
		}
		if (response.status >= 300 && response.status < 400) {
			return yield* Effect.fail(new Error("URL expansion ended on a redirect"));
		}

		const finalUrl = response.url || currentUrl;
		if (finalUrl !== url) {
			yield* Effect.try({
				try: () => assertSafePreviewUrl(finalUrl),
				catch: (error) => error,
			});
		}

		return {
			expandedUrl: finalUrl,
			finalUrl,
			status:
				response.ok || (finalUrl !== url && response.status < 300)
					? "hit"
					: "miss",
			...(response.ok ? {} : { error: `HTTP ${response.status}` }),
		} satisfies CachedUrlExpansion;
	}).pipe(
		Effect.catchAll((error) =>
			Effect.succeed({
				expandedUrl: url,
				finalUrl: url,
				status: "error" as const,
				error: error instanceof Error ? error.message : String(error),
			}),
		),
	);
}

export function expandUrlsEffect(
	urls: string[],
	options: ExpandUrlsOptions = {},
): Effect.Effect<UrlExpansionItem[], unknown> {
	return Effect.gen(function* () {
		const uniqueUrls = Array.from(new Set(urls));
		const usesInjectedFetch = options.fetchImpl !== undefined;
		const fetchImpl = options.fetchImpl ?? globalThis.fetch;
		const resolveHost =
			options.resolveHost ??
			(options.fetchImpl
				? null
				: (hostname: string) => resolvePublicAddresses(hostname));
		const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
		const results: UrlExpansionItem[] = [];

		for (const url of uniqueUrls) {
			const cached = yield* trySync(() =>
				readSyncCache<CachedUrlExpansion>(cacheKeyForUrl(url)),
			);
			if (cached && !options.refresh) {
				const maxAge =
					cached.value.status === "hit"
						? (options.successMaxAgeMs ?? SUCCESS_CACHE_TTL_MS)
						: (options.failureMaxAgeMs ?? FAILURE_CACHE_TTL_MS);
				if (isFresh(cached.updatedAt, maxAge)) {
					const item = toExpansionItem(
						url,
						cached.value,
						"cache",
						cached.updatedAt,
					);
					yield* trySync(() => persistExpansion(item));
					results.push(item);
					continue;
				}
			}

			const value = yield* fetchExpansionEffect(
				url,
				fetchImpl,
				usesInjectedFetch,
				timeoutMs,
				resolveHost,
			);
			const updatedAt = yield* trySync(() =>
				writeSyncCache(cacheKeyForUrl(url), value),
			);
			const item = toExpansionItem(url, value, "network", updatedAt);
			yield* trySync(() => persistExpansion(item));
			results.push(item);
		}

		return results;
	});
}

export function expandUrls(
	urls: string[],
	options: ExpandUrlsOptions = {},
): Promise<UrlExpansionItem[]> {
	return runEffectPromise(expandUrlsEffect(urls, options));
}

export function expandUrlsFromTextsEffect(
	texts: string[],
	options: ExpandUrlsOptions = {},
) {
	return expandUrlsEffect(
		texts.flatMap((text) => extractUrls(text)),
		options,
	);
}

export function expandUrlsFromTexts(
	texts: string[],
	options: ExpandUrlsOptions = {},
) {
	return runEffectPromise(expandUrlsFromTextsEffect(texts, options));
}

export const __test__ = {
	cacheKeyForUrl,
	trimTrailingPunctuation,
};
