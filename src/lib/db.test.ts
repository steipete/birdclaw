// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";

const tempDirs: string[] = [];

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;

	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("database init", () => {
	it("migrates legacy tweet tables before creating quoted tweet indexes", () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-db-"));
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;

		const legacyDb = new BetterSqlite3(path.join(tempDir, "birdclaw.sqlite"));
		legacyDb.exec(`
      create table tweets (
        id text primary key,
        account_id text not null,
        author_profile_id text not null,
        kind text not null,
        text text not null,
        created_at text not null,
        is_replied integer not null default 0,
        reply_to_id text,
        like_count integer not null default 0,
        media_count integer not null default 0,
        bookmarked integer not null default 0,
        liked integer not null default 0
      );
    `);
		legacyDb.close();

		const db = getNativeDb();
		const columnNames = db.prepare("pragma table_info(tweets)").all() as Array<{
			name: string;
		}>;

		expect(columnNames.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"entities_json",
				"media_json",
				"quoted_tweet_id",
			]),
		);

		const profileColumnNames = db
			.prepare("pragma table_info(profiles)")
			.all() as Array<{
			name: string;
		}>;
		expect(profileColumnNames.map((column) => column.name)).toEqual(
			expect.arrayContaining(["avatar_url"]),
		);

		const quotedIndex = db
			.prepare("pragma index_info(idx_tweets_quoted)")
			.all() as Array<{
			name: string;
		}>;
		expect(quotedIndex).toEqual([
			expect.objectContaining({ name: "quoted_tweet_id" }),
		]);

		const syncCacheColumnNames = db
			.prepare("pragma table_info(sync_cache)")
			.all() as Array<{
			name: string;
		}>;
		expect(syncCacheColumnNames.map((column) => column.name)).toEqual(
			expect.arrayContaining(["cache_key", "value_json", "updated_at"]),
		);

		const muteColumnNames = db
			.prepare("pragma table_info(mutes)")
			.all() as Array<{
			name: string;
		}>;
		expect(muteColumnNames.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"account_id",
				"profile_id",
				"source",
				"created_at",
			]),
		);

		const busyTimeout = db.pragma("busy_timeout", {
			simple: true,
		}) as number;
		expect(busyTimeout).toBe(5000);
	});
});
