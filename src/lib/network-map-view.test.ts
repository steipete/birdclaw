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
import * as networkMap from "./network-map";
import { NetworkMapViewIndex } from "./network-map-view-index";

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
	it("matches full GeoJSON views with Unicode ordering, location aliases, relationships and metadata", async () => {
		const db = fixture(360);
		db.exec(`
			update profiles set followers_count = 1, following_count = 23, verified_type = 'blue', avatar_url = 'https://example.com/avatar.png';
			update profiles set handle = (case when cast(substr(id, 2) as integer) % 3 = 0 then '𐀀' else '' end) || id;
			update profiles set handle = 'é' where id = 'p9';
			update profiles set handle = 'é' where id = 'p10';
			update profiles set display_name = 'Élodie 東京', location = ' VIENNA ' where id = 'p2';
			update profiles set location = null where id = 'p3';
			update profiles set location = '' where id = 'p4';
			update profiles set location = 'remote' where id = 'p5';
			update profiles set location = 'Missing City' where id = 'p6';
			update profiles set location = 'Suppressed City' where id = 'p7';
			insert into geocoded_locations_unresolved(normalized_key, original, reason, last_attempted_at, ttl_until)
			values('suppressed city', 'Suppressed City', 'fixture', '2026-01-01', '2099-01-01');
			update geocoded_locations set formatted = 'Resolved Vienna', approx_radius_m = 1234 where normalized_key = 'vienna';
			insert into follow_edges(account_id, direction, profile_id, external_user_id, source, current, first_seen_at, last_seen_at, updated_at) select account_id, 'following', profile_id, external_user_id, source, current, first_seen_at, last_seen_at, updated_at from follow_edges where account_id = 'a' and profile_id in ('p2', 'p3', 'p8');
			update follow_edges set current = 0 where account_id = 'a' and direction = 'followers' and profile_id = 'p8';
		`);
		vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "1");
		for (const account of ["a", "@OTHER"])
			for (const type of ["all", "followers", "following", "mutual"] as const) {
				const data = await networkMap.getNetworkMap(
					{ account, type, limit: null },
					db,
				);
				const expected = new NetworkMapViewIndex(data.features);
				for (const [search, offset] of [
					["", 0],
					["", 160],
					["élodie", 0],
					["東京", 0],
					["mutual", 0],
					["resolved vienna", 160],
					["missing", 0],
				] as const) {
					for (const viewport of [
						geometry.WORLD_VIEWPORT,
						{ bounds: [0, 40, 30, 55] as geometry.MapBounds, zoom: 4 },
					]) {
						const actual = await getNetworkMapView(
							{ account, type, search, offset, viewport },
							db,
						);
						expect(actual).toEqual({
							meta: data.meta,
							config: data.config,
							...expected.read(viewport, search, offset),
						});
					}
				}
			}
	});

	it("loads display metadata in bounded batches and reuses it across page and preview reads", async () => {
		const db = fixture(5_010);
		vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "1");
		const hydrate = vi.spyOn(networkMap, "hydrateMapFeatures");
		const first = await getNetworkMapView({}, db);
		expect(hydrate).toHaveBeenCalledTimes(1);
		const selected = hydrate.mock.calls[0][0];
		expect(selected.length).toBeLessThanOrEqual(160 + 6 * first.markers.length);
		expect(new Set(selected.map((f) => f.properties.profileId)).size).toBe(
			selected.length,
		);
		expect(selected.every((f) => !("avatarUrl" in f.properties))).toBe(true);
		expect(await getNetworkMapView({}, db)).toEqual(first);
		expect(hydrate).toHaveBeenCalledTimes(1);
		await getNetworkMapView({ offset: 160 }, db);
		expect(hydrate).toHaveBeenCalledTimes(2);
		expect(hydrate.mock.calls[1][0].length).toBeLessThanOrEqual(160);
		const searches = await getNetworkMapView({ search: "person5010" }, db);
		expect(searches.features[0].properties.profileId).toBe("p5010");
	});

	it("retries failed hydration and rebuilds explicit read-only refreshes without geocoding", async () => {
		const db = fixture();
		vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "1");
		vi.stubEnv("OPENCAGE_API_KEY", "test-key");
		const fetch = vi.spyOn(globalThis, "fetch");
		const hydrate = vi
			.spyOn(networkMap, "hydrateMapFeatures")
			.mockImplementationOnce(() => {
				throw new Error("fixture read failed");
			});
		await expect(getNetworkMapView({}, db)).rejects.toThrow(
			"fixture read failed",
		);
		const ordinary = await getNetworkMapView({}, db);
		expect(ordinary.visibleProfiles).toBe(350);
		const calls = hydrate.mock.calls.length;
		expect(
			await getNetworkMapView({ refresh: true, geocodeLimit: 500 }, db),
		).toEqual(ordinary);
		expect(hydrate.mock.calls.length).toBe(calls + 1);
		expect(await getNetworkMapView({}, db)).toEqual(ordinary);
		expect(hydrate.mock.calls.length).toBe(calls + 1);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("pins cached geometry and deferred metadata to the owner's snapshot during external commits", async () => {
		const writer = fixture();
		vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "1");
		let commitDuringRead = false;
		const owner = new NativeSqliteDatabase(getBirdclawPaths().dbPath, {
			readonly: true,
			onStatement(sql) {
				if (commitDuringRead && sql.includes("total_changes()")) {
					commitDuringRead = false;
					writer.exec(
						"update profiles set avatar_url = 'https://example.com/new.png', following_count = 42, verified_type = 'blue' where id = 'p200'",
					);
				}
			},
		});
		const reader = new NativeSqliteDatabase(getBirdclawPaths().dbPath, {
			readonly: true,
		});
		const build = vi.spyOn(geometry, "buildClusterIndex");
		try {
			await getNetworkMapView({}, owner);
			commitDuringRead = true;
			const old = await getNetworkMapView({ offset: 160 }, reader);
			expect(
				old.features.find((f) => f.properties.profileId === "p200")?.properties,
			).toMatchObject({ avatarUrl: null, followingCount: 0, verified: null });
			expect(commitDuringRead).toBe(false);
			expect(build).toHaveBeenCalledTimes(1);
			const fresh = await getNetworkMapView({ offset: 160 }, reader);
			expect(
				fresh.features.find((f) => f.properties.profileId === "p200")
					?.properties,
			).toMatchObject({
				avatarUrl: "https://example.com/new.png",
				followingCount: 42,
				verified: true,
			});
			expect(build).toHaveBeenCalledTimes(1);
			owner.close();
			expect(await getNetworkMapView({ offset: 160 }, reader)).toEqual(fresh);
			expect(build).toHaveBeenCalledTimes(2);
		} finally {
			owner.close();
			reader.close();
		}
	});

	it("retains the index through unrelated external writes and unchanged map fields", async () => {
		const writer = fixture();
		vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "1");
		const reader = new NativeSqliteDatabase(getBirdclawPaths().dbPath, {
			readonly: true,
		});
		const build = vi.spyOn(geometry, "buildClusterIndex");
		try {
			const original = await getNetworkMapView({}, reader);
			writer.exec(`
				insert into tweets(id,author_profile_id,text,created_at) values('unrelated','p1','New tweet','2026-01-01');
				update profiles set bio = 'New bio', raw_json = '{"changed":true}', display_name = display_name, followers_count = followers_count;
				update follow_edges set last_seen_at = '2026-09-14';
				update geocoded_locations set hits = hits + 1, last_used_at = '2026-09-14';
			`);
			expect(await getNetworkMapView({}, reader)).toEqual(original);
			expect(build).toHaveBeenCalledTimes(1);
			writer.exec(
				"update geocoded_locations set lng=17 where normalized_key='vienna'",
			);
			const moved = await getNetworkMapView({}, reader);
			expect(
				moved.features.find((f) => f.properties.location === "Vienna")?.geometry
					.coordinates,
			).toEqual([17, 48.2]);
			expect(build).toHaveBeenCalledTimes(2);
		} finally {
			reader.close();
		}
	});

	it("expires suppressed geocodes without waiting for another database write", async () => {
		const db = fixture(1);
		db.exec(`delete from geocoded_locations;
			insert into geocoded_locations_unresolved(normalized_key,original,reason,last_attempted_at,ttl_until)
			values('tokyo','Tokyo','fixture','2026-01-01','2026-09-14T00:00:01.000Z')`);
		vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "1");
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-09-14T00:00:00.000Z"));
			expect((await getNetworkMapView({}, db)).meta).toMatchObject({
				suppressedGeocodes: 1,
				missingGeocodes: 0,
			});
			vi.setSystemTime(new Date("2026-09-14T00:00:01.000Z"));
			expect((await getNetworkMapView({}, db)).meta).toMatchObject({
				suppressedGeocodes: 0,
				missingGeocodes: 1,
			});
			vi.setSystemTime(new Date("2026-09-14T00:00:00.000Z"));
			expect((await getNetworkMapView({}, db)).meta).toMatchObject({
				suppressedGeocodes: 1,
				missingGeocodes: 0,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not reuse a view from a rolled-back local transaction with a repeated revision", async () => {
		const db = fixture(1);
		vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "1");
		db.exec(
			"begin; update profiles set display_name='Rolled back' where id='p1'",
		);
		expect((await getNetworkMapView({}, db)).features[0].properties.name).toBe(
			"Rolled back",
		);
		db.exec(
			"rollback; update profiles set display_name='Committed' where id='p1'",
		);
		expect((await getNetworkMapView({}, db)).features[0].properties.name).toBe(
			"Committed",
		);
	});

	it.each([false, true])(
		"returns bounded markers and pages while retaining every follower and search result (read-only: %s)",
		async (readOnly) => {
			const db = fixture(50_010);
			vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", readOnly ? "1" : "0");
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
		},
	);

	it.each([false, true])(
		"reuses the index and invalidates local and external writes (read-only: %s)",
		async (readOnly) => {
			const db = fixture();
			vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", readOnly ? "1" : "0");
			const build = vi.spyOn(geometry, "buildClusterIndex");
			await getNetworkMapView({ account: "a" }, db);
			expect(
				(await getNetworkMapView({ account: "a", search: "updated" }, db))
					.matchingProfiles,
			).toBe(0);
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
				(await getNetworkMapView({ account: "a", search: "updated" }, db))
					.matchingProfiles,
			).toBe(1);
			expect(
				(await getNetworkMapView({ account: "a" }, db)).features[0].properties
					.name,
			).toBe("Updated");
			expect(build).toHaveBeenCalledTimes(3);
		},
	);

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
