// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests, getBirdclawPaths } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { getNetworkMapView } from "./network-map-view";
import { networkMapViewResponseSchema } from "./api-contracts";
import * as geometry from "./network-map-geometry";
import NativeSqliteDatabase from "./sqlite";

const homes: string[] = [];
afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
});

function fixture(count = 350) {
	const home = mkdtempSync(path.join(os.tmpdir(), "birdclaw-map-view-"));
	homes.push(home);
	vi.stubEnv("BIRDCLAW_HOME", home);
	const db = getNativeDb({ seedDemoData: false });
	db.exec(`
 insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at)
 values ('a', 'Demo', 'demo', '1', 'archive', 1, '2026-01-01'), ('b', 'Other', 'other', '2', 'archive', 0, '2026-01-01');
 with recursive numbers(n) as (select 1 union all select n + 1 from numbers where n < ${count})
 insert into profiles (id, handle, display_name, bio, followers_count, following_count, public_metrics_json, avatar_hue, location, created_at)
 select 'p' || n, 'person' || n, 'Person ' || n, '', ${count} - n, 0, '{}', 0, case when n % 2 = 0 then 'Vienna' else 'Tokyo' end, '2026-01-01' from numbers;
 insert into follow_edges (account_id, direction, profile_id, external_user_id, source, current, first_seen_at, last_seen_at, updated_at)
 select 'a', 'followers', id, id, 'test', 1, '2026-01-01', '2026-01-01', '2026-01-01' from profiles;
 insert into follow_edges (account_id, direction, profile_id, external_user_id, source, current, first_seen_at, last_seen_at, updated_at)
 values ('a', 'following', 'p1', 'p1', 'test', 1, '2026-01-01', '2026-01-01', '2026-01-01'), ('b', 'following', 'p2', 'p2', 'test', 1, '2026-01-01', '2026-01-01', '2026-01-01');
 insert into geocoded_locations (normalized_key, original, lat, lng, provider, hits, created_at, last_used_at)
 values ('vienna', 'Vienna', 48.2, 16.4, 'opencage', 1, '2026-01-01', '2026-01-01'), ('tokyo', 'Tokyo', 35.6, 139.6, 'opencage', 1, '2026-01-01', '2026-01-01');
 `);
	return db;
}

