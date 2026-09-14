// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { runDatabaseMigrations } from "./database-migrations";
import { DATABASE_MIGRATIONS } from "./database-schema";
import { deleteSearchRows, refreshSearchRows } from "./search-index";
import Database from "./sqlite";

let db: Database;
afterEach(() => db?.close());

function setup() {
	db = new Database(":memory:");
	runDatabaseMigrations(db, DATABASE_MIGRATIONS.slice(0, 12));
	db.exec(`
		insert into tweets(id,author_profile_id,text,created_at,deleted_at,superseded_at) values
			('shared','p','canonical tweet','',null,null),
			('untouched','p','sentinel','',null,null),
			('deleted','p','tombstone','', '2026-01-01',null),
			('superseded','p','obsolete','',null,'2026-01-01');
		insert into dm_messages(id,conversation_id,sender_profile_id,text,created_at,direction)
		values ('shared','c','p','canonical message','','inbound');
		insert into tweets_fts values ('shared','old'),('shared','duplicate'),('orphan','orphan'),('deleted','tombstone'),('superseded','obsolete');
		insert into dm_fts values ('shared','old message'),('shared','duplicate');
	`);
	runDatabaseMigrations(db, DATABASE_MIGRATIONS);
}

describe("indexed search document maintenance", () => {
	it("replaces dense batches across chunk boundaries without duplicating or losing unrelated documents", () => {
		setup();
		db.exec(`
			with recursive seq(n) as (select 0 union all select n+1 from seq where n<4999)
			insert into dm_messages(id,conversation_id,sender_profile_id,text,created_at,direction)
			select 'dense-'||n,'c','p','densebefore '||n,'','inbound' from seq;
		`);
		const ids = Array.from({ length: 5000 }, (_, index) => `dense-${index}`);
		db.transaction(() => refreshSearchRows(db, "dm", ids))();
		const replace = () => {
			db.exec(
				"update dm_messages set text='denseafter' where id like 'dense-%'; delete from dm_messages where id='dense-4999'",
			);
			refreshSearchRows(db, "dm", [...ids, ids[0]!]);
		};
		expect(() =>
			db.transaction(() => {
				replace();
				throw new Error("rollback dense batch");
			})(),
		).toThrow("rollback dense batch");
		expect(
			db
				.prepare(
					"select count(*) n from dm_fts where dm_fts match 'densebefore'",
				)
				.get(),
		).toEqual({ n: 5000 });
		db.transaction(replace)();
		expect(
			db
				.prepare(
					"select count(*) n from dm_fts where dm_fts match 'denseafter'",
				)
				.get(),
		).toEqual({ n: 4999 });
		expect(
			db
				.prepare(
					"select count(*) n from dm_fts where dm_fts match 'densebefore'",
				)
				.get(),
		).toEqual({ n: 0 });
		expect(
			db.prepare("select text from dm_fts where message_id='shared'").get(),
		).toEqual({ text: "canonical message" });
		expect(
			db
				.prepare(
					"select id from search_rows where kind='dm' and source_id='dense-4999'",
				)
				.all(),
		).toEqual([]);
	});

	it("rebuilds legacy duplicates and orphan entries from canonical active content", () => {
		setup();
		expect(
			db
				.prepare("select tweet_id,text from tweets_fts order by tweet_id")
				.all(),
		).toEqual([
			{ tweet_id: "shared", text: "canonical tweet" },
			{ tweet_id: "untouched", text: "sentinel" },
		]);
		expect(db.prepare("select message_id,text from dm_fts").all()).toEqual([
			{ message_id: "shared", text: "canonical message" },
		]);
		expect(
			db
				.prepare("select count(*) n from search_rows where source_id='shared'")
				.get(),
		).toEqual({ n: 2 });
	});

	it("skips unchanged content and updates only touched documents through indexed rowids", () => {
		setup();
		const total = () =>
			(db.prepare("select total_changes() n").get() as { n: number }).n;
		const before = total();
		db.transaction(() =>
			refreshSearchRows(db, "tweet", ["shared", "shared"]),
		)();
		expect(total()).toBe(before);
		db.transaction(() => {
			db.prepare("update tweets set text=? where id=?").run(
				"fresh unique",
				"shared",
			);
			refreshSearchRows(db, "tweet", ["shared"]);
		})();
		expect(
			db
				.prepare(
					"select tweet_id from tweets_fts where tweets_fts match 'fresh'",
				)
				.all(),
		).toEqual([{ tweet_id: "shared" }]);
		expect(
			db
				.prepare(
					"select tweet_id from tweets_fts where tweets_fts match 'canonical'",
				)
				.all(),
		).toEqual([]);
		expect(
			db
				.prepare("select text from tweets_fts where tweet_id='untouched'")
				.get(),
		).toEqual({ text: "sentinel" });
		expect(db.prepare("select text from dm_fts").get()).toEqual({
			text: "canonical message",
		});
		const plan = db
			.prepare(`explain query plan delete from tweets_fts where rowid in
			(select id from search_rows where kind=? and source_id in (select value from json_each(?)))`)
			.all("tweet", '["shared"]');
		expect(JSON.stringify(plan)).toContain("VIRTUAL TABLE INDEX 0:=");
	});

	it("keeps search identities across VACUUM and canonical rowid changes", () => {
		setup();
		const before = db.prepare("select * from search_rows order by id").all();
		db.exec("update tweets set rowid=700 where id='shared'; vacuum");
		db.transaction(() => refreshSearchRows(db, "tweet", ["shared"]))();
		expect(db.prepare("select * from search_rows order by id").all()).toEqual(
			before,
		);
		expect(
			db
				.prepare(
					"select tweet_id from tweets_fts where tweets_fts match 'canonical'",
				)
				.all(),
		).toEqual([{ tweet_id: "shared" }]);
	});

	it("removes deleted content and previews, preserving unrelated rows and rollback", () => {
		setup();
		const before = db
			.prepare("select * from tweets_fts order by tweet_id")
			.all();
		expect(() =>
			db.transaction(() => {
				db.exec("update tweets set deleted_at='2026-09-13' where id='shared'");
				refreshSearchRows(db, "tweet", ["shared"]);
				expect(
					db.prepare("select * from tweets_fts where tweet_id='shared'").all(),
				).toEqual([]);
				throw new Error("rollback");
			})(),
		).toThrow("rollback");
		expect(
			db.prepare("select * from tweets_fts order by tweet_id").all(),
		).toEqual(before);
		db.transaction(() => {
			db.exec("delete from dm_messages where id='shared'");
			refreshSearchRows(db, "dm", ["shared"]);
		})();
		expect(db.prepare("select * from dm_fts").all()).toEqual([]);
		expect(
			db.prepare("select * from search_rows where kind='dm'").all(),
		).toEqual([]);
		db.transaction(() => deleteSearchRows(db, "tweet", ["shared"]))();
		expect(db.prepare("select tweet_id from tweets_fts").all()).toEqual([
			{ tweet_id: "untouched" },
		]);
		refreshSearchRows(db, "dm", []);
		deleteSearchRows(db, "dm", []);
	});
});
