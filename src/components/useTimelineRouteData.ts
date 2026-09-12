import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import {
	fetchQueryEnvelope,
	fetchQueryResponse,
	postAction,
} from "#/lib/api-client";
import { queryKeys } from "#/lib/query-client";
import type { ReplyFilter, ResourceKind, TimelineItem } from "#/lib/types";
import { useQueryAccount } from "./account-selection";
import { useDebouncedValue } from "./useDebouncedValue";

const PAGE_SIZE = 50;
const TIMELINE_STALE_TIME_MS = 5 * 60_000;

interface UseTimelineRouteDataOptions {
	resource: Exclude<ResourceKind, "dms">;
	search: string;
	errorFallback: string;
	replyFilter?: ReplyFilter;
	likedOnly?: boolean;
	bookmarkedOnly?: boolean;
}

interface TimelinePageParam {
	until: string;
	untilId: string;
}

function buildTimelineQueryUrl({
	resource,
	search,
	replyFilter,
	likedOnly,
	bookmarkedOnly,
	selectedAccountId,
	pageParam,
}: {
	resource: Exclude<ResourceKind, "dms">;
	search: string;
	replyFilter?: ReplyFilter;
	likedOnly: boolean;
	bookmarkedOnly: boolean;
	selectedAccountId?: string;
	pageParam?: TimelinePageParam;
}) {
	const params = new URLSearchParams({
		resource,
		limit: String(PAGE_SIZE),
	});
	if (selectedAccountId) params.set("account", selectedAccountId);
	if (replyFilter) params.set("replyFilter", replyFilter);
	if (likedOnly) params.set("liked", "true");
	if (bookmarkedOnly) params.set("bookmarked", "true");
	if (search.trim()) params.set("search", search.trim());
	if (pageParam) {
		params.set("until", pageParam.until);
		params.set("untilId", pageParam.untilId);
	}
	params.sort();
	const base =
		typeof window === "undefined"
			? "http://birdclaw.local"
			: window.location.origin;
	return new URL(`/api/query?${params.toString()}`, base).toString();
}

export function useTimelineRouteData({
	resource,
	search,
	errorFallback,
	replyFilter,
	likedOnly = false,
	bookmarkedOnly = false,
}: UseTimelineRouteDataOptions) {
	const queryClient = useQueryClient();
	const statusQuery = useQuery({
		queryKey: queryKeys.status,
		queryFn: ({ signal }) => fetchQueryEnvelope({ signal }),
	});
	const meta = statusQuery.data ?? null;
	const { selectedAccountId, accountSelectionSettled } =
		useQueryAccount(statusQuery);
	const debouncedSearch = useDebouncedValue(search, 180);
	const timelineQueryKey = [
		...queryKeys.timelines,
		{
			resource,
			search: debouncedSearch,
			replyFilter: replyFilter ?? "all",
			likedOnly,
			bookmarkedOnly,
			selectedAccountId: selectedAccountId ?? null,
		},
	] as const;
	const timelineQuery = useInfiniteQuery({
		queryKey: timelineQueryKey,
		enabled: accountSelectionSettled,
		initialPageParam: undefined as TimelinePageParam | undefined,
		queryFn: ({ pageParam, signal }) =>
			fetchQueryResponse(
				buildTimelineQueryUrl({
					resource,
					search: debouncedSearch,
					replyFilter,
					likedOnly,
					bookmarkedOnly,
					selectedAccountId,
					pageParam,
				}),
				{ signal },
			),
		getNextPageParam: (lastPage) => {
			if (lastPage.resource === "dms") return undefined;
			const items = lastPage.items;
			const lastItem = items.at(-1);
			return items.length >= PAGE_SIZE && lastItem
				? { until: lastItem.createdAt, untilId: lastItem.id }
				: undefined;
		},
		staleTime: TIMELINE_STALE_TIME_MS,
	});
	const items = useMemo(() => {
		const seen = new Set<string>();
		const merged: TimelineItem[] = [];
		for (const page of timelineQuery.data?.pages ?? []) {
			if (page.resource === "dms") continue;
			for (const item of page.items) {
				if (seen.has(item.id)) continue;
				seen.add(item.id);
				merged.push(item);
			}
		}
		return merged;
	}, [timelineQuery.data]);
	const replyMutation = useMutation({
		mutationFn: ({ tweetId, text }: { tweetId: string; text: string }) =>
			postAction({
				kind: "replyTweet",
				accountId: selectedAccountId ?? "acct_primary",
				tweetId,
				text,
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: timelineQueryKey }),
	});

	function retry() {
		void timelineQuery.refetch();
	}

	function refreshLocalView() {
		void Promise.all([
			queryClient.invalidateQueries({ queryKey: queryKeys.timelines }),
			queryClient.invalidateQueries({ queryKey: queryKeys.status }),
		]);
	}

	async function replyToTweet(tweetId: string) {
		const text = window.prompt("Reply text");
		if (!text?.trim()) return;
		await replyMutation
			.mutateAsync({ tweetId, text: text.trim() })
			.catch(() => {
				// The mutation error is exposed below for the route frame.
			});
	}

	const queryError = timelineQuery.error;
	return {
		meta,
		items,
		loading: timelineQuery.isPending,
		error: queryError
			? queryError instanceof Error
				? queryError.message
				: errorFallback
			: null,
		replyError: replyMutation.error
			? replyMutation.error instanceof Error
				? replyMutation.error.message
				: "Reply failed"
			: null,
		retry,
		refreshLocalView,
		replyToTweet,
		selectedAccountId,
		hasMore: timelineQuery.hasNextPage,
		loadingMore: timelineQuery.isFetchingNextPage,
		loadMore: () => timelineQuery.fetchNextPage().then(() => undefined),
	};
}