describe("network map views", () => {
	it("returns bounded markers and pages while retaining every follower and search result", async () => {
		const db = fixture(50_010);
		const map = await getNetworkMapView(
			{ account: "a", type: "followers" },
			db,
		);
		expect(networkMapViewResponseSchema.safeParse(map).success).toBe(true);
		expect(map.meta.totalProfiles).toBe(50_010);
		expect(map.visibleProfiles).toBe(50_010);
		expect(map.features).toHaveLength(160);
		expect(map.markers).toHaveLength(2);
		expect(
			map.markers.reduce(
				(n, marker) => n + (marker.kind === "cluster" ? marker.count : 1),
				0,
			),
		).toBe(50_010);
		expect(
			map.markers.every(
				(marker) => marker.kind === "cluster" && marker.features.length <= 6,
			),
		).toBe(true);
		expect(JSON.stringify(map).length).toBeLessThan(100_000);
		const next = await getNetworkMapView(
			{ account: "a", type: "followers", offset: 160 },
			db,
		);
		expect(next.features[0].properties.handle).toBe("person161");
		const search = await getNetworkMapView(
			{ account: "a", type: "followers", search: "person50010" },
			db,
		);
		expect(search.matchingProfiles).toBe(1);
		expect(search.features[0].properties.handle).toBe("person50010");
		expect(search.markers).toEqual(map.markers);
	});

	it("reuses the index for pan, search, and page requests and invalidates local and external writes", async () => {
		const db = fixture();
		const build = vi.spyOn(geometry, "buildClusterIndex");
		await getNetworkMapView({ account: "a" }, db);
		await getNetworkMapView(
			{ account: "a", search: "person", offset: 160 },
			db,
		);
		const europe = await getNetworkMapView(
			{ account: "a", viewport: { bounds: [0, 40, 30, 55], zoom: 4 } },
			db,
		);
		expect(europe.visibleProfiles).toBe(175);
		expect(
			europe.features.every(
				(feature) => feature.properties.location === "Vienna",
			),
		).toBe(true);
		expect(build).toHaveBeenCalledTimes(1);
		db.exec(
			"update follow_edges set current = 0 where profile_id = 'p2' and account_id = 'a'",
		);
		expect(
			(await getNetworkMapView({ account: "a" }, db)).meta.totalProfiles,
		).toBe(349);
		expect(build).toHaveBeenCalledTimes(2);
		const writer = new NativeSqliteDatabase(getBirdclawPaths().dbPath);
		try {
			writer.exec(
				"update profiles set display_name = 'Updated' where id = 'p1'",
			);
		} finally {
			writer.close();
		}
		expect(
			(await getNetworkMapView({ account: "a" }, db)).features[0].properties
				.name,
		).toBe("Updated");
		expect(build).toHaveBeenCalledTimes(3);
	});

	it("isolates accounts, applies relationships before paging, and clamps empty or obsolete pages", async () => {
		const db = fixture();
		const mutual = await getNetworkMapView(
			{ account: "a", type: "mutual", offset: 160 },
			db,
		);
		expect(mutual.features.map((f) => f.properties.handle)).toEqual([
			"person1",
		]);
		expect(mutual.offset).toBe(0);
		const other = await getNetworkMapView({ account: "b" }, db);
		expect(other.meta.totalProfiles).toBe(1);
		expect(other.features.map((f) => f.properties.handle)).toEqual(["person2"]);
		const empty = await getNetworkMapView(
			{ account: "b", search: "missing", offset: 160 },
			db,
		);
		expect(empty.matchingProfiles).toBe(0);
		expect(empty.offset).toBe(0);
		expect(empty.features).toEqual([]);
		await expect(getNetworkMapView({ account: "missing" }, db)).rejects.toThrow(
			"Unknown account",
		);
	});

	it("serves reads without geocoding and preserves an explicit refresh", async () => {
		const db = fixture(1);
		vi.stubEnv("OPENCAGE_API_KEY", "test-key");
		db.exec("delete from geocoded_locations");
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{ geometry: { lat: 35.6, lng: 139.6 }, formatted: "Tokyo" },
					],
					status: { code: 200, message: "OK" },
				}),
			),
		);
		expect((await getNetworkMapView({ account: "a" }, db)).features).toEqual(
			[],
		);
		expect(fetch).not.toHaveBeenCalled();
		const refreshed = await getNetworkMapView(
			{ account: "a", refresh: true, geocodeLimit: 1 },
			db,
		);
		expect(refreshed.meta.geocodedThisRun).toBe(1);
		expect(refreshed.features).toHaveLength(1);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(
			(await getNetworkMapView({ account: "a" }, db)).meta.geocodedThisRun,
		).toBe(0);
	});

	it("shares concurrent reads and does not let an aborted caller poison the shared result", async () => {
		const db = fixture();
		const build = vi.spyOn(geometry, "buildClusterIndex");
		const abort = new AbortController();
		abort.abort();
		const [first, second] = await Promise.all([
			getNetworkMapView({ signal: abort.signal }, db),
			getNetworkMapView({}, db),
		]);
		expect(first.meta.totalProfiles).toBe(350);
		expect(second).toEqual(first);
		expect(build).toHaveBeenCalledTimes(1);
	});
	it("does not block cached reads behind a slow explicit geocode refresh", async () => {
		const db = fixture(1);
		vi.stubEnv("OPENCAGE_API_KEY", "test-key");
		const original = await getNetworkMapView({}, db);
		let finish!: (response: Response) => void;
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const refreshing = getNetworkMapView(
			{ refresh: true, geocodeLimit: 1 },
			db,
		);
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		const ordinary = await getNetworkMapView({}, db);
		expect(ordinary.features).toEqual(original.features);
		finish(
			new Response(
				JSON.stringify({ results: [], status: { code: 200, message: "OK" } }),
			),
		);
		await refreshing;
	});

	it("includes wrapped-world and antimeridian profiles in the visible list", async () => {
		const db = fixture(2);
		db.exec(
			"update geocoded_locations set lng = case when normalized_key = 'vienna' then 179 else -179 end",
		);
		for (const bounds of [
			[170, -85, -170, 85],
			[-550, -85, -530, 85],
		] as [number, number, number, number][]) {
			const map = await getNetworkMapView(
				{ viewport: { bounds, zoom: 4 } },
				db,
			);
			expect(map.visibleProfiles).toBe(2);
			expect(map.features).toHaveLength(2);
		}
	});
	it("shares the index across pooled readers, detects writes, and retires closed owners", async () => {
		const writer = fixture();
		const first = new NativeSqliteDatabase(getBirdclawPaths().dbPath, {
			readonly: true,
		});
		const second = new NativeSqliteDatabase(getBirdclawPaths().dbPath, {
			readonly: true,
		});
		const build = vi.spyOn(geometry, "buildClusterIndex");
		try {
			const original = await getNetworkMapView({}, first);
			expect(await getNetworkMapView({}, second)).toEqual(original);
			expect(build).toHaveBeenCalledTimes(1);
			writer.exec(
				"update profiles set display_name = 'Changed through writer' where id = 'p1'",
			);
			const changed = await getNetworkMapView({}, second);
			expect(changed.features[0].properties.name).toBe(
				"Changed through writer",
			);
			expect(build).toHaveBeenCalledTimes(2);
			second.close();
			expect(await getNetworkMapView({}, first)).toEqual(changed);
			expect(build).toHaveBeenCalledTimes(3);
		} finally {
			first.close();
			second.close();
		}
	});
});
