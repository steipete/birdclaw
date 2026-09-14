// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import NativeSqliteDatabase from "./sqlite";
import { DATABASE_MIGRATIONS } from "./database-schema";
import { runDatabaseMigrations } from "./database-migrations";
import { readNetworkMapRevision } from "./network-map-revision";

const databases: NativeSqliteDatabase[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function fixture(version = 14) {
	const db = new NativeSqliteDatabase(":memory:");
	databases.push(db);
	runDatabaseMigrations(db, DATABASE_MIGRATIONS.slice(0, version));
	db.exec(`
		insert into profiles(id,handle,display_name,bio,created_at) values('p','person','Person','',''), ('q','other','Other','','');
		insert into follow_edges(account_id,direction,profile_id,external_user_id,source,current,first_seen_at,last_seen_at,updated_at)
		values('a','followers','p','p','fixture',1,'','','');
		insert into geocoded_locations(normalized_key,original,lat,lng,provider,created_at,last_used_at) values('vienna','Vienna',48,16,'opencage','','');
		insert into geocoded_locations_unresolved(normalized_key,original,reason,last_attempted_at,ttl_until) values('missing','Missing','fixture','',null);
	`);
	return db;
}

function revision(db: NativeSqliteDatabase) {
	const { geometry, details } = readNetworkMapRevision(db);
	return { geometry, details };
}

describe("network map revisions", () => {
	it("upgrades v13 without changing canonical content and preserves counters on repeated initialization", () => {
		const db = fixture(13);
		const data = db.prepare("select * from profiles order by id").all();
		expect(runDatabaseMigrations(db, DATABASE_MIGRATIONS)).toBe(14);
		expect(revision(db)).toEqual({ geometry: 0, details: 0 });
		expect(db.prepare("select * from profiles order by id").all()).toEqual(
			data,
		);
		db.exec("update profiles set location='Vienna' where id='p'");
		runDatabaseMigrations(db, DATABASE_MIGRATIONS);
		expect(revision(db)).toEqual({ geometry: 1, details: 0 });
	});

	it.each([
		["profiles", "id='new'", "geometry"],
		["profiles", "handle='renamed'", "geometry"],
		["profiles", "display_name='Renamed'", "geometry"],
		["profiles", "followers_count=99", "geometry"],
		["profiles", "location='Tokyo'", "geometry"],
		["profiles", "avatar_url='https://example.com/a.png'", "details"],
		["profiles", "following_count=99", "details"],
		["profiles", "verified_type='blue'", "details"],
		["follow_edges", "account_id='b'", "geometry"],
		["follow_edges", "profile_id='q'", "geometry"],
		["follow_edges", "direction='following'", "geometry"],
		["follow_edges", "current=0", "geometry"],
		["geocoded_locations", "normalized_key='other'", "geometry"],
		["geocoded_locations", "lat=49", "geometry"],
		["geocoded_locations", "lng=17", "geometry"],
		["geocoded_locations", "formatted='Vienna, Austria'", "geometry"],
		["geocoded_locations", "approx_radius_m=100", "geometry"],
		["geocoded_locations_unresolved", "normalized_key='other'", "geometry"],
		["geocoded_locations_unresolved", "ttl_until='2099-01-01'", "geometry"],
	] as const)(
		"tracks changed %s %s as %s, ignoring an identical update",
		(table, assignment, kind) => {
			const db = fixture();
			const before = revision(db);
			const where = table === "profiles" ? " where handle='person'" : "";
			db.exec(`update ${table} set ${assignment}${where}`);
			const after = revision(db);
			expect(after[kind]).toBe(before[kind] + 1);
			expect(after[kind === "geometry" ? "details" : "geometry"]).toBe(
				before[kind === "geometry" ? "details" : "geometry"],
			);
			db.exec(`update ${table} set ${assignment}${where}`);
			expect(revision(db)).toEqual(after);
		},
	);

	it("tracks inserts, deletes and SQLite REPLACE even with recursive triggers disabled", () => {
		const db = fixture();
		db.pragma("recursive_triggers=off");
		let before = revision(db).geometry;
		db.exec(
			"insert or replace into profiles(id,handle,display_name,bio,created_at) values('q','person','Replaced','','')",
		);
		expect(revision(db).geometry).toBeGreaterThan(before);
		before = revision(db).geometry;
		db.exec(
			"insert or replace into follow_edges(account_id,direction,profile_id,external_user_id,source,current,first_seen_at,last_seen_at,updated_at) values('a','followers','p','p','fixture',0,'','','')",
		);
		expect(revision(db).geometry).toBeGreaterThan(before);
		for (const table of [
			"profiles",
			"follow_edges",
			"geocoded_locations",
			"geocoded_locations_unresolved",
		]) {
			before = revision(db).geometry;
			db.exec(`delete from ${table}`);
			expect(revision(db).geometry).toBeGreaterThan(before);
		}
	});

	it("rolls back revisions with canonical changes and ignores unrelated fields", () => {
		const db = fixture();
		const before = revision(db);
		expect(() =>
			db.transaction(() => {
				db.exec(
					"update profiles set location='New location', avatar_url='new'",
				);
				throw new Error("abort");
			})(),
		).toThrow("abort");
		expect(revision(db)).toEqual(before);
		db.exec(`
			update profiles set bio='New bio', raw_json='{"new":1}';
			update follow_edges set last_seen_at='later', source='new';
			update geocoded_locations set hits=hits+1, last_used_at='later', original='Other spelling';
			update geocoded_locations_unresolved set last_attempted_at='later', reason='different';
			insert into tweets(id,author_profile_id,text,created_at) values('t','p','Unrelated','');
		`);
		expect(revision(db)).toEqual(before);
	});
});
