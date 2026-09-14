import { afterEach, describe, expect, it, vi } from "vitest";
import * as geometry from "./network-map-geometry";
import { type MapFeature, WORLD_VIEWPORT } from "./network-map-geometry";
import { NetworkMapViewIndex } from "./network-map-view-index";
import type { MapIndexFeature } from "./network-map";

function features(count = 400): MapFeature[] {
	return Array.from({ length: count }, (_, i) => ({
		type: "Feature",
		geometry: { type: "Point", coordinates: i % 2 ? [16, 48] : [-122, 37] },
		properties: {
			profileId: `p${i}`,
			handle: `person${i}`,
			name: `Person ${i}`,
			avatarUrl: null,
			location: i % 2 ? "Vienna" : "San Francisco",
			resolvedLocation: null,
			followersCount: count - i,
			followingCount: 1,
			verified: null,
			relationship: i % 3 ? "followers" : "mutual",
			approxRadiusM: null,
		},
	}));
}
afterEach(() => vi.restoreAllMocks());

describe("indexed network map views", () => {
	it("evicts old display metadata while retaining compact cluster previews", () => {
		const source = features(5_500);
		const byId = new Map(
			source.map((feature) => [feature.properties.profileId, feature]),
		);
		const hydrate = vi.fn((points: MapIndexFeature[]) =>
			points.map((point) => byId.get(point.properties.profileId)!),
		);
		const index = new NetworkMapViewIndex(source, hydrate);
		const original = index.read(WORLD_VIEWPORT, "", 160);
		for (let offset = 320; offset < 5_500; offset += 160)
			index.read(WORLD_VIEWPORT, "", offset);
		hydrate.mockClear();
		expect(index.read(WORLD_VIEWPORT, "", 160)).toEqual(original);
		expect(hydrate).toHaveBeenCalledTimes(1);
		expect(
			hydrate.mock.calls[0][0].map((point) => point.properties.profileId),
		).toContain("p200");
		expect(hydrate.mock.calls[0][0].length).toBeLessThanOrEqual(160);
		hydrate.mockClear();
		expect(index.read(WORLD_VIEWPORT, "", 160)).toEqual(original);
		expect(hydrate).not.toHaveBeenCalled();
	});

	it("reuses viewport filtering and previews across pages, and previews across nearby pans", () => {
		const bounds = vi.spyOn(geometry, "createBoundsFilter");
		const anchor = vi.spyOn(geometry, "getClusterDisplayAnchor");
		const index = new NetworkMapViewIndex(features());
		const first = index.read(WORLD_VIEWPORT, "", 0);
		expect(first.matchingProfiles).toBe(400);
		expect(first.features[0].properties.handle).toBe("person0");
		const second = index.read(WORLD_VIEWPORT, "", 160);
		expect(second.features[0].properties.handle).toBe("person160");
		expect(bounds).toHaveBeenCalledTimes(1);
		expect(anchor).toHaveBeenCalledTimes(2);
		const moved = index.read(
			{ bounds: [-179, -84, 179, 84], zoom: 1.4 },
			"",
			0,
		);
		expect(moved).toEqual(first);
		expect(bounds).toHaveBeenCalledTimes(2);
		expect(anchor).toHaveBeenCalledTimes(2);
	});

	it("reuses normalized text while narrowing, broadening, replacing and clearing searches", () => {
		const source = features();
		const text = vi.spyOn(geometry, "featureSearchText");
		const index = new NetworkMapViewIndex(source);
		for (const search of [
			"PeRsOn",
			"person2",
			"person23",
			"not present",
			"person2",
			"VIENNA",
			" mutual ",
			"",
			"san francisco",
		]) {
			const needle = search.trim().toLowerCase();
			const expected = source.filter((feature) =>
				[
					feature.properties.name,
					feature.properties.handle,
					feature.properties.location,
					"",
					feature.properties.relationship === "mutual" ? "mutual" : "follower",
				]
					.join(" ")
					.toLowerCase()
					.includes(needle),
			);
			const result = index.read(WORLD_VIEWPORT, search, 0);
			expect(result.matchingProfiles).toBe(expected.length);
			expect(result.features).toEqual(expected.slice(0, 160));
		}
		expect(text).toHaveBeenCalledTimes(source.length);
	});

	it("keeps search state scoped to its viewport and recovers evicted views", () => {
		const index = new NetworkMapViewIndex(features());
		const world = index.read(WORLD_VIEWPORT, "person", 320);
		for (let i = 0; i < 6; i++) {
			const local = index.read(
				{ bounds: [0 + i, 40, 30 + i, 55], zoom: 4 },
				"person",
				160,
			);
			expect(local.visibleProfiles).toBe(200);
			expect(
				local.features.every(
					(feature) => feature.properties.location === "Vienna",
				),
			).toBe(true);
		}
		expect(index.read(WORLD_VIEWPORT, "person", 320)).toEqual(world);
		const empty = index.read(WORLD_VIEWPORT, "missing", 320);
		expect(empty.matchingProfiles).toBe(0);
		expect(empty.offset).toBe(0);
		expect(index.read(WORLD_VIEWPORT, "person", 320)).toEqual(world);
	});
});
