import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import NativeSqliteDatabase from "../src/lib/sqlite";
import { DATABASE_MIGRATIONS } from "../src/lib/database-schema";
import { runDatabaseMigrations } from "../src/lib/database-migrations";

const root = mkdtempSync(path.join(os.tmpdir(), "birdclaw-map-write-perf-"));
const databases = new Map<string, NativeSqliteDatabase>();
const sizes: Record<string, number> = {};
const results: unknown[] = [];

try {
	for (const [name, version] of [
		["before", 13],
		["after", 14],
	] as const) {
		const db = new NativeSqliteDatabase(path.join(root, `${name}.sqlite`));
		databases.set(name, db);
		db.exec("pragma journal_mode=wal; pragma foreign_keys=on");
		runDatabaseMigrations(db, DATABASE_MIGRATIONS.slice(0, version));
		db.transaction(() =>
			db.exec(`
			with recursive seq(n) as (select 1 union all select n+1 from seq where n<10000)
			insert into profiles(id,handle,display_name,bio,followers_count,location,created_at)
			select 'p'||n,'person'||n,'Synthetic Person '||n,'',n,'City '||(n%100),'' from seq;
			insert into follow_edges(account_id,direction,profile_id,external_user_id,source,current,first_seen_at,last_seen_at,updated_at)
			select 'audit','followers',id,id,'fixture',1,'','','' from profiles;
		`),
		)();
		sizes[name] =
			Number(db.pragma("page_count", { simple: true })) *
			Number(db.pragma("page_size", { simple: true }));
	}
	const scenarios = [
		[
			"profile-heartbeat-100",
			"update profiles set raw_json='{\"fresh\":true}', followers_count=followers_count, location=location where rowid<=100",
		],
		[
			"profile-display-100",
			"update profiles set avatar_url='https://example.com/new.png', following_count=42 where rowid<=100",
		],
		[
			"profile-geometry-100",
			"update profiles set followers_count=followers_count+1 where rowid<=100",
		],
		[
			"profile-geometry-10000",
			"update profiles set followers_count=followers_count+1",
		],
		[
			"follow-heartbeat-10000",
			"update follow_edges set last_seen_at='2026-09-14'",
		],
		["follow-ended-10000", "update follow_edges set current=0"],
		[
			"insert-profiles-1000",
			"with recursive seq(n) as (select 1 union all select n+1 from seq where n<1000) insert into profiles(id,handle,display_name,bio,created_at) select 'new'||n,'newperson'||n,'New Person '||n,'','' from seq",
		],
		[
			"insert-following-1000",
			"insert into follow_edges(account_id,direction,profile_id,external_user_id,source,current,first_seen_at,last_seen_at,updated_at) select 'audit','following',id,id,'fixture',1,'','','' from profiles where rowid<=1000",
		],
	];
	for (const [scenario, sql] of scenarios) {
		const samples = new Map<string, number[]>();
		const digests = new Set<string>();
		for (let i = 0; i < 10; i++) {
			const order = [...databases];
			if (i % 2) order.reverse();
			for (const [name, db] of order) {
				db.exec("begin immediate");
				try {
					const start = performance.now();
					db.exec(sql);
					const ms = performance.now() - start;
					const values = samples.get(name) ?? [];
					values.push(ms);
					samples.set(name, values);
					const canonical = {
						profiles: db.prepare("select * from profiles order by id").all(),
						edges: db
							.prepare(
								"select * from follow_edges order by account_id,direction,profile_id",
							)
							.all(),
					};
					digests.add(
						createHash("sha256")
							.update(JSON.stringify(canonical))
							.digest("hex"),
					);
				} finally {
					db.exec("rollback");
				}
			}
		}
		if (digests.size !== 1)
			throw new Error(`${scenario}: canonical rows differ`);
		results.push({
			scenario,
			digest: [...digests][0],
			variants: Object.fromEntries(
				[...samples].map(([name, values]) => {
					const warm = values.slice(2).sort((a, b) => a - b);
					return [
						name,
						{
							firstMs: values[0],
							medianMs: (warm[3] + warm[4]) / 2,
							samplesMs: values,
						},
					];
				}),
			),
		});
	}
	console.log(
		JSON.stringify(
			{
				runtime: { bun: process.versions.bun, sqlite: process.versions.sqlite },
				method:
					"Schema 13 versus 14 on identical synthetic 10,000-profile/edge databases. Alternating execution order, ten samples, median excludes first two. Writes roll back; commit/fsync and canonical verification are excluded. All canonical row digests match.",
				databaseBytes: sizes,
				results,
			},
			null,
			2,
		),
	);
} finally {
	for (const db of databases.values()) db.close();
	rmSync(root, { recursive: true, force: true });
}
