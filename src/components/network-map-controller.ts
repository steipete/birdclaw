import {
	keepPreviousData,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useQueryAccount } from "./account-selection";
import {
	MAP_TYPES,
	WORLD_VIEWPORT,
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
	const [viewport, updateViewport] = useState<MapViewport>(WORLD_VIEWPORT);
	const [offset, setOffset] = useState(0);
	const [search, setSearch] = useState(visibleSearch);
	useEffect(() => {
		const timer = setTimeout(() => {
			setSearch(visibleSearch);
			setOffset(0);
		}, 200);
		return () => clearTimeout(timer);
	}, [visibleSearch]);
	const statusQuery = useQuery({
		queryKey: queryKeys.status,
		queryFn: ({ signal }) => fetchQueryEnvelope({ signal }),
	});
	const { selectedAccountId, accountSelectionSettled } =
		useQueryAccount(statusQuery);
	useEffect(() => setOffset(0), [type, selectedAccountId]);
	const scope = { type, selectedAccountId: selectedAccountId ?? null };
	const mapQueryKey = [
		...queryKeys.networkMap,
		scope,
		{ viewport, search, offset },
	] as const;
	const mapQuery = useQuery({
		queryKey: mapQueryKey,
		enabled: accountSelectionSettled,
		queryFn: ({ signal }) =>
			fetchMap(
				type,
				false,
				selectedAccountId,
				viewport,
				search,
				offset,
				signal,
			),
		staleTime: 5 * 60_000,
		gcTime: 60_000,
		placeholderData: (previous, query) => {
			const previousScope = query?.queryKey[queryKeys.networkMap.length] as
				| typeof scope
				| undefined;
			return previousScope?.type === type &&
				previousScope.selectedAccountId === scope.selectedAccountId
				? keepPreviousData(previous)
				: undefined;
		},
	});
	const refreshMutation = useMutation({
		mutationFn: (request: {
			queryKey: typeof mapQueryKey;
			type: NetworkMapKind;
			accountId?: string;
			viewport: MapViewport;
			search: string;
			offset: number;
		}) =>
			fetchMap(
				request.type,
				true,
				request.accountId,
				request.viewport,
				request.search,
				request.offset,
			),
		onSuccess: (nextData, request) => {
			void queryClient.invalidateQueries({
				queryKey: queryKeys.networkMap,
				refetchType: "none",
			});
			queryClient.setQueryData(request.queryKey, nextData);
		},
	});
	const setViewport = useCallback((next: MapViewport) => {
		updateViewport((previous) =>
			previous.zoom === next.zoom &&
			previous.bounds.every((value, index) => value === next.bounds[index])
				? previous
				: next,
		);
		setOffset(0);
	}, []);
	const data = mapQuery.data ?? null;
	const queryError = refreshMutation.error ?? mapQuery.error;
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
		loading: mapQuery.isPending || refreshMutation.isPending,
		updating: mapQuery.isFetching || visibleSearch !== search,
		error: queryError
			? queryError instanceof Error
				? queryError.message
				: "Map unavailable"
			: null,
		refresh: () =>
			refreshMutation.mutate({
				queryKey: mapQueryKey,
				type,
				accountId: selectedAccountId,
				viewport,
				search,
				offset,
			}),
		setOffset,
		mapTypes: MAP_TYPES,
	};
}
