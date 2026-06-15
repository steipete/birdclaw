import { useEffect, useRef, useState } from "react";
import type {
	QueryEnvelope,
	ReplyFilter,
	ResourceKind,
	TimelineItem,
} from "#/lib/types";
import {
	fetchCachedQueryResponse,
	fetchQueryEnvelope,
	invalidateCachedQueryResponse,
	invalidateCachedQueryResponses,
	postAction,
	readCachedQueryEnvelope,
} from "#/lib/api-client";
import {
	deleteClientCache,
	deleteClientCacheByPrefix,
	readClientCache,
	writeClientCache,
} from "#/lib/client-cache";
import { useSelectedAccountId } from "./account-selection";
import { useDebouncedValue } from "./useDebouncedValue";

const PAGE_SIZE = 50;
const TIMELINE_VIEW_CACHE_PREFIX = "timeline-view:";
const TIMELINE_VIEW_CACHE_MAX_AGE_MS = 5 * 60_000;

interface TimelineViewSnapshot {
	items: TimelineItem[];
	hasMore: boolean;
}

interface UseTimelineRouteDataOptions {
	resource: Exclude<ResourceKind, "dms">;
	search: string;
	errorFallback: string;
	replyFilter?: ReplyFilter;
	likedOnly?: boolean;
	bookmarkedOnly?: boolean;
}

function buildTimelineQueryUrl({
	resource,
	search,
	replyFilter,
	likedOnly,
	bookmarkedOnly,
	selectedAccountId,
	refreshTick,
	until,
	untilId,
}: {
	resource: Exclude<ResourceKind, "dms">;
	search: string;
	replyFilter?: ReplyFilter;
	likedOnly: boolean;
	bookmarkedOnly: boolean;
	selectedAccountId?: string;
	refreshTick: number;
	until?: string;
	untilId?: string;
}) {
	const params = new URLSearchParams({
		resource,
		limit: String(PAGE_SIZE),
	});
	if (selectedAccountId) params.set("account", selectedAccountId);
	params.set("refresh", String(refreshTick));
	if (replyFilter) params.set("replyFilter", replyFilter);
	if (likedOnly) params.set("liked", "true");
	if (bookmarkedOnly) params.set("bookmarked", "true");
	if (search.trim()) params.set("search", search.trim());
	if (until) params.set("until", until);
	if (untilId) params.set("untilId", untilId);
	params.sort();
	const base =
		typeof window === "undefined"
			? "http://birdclaw.local"
			: window.location.origin;
	return new URL(`/api/query?${params.toString()}`, base).toString();
}

function timelineViewCacheKey(requestUrl: string) {
	const url = new URL(requestUrl, "http://birdclaw.local");
	url.searchParams.delete("refresh");
	return `${TIMELINE_VIEW_CACHE_PREFIX}${url.pathname}?${url.searchParams.toString()}`;
}

