// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
	getDatabaseSchemaVersion,
	runDatabaseMigrations,
} from "./database-migrations";
import NativeSqliteDatabase from "./sqlite";
import { DATABASE_MIGRATIONS } from "./database-schema";

describe("database migrations", () => {
	it("upgrades v11 indexes without changing tweet order or current graph membership", () => {
		const db = new NativeSqliteDatabase(":memory:");
		try {
			runDatabaseMigrations(db, DATABASE_MIGRATIONS.slice(0, 11));
			db.exec(`
				insert into tweets(id,author_profile_id,text,created_at) values
					('z','p','last','2026-01-01'),('a','p','first','2026-01-01'),
					('b','p','middle','2026-01-01');
				insert into follow_edges(account_id,direction,profile_id,external_user_id,source,current,first_seen_at,last_seen_at,updated_at) values
					('a','followers','p','1','fixture',1,'','',''),
					('a','following','p','1','fixture',1,'','',''),
					('a','followers','ended','2','fixture',0,'','',''),
					('other','followers','unrelated','3','fixture',1,'','','');
			`);
			const tweets =
				"select id from tweets order by created_at desc, id desc limit 2";
			const membership = `select profile_id, count(*) directions from follow_edges
				where account_id=? and current=1 group by profile_id`;
			const beforeTweets = db.prepare(tweets).all();
			const beforeGraph = db.prepare(membership).all("a");
			expect(runDatabaseMigrations(db, DATABASE_MIGRATIONS.slice(0, 12))).toBe(
				12,
			);
			expect(runDatabaseMigrations(db, DATABASE_MIGRATIONS.slice(0, 12))).toBe(
				12,
			);
			expect(db.prepare(tweets).all()).toEqual(beforeTweets);
			expect(beforeTweets).toEqual([{ id: "z" }, { id: "b" }]);
			expect(db.prepare(membership).all("a")).toEqual(beforeGraph);
			expect(beforeGraph).toEqual([{ profile_id: "p", directions: 2 }]);
			for (const [sql, params, index] of [
				[tweets, [], "idx_tweets_created"],
				[membership, ["a"], "idx_follow_edges_current_profile"],
			] as const) {
				const plan = JSON.stringify(
					db.prepare(`explain query plan ${sql}`).all(...params),
				);
				expect(plan).toContain(`USING COVERING INDEX ${index}`);
				expect(plan).not.toContain("TEMP B-TREE");
			}
			db.exec(
				"update follow_edges set current=0 where account_id='a' and direction='following'",
			);
			expect(db.prepare(membership).all("a")).toEqual([
				{ profile_id: "p", directions: 1 },
			]);
		} finally {
			db.close();
		}
	});

	it("runs each version once and records the latest version", () => {
		const db = new NativeSqliteDatabase(":memory:");
		const first = vi.fn((database: NativeSqliteDatabase) => {
			database.exec("create table events (name text)");
		});
		const second = vi.fn((database: NativeSqliteDatabase) => {
			database.exec("alter table events add column detail text");
		});
		const migrations = [
			{ version: 1, name: "events", up: first },
			{ version: 2, name: "event details", up: second },
		];

		expect(runDatabaseMigrations(db, migrations)).toBe(2);
		expect(runDatabaseMigrations(db, migrations)).toBe(2);
		expect(getDatabaseSchemaVersion(db)).toBe(2);
		expect(first).toHaveBeenCalledOnce();
		expect(second).toHaveBeenCalledOnce();
		db.close();
	});

	it("rejects gaps instead of silently skipping schema history", () => {
		const db = new NativeSqliteDatabase(":memory:");

		expect(() =>
			runDatabaseMigrations(db, [
				{ version: 2, name: "gap", up: () => undefined },
			]),
		).toThrow("Missing database migration");
		expect(getDatabaseSchemaVersion(db)).toBe(0);
		db.close();
	});

	it("rolls back the schema and version when a migration fails", () => {
		const db = new NativeSqliteDatabase(":memory:");

		expect(() =>
			runDatabaseMigrations(db, [
				{
					version: 1,
					name: "broken migration",
					up: (database) => {
						database.exec("create table partial_change (value text)");
						throw new Error("migration failed");
					},
				},
			]),
		).toThrow("migration failed");
		expect(getDatabaseSchemaVersion(db)).toBe(0);
		expect(
			db
				.prepare(
					"select name from sqlite_master where type = 'table' and name = 'partial_change'",
				)
				.get(),
		).toBeUndefined();
		db.close();
	});
});
