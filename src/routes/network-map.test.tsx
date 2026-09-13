import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NetworkMapRouteView } from "./network-map";
import { MAP_TYPES, WORLD_VIEWPORT } from "#/components/network-map-model";
import type { NetworkMapViewResponse } from "#/lib/api-contracts";

vi.mock("react-map-gl/mapbox", () => ({
	default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	Marker: ({
		children,
		onClick,
	}: {
		children: ReactNode;
		onClick: (event: object) => void;
	}) => <div onClick={() => onClick({})}>{children}</div>,
	NavigationControl: () => null,
	Popup: ({ children }: { children: ReactNode }) => (
		<div role="dialog">{children}</div>
	),
}));

vi.mock("#/components/network-map-controller", () => ({
	useNetworkMapController: () => ({
		type: "all",
		setType: vi.fn(),
		viewport: WORLD_VIEWPORT,
		setViewport: vi.fn(),
		visibleSearch: "",
		setVisibleSearch: vi.fn(),
		data,
		loading: false,
		error: null,
		refresh: vi.fn(),
		updating: false,
		setOffset: vi.fn(),
		mapTypes: MAP_TYPES,
	}),
}));

const data: NetworkMapViewResponse = {
	markers: [],
	visibleProfiles: 3,
	matchingProfiles: 3,
	offset: 0,
	pageSize: 160,
	features: [
		{ name: "Avery", coordinates: [-122.4, 37.8] },
		{ name: "Blair", coordinates: [16.4, 48.2] },
		{ name: "Casey", coordinates: [16.4, 48.2] },
	].map(({ name, coordinates }) => ({
		type: "Feature",
		geometry: { type: "Point", coordinates: coordinates as [number, number] },
		properties: {
			profileId: name.toLowerCase(),
			handle: name.toLowerCase(),
			name,
			avatarUrl: `https://pbs.twimg.com/profile_images/demo/${name}.png`,
			location: "Demo city",
			resolvedLocation: null,
			followersCount: 100,
			followingCount: 10,
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
		mapboxTokenConfigured: true,
	},
	config: { mapboxToken: "fixture" },
};

data.markers = [
	{ kind: "profile", feature: data.features[0] },
	{
		kind: "cluster",
		id: 1,
		coordinates: [16.4, 48.2],
		count: 2,
		expansionZoom: 12,
		stats: { mutual: 2, following: 0, followers: 0 },
		features: data.features.slice(1),
	},
];

afterEach(cleanup);

function expectAvatarRecovery(container: HTMLElement, expectedCount: number) {
	const images = [...container.querySelectorAll("img")];
	expect(images).toHaveLength(expectedCount);
	for (const image of images) {
		const source = new URL(image.src);
		expect(source.pathname).toBe("/api/avatar");
		const remote = source.searchParams.get("v");
		const parent = image.parentElement!;
		const initial = source.searchParams
			.get("profileId")!
			.slice(0, 1)
			.toUpperCase();
		fireEvent.error(image);
		const fallback = parent.querySelector("img")!;
		expect(fallback).toHaveAttribute("src", remote);
		expect(fallback).toHaveAttribute("referrerpolicy", "no-referrer");
		fireEvent.error(fallback);
		expect(parent.querySelector("img")).toBeNull();
		expect(parent).toHaveTextContent(initial);
	}
}

describe("network map avatars", () => {
	it("recovers missing cached avatars in profile markers, clusters, and the people list", async () => {
		expect.hasAssertions();
		const { container } = render(<NetworkMapRouteView />);
		await screen.findByRole("button", { name: "Open @avery" });
		expectAvatarRecovery(container, 6);
	});

	it.each([
		["Open @avery", 1],
		["2 located profiles", 4],
	] as const)("recovers avatars in the %s popup", async (button, count) => {
		expect.hasAssertions();
		render(<NetworkMapRouteView />);
		fireEvent.click(await screen.findByRole("button", { name: button }));
		expectAvatarRecovery(screen.getByRole("dialog"), count);
	});
	it("keeps relationship colors in the lightweight map", () => {
		const token = data.config.mapboxToken;
		data.config.mapboxToken = null;
		try {
			const { container } = render(<NetworkMapRouteView />);
			const points = container.querySelectorAll(
				'svg[aria-label="Network map"] circle',
			);
			expect(points).toHaveLength(2);
			for (const point of points)
				expect(point).toHaveAttribute("fill", "#22c55e");
		} finally {
			data.config.mapboxToken = token;
		}
	});
});
