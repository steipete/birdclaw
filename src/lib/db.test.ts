// @vitest-environment node
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import {
	getNativeDb,
	getReadDb,
	getStrictReadDb,
	resetDatabaseForTests,
} from "./db";
import { seedDemoData } from "./seed";
import NativeSqliteDatabase, { SQLITE_BUSY_TIMEOUT_MS } from "./sqlite";

const tempDirs: string[] = [];

async function waitForOutput(child: ChildProcess, expected: string) {
	await new Promise<void>((resolve, reject) => {
		let output = "";
		const onData = (chunk: Buffer) => {
			output += chunk.toString();
			if (output.includes(expected)) {
				cleanup();
				resolve();
			}
		};
		const onExit = (code: number | null) => {
			cleanup();
			reject(new Error(`lock holder exited before ready (${code})`));
		};
		const cleanup = () => {
			child.stdout?.off("data", onData);
			child.off("exit", onExit);
		};
		child.stdout?.on("data", onData);
		child.on("exit", onExit);
	});
}

async function stopChild(child: ChildProcess) {
	if (child.exitCode !== null) return;
	await new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
		child.kill();
	});
}

function spawnWriteLockHolder(dbPath: string, holdMs: number) {
	return spawn(
		process.execPath,
		[
			"-e",
			`
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(process.argv[1], { timeout: 1000 });
        db.exec("pragma journal_mode = wal; begin immediate");
        db.prepare(
          "insert or replace into sync_cache (cache_key, value_json, updated_at) values ('test:lock', '{}', '2026-06-15T00:00:00.000Z')"
        ).run();
        process.stdout.write("locked\\n");
        setTimeout(() => {
          db.exec("commit");
          db.close();
        }, Number(process.argv[2]));
      `,
			dbPath,
			String(holdMs),
		],
		{ stdio: ["ignore", "pipe", "inherit"] },
	);
}

