// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { storeGeocode } from "./geocoding";
import { getNetworkMap, getPublicMapboxToken } from "./network-map";

const tempDirs: string[] = [];

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	delete process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;
	delete process.env.BIRDCLAW_MAPBOX_ACCESS_TOKEN;
	delete process.env.OPENCAGE_API_KEY;
	vi.restoreAllMocks();

	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeDb() {
	const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-map-"));
	tempDirs.push(tempDir);
	process.env.BIRDCLAW_HOME = tempDir;
	return getNativeDb({ seedDemoData: false });
}

describe("network map", () => {
	it("returns current follower/following profile points from cached geocodes", async () => {
		const db = makeDb();
		db.exec(`
      insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at)
      values ('acct_primary', 'Primary', 'steipete', '1', 'archive', 1, '2026-01-01T00:00:00.000Z');

      insert into profiles (
        id, handle, display_name, bio, followers_count, following_count,
        public_metrics_json, avatar_hue, location, created_at
      ) values
        ('profile_user_1', 'ava', 'Ava', '', 100, 10, '{}', 20, 'Vienna, Austria', '2026-01-01T00:00:00.000Z'),
        ('profile_user_2', 'bea', 'Bea', '', 50, 5, '{}', 30, 'San Francisco', '2026-01-01T00:00:00.000Z'),
        ('profile_user_3', 'cam', 'Cam', '', 25, 8, '{}', 40, 'San Francisco', '2026-01-01T00:00:00.000Z');

      insert into follow_edges (
        account_id, direction, profile_id, external_user_id, source, current,
        first_seen_at, last_seen_at, updated_at
      ) values
        ('acct_primary', 'followers', 'profile_user_1', '1', 'test', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('acct_primary', 'following', 'profile_user_1', '1', 'test', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('acct_primary', 'following', 'profile_user_2', '2', 'test', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('acct_primary', 'following', 'profile_user_3', '3', 'test', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
		storeGeocode(
			{
				normalizedKey: "vienna,austria",
				original: "Vienna, Austria",
				lat: 48.2082,
				lng: 16.3738,
				formatted: "Vienna, Austria",
				countryCode: "AT",
				provider: "opencage",
			},
			db,
		);
		storeGeocode(
			{
				normalizedKey: "san francisco",
				original: "San Francisco",
				lat: 37.7749,
				lng: -122.4194,
				formatted: "San Francisco, CA, USA",
				countryCode: "US",
				provider: "opencage",
			},
			db,
		);

		const all = await getNetworkMap({ type: "all" }, db);
		expect(all.features).toHaveLength(3);
		expect(all.features.map((item) => item.properties.handle).sort()).toEqual([
			"ava",
			"bea",
			"cam",
		]);
		expect(
			all.features.find((item) => item.properties.handle === "ava")?.properties
				.relationship,
		).toBe("mutual");
		const sanFranciscoCoordinates = all.features
			.filter((item) => item.properties.location === "San Francisco")
			.map((item) => item.geometry.coordinates);
		expect(sanFranciscoCoordinates).toEqual([
			[-122.4194, 37.7749],
			[-122.4194, 37.7749],
		]);

		const mutual = await getNetworkMap({ type: "mutual" }, db);
		expect(mutual.features.map((item) => item.properties.handle)).toEqual([
			"ava",
		]);
	});

	it("filters relationship and account before applying the map limit", async () => {
		const db = makeDb();
		db.exec(`
      insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at)
      values
        ('acct_primary', 'Primary', 'steipete', '1', 'archive', 1, '2026-01-01T00:00:00.000Z'),
        ('acct_studio', 'Studio', 'studio', '2', 'archive', 0, '2026-01-01T00:00:00.000Z');

      insert into profiles (
        id, handle, display_name, bio, followers_count, following_count,
        public_metrics_json, avatar_hue, location, created_at
      ) values
        ('profile_following_high', 'high', 'High', '', 10000, 10, '{}', 20, 'Berlin', '2026-01-01T00:00:00.000Z'),
        ('profile_follower_low', 'low', 'Low', '', 10, 5, '{}', 30, 'Vienna', '2026-01-01T00:00:00.000Z'),
        ('profile_studio', 'studiofriend', 'Studio Friend', '', 5000, 5, '{}', 40, 'Paris', '2026-01-01T00:00:00.000Z');

      insert into follow_edges (
        account_id, direction, profile_id, external_user_id, source, current,
        first_seen_at, last_seen_at, updated_at
      ) values
        ('acct_primary', 'following', 'profile_following_high', '10', 'test', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('acct_primary', 'followers', 'profile_follower_low', '11', 'test', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('acct_studio', 'following', 'profile_studio', '12', 'test', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
		for (const [normalizedKey, original, lat, lng] of [
			["berlin", "Berlin", 52.52, 13.405],
			["vienna", "Vienna", 48.2082, 16.3738],
			["paris", "Paris", 48.8566, 2.3522],
		] as const) {
			storeGeocode(
				{
					normalizedKey,
					original,
					lat,
					lng,
					provider: "opencage",
				},
				db,
			);
		}

		const followers = await getNetworkMap(
			{ account: "acct_primary", type: "followers", limit: 1 },
			db,
		);
		expect(followers.features.map((item) => item.properties.handle)).toEqual([
			"low",
		]);

		const studio = await getNetworkMap(
			{ account: "acct_studio", type: "following", limit: 1 },
			db,
		);
		expect(studio.meta.accountId).toBe("acct_studio");
		expect(studio.features.map((item) => item.properties.handle)).toEqual([
			"studiofriend",
		]);
		for (const selector of ["@STUDIO", "studio"]) {
			await expect(
				getNetworkMap({ account: selector, type: "following", limit: 1 }, db),
			).resolves.toMatchObject({ meta: { accountId: "acct_studio" } });
		}
		await expect(getNetworkMap({ account: "missing" }, db)).rejects.toThrow(
			"Unknown account: missing",
		);
	});

	it("only exposes public Mapbox tokens to the browser config", () => {
		process.env.BIRDCLAW_MAPBOX_ACCESS_TOKEN = "sk.secret";
		expect(getPublicMapboxToken()).toBeNull();

		process.env.BIRDCLAW_MAPBOX_ACCESS_TOKEN = "pk.public";
		expect(getPublicMapboxToken()).toBe("pk.public");
	});

	it("resolves coordinate-only profile locations without OpenCage quota", async () => {
		const db = makeDb();
		db.exec(`
      insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at)
      values ('acct_primary', 'Primary', 'steipete', '1', 'archive', 1, '2026-01-01T00:00:00.000Z');

      insert into profiles (
        id, handle, display_name, bio, followers_count, following_count,
        public_metrics_json, avatar_hue, location, created_at
      ) values
        ('profile_coords', 'coords', 'Coords', '', 100, 10, '{}', 20, '48.2082, 16.3738', '2026-01-01T00:00:00.000Z');

      insert into follow_edges (
        account_id, direction, profile_id, external_user_id, source, current,
        first_seen_at, last_seen_at, updated_at
      ) values
        ('acct_primary', 'following', 'profile_coords', '1', 'test', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);

		const map = await getNetworkMap({ geocodeLimit: 0 }, db);
		expect(map.features).toHaveLength(1);
		expect(map.features[0]?.geometry.coordinates).toEqual([16.3738, 48.2082]);
		expect(map.meta.geocodedThisRun).toBe(1);
		expect(map.meta.missingGeocodes).toBe(0);
	});

	it("keeps the map response when OpenCage fails", async () => {
		const db = makeDb();
		process.env.OPENCAGE_API_KEY = "test-key";
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
		db.exec(`
      insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at)
      values ('acct_primary', 'Primary', 'steipete', '1', 'archive', 1, '2026-01-01T00:00:00.000Z');

      insert into profiles (
        id, handle, display_name, bio, followers_count, following_count,
        public_metrics_json, avatar_hue, location, created_at
      ) values
        ('profile_berlin', 'berlin', 'Berlin', '', 100, 10, '{}', 20, 'Berlin', '2026-01-01T00:00:00.000Z');

      insert into follow_edges (
        account_id, direction, profile_id, external_user_id, source, current,
        first_seen_at, last_seen_at, updated_at
      ) values
        ('acct_primary', 'following', 'profile_berlin', '1', 'test', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);

		const map = await getNetworkMap({ geocodeLimit: 1 }, db);
		expect(map.features).toHaveLength(0);
		expect(map.meta.missingGeocodes).toBe(1);
		expect(map.meta.geocodedThisRun).toBe(0);
	});

	it("lets explicit refresh retry suppressed geocode keys", async () => {
		const db = makeDb();
		process.env.OPENCAGE_API_KEY = "test-key";
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{
							geometry: { lat: 52.52, lng: 13.405 },
							confidence: 8,
							formatted: "Berlin, Germany",
						},
					],
					status: { code: 200, message: "OK" },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		db.exec(`
      insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at)
      values ('acct_primary', 'Primary', 'steipete', '1', 'archive', 1, '2026-01-01T00:00:00.000Z');

      insert into profiles (
        id, handle, display_name, bio, followers_count, following_count,
        public_metrics_json, avatar_hue, location, created_at
      ) values
        ('profile_berlin', 'berlin', 'Berlin', '', 100, 10, '{}', 20, 'Berlin', '2026-01-01T00:00:00.000Z');

      insert into follow_edges (
        account_id, direction, profile_id, external_user_id, source, current,
        first_seen_at, last_seen_at, updated_at
      ) values
        ('acct_primary', 'following', 'profile_berlin', '1', 'test', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

      insert into geocoded_locations_unresolved (
        normalized_key, original, reason, last_attempted_at, ttl_until
      ) values (
        'berlin', 'Berlin', 'opencage:500',
        '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'
      );
    `);

		const map = await getNetworkMap({ refresh: true, geocodeLimit: 1 }, db);
		expect(map.features).toHaveLength(1);
		expect(map.features[0]?.geometry.coordinates).toEqual([13.405, 52.52]);
		expect(map.meta.geocodedThisRun).toBe(1);
		expect(map.meta.missingGeocodes).toBe(0);
	});

	it("does not poison geocode retry after an OpenCage rate limit", async () => {
		const db = makeDb();
		process.env.OPENCAGE_API_KEY = "test-key";
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						results: [],
						status: { code: 429, message: "rate limited" },
					}),
					{ status: 429, headers: { "content-type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						results: [
							{
								geometry: { lat: 52.52, lng: 13.405 },
								confidence: 8,
								formatted: "Berlin, Germany",
							},
						],
						status: { code: 200, message: "OK" },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);
		db.exec(`
      insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at)
      values ('acct_primary', 'Primary', 'steipete', '1', 'archive', 1, '2026-01-01T00:00:00.000Z');

      insert into profiles (
        id, handle, display_name, bio, followers_count, following_count,
        public_metrics_json, avatar_hue, location, created_at
      ) values
        ('profile_berlin', 'berlin', 'Berlin', '', 100, 10, '{}', 20, 'Berlin', '2026-01-01T00:00:00.000Z');

      insert into follow_edges (
        account_id, direction, profile_id, external_user_id, source, current,
        first_seen_at, last_seen_at, updated_at
      ) values
        ('acct_primary', 'following', 'profile_berlin', '1', 'test', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);

		const limited = await getNetworkMap({ refresh: true, geocodeLimit: 1 }, db);
		expect(limited.features).toHaveLength(0);
		expect(limited.meta.suppressedGeocodes).toBe(0);

		const retried = await getNetworkMap({ refresh: true, geocodeLimit: 1 }, db);
		expect(retried.features).toHaveLength(1);
		expect(retried.features[0]?.geometry.coordinates).toEqual([13.405, 52.52]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