export function useTimelineRouteData({
	resource,
	search,
	errorFallback,
	replyFilter,
	likedOnly = false,
	bookmarkedOnly = false,
}: UseTimelineRouteDataOptions) {
	const [meta, setMeta] = useState<QueryEnvelope | null>(
		() => readCachedQueryEnvelope() ?? null,
	);
	const selectedAccountId = useSelectedAccountId(meta?.accounts);
	const debouncedSearch = useDebouncedValue(search, 180);
	const initialRequestUrl = buildTimelineQueryUrl({
		resource,
		search: debouncedSearch,
		replyFilter,
		likedOnly,
		bookmarkedOnly,
		selectedAccountId,
		refreshTick: 0,
	});
	const initialSnapshot = useRef(
		readClientCache<TimelineViewSnapshot>(
			timelineViewCacheKey(initialRequestUrl),
			TIMELINE_VIEW_CACHE_MAX_AGE_MS,
		),
	);
	const [items, setItems] = useState<TimelineItem[]>(
		() => initialSnapshot.current?.items ?? [],
	);
	const [loading, setLoading] = useState(() => !initialSnapshot.current);
	const [error, setError] = useState<string | null>(null);
	const [replyError, setReplyError] = useState<string | null>(null);
	const [refreshTick, setRefreshTick] = useState(0);
	const [hasMore, setHasMore] = useState(
		() => initialSnapshot.current?.hasMore ?? false,
	);
	const [loadingMore, setLoadingMore] = useState(false);
	// Bumped whenever the active filters change. A `loadMore` request that
	// resolves against a stale generation is discarded so its older page is
	// never appended to a freshly loaded feed.
	const generationRef = useRef(0);
	const loadMoreControllerRef = useRef<AbortController | null>(null);
	const activeRequestUrlRef = useRef(initialRequestUrl);

	async function loadStatus(force = false) {
		setMeta(await fetchQueryEnvelope(undefined, { force }));
	}

	useEffect(() => {
		void loadStatus();
	}, []);

	useEffect(() => {
		generationRef.current += 1;
		loadMoreControllerRef.current?.abort();
		const controller = new AbortController();
		let active = true;
		const requestUrl = buildTimelineQueryUrl({
			resource,
			search: debouncedSearch,
			replyFilter,
			likedOnly,
			bookmarkedOnly,
			selectedAccountId,
			refreshTick,
		});
		const viewCacheKey = timelineViewCacheKey(requestUrl);
		activeRequestUrlRef.current = requestUrl;
		setError(null);
		setLoadingMore(false);
		const cached = readClientCache<TimelineViewSnapshot>(
			viewCacheKey,
			TIMELINE_VIEW_CACHE_MAX_AGE_MS,
		);
		if (cached) {
			setItems(cached.items);
			setHasMore(cached.hasMore);
			setLoading(false);
			return () => {
				active = false;
				controller.abort();
			};
		}

		setItems([]);
		setHasMore(false);
		setLoading(true);
		fetchCachedQueryResponse(requestUrl, { signal: controller.signal })
			.then((data) => {
				if (!active) return;
				const next = data.items as TimelineItem[];
				setItems(next);
				const nextHasMore = next.length >= PAGE_SIZE;
				setHasMore(nextHasMore);
				writeClientCache(viewCacheKey, {
					items: next,
					hasMore: nextHasMore,
				});
			})
			.catch((fetchError: unknown) => {
				if (
					fetchError instanceof DOMException &&
					fetchError.name === "AbortError"
				) {
					return;
				}
				if (!active) return;
				setError(
					fetchError instanceof Error ? fetchError.message : errorFallback,
				);
				setItems([]);
				setHasMore(false);
			})
			.finally(() => {
				if (active) {
					setLoading(false);
				}
			});

		return () => {
			active = false;
			controller.abort();
		};
	}, [
		bookmarkedOnly,
		debouncedSearch,
		errorFallback,
		likedOnly,
		refreshTick,
		replyFilter,
		resource,
		selectedAccountId,
	]);

	async function loadMore() {
		if (loading || loadingMore || !hasMore || items.length === 0) return;
		const lastItem = items[items.length - 1];
		const until = lastItem?.createdAt;
		const untilId = lastItem?.id;
		if (!until || !untilId) return;
		const generation = generationRef.current;
		const controller = new AbortController();
		loadMoreControllerRef.current = controller;
		setLoadingMore(true);
		try {
			const nextPageUrl = new URL(
				activeRequestUrlRef.current,
				window.location.origin,
			);
			nextPageUrl.searchParams.set("until", until);
			nextPageUrl.searchParams.set("untilId", untilId);
			const data = await fetchCachedQueryResponse(nextPageUrl, {
				signal: controller.signal,
			});
			// Discard if the filters changed (new generation) while in flight.
			if (generation !== generationRef.current) return;
			const page = data.items as TimelineItem[];
			setItems((prev) => {
				const seen = new Set(prev.map((item) => item.id));
				const next = [...prev, ...page.filter((item) => !seen.has(item.id))];
				writeClientCache(timelineViewCacheKey(activeRequestUrlRef.current), {
					items: next,
					hasMore: page.length >= PAGE_SIZE,
				});
				return next;
			});
			setHasMore(page.length >= PAGE_SIZE);
		} catch (loadError) {
			if (
				loadError instanceof DOMException &&
				loadError.name === "AbortError"
			) {
				return;
			}
			if (generation !== generationRef.current) return;
			setError(loadError instanceof Error ? loadError.message : errorFallback);
		} finally {
			if (generation === generationRef.current) {
				setLoadingMore(false);
			}
		}
	}

	function retry() {
		invalidateCachedQueryResponse(activeRequestUrlRef.current);
		deleteClientCache(timelineViewCacheKey(activeRequestUrlRef.current));
		setRefreshTick((value) => value + 1);
	}

	function refreshLocalView() {
		invalidateCachedQueryResponses();
		deleteClientCacheByPrefix(TIMELINE_VIEW_CACHE_PREFIX);
		setRefreshTick((value) => value + 1);
		void loadStatus(true);
	}

	async function replyToTweet(tweetId: string) {
		const text = window.prompt("Reply text");
		if (!text?.trim()) return;

		setReplyError(null);
		try {
			await postAction({
				kind: "replyTweet",
				accountId: selectedAccountId ?? "acct_primary",
				tweetId,
				text,
			});

			retry();
		} catch (replyError) {
			setReplyError(
				replyError instanceof Error ? replyError.message : "Reply failed",
			);
		}
	}

	return {
		meta,
		items,
		loading,
		error,
		replyError,
		retry,
		refreshLocalView,
		replyToTweet,
		selectedAccountId,
		hasMore,
		loadingMore,
		loadMore,
	};
}
