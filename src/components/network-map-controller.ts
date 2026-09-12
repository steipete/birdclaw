import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useQueryAccount } from "./account-selection";
import {
	MAP_TYPES,
	WORLD_VIEWPORT,
	boundsContainFeature,
	compareClusterFeatures,
	featureMatchesSearch,
	fetchMap,
	type MapViewport,
} from "./network-map-model";
import { fetchQueryEnvelope } from "#/lib/api-client";
import type { NetworkMapKind } from "#/lib/network-map";
import { queryKeys } from "#/lib/query-client";
import type {
	NetworkMapRouteSearch,
	RouteSearchChange,
} from "#/lib/route-search";

export function useNetworkMapController(
	filters: NetworkMapRouteSearch,
	onFiltersChange: RouteSearchChange<NetworkMapRouteSearch>,
) {
	const queryClient = useQueryClient();
	const { type, q: visibleSearch } = filters;
	const [viewport, setViewport] = useState<MapViewport>(WORLD_VIEWPORT);
	const statusQuery = useQuery({
		queryKey: queryKeys.status,
		queryFn: ({ signal }) => fetchQueryEnvelope({ signal }),
	});
	const { selectedAccountId, accountSelectionSettled } =
		useQueryAccount(statusQuery);
	const mapQueryKey = [
		...queryKeys.networkMap,
		{ type, selectedAccountId: selectedAccountId ?? null },
	] as const;
	const mapQuery = useQuery({
		queryKey: mapQueryKey,
		enabled: accountSelectionSettled,
		queryFn: ({ signal }) => fetchMap(type, false, selectedAccountId, signal),
		staleTime: 5 * 60_000,
	});
	const refreshMutation = useMutation({
		mutationFn: () => fetchMap(type, true, selectedAccountId),
		onSuccess: (nextData) => {
			queryClient.setQueryData(mapQueryKey, nextData);
		},
	});
	const data = mapQuery.data ?? null;
	const loading = mapQuery.isPending || refreshMutation.isPending;
	const queryError = refreshMutation.error ?? mapQuery.error;

	const rankedFeatures = useMemo(
		() => [...(data?.features ?? [])].sort(compareClusterFeatures),
		[data?.features],
	);
	const visibleFeatures = useMemo(
		() =>
			rankedFeatures.filter((feature) =>
				boundsContainFeature(viewport.bounds, feature),
			),
		[rankedFeatures, viewport],
	);
	const filteredVisibleFeatures = useMemo(
		() =>
			visibleFeatures
				.filter((feature) => featureMatchesSearch(feature, visibleSearch))
				.slice(0, 160),
		[visibleFeatures, visibleSearch],
	);

	return {
		type,
		setType: (value: NetworkMapKind) =>
			onFiltersChange({ ...filters, type: value }),
		viewport,
		setViewport,
		visibleSearch,
		setVisibleSearch: (value: string) =>
			onFiltersChange({ ...filters, q: value }, { replace: true }),
		data,
		loading,
		error: queryError
			? queryError instanceof Error
				? queryError.message
				: "Map unavailable"
			: null,
		refresh: refreshMutation.mutate,
		visibleFeatures,
		filteredVisibleFeatures,
		mapTypes: MAP_TYPES,
	};
}
