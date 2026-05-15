import { useEffect, useState } from "react";
import type {
	QueryEnvelope,
	QueryResponse,
	ReplyFilter,
	ResourceKind,
	TimelineItem,
} from "#/lib/types";

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
	const [refreshTick, setRefreshTick] = useState(0);

	async function loadStatus() {
		const response = await fetch("/api/status");
		const data = (await response.json()) as QueryEnvelope;
		setMeta(data);
	}

	useEffect(() => {
		void loadStatus();
	}, []);

	useEffect(() => {
		const url = new URL("/api/query", window.location.origin);
		url.searchParams.set("resource", resource);
		url.searchParams.set("refresh", String(refreshTick));
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

		const controller = new AbortController();
		let active = true;
		setError(null);
		setLoading(true);
		fetch(url, { signal: controller.signal })
			.then((response) => response.json())
			.then((data: QueryResponse) => {
				if (active) {
					setItems(data.items as TimelineItem[]);
				}
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
	]);

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

		await fetch("/api/action", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				kind: "replyTweet",
				accountId: "acct_primary",
				tweetId,
				text,
			}),
		});

		retry();
	}

	return {
		meta,
		items,
		loading,
		error,
		retry,
		refreshLocalView,
		replyToTweet,
	};
}
