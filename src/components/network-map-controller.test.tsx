import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderWithQueryClient } from "#/test/render";
import type { NetworkMapViewResponse } from "#/lib/api-contracts";
import { queryKeys } from "#/lib/query-client";
import * as model from "./network-map-model";
import { useNetworkMapController } from "./network-map-controller";

const data: NetworkMapViewResponse = {
	markers: [],
	visibleProfiles: 3,
	matchingProfiles: 3,
	offset: 0,
	pageSize: 160,
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

it("requests bounded views and retains the map while a new viewport loads", async () => {
	const fetch = vi.spyOn(model, "fetchMap").mockResolvedValueOnce(data);
	let finish!: (data: NetworkMapViewResponse) => void;
	fetch.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	let controller!: ReturnType<typeof useNetworkMapController>;
	function Harness() {
		controller = useNetworkMapController({ type: "all", q: "" }, () => {});
		return null;
	}
	const { queryClient } = renderWithQueryClient(<Harness />, {
		readOnly: true,
	});
	await waitFor(() => expect(controller.data).toEqual(data));
	act(() => controller.setViewport({ bounds: [-1, -85, 20, 85], zoom: 4 }));
	await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
	expect(controller.data).toEqual(data);
	expect(controller.updating).toBe(true);
	expect(fetch.mock.calls[1].slice(0, 6)).toEqual([
		"all",
		false,
		undefined,
		{ bounds: [-1, -85, 20, 85], zoom: 4 },
		"",
		0,
	]);
	const next = {
		...data,
		features: data.features.slice(0, 1),
		visibleProfiles: 1,
		matchingProfiles: 1,
	};
	await act(async () => finish(next));
	await waitFor(() => expect(controller.data).toEqual(next));
	expect(controller.updating).toBe(false);
	queryClient.clear();
});

it("debounces search, resets pagination, and never displays another relationship's cached view", async () => {
	const fetch = vi.spyOn(model, "fetchMap").mockResolvedValue(data);
	let controller!: ReturnType<typeof useNetworkMapController>;
	function Harness({
		type = "all",
		q = "",
	}: {
		type?: "all" | "followers";
		q?: string;
	}) {
		controller = useNetworkMapController({ type, q }, () => {});
		return null;
	}
	const { queryClient, rerender } = renderWithQueryClient(<Harness />, {
		readOnly: true,
	});
	await waitFor(() => expect(controller.data).toEqual(data));
	act(() => controller.setOffset(160));
	await waitFor(() => expect(fetch.mock.lastCall?.[5]).toBe(160));
	rerender(<Harness q="per" />);
	rerender(<Harness q="person" />);
	await waitFor(() =>
		expect(fetch.mock.lastCall?.slice(4, 6)).toEqual(["person", 0]),
	);
	expect(fetch.mock.calls.some((call) => call[4] === "per")).toBe(false);
	fetch.mockImplementation(() => new Promise(() => {}));
	rerender(<Harness type="followers" q="person" />);
	await waitFor(() => expect(controller.data).toBeNull());
	queryClient.clear();
});

it("requests a page without truncating its returned results and refreshes the originating query", async () => {
	const fetch = vi.spyOn(model, "fetchMap").mockResolvedValue(data);
	let controller!: ReturnType<typeof useNetworkMapController>;
	function Harness() {
		controller = useNetworkMapController({ type: "all", q: "" }, () => {});
		return null;
	}
	const { queryClient } = renderWithQueryClient(<Harness />, {
		readOnly: true,
	});
	await waitFor(() => expect(controller.data).toEqual(data));
	act(() => controller.setOffset(160));
	await waitFor(() => expect(fetch.mock.lastCall?.[5]).toBe(160));
	act(() => controller.refresh());
	await waitFor(() => expect(fetch.mock.lastCall?.[1]).toBe(true));
	expect(controller.data?.features).toEqual(data.features);
	expect(
		queryClient.getQueriesData({ queryKey: queryKeys.networkMap }).length,
	).toBeGreaterThan(0);
	queryClient.clear();
});
