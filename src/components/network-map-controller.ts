import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useSelectedAccountId } from "./account-selection";
import {
	MAP_TYPES,
	WORLD_VIEWPORT,
	boundsContainFeature,
	featureMatchesSearch,
	fetchMap,
	type MapViewport,
} from "./network-map-model";
import { fetchQueryEnvelope } from "#/lib/api-client";
import type { NetworkMapKind } from "#/lib/network-map";
import { queryKeys } from "#/lib/query-client";

export function useNetworkMapController() {
	const queryClient = useQueryClient();
	const [type, setType] = useState<NetworkMapKind>("all");
	const [viewport, setViewport] = useState<MapViewport>(WORLD_VIEWPORT);
	const [visibleSearch, setVisibleSearch] = useState("");
	const statusQuery = useQuery({
		queryKey: queryKeys.status,
		queryFn: ({ signal }) => fetchQueryEnvelope({ signal }),
	});
	const selectedAccountId = useSelectedAccountId(statusQuery.data?.accounts);
	const mapQueryKey = [
		...queryKeys.networkMap,
		{ type, selectedAccountId: selectedAccountId ?? null },
	] as const;
	const mapQuery = useQuery({
		queryKey: mapQueryKey,
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

	const visibleFeatures = useMemo(
		() =>
			(data?.features ?? [])
				.slice()
				.filter((feature) => boundsContainFeature(viewport.bounds, feature))
				.sort(
					(a, b) =>
						b.properties.followersCount - a.properties.followersCount ||
						a.properties.handle.localeCompare(b.properties.handle),
				),
		[data, viewport],
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
		setType,
		viewport,
		setViewport,
		visibleSearch,
		setVisibleSearch,
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
