// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import {
	fetchProfileSnapshots,
	profileSnapshotHash,
	recordProfileSnapshot,
	rekeyProfileSnapshots,
} from "./profile-history";

let homeDir = "";

describe("profile history", () => {
	beforeEach(() => {
		homeDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-profile-history-"));
		process.env.BIRDCLAW_HOME = homeDir;
		resetBirdclawPathsForTests();
		resetDatabaseForTests();
	});

	afterEach(() => {
		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		delete process.env.BIRDCLAW_HOME;
		rmSync(homeDir, { recursive: true, force: true });
	});

	it("records deduplicated snapshots with affiliations", () => {
		const db = getNativeDb();
		db.prepare(
			`
      insert into profiles (
        id, handle, display_name, bio, followers_count, following_count,
        avatar_hue, location, url, verified_type, raw_json, created_at
      ) values (
        'profile_user_42', 'aditya', 'Aditya', 'Building @useblacksmith',
        100, 7, 10, 'San Francisco', 'https://blacksmith.sh', 'business',
        '{"id":"42"}', '2026-05-01T00:00:00.000Z'
      )
      `,
		).run();
		db.prepare(
			`
      insert into profile_affiliations (
        subject_profile_id, organization_profile_id, organization_name,
        organization_handle, badge_url, url, label, source, is_active,
        first_seen_at, last_seen_at, raw_json, updated_at
      ) values (
        'profile_user_42', 'profile_user_999', 'Blacksmith', 'useblacksmith',
        null, 'https://x.com/useblacksmith', 'Blacksmith', 'bird', 1,
        '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '{}',
        '2026-05-01T00:00:00.000Z'
      )
      `,
		).run();

		const firstHash = recordProfileSnapshot(db, "profile_user_42", "bird");
		const secondHash = recordProfileSnapshot(db, "profile_user_42", "cache");

		expect(firstHash).toEqual(secondHash);
		expect(
			db.prepare("select count(*) as count from profile_snapshots").get(),
		).toEqual({ count: 1 });
		expect(fetchProfileSnapshots(db, ["profile_user_42"])).toEqual(
			new Map([
				[
					"profile_user_42",
					[
						expect.objectContaining({
							source: "cache",
							handle: "aditya",
							location: "San Francisco",
							url: "https://blacksmith.sh",
							verifiedType: "business",
							followersCount: 100,
							followingCount: 7,
							affiliations: [
								expect.objectContaining({
									organizationProfileId: "profile_user_999",
									organizationHandle: "useblacksmith",
								}),
							],
						}),
					],
				],
			]),
		);
	});

	it("handles missing profiles, empty fetches, bad affiliation json, and limits", () => {
		const db = getNativeDb();
		expect(recordProfileSnapshot(db, "missing")).toBeNull();
		expect(fetchProfileSnapshots(db, [])).toEqual(new Map());

		db.prepare(
			`
      insert into profile_snapshots (
        profile_id, snapshot_hash, observed_at, last_seen_at, source, handle,
        display_name, bio, location, url, verified_type, followers_count,
        following_count, affiliations_json, raw_json
      ) values
        ('profile_user_42', 'hash1', '2026-05-01T00:00:00.000Z', '2026-05-03T00:00:00.000Z', 'test', 'old', 'Old', 'Old bio', '', '', '', 1, 2, '{bad json', '{}'),
        ('profile_user_42', 'hash2', '2026-05-02T00:00:00.000Z', '2026-05-02T00:00:00.000Z', 'test', 'older', 'Older', 'Older bio', null, null, null, 3, 4, '{"not":"array"}', '{}'),
        ('profile_user_42', 'hash3', '2026-05-03T00:00:00.000Z', '2026-05-01T00:00:00.000Z', 'test', 'oldest', 'Oldest', 'Oldest bio', null, null, null, 5, 6, '', '{}')
      `,
		).run();

		expect(fetchProfileSnapshots(db, ["profile_user_42"], 1)).toEqual(
			new Map([
				[
					"profile_user_42",
					[
						expect.objectContaining({
							snapshotHash: "hash1",
							location: null,
							url: null,
							verifiedType: null,
							affiliations: [],
						}),
					],
				],
			]),
		);
	});

	it("recomputes and deduplicates hashes when snapshot affiliation ids are rekeyed", () => {
		const db = getNativeDb();
		const payload = {
			handle: "history",
			displayName: "History",
			bio: "bio",
			location: null,
			url: null,
			verifiedType: null,
			followersCount: 1,
			followingCount: 2,
			affiliations: [{ organizationProfileId: "profile_user_77" }],
		};
		const canonicalHash = profileSnapshotHash(payload);
		db.prepare(
			`insert into profile_snapshots (
			 profile_id, snapshot_hash, observed_at, last_seen_at, source, handle,
			 display_name, bio, followers_count, following_count, affiliations_json, raw_json
			) values
			 ('profile_legacy_77', 'stale-hash', ?, ?, 'legacy', 'history', 'History',
			  'bio', 1, 2, '[{"organizationProfileId":"profile_legacy_77"}]', '{"legacy":true}'),
			 ('profile_user_77', ?, ?, ?, 'canonical', 'history', 'History',
			  'bio', 1, 2, '[{"organizationProfileId":"profile_user_77"}]', '{"canonical":true}')`,
		).run(
			"2025-01-01T00:00:00.000Z",
			"2025-02-01T00:00:00.000Z",
			canonicalHash,
			"2025-01-15T00:00:00.000Z",
			"2026-02-01T00:00:00.000Z",
		);

		rekeyProfileSnapshots(db, "profile_legacy_77", "profile_user_77");

		expect(
			db
				.prepare(
					"select profile_id, snapshot_hash, observed_at, last_seen_at, source, raw_json from profile_snapshots",
				)
				.all(),
		).toEqual([
			{
				profile_id: "profile_user_77",
				snapshot_hash: canonicalHash,
				observed_at: "2025-01-01T00:00:00.000Z",
				last_seen_at: "2026-02-01T00:00:00.000Z",
				source: "canonical",
				raw_json: '{"canonical":true}',
			},
		]);
	});
});
