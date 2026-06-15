import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { formatCompactNumber } from "#/lib/present";
import { queryKeys } from "#/lib/query-client";
import type {
	LinkInsightKind,
	LinkInsightRange,
	LinkInsightSort,
	LinkInsightSource,
} from "#/lib/types";
import {
	LINK_INSIGHTS_CACHE_MAX_AGE_MS,
	PROFILE_HYDRATION_DELAY_MS,
	collectProfilesForHydration,
	fetchLinkInsights,
	hydratingLinkProfileHandles,
	linkInsightQueryKey,
} from "./links-model";

export function useLinksController() {
	const queryClient = useQueryClient();
	const [kind, setKind] = useState<LinkInsightKind>("links");
	const [range, setRange] = useState<LinkInsightRange>("week");
	const [source, setSource] = useState<LinkInsightSource>("all");
	const [sort, setSort] = useState<LinkInsightSort>("rank");
	const [search, setSearch] = useState("");
	const insightsQuery = useQuery({
		queryKey: linkInsightQueryKey(kind, range, sort, source),
		queryFn: ({ signal }) =>
			fetchLinkInsights(kind, range, sort, source, signal),
		staleTime: LINK_INSIGHTS_CACHE_MAX_AGE_MS,
	});
	const data = insightsQuery.data ?? null;

	useEffect(() => {
		if (!data) return;
		const prefetchKind = kind === "links" ? "videos" : "links";
		const timer = window.setTimeout(() => {
			void queryClient.prefetchQuery({
				queryKey: linkInsightQueryKey(prefetchKind, range, sort, source),
				queryFn: ({ signal }) =>
					fetchLinkInsights(prefetchKind, range, sort, source, signal),
				staleTime: LINK_INSIGHTS_CACHE_MAX_AGE_MS,
			});
		}, 250);
		return () => window.clearTimeout(timer);
	}, [data, kind, queryClient, range, sort, source]);

	useEffect(() => {
		const handles = collectProfilesForHydration(data).filter((handle) => {
			const normalized = handle.toLowerCase();
			return (
				queryClient.getQueryData([
					...queryKeys.profileHydration,
					normalized,
				]) !== true && !hydratingLinkProfileHandles.has(normalized)
			);
		});
		if (handles.length === 0) return;

		const controller = new AbortController();
		const url = new URL("/api/profile-hydrate", window.location.origin);
		url.searchParams.set("handles", handles.join(","));
		for (const handle of handles) {
			hydratingLinkProfileHandles.add(handle.toLowerCase());
		}
		const finishHydration = (succeeded: boolean) => {
			for (const handle of handles) {
				const normalized = handle.toLowerCase();
				hydratingLinkProfileHandles.delete(normalized);
				if (succeeded) {
					queryClient.setQueryData(
						[...queryKeys.profileHydration, normalized],
						true,
					);
				}
			}
		};

		let idleId: number | null = null;
		const runHydration = () => {
			fetch(url, { signal: controller.signal })
				.then((response) => response.json())
				.then((response: { hydratedProfiles?: number }) => {
					finishHydration(true);
					if ((response.hydratedProfiles ?? 0) > 0) {
						void queryClient.invalidateQueries({
							queryKey: queryKeys.linkInsights,
						});
					}
				})
				.catch((error: unknown) => {
					finishHydration(false);
					if (error instanceof DOMException && error.name === "AbortError") {
						return;
					}
					console.warn("Profile hydration failed", error);
				});
		};
		const timer = window.setTimeout(() => {
			if ("requestIdleCallback" in window) {
				idleId = window.requestIdleCallback(runHydration, { timeout: 2500 });
			} else {
				runHydration();
			}
		}, PROFILE_HYDRATION_DELAY_MS);

		return () => {
			controller.abort();
			finishHydration(false);
			window.clearTimeout(timer);
			if (idleId !== null && "cancelIdleCallback" in window) {
				window.cancelIdleCallback(idleId);
			}
		};
	}, [data, queryClient]);

	const items = useMemo(() => {
		const query = search.trim().toLowerCase();
		return (data?.items ?? []).filter((item) => {
			if (!query) return true;
			return [
				item.title,
				item.description,
				item.displayUrl,
				item.host,
				item.topSharer?.handle,
				...item.mentions.map((mention) => mention.commentText),
			]
				.filter(Boolean)
				.some((value) => String(value).toLowerCase().includes(query));
		});
	}, [data?.items, search]);

	const subtitle = useMemo(() => {
		if (!data) return "Loading link memory...";
		const label = kind === "videos" ? "video URLs" : "URLs";
		return `${formatCompactNumber(data.stats.occurrences)} ${label} across ${formatCompactNumber(data.stats.groups)} groups`;
	}, [data, kind]);

	return {
		kind,
		setKind,
		range,
		setRange,
		source,
		setSource,
		sort,
		setSort,
		search,
		setSearch,
		items,
		subtitle,
		loading: insightsQuery.isPending,
		error: insightsQuery.error
			? insightsQuery.error instanceof Error
				? insightsQuery.error.message
				: "Link insights unavailable"
			: null,
		retry: insightsQuery.refetch,
	};
}
