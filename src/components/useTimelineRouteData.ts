import { useEffect, useState } from "react";
import type {
	QueryEnvelope,
	ReplyFilter,
	ResourceKind,
	TimelineItem,
} from "#/lib/types";
import {
	fetchQueryEnvelope,
	fetchQueryResponse,
	postAction,
} from "#/lib/api-client";
import { useSelectedAccountId } from "./account-selection";

const PAGE_SIZE = 50;

interface UseTimelineRouteDataOptions {
	resource: Exclude<ResourceKind, "dms">;
	search: string;
	errorFallback: string;
	replyFilter?: ReplyFilter;
	likedOnly?: boolean;
	bookmarkedOnly?: boolean;
}

export function useTimelineRouteData({
	resource,
	search,
	errorFallback,
	replyFilter,
	likedOnly = false,
	bookmarkedOnly = false,
}: UseTimelineRouteDataOptions) {
	const [meta, setMeta] = useState<QueryEnvelope | null>(null);
	const [items, setItems] = useState<TimelineItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [replyError, setReplyError] = useState<string | null>(null);
	const [refreshTick, setRefreshTick] = useState(0);
	const [hasMore, setHasMore] = useState(false);
	const [loadingMore, setLoadingMore] = useState(false);
	const selectedAccountId = useSelectedAccountId(meta?.accounts);

	async function loadStatus() {
		setMeta(await fetchQueryEnvelope());
	}

	useEffect(() => {
		void loadStatus();
	}, []);

	// Build the /api/query URL for the current filters. `until` requests the next
	// (older) page via the server's created_at cursor (created_at < until).
	function buildQueryUrl(until?: string) {
		const url = new URL("/api/query", window.location.origin);
		url.searchParams.set("resource", resource);
		url.searchParams.set("refresh", String(refreshTick));
		url.searchParams.set("limit", String(PAGE_SIZE));
		if (selectedAccountId) {
			url.searchParams.set("account", selectedAccountId);
		}
		if (replyFilter) {
			url.searchParams.set("replyFilter", replyFilter);
		}
		if (likedOnly) {
			url.searchParams.set("liked", "true");
		}
		if (bookmarkedOnly) {
			url.searchParams.set("bookmarked", "true");
		}
		if (search.trim()) {
			url.searchParams.set("search", search.trim());
		}
		if (until) {
			url.searchParams.set("until", until);
		}
		return url;
	}

	useEffect(() => {
		const controller = new AbortController();
		let active = true;
		setError(null);
		setLoading(true);
		setLoadingMore(false);
		fetchQueryResponse(buildQueryUrl(), { signal: controller.signal })
			.then((data) => {
				if (!active) return;
				const next = data.items as TimelineItem[];
				setItems(next);
				setHasMore(next.length >= PAGE_SIZE);
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
		errorFallback,
		likedOnly,
		refreshTick,
		replyFilter,
		resource,
		search,
		selectedAccountId,
	]);

	async function loadMore() {
		if (loading || loadingMore || !hasMore || items.length === 0) return;
		const until = items[items.length - 1]?.createdAt;
		if (!until) return;
		setLoadingMore(true);
		try {
			const data = await fetchQueryResponse(buildQueryUrl(until));
			const page = data.items as TimelineItem[];
			setItems((prev) => {
				const seen = new Set(prev.map((item) => item.id));
				return [...prev, ...page.filter((item) => !seen.has(item.id))];
			});
			setHasMore(page.length >= PAGE_SIZE);
		} catch (loadError) {
			setError(
				loadError instanceof Error ? loadError.message : errorFallback,
			);
		} finally {
			setLoadingMore(false);
		}
	}

	function retry() {
		setRefreshTick((value) => value + 1);
	}

	function refreshLocalView() {
		setRefreshTick((value) => value + 1);
		void loadStatus();
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
