// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { deleteSyncCache, readSyncCache, writeSyncCache } from "./sync-cache";

const tempDirs: string[] = [];

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;

	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("sync cache", () => {
	it("stores and deletes structured payloads", () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-sync-cache-"));
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;
		const db = getNativeDb();

		writeSyncCache("mentions:test", { ok: true, count: 2 }, db);

		expect(
			readSyncCache<{ ok: boolean; count: number }>("mentions:test", db),
		).toEqual(
			expect.objectContaining({
				value: { ok: true, count: 2 },
			}),
		);

		deleteSyncCache("mentions:test", db);
		expect(readSyncCache("mentions:test", db)).toBeNull();
	});

	it("returns null for corrupted cached json", () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-sync-cache-"));
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;
		const db = getNativeDb();

		db.prepare(
			"insert into sync_cache (cache_key, value_json, updated_at) values (?, ?, ?)",
		).run("mentions:bad", "{not-json", "2026-03-09T00:00:00.000Z");

		expect(readSyncCache("mentions:bad", db)).toBeNull();
	});
});
