// @vitest-environment node
import { describe, expect, it } from "vitest";
import { useTestHome } from "../test/test-home";
import { createServerRuntimeServices } from "./server-runtime-services";
import {
	deleteSyncCache,
	inspectSyncCache,
	readSyncCache,
	writeSyncCache,
} from "./sync-cache";

const testHome = useTestHome({ prefix: "birdclaw-sync-cache-" });

describe("sync cache", () => {
	it("stores and deletes structured payloads", () => {
		const { db } = testHome();

		const updatedAt = writeSyncCache(
			"mentions:test",
			{ ok: true, count: 2 },
			db,
			createServerRuntimeServices({
				now: () => new Date("2026-06-15T12:00:00.000Z"),
			}),
		);

		expect(
			readSyncCache<{ ok: boolean; count: number }>("mentions:test", db),
		).toEqual(
			expect.objectContaining({
				value: { ok: true, count: 2 },
				updatedAt: "2026-06-15T12:00:00.000Z",
			}),
		);
		expect(updatedAt).toBe("2026-06-15T12:00:00.000Z");

		deleteSyncCache("mentions:test", db);
		expect(readSyncCache("mentions:test", db)).toBeNull();
	});

	it("returns null for corrupted cached json", () => {
		const { db } = testHome();

		db.prepare(
			"insert into sync_cache (cache_key, value_json, updated_at) values (?, ?, ?)",
		).run("mentions:bad", "{not-json", "2026-03-09T00:00:00.000Z");

		expect(readSyncCache("mentions:bad", db)).toBeNull();
	});

	it("treats the TTL boundary as fresh but stale, invalid, and future timestamps as unusable", () => {
		const { db } = testHome();
		const runtime = createServerRuntimeServices({
			now: () => new Date("2026-06-15T12:00:10.000Z"),
		});
		const insert = db.prepare(
			"insert into sync_cache (cache_key, value_json, updated_at) values (?, '{}', ?)",
		);
		insert.run("boundary", "2026-06-15T12:00:00.000Z");
		insert.run("stale", "2026-06-15T11:59:59.999Z");
		insert.run("invalid", "not-a-date");
		insert.run("future", "2026-06-15T12:00:10.001Z");

		const policy = { ttlMs: 10_000, defaultTtlMs: 60_000 };
		expect(inspectSyncCache("boundary", policy, db, runtime)).toMatchObject({
			ageMs: 10_000,
			fresh: true,
			ttlMs: 10_000,
		});
		expect(inspectSyncCache("stale", policy, db, runtime).fresh).toBe(false);
		expect(inspectSyncCache("invalid", policy, db, runtime)).toMatchObject({
			ageMs: null,
			fresh: false,
		});
		expect(inspectSyncCache("future", policy, db, runtime)).toMatchObject({
			ageMs: -1,
			fresh: false,
		});
	});

	it("normalizes optional TTL values during inspection", () => {
		const { db } = testHome();
		expect(
			inspectSyncCache("missing", { ttlMs: Number.NaN, defaultTtlMs: 42 }, db),
		).toMatchObject({ ttlMs: 42, fresh: false });
	});
});
