import { Effect } from "effect";
import { getNativeDb } from "./db";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import { readSyncCache, writeSyncCache } from "./sync-cache";
import type { UrlExpansionItem } from "./types";
import {
	normalizeUrlExpansionForIndex,
	upsertUrlExpansion,
} from "./url-expansion-store";

const SUCCESS_CACHE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const FAILURE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
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

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function trySync<T>(try_: () => T) {
	return Effect.try({
		try: try_,
		catch: toError,
	});
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
	timeoutMs: number,
): Effect.Effect<CachedUrlExpansion, never> {
	const requestInit = {
		redirect: "follow",
		headers: { "user-agent": "birdclaw/0.3 url-expander" },
		signal: AbortSignal.timeout(timeoutMs),
	} satisfies RequestInit;

	return Effect.gen(function* () {
		let response = yield* tryPromise(() =>
			fetchImpl(url, {
				...requestInit,
				method: "HEAD",
			}),
		);

		if (!response.url || response.url === url || response.status >= 400) {
			response = yield* tryPromise(() =>
				fetchImpl(url, {
					...requestInit,
					method: "GET",
				}),
			);
		}

		const finalUrl = response.url || url;
		return {
			expandedUrl: finalUrl,
			finalUrl,
			status: response.ok || finalUrl !== url ? "hit" : "miss",
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
		const fetchImpl = options.fetchImpl ?? globalThis.fetch;
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

			const value = yield* fetchExpansionEffect(url, fetchImpl, timeoutMs);
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
