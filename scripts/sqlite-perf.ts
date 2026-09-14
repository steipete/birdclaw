import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDatabasePerformanceTotals } from "../src/lib/database-metrics";
import { getNativeDb, resetDatabaseForTests } from "../src/lib/db";
import { listDmConversations } from "../src/lib/dm-read-model";
import { syncDirectMessagesViaCachedBird } from "../src/lib/dms-live";
import { getLinkInsights } from "../src/lib/link-insights";
import { getNetworkMap } from "../src/lib/network-map";
import { writeSyncCache } from "../src/lib/sync-cache";
import { listTimelineItems } from "../src/lib/timeline-read-model";

// Own the fixture so write benchmarks can never target a user's archive.
const root = mkdtempSync(path.join(os.tmpdir(), "birdclaw-sqlite-perf-"));
const home = path.join(root, "home");
const samples = 6;
const results: unknown[] = [];
const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");

try {
	const fixture = spawnSync(
		process.execPath,
		[
			"--no-env-file",
			fileURLToPath(new URL("./page-perf-fixture.ts", import.meta.url)),
			home,
		],
		{ encoding: "utf8" },
	);
	if (fixture.status !== 0) {
		throw new Error(fixture.stderr || "Synthetic fixture creation failed");
	}
	process.env.BIRDCLAW_HOME = home;
	process.env.BIRDCLAW_DEPLOYMENT_READ_ONLY = "0";
	const db = getNativeDb({ seedDemoData: false });

	async function measure(
		name: string,
		operation: () => unknown,
		rollback = false,
	) {
		const timings = [];
		let digest = "";
		for (let index = 0; index < samples; index++) {
			if (rollback) db.exec("begin immediate");
			try {
				const before = getDatabasePerformanceTotals();
				const start = performance.now();
				const result = await operation();
				const ms = performance.now() - start;
				const after = getDatabasePerformanceTotals();
				timings.push({
					ms,
					dbMs: after.milliseconds - before.milliseconds,
					calls: after.calls - before.calls,
				});
				const nextDigest = hash(result);
				if (digest && nextDigest !== digest) {
					throw new Error(`${name} returned inconsistent results`);
				}
				digest = nextDigest;
			} finally {
				if (rollback) db.exec("rollback");
			}
		}
		const warm = timings.slice(1).map((sample) => sample.ms);
		warm.sort((a, b) => a - b);
		results.push({ name, timings, medianMs: warm[2], digest });
	}

	await measure("home", () =>
		listTimelineItems({ resource: "home", account: "audit", limit: 50 }),
	);
	await measure("tweet-search", () =>
		listTimelineItems({
			resource: "home",
			account: "audit",
			search: "needle",
			limit: 50,
		}),
	);
	await measure("dm-followers", () =>
		listDmConversations({ account: "audit", sort: "followers", limit: 20 }),
	);
	await measure("links-week", () =>
		getLinkInsights({
			account: "audit",
			range: "week",
			limit: 30,
			now: new Date("2026-09-13T20:00:00Z"),
		}),
	);
	process.env.BIRDCLAW_DEPLOYMENT_READ_ONLY = "1";
	await measure("uncached-map", () =>
		getNetworkMap({ account: "audit", type: "followers", limit: null }, db),
	);
	process.env.BIRDCLAW_DEPLOYMENT_READ_ONLY = "0";

	const batchSize = 10_000;
	const events = Array.from({ length: batchSize }, (_, index) => ({
		id: `m${index + 1}`,
		conversationId: "1-2",
		senderId: "2",
		recipientId: "1",
		text: `Synthetic refreshed message ${index}`,
		createdAt: "2026-09-13T20:00:00.000Z",
	}));
	writeSyncCache(
		`dms:bird:audit:${batchSize}:all:max-pages:0`,
		{
			conversations: [
				{
					id: "1-2",
					participants: [
						{ id: "1", username: "audit" },
						{ id: "2", username: "syntheticpeer" },
					],
				},
			],
			events,
		},
		db,
	);
	await measure(
		"dm-sync-10000",
		async () => {
			const result = await syncDirectMessagesViaCachedBird({
				account: "audit",
				mode: "bird",
				limit: batchSize,
				cacheTtlMs: Number.MAX_SAFE_INTEGER,
			});
			if (result.source !== "cache") throw new Error("Expected cached DMs");
			return db
				.prepare("select message_id, text from dm_fts order by message_id")
				.all();
		},
		true,
	);
	await measure(
		"follow-insert-10000",
		() =>
			db
				.prepare(`
        insert into follow_edges(account_id,direction,profile_id,external_user_id,source,current,first_seen_at,last_seen_at,updated_at)
        select account_id,'following',profile_id,external_user_id,source,current,first_seen_at,last_seen_at,updated_at
        from follow_edges where direction='followers' limit 10000
      `)
				.run(),
		true,
	);
	await measure(
		"tweet-insert-10000",
		() =>
			db
				.prepare(`
        insert into tweets(id,author_profile_id,text,created_at)
        select 'new-'||id,author_profile_id,text,created_at from tweets limit 10000
      `)
				.run(),
		true,
	);

	const timelineSql =
		"select id from tweets order by created_at desc, id desc limit 5000";
	db.exec("begin immediate");
	try {
		db.exec("update tweets set created_at='2026-09-13T20:00:00.000Z'");
		await measure("timeline-timestamp-ties", () =>
			db.prepare(timelineSql).all(),
		);
	} finally {
		db.exec("rollback");
	}
	const membershipSql = `
    select profile_id,
      max(case when direction='followers' then 1 else 0 end) in_followers,
      max(case when direction='following' then 1 else 0 end) in_following
    from follow_edges where account_id=? and current=1 group by profile_id
  `;
	console.log(
		JSON.stringify(
			{
				runtime: process.versions,
				fixture: JSON.parse(fixture.stdout),
				results,
				plans: {
					timeline: db.prepare(`explain query plan ${timelineSql}`).all(),
					membership: db
						.prepare(`explain query plan ${membershipSql}`)
						.all("audit"),
				},
				indexBytes: db
					.prepare(`
          select name, sum(pgsize) bytes from dbstat
          where name in ('idx_tweets_created','idx_follow_edges_current_profile')
          group by name
        `)
					.all(),
			},
			null,
			2,
		),
	);
} finally {
	resetDatabaseForTests();
	rmSync(root, { recursive: true, force: true });
}