afterEach(() => {
	vi.restoreAllMocks();
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;

	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("database init", () => {
	it("seeds demo data only after an explicit request", () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-db-"));
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;

		const testSeedFlag = process.env.BIRDCLAW_TEST_SEED_DEMO_DATA;
		delete process.env.BIRDCLAW_TEST_SEED_DEMO_DATA;
		const unseededDb = getNativeDb();
		if (testSeedFlag === undefined) {
			delete process.env.BIRDCLAW_TEST_SEED_DEMO_DATA;
		} else {
			process.env.BIRDCLAW_TEST_SEED_DEMO_DATA = testSeedFlag;
		}
		expect(
			unseededDb.prepare("select count(*) as count from accounts").get(),
		).toEqual({ count: 0 });

		const seededDb = getNativeDb({ seedDemoData: true });

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

	it("refuses to mix demo data into a partially populated database", () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-db-"));
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;

		const db = getNativeDb({ seedDemoData: false });
		db.prepare(`
			insert into profiles (
				id, handle, display_name, bio, followers_count, following_count,
				avatar_hue, created_at
			) values (?, ?, ?, '', 0, 0, 0, ?)
		`).run("profile_real", "real", "Real profile", "2026-07-17T00:00:00Z");

		expect(seedDemoData(db)).toEqual({
			seeded: false,
			reason: "database-not-empty",
		});
		expect(db.prepare("select count(*) as count from accounts").get()).toEqual({
			count: 0,
		});
		expect(db.prepare("select count(*) as count from profiles").get()).toEqual({
			count: 1,
		});
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
			insert into tweets (
				id, account_id, author_profile_id, kind, text, created_at,
				bookmarked, liked
			) values (
				'legacy_saved_home', 'legacy_account', 'legacy_author', 'home',
				'legacy tweet', '2026-01-01T00:00:00.000Z', 1, 1
			), (
				'legacy_authored', 'legacy_account', 'legacy_author', 'authored',
				'legacy authored tweet', '2026-01-02T00:00:00.000Z', 0, 0
			), (
				'legacy_search', 'legacy_account', 'legacy_author', 'search',
				'legacy search tweet', '2026-01-03T00:00:00.000Z', 0, 0
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
		expect(columnNames.map((column) => column.name)).not.toEqual(
			expect.arrayContaining(["account_id", "kind", "bookmarked", "liked"]),
		);
		expect(
			db
				.prepare(
					"select account_id, tweet_id, kind from tweet_account_edges where tweet_id = ?",
				)
				.get("legacy_saved_home"),
		).toEqual({
			account_id: "legacy_account",
			tweet_id: "legacy_saved_home",
			kind: "home",
		});
		expect(
			db
				.prepare(
					"select tweet_id, kind from tweet_account_edges where tweet_id in ('legacy_authored', 'legacy_search') order by tweet_id",
				)
				.all(),
		).toEqual([
			{ tweet_id: "legacy_authored", kind: "authored" },
			{ tweet_id: "legacy_search", kind: "search" },
		]);
		expect(
			db
				.prepare(
					"select kind from tweet_collections where tweet_id = ? order by kind",
				)
				.all("legacy_saved_home"),
		).toEqual([{ kind: "bookmarks" }, { kind: "likes" }]);

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
		const replyIndex = db
			.prepare("pragma index_info(idx_tweets_reply_to)")
			.all() as Array<{ name: string }>;
		expect(replyIndex).toEqual([
			expect.objectContaining({ name: "reply_to_id" }),
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
		expect(
			db
				.prepare(
					"select name from sqlite_master where type = 'table' and name in ('x_lists', 'x_list_members') order by name",
				)
				.all(),
		).toEqual([{ name: "x_list_members" }, { name: "x_lists" }]);
		expect(
			db
				.prepare("pragma table_info(tweet_sources)")
				.all()
				.map((column) => (column as { name: string }).name),
		).toEqual(["tweet_id", "source", "source_url", "observed_at"]);

		const busyTimeout = db.pragma("busy_timeout", {
			simple: true,
		}) as number;
		expect(busyTimeout).toBe(SQLITE_BUSY_TIMEOUT_MS);
		expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
		expect(db.pragma("user_version", { simple: true })).toBe(5);
	});

	it("does not request a write lock for completed startup backfills", async () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-db-lock-"));
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;

		getNativeDb();
		resetDatabaseForTests();

		const dbPath = path.join(tempDir, "birdclaw.sqlite");
		const holder = spawnWriteLockHolder(dbPath, 1500);
		await waitForOutput(holder, "locked");

		const startedAt = Date.now();
		try {
			const reopened = getNativeDb({ seedDemoData: false });
			expect(Date.now() - startedAt).toBeLessThan(900);
			expect(reopened.pragma("foreign_keys", { simple: true })).toBe(1);
			expect(reopened.pragma("busy_timeout", { simple: true })).toBe(
				SQLITE_BUSY_TIMEOUT_MS,
			);
		} finally {
			await stopChild(holder);
		}
	});

	it("uses independent query-only connections for reads", () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-db-read-"));
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;

		const writer = getNativeDb({ seedDemoData: false });
		writer.exec("create table read_probe (value text)");
		writer.prepare("insert into read_probe (value) values ('committed')").run();
		const reader = getReadDb({ seedDemoData: false });

		writer.exec("begin immediate");
		try {
			writer.prepare("insert into read_probe (value) values ('pending')").run();
			expect(
				reader.prepare("select value from read_probe order by value").all(),
			).toEqual([{ value: "committed" }]);
			expect(() =>
				reader
					.prepare("insert into read_probe (value) values ('blocked')")
					.run(),
			).toThrow(/read.?only|write/i);
		} finally {
			writer.exec("rollback");
		}
	});

	it("opens strict readers without initialization and rejects writes", () => {
		const tempDir = mkdtempSync(
			path.join(os.tmpdir(), "birdclaw-db-strict-read-"),
		);
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;

		const writer = getNativeDb({ seedDemoData: false });
		writer.exec("create table strict_read_probe (value text)");
		writer
			.prepare("insert into strict_read_probe (value) values ('committed')")
			.run();
		resetDatabaseForTests();

		const reader = getStrictReadDb();
		expect(reader.prepare("select value from strict_read_probe").all()).toEqual(
			[{ value: "committed" }],
		);
		expect(reader.pragma("query_only", { simple: true })).toBe(1);
		expect(() =>
			reader
				.prepare("insert into strict_read_probe (value) values ('blocked')")
				.run(),
		).toThrow(/read.?only|write/i);
		expect(() =>
			reader.exec("create table strict_ddl_probe (value text)"),
		).toThrow(/read.?only|write/i);
	});

	it.each([
		{ kind: "stale", version: 4 },
		{ kind: "future", version: 6 },
	])(
		"rejects a $kind schema and closes its provisional reader",
		({ version }) => {
			const tempDir = mkdtempSync(
				path.join(os.tmpdir(), "birdclaw-db-strict-schema-"),
			);
			tempDirs.push(tempDir);
			process.env.BIRDCLAW_HOME = tempDir;

			getNativeDb({ seedDemoData: false });
			resetDatabaseForTests();
			const schemaDb = new NativeSqliteDatabase(
				path.join(tempDir, "birdclaw.sqlite"),
			);
			schemaDb.pragma(`user_version = ${String(version)}`);
			schemaDb.close();

			const closeSpy = vi.spyOn(NativeSqliteDatabase.prototype, "close");
			expect(() => getStrictReadDb()).toThrow(
				new RegExp(`schema ${String(version)} is not ready`),
			);
			expect(closeSpy).toHaveBeenCalledTimes(1);
		},
	);

	it("validates the schema before reusing a general read pool", () => {
		const tempDir = mkdtempSync(
			path.join(os.tmpdir(), "birdclaw-db-strict-reuse-"),
		);
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;

		const writer = getNativeDb({ seedDemoData: false });
		getReadDb({ seedDemoData: false });
		writer.pragma("user_version = 6");

		expect(() => getStrictReadDb()).toThrow(
			/schema 6 is not ready for version 5/,
		);
	});

	it("closes a read connection when its setup pragmas fail", () => {
		const tempDir = mkdtempSync(
			path.join(os.tmpdir(), "birdclaw-db-read-pragma-"),
		);
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;

		getNativeDb({ seedDemoData: false });
		resetDatabaseForTests();

		const closeSpy = vi.spyOn(NativeSqliteDatabase.prototype, "close");
		const execSpy = vi
			.spyOn(NativeSqliteDatabase.prototype, "exec")
			.mockImplementationOnce(() => {
				throw new Error("read pragma failed");
			});

		expect(() => getStrictReadDb()).toThrow("read pragma failed");
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(closeSpy.mock.instances[0]).toBe(execSpy.mock.instances[0]);
	});

	it("closes both provisional readers when the second pool open fails", () => {
		const tempDir = mkdtempSync(
			path.join(os.tmpdir(), "birdclaw-db-read-pool-"),
		);
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;

		getNativeDb({ seedDemoData: false });
		resetDatabaseForTests();

		const originalExec = NativeSqliteDatabase.prototype.exec;
		const closeSpy = vi.spyOn(NativeSqliteDatabase.prototype, "close");
		let readSetupCalls = 0;
		const execSpy = vi
			.spyOn(NativeSqliteDatabase.prototype, "exec")
			.mockImplementation(function (this: NativeSqliteDatabase, sql) {
				if (sql.includes("pragma query_only")) {
					readSetupCalls += 1;
					if (readSetupCalls === 2) {
						throw new Error("second read open failed");
					}
				}
				return originalExec.call(this, sql);
			});

		expect(() => getStrictReadDb()).toThrow("second read open failed");
		expect(closeSpy).toHaveBeenCalledTimes(2);
		expect(new Set(closeSpy.mock.instances).size).toBe(2);

		execSpy.mockRestore();
		closeSpy.mockRestore();
		expect(getStrictReadDb().pragma("query_only", { simple: true })).toBe(1);
	});
});

describe("native sqlite compatibility wrapper", () => {
	it("installs a busy timeout as soon as the database opens", () => {
		const db = new NativeSqliteDatabase(":memory:");

		try {
			expect(db.pragma("busy_timeout", { simple: true })).toBe(
				SQLITE_BUSY_TIMEOUT_MS,
			);
		} finally {
			db.close();
		}
	});

	it("waits for the writer slot before a transaction reads and writes", async () => {
		const tempDir = mkdtempSync(
			path.join(os.tmpdir(), "birdclaw-sqlite-lock-"),
		);
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "database.sqlite");
		const setupDb = new NativeSqliteDatabase(dbPath);
		setupDb.exec(`
      pragma journal_mode = wal;
      create table sync_cache (
        cache_key text primary key,
        value_json text not null,
        updated_at text not null
      );
      create table events (name text);
    `);
		setupDb.close();

		const holder = spawnWriteLockHolder(dbPath, 500);
		await waitForOutput(holder, "locked");
		const contender = new NativeSqliteDatabase(dbPath, { timeout: 2000 });
		const startedAt = Date.now();

		try {
			contender.transaction(() => {
				contender.prepare("select count(*) from events").get();
				contender.prepare("insert into events (name) values (?)").run("waited");
			})();
			expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
			expect(contender.prepare("select name from events").all()).toEqual([
				{ name: "waited" },
			]);
		} finally {
			contender.close();
			await stopChild(holder);
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

	it("holds one WAL snapshot in a deferred read transaction", () => {
		const tempDir = mkdtempSync(
			path.join(os.tmpdir(), "birdclaw-sqlite-read-tx-"),
		);
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "database.sqlite");
		const setupDb = new NativeSqliteDatabase(dbPath);
		setupDb.exec(`
			pragma journal_mode = wal;
			create table events (name text);
			insert into events (name) values ('first');
		`);
		setupDb.close();

		const reader = new NativeSqliteDatabase(dbPath, { readonly: true });
		const writer = new NativeSqliteDatabase(dbPath);
		reader.exec("pragma query_only = on");

		try {
			const counts = reader.readTransaction(() => {
				const before = reader
					.prepare("select count(*) as count from events")
					.get() as { count: number };
				writer.prepare("insert into events (name) values ('second')").run();
				const afterWrite = reader
					.prepare("select count(*) as count from events")
					.get() as { count: number };
				return [before.count, afterWrite.count];
			})();

			expect(counts).toEqual([1, 1]);
			expect(
				reader.prepare("select count(*) as count from events").get(),
			).toEqual({ count: 2 });
			expect(() =>
				reader.readTransaction(() => {
					throw new Error("read failed");
				})(),
			).toThrow("read failed");
			expect(
				reader.prepare("select count(*) as count from events").get(),
			).toEqual({ count: 2 });
		} finally {
			reader.close();
			writer.close();
		}
	});
});
