import { afterEach, describe, expect, it, vi } from "vitest";
import * as geometry from "./network-map-geometry";
import type { MapIndexFeature } from "./network-map";
import { NetworkMapBoundsIndex } from "./network-map-bounds-index";

function point(lng: number, lat: number): MapIndexFeature {
	return {
		type: "Feature",
		geometry: { type: "Point", coordinates: [lng, lat] },
		properties: {
			profileId: "",
			handle: "",
			name: "",
			location: "",
			resolvedLocation: null,
			followersCount: 0,
			relationship: "followers",
			approxRadiusM: null,
		},
	};
}

afterEach(() => vi.restoreAllMocks());

describe("map bounds index", () => {
	it("matches ranked scans across cell boundaries, wrapped worlds, poles and dateline overlaps", () => {
		const points = Array.from({ length: 10_000 }, (_, i) =>
			point(((i * 137.3) % 360) - 180, ((i * 17.9) % 170) - 85),
		);
		for (const lng of [-181, -180, -179, -176, -175, 0, 10, 170, 175, 180, 181])
			for (const lat of [-90, -85, -80, 0, 40, 50, 85, 90])
				points.push(point(lng, lat));
		const index = new NetworkMapBoundsIndex(points);
		const bounds: geometry.MapBounds[] = [
			[-180, -85, 180, 85],
			[-540, -100, 540, 100],
			[170, -85, -170, 85],
			[-175, -85, -176, 85],
			[170, 0, 180, 50],
			[0, 40, 10, 50],
			[175, 0, 175, 50],
			[0, 90, 10, 95],
			[0, 50, 10, 40],
			[540, -85, 560, 85],
		];
		for (let i = 0; i < 100; i++)
			bounds.push([i * 11 - 530, (i % 40) - 20, i * 11 - 500, (i % 40) + 5]);
		for (const box of bounds) {
			const contains = geometry.createBoundsFilter(box);
			const expected = points.flatMap((feature, i) =>
				contains(feature) ? [i] : [],
			);
			expect(index.read(box)).toEqual(expected);
		}
	});

	it("examines nearby candidates for small pans without scanning the entire network", () => {
		const points = Array.from({ length: 20_000 }, (_, i) =>
			point(((i * 137.3) % 360) - 180, ((i * 17.9) % 170) - 85),
		);
		const create = geometry.createBoundsFilter;
		let examined = 0;
		vi.spyOn(geometry, "createBoundsFilter").mockImplementation((bounds) => {
			const contains = create(bounds);
			return (feature) => {
				examined++;
				return contains(feature);
			};
		});
		const index = new NetworkMapBoundsIndex(points);
		const result = index.read([0, 40, 30, 55]);
		expect(result.length).toBeGreaterThan(0);
		expect(examined).toBeLessThan(points.length / 20);
	});
});
