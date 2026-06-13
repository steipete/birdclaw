// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import NativeSqliteDatabase from "./sqlite";
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
	it("seeds demo data after an initial unseeded open", () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-db-"));
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;

		const unseededDb = getNativeDb({ seedDemoData: false });
		expect(
			unseededDb.prepare("select count(*) as count from accounts").get(),
		).toEqual({ count: 0 });

		const seededDb = getNativeDb();

		expect(
			seededDb.prepare("select count(*) as count from accounts").get(),
		).toEqual({ count: 2 });
		expect(
			seededDb
				.prepare(
					"select count(*) as count from link_occurrences where source_kind = 'tweet'",
				)
				.get(),
		).toEqual({ count: 3 });
	});

	it("migrates legacy tweet tables before creating quoted tweet indexes", () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-db-"));
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;

		const legacyDb = new NativeSqliteDatabase(
			path.join(tempDir, "birdclaw.sqlite"),
		);
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
			expect.arrayContaining([
				"following_count",
				"avatar_url",
				"public_metrics_json",
			]),
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

		const followEdgeColumnNames = db
			.prepare("pragma table_info(follow_edges)")
			.all() as Array<{
			name: string;
		}>;
		expect(followEdgeColumnNames.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"account_id",
				"direction",
				"profile_id",
				"external_user_id",
				"current",
				"first_seen_at",
				"last_seen_at",
				"ended_at",
			]),
		);

		const followSnapshotColumnNames = db
			.prepare("pragma table_info(follow_snapshots)")
			.all() as Array<{
			name: string;
		}>;
		expect(followSnapshotColumnNames.map((column) => column.name)).toEqual(
			expect.arrayContaining(["id", "direction", "status", "result_count"]),
		);

		const geocodeColumnNames = db
			.prepare("pragma table_info(geocoded_locations)")
			.all() as Array<{
			name: string;
		}>;
		expect(geocodeColumnNames.map((column) => column.name)).toEqual(
			expect.arrayContaining(["normalized_key", "lat", "lng", "provider"]),
		);

		const collectionColumnNames = db
			.prepare("pragma table_info(tweet_collections)")
			.all() as Array<{
			name: string;
		}>;
		expect(collectionColumnNames.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"account_id",
				"tweet_id",
				"kind",
				"collected_at",
				"source",
				"raw_json",
				"updated_at",
			]),
		);

		const timelineEdgeColumnNames = db
			.prepare("pragma table_info(tweet_account_edges)")
			.all() as Array<{
			name: string;
		}>;
		expect(timelineEdgeColumnNames.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"account_id",
				"tweet_id",
				"kind",
				"first_seen_at",
				"last_seen_at",
				"seen_count",
				"source",
				"raw_json",
				"updated_at",
			]),
		);

		const identityIndexColumnNames = db
			.prepare("pragma table_info(identity_search_index)")
			.all() as Array<{
			name: string;
		}>;
		expect(identityIndexColumnNames.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"profile_id",
				"kind",
				"value",
				"normalized_value",
				"source",
				"weight",
				"updated_at",
			]),
		);

		const accountColumnNames = db
			.prepare("pragma table_info(accounts)")
			.all() as Array<{
			name: string;
		}>;
		expect(accountColumnNames.map((column) => column.name)).toEqual(
			expect.arrayContaining(["external_user_id"]),
		);

		const urlExpansionColumnNames = db
			.prepare("pragma table_info(url_expansions)")
			.all() as Array<{
			name: string;
		}>;
		expect(urlExpansionColumnNames.map((column) => column.name)).toEqual(
			expect.arrayContaining(["image_url", "site_name"]),
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

describe("native sqlite compatibility wrapper", () => {
	it("installs a busy timeout as soon as the database opens", () => {
		const db = new NativeSqliteDatabase(":memory:");

		try {
			expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
		} finally {
			db.close();
		}
	});

	it("normalizes rows, buffers, parameter arrays, and close behavior", () => {
		const db = new NativeSqliteDatabase(":memory:");
		db.exec(
			"create table files (id integer primary key, name text, data blob)",
		);

		const insert = db.prepare("insert into files (name, data) values (?, ?)");
		const result = insert.run(["readme", Buffer.from("hello")]);
		expect(result).toMatchObject({ changes: 1, lastInsertRowid: 1 });

		const row = db
			.prepare("select id, name, data from files where name = ?")
			.get("readme") as { id: number; name: string; data: Buffer };
		expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
		expect(row.data).toBeInstanceOf(Buffer);
		expect(row.data.toString("utf8")).toBe("hello");

		const rows = [
			...db.prepare("select name from files where id in (?)").iterate(1),
		] as Array<{ name: string }>;
		expect(rows).toEqual([{ name: "readme" }]);
		expect(db.pragma("application_id")).toEqual([
			expect.objectContaining({ application_id: 0 }),
		]);
		expect(db.pragma("does_not_exist", { simple: true })).toBeUndefined();

		db.close();
		expect(() => db.close()).not.toThrow();
	});

	it("commits, rolls back, and nests transactions with savepoints", () => {
		const db = new NativeSqliteDatabase(":memory:");
		db.exec("create table events (name text)");

		db.transaction((name: string) => {
			db.prepare("insert into events (name) values (?)").run(name);
		})("committed");

		expect(() =>
			db.transaction(() => {
				db.prepare("insert into events (name) values (?)").run("rolled-back");
				throw new Error("nope");
			})(),
		).toThrow("nope");

		expect(() =>
			db.transaction(() => {
				db.prepare("insert into events (name) values (?)").run("outer");
				db.transaction(() => {
					db.prepare("insert into events (name) values (?)").run("inner");
					throw new Error("inner nope");
				})();
			})(),
		).toThrow("inner nope");

		const names = db
			.prepare("select name from events order by name")
			.all() as Array<{ name: string }>;
		expect(names).toEqual([{ name: "committed" }]);
		db.close();
	});
});
