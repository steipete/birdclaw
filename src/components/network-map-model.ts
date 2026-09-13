import { networkMapViewResponseSchema } from "#/lib/api-contracts";
import { fetchJson } from "#/lib/api-client";
import type { NetworkMapKind } from "#/lib/network-map";
import type { MapViewport } from "#/lib/network-map-geometry";
export * from "#/lib/network-map-geometry";
export type ReactMapboxModule = typeof import("react-map-gl/mapbox");

export async function fetchMap(
	type: NetworkMapKind,
	refresh: boolean,
	accountId: string | undefined,
	viewport: MapViewport,
	search: string,
	offset: number,
	signal?: AbortSignal,
) {
	const url = new URL("/api/network-map", window.location.origin);
	url.searchParams.set("format", "view");
	url.searchParams.set("type", type);
	url.searchParams.set("bounds", viewport.bounds.join(","));
	url.searchParams.set("zoom", String(viewport.zoom));
	url.searchParams.set("q", search);
	url.searchParams.set("offset", String(offset));
	url.searchParams.set("geocodeLimit", refresh ? "80" : "0");
	if (accountId) url.searchParams.set("account", accountId);
	if (refresh) url.searchParams.set("refresh", "true");
	return fetchJson(
		url,
		{ signal },
		networkMapViewResponseSchema,
		"Map request failed",
	);
}
