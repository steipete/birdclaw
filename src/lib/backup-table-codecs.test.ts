import { describe, expect, it } from "vitest";
import {
	BACKUP_TABLE_CODECS,
	adaptLegacyTweetState,
	assertBackupTableCodecRegistry,
	backupCodecForPath,
	buildBackupShardsFromRowSets,
	countBackupFiles,
	logicalBackupShardPath,
	type BackupTableCodec,
} from "./backup-table-codecs";

describe("backup table codecs", () => {
	it("owns every portable table and path exactly once", () => {
		expect(assertBackupTableCodecRegistry()).toBe(true);
		expect(BACKUP_TABLE_CODECS).toHaveLength(23);
		expect(BACKUP_TABLE_CODECS.map((codec) => codec.name)).toEqual([
			"accounts",
			"profiles",
			"profile_affiliations",
			"profile_snapshots",
			"profile_bio_entities",
			"x_lists",
			"x_list_members",
			"tweets",
			"tweet_sources",
			"tweet_collections",
			"tweet_account_edges",
			"dm_conversations",
			"dm_messages",
			"url_expansions",
			"link_occurrences",
			"blocks",
			"mutes",
			"tweet_actions",
			"ai_scores",
			"follow_snapshots",
			"follow_snapshot_members",
			"follow_edges",
			"follow_events",
		]);
		expect(
			BACKUP_TABLE_CODECS.map((codec) => codec.merge.order).sort(
				(left, right) => left - right,
			),
		).toEqual(Array.from({ length: 23 }, (_, index) => index));

		const sample = { created_at: "2026-01-02T00:00:00.000Z", kind: "likes" };
		for (const codec of BACKUP_TABLE_CODECS) {
			const relativePath = codec.shardPath(sample);
			expect(backupCodecForPath(relativePath)).toBe(codec);
			expect(codec.countKey(relativePath)).not.toBe("");
		}
	});

	it("routes and counts a synthetic descriptor without central switches", () => {
		const synthetic: BackupTableCodec = {
			name: "synthetic",
			exportSql: "select id from synthetic order by id",
			shardPath: (row) => `data/synthetic/${String(row.bucket)}.jsonl`,
			matchesPath: (relativePath) => relativePath.startsWith("data/synthetic/"),
			countKey: () => "synthetic",
			merge: {
				order: 0,
				sql: "insert into synthetic (id) values (?)",
				columns: ["id"],
			},
		};
		const shards = buildBackupShardsFromRowSets(
			[
				{
					logicalName: "synthetic",
					rows: [
						{ id: "one", bucket: "a" },
						{ id: "two", bucket: "a" },
					],
				},
			],
			[synthetic],
		);

		expect(shards.get("data/synthetic/a.jsonl")).toHaveLength(2);
		expect(
			countBackupFiles(
				[{ path: "data/synthetic/a.jsonl", rows: 2 }],
				[synthetic],
			),
		).toEqual({ synthetic: 2 });
		expect(backupCodecForPath("data/synthetic/a.jsonl", [synthetic])).toBe(
			synthetic,
		);
	});

	it("routes deterministic part files through their logical shard codec", () => {
		expect(logicalBackupShardPath("data/profiles.part-0001.jsonl")).toBe(
			"data/profiles.jsonl",
		);
		expect(backupCodecForPath("data/profiles.part-0001.jsonl").name).toBe(
			"profiles",
		);
		expect(backupCodecForPath("data/tweets/2026.part-0012.jsonl").name).toBe(
			"tweets",
		);
		expect(
			countBackupFiles([
				{ path: "data/profiles.part-0001.jsonl", rows: 2 },
				{ path: "data/profiles.part-0002.jsonl", rows: 3 },
			]),
		).toEqual({ profiles: 5 });
	});

	it("adapts schema-v1 tweet state at the registry boundary", () => {
		const observedAt = "2026-01-02T03:04:05.000Z";
		const existingCollection = {
			account_id: "account",
			tweet_id: "tweet",
			kind: "likes",
		};
		const adapted = adaptLegacyTweetState(
			1,
			[
				{
					id: "tweet",
					account_id: "account",
					kind: "home",
					liked: 1,
					bookmarked: 1,
					created_at: observedAt,
				},
			],
			[existingCollection],
			[],
		);

		expect(adapted.collections).toEqual([
			existingCollection,
			{
				account_id: "account",
				tweet_id: "tweet",
				kind: "bookmarks",
				collected_at: null,
				source: "legacy",
				raw_json: "{}",
				updated_at: observedAt,
			},
		]);
		expect(adapted.timelineEdges).toEqual([
			{
				account_id: "account",
				tweet_id: "tweet",
				kind: "home",
				first_seen_at: observedAt,
				last_seen_at: observedAt,
				seen_count: 1,
				source: "legacy",
				raw_json: "{}",
				updated_at: observedAt,
			},
		]);
	});
});
