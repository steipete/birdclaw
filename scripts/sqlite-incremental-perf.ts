import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getNativeDb, resetDatabaseForTests } from "../src/lib/db";
import { getDatabasePerformanceTotals } from "../src/lib/database-metrics";
import { syncDirectMessagesViaCachedBird } from "../src/lib/dms-live";
import { getLinkInsights } from "../src/lib/link-insights";
import { writeSyncCache } from "../src/lib/sync-cache";
import { ingestTweetPayload } from "../src/lib/tweet-repository";

const root = mkdtempSync(path.join(os.tmpdir(), "birdclaw-incremental-perf-"));
const home = path.join(root, "home");
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
	if (fixture.status !== 0)
		throw new Error(fixture.stderr || "Fixture creation failed");
	process.env.BIRDCLAW_HOME = home;
	process.env.BIRDCLAW_DEPLOYMENT_READ_ONLY = "0";
	const db = getNativeDb({ seedDemoData: false });

	async function measure(
		name: string,
		operation: (sample: number) => unknown,
		verify?: () => unknown,
	) {
		const timings = [];
		let digest: string | undefined;
		for (let sample = 0; sample < 7; sample++) {
			if (verify) db.exec("begin immediate");
			try {
				const before = getDatabasePerformanceTotals();
				const start = performance.now();
				const result = await operation(sample);
				const ms = performance.now() - start;
				const after = getDatabasePerformanceTotals();
				timings.push({
					ms,
					dbMs: after.milliseconds - before.milliseconds,
					calls: after.calls - before.calls,
				});
				// Verification is deliberately outside the operation's timing.
				const nextDigest = hash(verify ? verify() : result);
				if (digest && digest !== nextDigest)
					throw new Error(`${name}: results changed between samples`);
				digest = nextDigest;
			} finally {
				if (verify) db.exec("rollback");
			}
		}
		const warm = timings
			.slice(2)
			.map((value) => value.ms)
			.sort((a, b) => a - b);
		results.push({ name, timings, medianLastFiveMs: warm[2], digest });
	}

	for (const size of [1, 100, 10000]) {
		for (const changed of [true, false]) {
			const events = Array.from({ length: size }, (_, i) => ({
				id: `m${i + 1}`,
				conversationId: "1-2",
				senderId: "2",
				recipientId: "1",
				text: changed
					? `Refreshed message ${i + 1}`
					: `Synthetic message ${i + 1}${(i + 1) % 5000 === 0 ? " needle" : ""}`,
				createdAt: "2026-09-13T20:00:00.000Z",
			}));
			writeSyncCache(
				`dms:bird:audit:${size}:all:max-pages:0`,
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
				`dm-${size}-${changed ? "changed" : "unchanged"}`,
				async () => {
					const result = await syncDirectMessagesViaCachedBird({
						account: "audit",
						mode: "bird",
						limit: size,
						cacheTtlMs: Number.MAX_SAFE_INTEGER,
					});
					if (result.source !== "cache")
						throw new Error("Expected synthetic cache input");
					return result;
				},
				() =>
					db
						.prepare("select message_id,text from dm_fts order by message_id")
						.all(),
			);
		}
	}

	const tweets = db
		.prepare("select id,created_at from tweets limit 100")
		.all() as { id: string; created_at: string }[];
	await measure(
		"tweet-100-changed",
		() =>
			ingestTweetPayload(db, {
				accountId: "audit",
				source: "fixture",
				edgeKind: "home",
				payload: {
					data: tweets.map((tweet) => ({
						...tweet,
						author_id: "2",
						text: `Refreshed tweet ${tweet.id}`,
					})),
				},
			}),
		() =>
			db
				.prepare("select tweet_id,text from tweets_fts order by tweet_id")
				.all(),
	);

	process.env.BIRDCLAW_DEPLOYMENT_READ_ONLY = "1";
	await measure("rolling-links", (sample) => {
		const now = new Date(Date.parse("2026-09-13T20:00:00Z") + sample);
		const result = getLinkInsights({
			account: "audit",
			range: "week",
			limit: 30,
			now,
		});
		if (result.until !== now.toISOString())
			throw new Error("Stale rolling boundary");
		const { since: _since, until: _until, ...body } = result;
		return body;
	});
	console.log(
		JSON.stringify(
			{
				runtime: { bun: process.versions.bun, sqlite: process.versions.sqlite },
				samples: 7,
				warmupSamples: 2,
				verification:
					"Full search-index hashes for writes; rolling Links excludes its changing timestamps from the hash and asserts the upper bound on every sample. Writes roll back; commit/fsync cost is excluded.",
				results,
			},
			null,
			2,
		),
	);
} finally {
	resetDatabaseForTests();
	rmSync(root, { recursive: true, force: true });
}
