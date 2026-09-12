import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderWithQueryClient } from "#/test/render";
import type { NetworkMapResponse } from "#/lib/api-contracts";
import { queryKeys } from "#/lib/query-client";
import * as model from "./network-map-model";
import { useNetworkMapController } from "./network-map-controller";

const data: NetworkMapResponse = {
	type: "FeatureCollection",
	features: [
		{ handle: "zulu", x: 10, followers: 100 },
		{ handle: "alpha", x: -10, followers: 200 },
		{ handle: "beta", x: 0, followers: 100 },
	].map(({ handle, x, followers }) => ({
		type: "Feature",
		geometry: { type: "Point", coordinates: [x, 0] },
		properties: {
			profileId: handle,
			handle,
			name: handle,
			avatarUrl: null,
			location: "Demo",
			resolvedLocation: null,
			followersCount: followers,
			followingCount: 0,
			verified: false,
			relationship: "mutual",
			approxRadiusM: null,
		},
	})),
	meta: {
		accountId: "demo",
		type: "all",
		totalProfiles: 3,
		profilesWithLocation: 3,
		meaningfulProfiles: 3,
		locatedProfiles: 3,
		missingGeocodes: 0,
		geocodedThisRun: 0,
		suppressedGeocodes: 0,
		opencageConfigured: false,
		mapboxTokenConfigured: false,
	},
	config: { mapboxToken: null },
};

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	window.localStorage.clear();
});

it("keeps profile ranking across viewport changes and recomputes it for new data", async () => {
	vi.spyOn(model, "fetchMap").mockResolvedValue(data);
	const compare = vi.spyOn(model, "compareClusterFeatures");
	let controller!: ReturnType<typeof useNetworkMapController>;
	function Harness() {
		controller = useNetworkMapController({ type: "all", q: "" }, () => {});
		return null;
	}
	const { queryClient, unmount } = renderWithQueryClient(<Harness />, {
		readOnly: true,
	});
	await waitFor(() =>
		expect(controller.visibleFeatures.map((x) => x.properties.handle)).toEqual([
			"alpha",
			"beta",
			"zulu",
		]),
	);
	expect(data.features.map((x) => x.properties.handle)).toEqual([
		"zulu",
		"alpha",
		"beta",
	]);
	compare.mockClear();
	act(() => controller.setViewport({ bounds: [-1, -85, 20, 85], zoom: 4 }));
	expect(controller.visibleFeatures.map((x) => x.properties.handle)).toEqual([
		"beta",
		"zulu",
	]);
	expect(compare).not.toHaveBeenCalled();
	await act(async () => {
		queryClient.setQueryData(
			[...queryKeys.networkMap, { type: "all", selectedAccountId: null }],
			{
				...data,
				features: data.features.map((x) =>
					x.properties.handle === "zulu"
						? { ...x, properties: { ...x.properties, followersCount: 500 } }
						: x,
				),
			},
		);
	});
	await waitFor(() =>
		expect(controller.visibleFeatures.map((x) => x.properties.handle)).toEqual([
			"zulu",
			"beta",
		]),
	);
	expect(compare).toHaveBeenCalled();
	unmount();
	queryClient.clear();
});
