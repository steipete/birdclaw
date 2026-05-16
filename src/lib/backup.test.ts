// @vitest-environment node
import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
	exportBackup,
	exportBackupEffect,
	getBackupDatabaseFingerprint,
	importBackup,
	importBackupEffect,
	maybeAutoSyncBackup,
	maybeAutoUpdateBackup,
	syncBackup,
	updateBackupFromGitEffect,
	validateBackup,
	validateBackupEffect,
} from "./backup";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";

const tempDirs: string[] = [];

function makeTempDir(prefix: string) {
	const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function clearData() {
	const db = getNativeDb();
	db.exec(`
    delete from follow_events;
    delete from follow_edges;
    delete from follow_snapshot_members;
    delete from follow_snapshots;
    delete from ai_scores;
    delete from tweet_actions;
    delete from tweet_account_edges;
    delete from tweet_collections;
    delete from link_occurrences;
    delete from url_expansions;
    delete from blocks;
    delete from mutes;
    delete from dm_fts;
    delete from tweets_fts;
    delete from dm_messages;
    delete from dm_conversations;
    delete from tweets;
    delete from profile_bio_entities;
    delete from profile_snapshots;
    delete from profile_affiliations;
    delete from profiles;
    delete from accounts;
    delete from sync_cache;
	`);
}

function writeBackupConfig(
	home: string,
	backup: {
		repoPath?: string;
		remote?: string;
		autoSync?: boolean;
		staleAfterSeconds?: number;
	},
) {
	writeFileSync(path.join(home, "config.json"), JSON.stringify({ backup }));
	resetBirdclawPathsForTests();
}

function seedBackupFixture() {
	const db = getNativeDb();
	clearData();
	db.exec(`
    insert into accounts (
      id, name, handle, external_user_id, transport, is_default, created_at
    ) values (
      'acct_primary', 'Peter Steinberger', '@steipete', '25401953', 'archive', 1, '2009-03-19T22:54:05.000Z'
    );

    insert into profiles (
      id, handle, display_name, bio, followers_count, following_count,
      public_metrics_json, avatar_hue, avatar_url, location, url,
      verified_type, entities_json, raw_json, created_at
    ) values
      ('profile_me', 'steipete', 'Peter Steinberger', 'Local-first builder', 1000, 75, '{"followers_count":1000,"following_count":75,"listed_count":42}', 42, 'https://img.example/me.jpg', 'Vienna', 'https://steipete.me', 'blue', '{"url":{"urls":[{"url":"https://t.co/me","expanded_url":"https://steipete.me"}]}}', '{"id":"profile_me"}', '2009-03-19T22:54:05.000Z'),
      ('profile_friend', 'friend', 'Friend', 'Sends useful DMs', 50, 25, '{"followers_count":50,"following_count":25,"listed_count":3}', 210, null, null, 'https://friend.example', null, '{}', '{}', '2025-01-01T00:00:00.000Z');

    insert into profile_affiliations (
      subject_profile_id, organization_profile_id, organization_name,
      organization_handle, badge_url, url, label, source, is_active,
      first_seen_at, last_seen_at, raw_json, updated_at
    ) values (
      'profile_friend', 'profile_org_blacksmith', 'Blacksmith', 'blacksmith',
      'https://cdn.example/badge.png', 'https://www.blacksmith.sh', 'Blacksmith',
      'fixture', 1, '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z',
      '{"label":"Blacksmith"}', '2025-01-02T00:00:00.000Z'
    );

    insert into profile_snapshots (
      profile_id, snapshot_hash, observed_at, last_seen_at, source, handle,
      display_name, bio, location, url, verified_type, followers_count,
      following_count, affiliations_json, raw_json
    ) values (
      'profile_friend', 'snapshot_blacksmith', '2025-01-01T00:00:00.000Z',
      '2025-01-02T00:00:00.000Z', 'fixture', 'friend', 'Friend',
      'Sends useful DMs', null, 'https://friend.example', null, 50, 0,
      '[{"organizationName":"Blacksmith"}]', '{}'
    );

    insert into profile_bio_entities (
      profile_id, kind, value, source, is_active, first_seen_at, last_seen_at,
      raw_json
    ) values
      ('profile_friend', 'domain', 'friend.example', 'profile_url', 1,
        '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z', '{}'),
      ('profile_friend', 'company_phrase', 'Blacksmith', 'affiliation', 1,
        '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z', '{}');

    insert into tweets (
      id, account_id, author_profile_id, kind, text, created_at, is_replied,
      reply_to_id, like_count, media_count, bookmarked, liked, entities_json,
      media_json, quoted_tweet_id
    ) values
      ('tweet_2024', 'acct_primary', 'profile_me', 'home', 'Shipping text backups', '2024-12-31T23:59:00.000Z', 0, null, 12, 0, 0, 0, '{"hashtags":[{"text":"backup"}]}', '[]', null),
      ('tweet_2025', 'acct_primary', 'profile_friend', 'bookmark', 'Saved useful thing', '2025-01-02T08:00:00.000Z', 0, null, 5, 1, 1, 1, '{}', '[{"type":"photo"}]', 'tweet_quote'),
      ('tweet_unknown_date', 'acct_primary', 'profile_friend', 'like', 'Unknown creation date like', '1970-01-01T00:00:00.000Z', 0, null, 1, 0, 0, 1, '{}', '[]', null);

    insert into tweet_collections (
      account_id, tweet_id, kind, collected_at, source, raw_json, updated_at
    ) values
      ('acct_primary', 'tweet_2025', 'bookmarks', '2025-01-02T09:00:00.000Z', 'archive', '{"bookmark":{"tweetId":"tweet_2025"}}', '2025-01-03T00:00:00.000Z'),
      ('acct_primary', 'tweet_2025', 'likes', null, 'bird', '{"id":"tweet_2025"}', '2025-01-03T00:00:00.000Z'),
      ('acct_primary', 'tweet_unknown_date', 'likes', null, 'archive', '{"like":{"tweetId":"tweet_unknown_date"}}', '2025-01-03T00:00:00.000Z');

    insert into tweet_account_edges (
      account_id, tweet_id, kind, first_seen_at, last_seen_at, seen_count, source,
      raw_json, updated_at
    ) values
      ('acct_primary', 'tweet_2024', 'home', '2024-12-31T23:59:00.000Z', '2024-12-31T23:59:00.000Z', 1, 'archive', '{}', '2025-01-03T00:00:00.000Z');

    insert into tweets_fts (tweet_id, text) values
      ('tweet_2024', 'Shipping text backups'),
      ('tweet_2025', 'Saved useful thing'),
      ('tweet_unknown_date', 'Unknown creation date like');

    insert into dm_conversations (
      id, account_id, participant_profile_id, title, last_message_at, unread_count, needs_reply
    ) values (
      'dm:friend', 'acct_primary', 'profile_friend', 'Friend', '2025-01-05T10:00:00.000Z', 0, 1
    );

    insert into dm_messages (
      id, conversation_id, sender_profile_id, text, created_at, direction, is_replied, media_count
    ) values
      ('dm_1', 'dm:friend', 'profile_friend', 'Backup this please', '2025-01-05T09:00:00.000Z', 'inbound', 0, 0),
      ('dm_2', 'dm:friend', 'profile_me', 'On it', '2025-01-05T10:00:00.000Z', 'outbound', 1, 0);

    insert into dm_fts (message_id, text) values
      ('dm_1', 'Backup this please'),
      ('dm_2', 'On it');

    insert into url_expansions (
      short_url, expanded_url, final_url, status, expanded_tweet_id,
      expanded_handle, title, description, error, source, updated_at
    ) values (
      'https://t.co/shared', 'https://x.com/friend/status/2039395915421942108',
      'https://x.com/friend/status/2039395915421942108', 'hit',
      '2039395915421942108', 'friend', 'Shared tweet', 'An expanded DM share',
      null, 'network', '2025-01-05T10:01:00.000Z'
    );

    insert into link_occurrences (
      source_kind, source_id, source_position, short_url, account_id,
      conversation_id, direction, created_at
    ) values (
      'dm', 'dm_2', 0, 'https://t.co/shared', 'acct_primary', 'dm:friend',
      'outbound', '2025-01-05T10:00:00.000Z'
    );

    insert into blocks (account_id, profile_id, source, created_at)
    values ('acct_primary', 'profile_friend', 'manual', '2025-01-06T00:00:00.000Z');

    insert into mutes (account_id, profile_id, source, created_at)
    values ('acct_primary', 'profile_friend', 'manual', '2025-01-07T00:00:00.000Z');

    insert into tweet_actions (id, account_id, tweet_id, kind, body, created_at)
    values ('action_1', 'acct_primary', 'tweet_2025', 'reply', 'Thanks', '2025-01-08T00:00:00.000Z');

    insert into ai_scores (
      entity_kind, entity_id, model, score, summary, reasoning, updated_at
    ) values (
      'tweet', 'tweet_2025', 'test-model', 88, 'useful', 'has context', '2025-01-09T00:00:00.000Z'
    );

    insert into follow_snapshots (
      id, account_id, direction, source, status, page_count, result_count,
      started_at, completed_at, raw_meta_json
    ) values (
      'follow_snapshot_1', 'acct_primary', 'followers', 'xurl', 'complete',
      1, 1, '2025-01-10T00:00:00.000Z', '2025-01-10T00:00:01.000Z',
      '{"result_count":1}'
    );

    insert into follow_snapshot_members (
      snapshot_id, profile_id, external_user_id, position
    ) values (
      'follow_snapshot_1', 'profile_friend', 'external_friend', 0
    );

    insert into follow_edges (
      account_id, direction, profile_id, external_user_id, source, current,
      first_seen_at, last_seen_at, ended_at, updated_at
    ) values (
      'acct_primary', 'followers', 'profile_friend', 'external_friend', 'xurl',
      1, '2025-01-10T00:00:01.000Z', '2025-01-10T00:00:01.000Z', null,
      '2025-01-10T00:00:01.000Z'
    );

    insert into follow_events (
      id, account_id, direction, profile_id, external_user_id, kind, event_at,
      snapshot_id
    ) values (
      'follow_event_1', 'acct_primary', 'followers', 'profile_friend',
      'external_friend', 'started', '2025-01-10T00:00:01.000Z',
      'follow_snapshot_1'
    );
  `);
}

function expectNoDemoSeedRows() {
	const db = getNativeDb({ seedDemoData: false });
	expect(
		db
			.prepare(
				"select count(*) as count from accounts where id = 'acct_studio'",
			)
			.get(),
	).toEqual({ count: 0 });
	expect(
		db
			.prepare("select count(*) as count from tweets where id like 'tweet_00%'")
			.get(),
	).toEqual({ count: 0 });
	expect(
		db
			.prepare(
				"select count(*) as count from dm_conversations where id glob 'dm_00*'",
			)
			.get(),
	).toEqual({ count: 0 });
}

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	delete process.env.BIRDCLAW_CONFIG;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("text backup", () => {
	it("builds backup Git update effects lazily", async () => {
		process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-backup-lazy-home-");
		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		const repoPath = path.join(
			makeTempDir("birdclaw-backup-lazy-parent-"),
			"repo",
		);

		const effect = updateBackupFromGitEffect({ repoPath });

		expect(existsSync(repoPath)).toBe(false);
		await expect(Effect.runPromise(effect)).resolves.toMatchObject({
			ok: true,
			repoPath,
			pulled: false,
			imported: false,
		});
		expect(existsSync(path.join(repoPath, ".git"))).toBe(true);
	}, 20000);

	it("exposes backup export, import, and validation as Effects", async () => {
		process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-backup-effect-src-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-backup-effect-store-");

		const exported = await Effect.runPromise(exportBackupEffect({ repoPath }));
		const validation = await Effect.runPromise(validateBackupEffect(repoPath));

		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-backup-effect-dst-");
		const imported = await Effect.runPromise(
			importBackupEffect({ repoPath, mode: "replace" }),
		);

		expect(exported.validation.ok).toBe(true);
		expect(validation.ok).toBe(true);
		expect(imported.ok).toBe(true);
		expect(imported.mode).toBe("replace");
	}, 20000);

	it("builds backup import effects lazily", async () => {
		process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-backup-import-src-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-backup-import-store-");

		const effect = importBackupEffect({ repoPath, mode: "replace" });

		expect(existsSync(path.join(repoPath, "manifest.json"))).toBe(false);
		await exportBackup({ repoPath });

		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-backup-import-dst-");
		const imported = await Effect.runPromise(effect);

		expect(imported.ok).toBe(true);
		expect(imported.mode).toBe("replace");
		expect(
			getNativeDb({ seedDemoData: false })
				.prepare("select count(*) as count from tweets where id = 'tweet_2025'")
				.get(),
		).toEqual({ count: 1 });
	}, 20000);

	it("exports JSONL shards and imports them without changing the portable fingerprint", async () => {
		process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-backup-src-");
		seedBackupFixture();
		const before = getBackupDatabaseFingerprint();
		const repoPath = makeTempDir("birdclaw-store-");

		const exported = await exportBackup({ repoPath });

		expect(exported.validation.ok).toBe(true);
		expect(exported.manifest.counts).toMatchObject({
			accounts: 1,
			profiles: 2,
			profile_affiliations: 1,
			profile_snapshots: 1,
			profile_bio_entities: 2,
			tweets: 3,
			timeline_edges_home: 1,
			collections_bookmarks: 1,
			collections_likes: 2,
			dm_conversations: 1,
			dm_messages: 2,
			url_expansions: 1,
			link_occurrences: 1,
			blocks: 1,
			mutes: 1,
			tweet_actions: 1,
			ai_scores: 1,
			follow_snapshots: 1,
			follow_snapshot_members: 1,
			follow_edges: 1,
			follow_events: 1,
		});
		expect(existsSync(path.join(repoPath, "data/tweets/2024.jsonl"))).toBe(
			true,
		);
		expect(existsSync(path.join(repoPath, "data/tweets/2025.jsonl"))).toBe(
			true,
		);
		expect(existsSync(path.join(repoPath, "data/tweets/unknown.jsonl"))).toBe(
			true,
		);
		expect(existsSync(path.join(repoPath, "data/dms/2025.jsonl"))).toBe(true);
		expect(
			existsSync(path.join(repoPath, "data/links/url_expansions.jsonl")),
		).toBe(true);
		expect(
			existsSync(path.join(repoPath, "data/links/occurrences.jsonl")),
		).toBe(true);
		expect(
			readFileSync(path.join(repoPath, "data/tweets/2025.jsonl"), "utf8"),
		).toContain('"bookmarked":1');
		expect(
			readFileSync(
				path.join(repoPath, "data/links/url_expansions.jsonl"),
				"utf8",
			),
		).toContain('"expanded_tweet_id":"2039395915421942108"');
		expect(
			readFileSync(path.join(repoPath, "data/profiles.jsonl"), "utf8"),
		).toContain('"public_metrics_json"');
		expect(existsSync(path.join(repoPath, "data/follow_snapshots.jsonl"))).toBe(
			true,
		);
		expect(existsSync(path.join(repoPath, "data/follow_edges.jsonl"))).toBe(
			true,
		);

		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-backup-dst-");
		const staleDb = getNativeDb();
		staleDb.exec(`
      insert into url_expansions (
        short_url, expanded_url, final_url, status, source, updated_at
      ) values (
        'https://t.co/stale', 'https://x.com/stale/status/1', 'https://x.com/stale/status/1', 'hit', 'network', '2026-04-01T00:00:00.000Z'
      );
      insert into link_occurrences (
        source_kind, source_id, source_position, short_url, created_at
      ) values (
        'dm', 'deleted-message', 0, 'https://t.co/stale', '2026-04-01T00:00:00.000Z'
      );
    `);
		const imported = await importBackup({ repoPath, mode: "replace" });
		const after = getBackupDatabaseFingerprint();

		expect(imported.mode).toBe("replace");
		expect(imported.validation?.ok).toBe(true);
		expect(after).toEqual(before);
		expect(imported.fingerprint).toEqual(before);
		expect(
			staleDb
				.prepare(
					"select short_url, expanded_tweet_id from url_expansions order by short_url",
				)
				.all(),
		).toEqual([
			{
				short_url: "https://t.co/shared",
				expanded_tweet_id: "2039395915421942108",
			},
		]);
		expect(
			staleDb
				.prepare(
					"select source_kind, source_id, short_url from link_occurrences order by source_kind, source_id",
				)
				.all(),
		).toEqual([
			{
				source_kind: "dm",
				source_id: "dm_2",
				short_url: "https://t.co/shared",
			},
		]);
		expect(
			getNativeDb({ seedDemoData: false })
				.prepare(
					"select public_metrics_json from profiles where id = 'profile_friend'",
				)
				.get(),
		).toEqual({
			public_metrics_json:
				'{"followers_count":50,"following_count":25,"listed_count":3}',
		});
		expect(
			getNativeDb({ seedDemoData: false })
				.prepare(
					"select count(*) as count from follow_events where id = 'follow_event_1'",
				)
				.get(),
		).toEqual({ count: 1 });

		const validation = await validateBackup(repoPath);
		expect(validation.ok).toBe(true);
	}, 20000);

	it("merges backup rows without deleting local-only tweets", async () => {
		process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-backup-src-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-store-");
		await exportBackup({ repoPath });

		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-backup-merge-");
		const db = getNativeDb();
		clearData();
		db.exec(`
      insert into accounts (
        id, name, handle, external_user_id, transport, is_default, created_at
      ) values (
        'acct_primary', 'Peter Steinberger', '@steipete', '25401953', 'archive', 1, '2009-03-19T22:54:05.000Z'
      );
      insert into profiles (
        id, handle, display_name, bio, followers_count, avatar_hue, avatar_url, created_at
      ) values (
        'profile_me', 'steipete', 'Peter Steinberger', '', 0, 42, null, '2009-03-19T22:54:05.000Z'
      );
      insert into tweets (
        id, account_id, author_profile_id, kind, text, created_at, is_replied,
        reply_to_id, like_count, media_count, bookmarked, liked, entities_json,
        media_json, quoted_tweet_id
      ) values (
        'local_only', 'acct_primary', 'profile_me', 'home', 'Local-only tweet', '2026-01-01T00:00:00.000Z', 0,
        null, 0, 0, 0, 0, '{}', '[]', null
      );
    `);

		await importBackup({ repoPath });

		expect(
			db
				.prepare("select count(*) from tweets where id = 'local_only'")
				.get() as { "count(*)": number },
		).toEqual({ "count(*)": 1 });
		expect(
			db
				.prepare("select count(*) from tweets where id = 'tweet_2025'")
				.get() as { "count(*)": number },
		).toEqual({ "count(*)": 1 });
	}, 20000);

	it("syncs through git by pulling, merging, exporting, committing, and pushing", async () => {
		const remotePath = path.join(makeTempDir("birdclaw-remote-"), "remote.git");
		execFileSync("git", ["init", "--bare", remotePath]);

		process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-sync-src-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-sync-work-");

		const first = await syncBackup({
			repoPath,
			remote: remotePath,
			message: "archive: initial backup",
		});

		expect(first.imported).toBe(false);
		expect(first.exportResult.git?.committed).toBe(true);
		expect(first.exportResult.git?.pushed).toBe(true);

		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-sync-dst-");
		const secondRepoPath = makeTempDir("birdclaw-sync-other-");
		const second = await syncBackup({
			repoPath: secondRepoPath,
			remote: remotePath,
			message: "archive: roundtrip backup",
		});

		expect(second.imported).toBe(true);
		expect(second.importResult?.validation?.ok).toBe(true);
		expect(second.exportResult.git?.committed).toBe(false);
		expect(second.exportResult.manifest.counts).toMatchObject({
			accounts: 1,
			profiles: 2,
			profile_affiliations: 1,
			profile_snapshots: 1,
			profile_bio_entities: 2,
			tweets: 3,
			timeline_edges_home: 1,
			collections_bookmarks: 1,
			collections_likes: 2,
			dm_conversations: 1,
			dm_messages: 2,
			url_expansions: 1,
			link_occurrences: 1,
			blocks: 1,
			mutes: 1,
			tweet_actions: 1,
			ai_scores: 1,
			follow_snapshots: 1,
			follow_snapshot_members: 1,
			follow_edges: 1,
			follow_events: 1,
		});
		expectNoDemoSeedRows();
		expect(
			getNativeDb({ seedDemoData: false })
				.prepare(
					"select count(*) as count from tweets where id in ('tweet_2024', 'tweet_2025', 'tweet_unknown_date')",
				)
				.get(),
		).toEqual({ count: 3 });
		expect(
			execFileSync(
				"git",
				["--git-dir", remotePath, "rev-list", "--count", "refs/heads/main"],
				{ encoding: "utf8" },
			).trim(),
		).toBe("1");
	}, 20000);

	it("does not inherit commit signing for generated backup commits", async () => {
		process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-sync-signing-src-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-sync-signing-work-");
		execFileSync("git", ["init", repoPath]);
		execFileSync("git", ["-C", repoPath, "config", "commit.gpgsign", "true"]);
		execFileSync("git", ["-C", repoPath, "config", "gpg.program", "false"]);

		const result = await exportBackup({
			repoPath,
			commit: true,
			message: "archive: unsigned backup",
		});

		expect(result.git?.committed).toBe(true);
		expect(
			execFileSync("git", ["-C", repoPath, "rev-parse", "--verify", "HEAD"], {
				encoding: "utf8",
			}).trim(),
		).toBe(result.git?.commit);
	}, 20000);

	it("reports validation errors for missing or corrupt backup files", async () => {
		const missingManifest = await validateBackup(
			makeTempDir("birdclaw-empty-"),
		);

		expect(missingManifest.ok).toBe(false);
		expect(missingManifest.errors[0]).toContain("manifest.json");

		process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-corrupt-src-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-corrupt-store-");
		await exportBackup({ repoPath });

		const manifestPath = path.join(repoPath, "manifest.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			backupHash: string;
			counts: { tweets: number };
		};
		manifest.backupHash = "bad-hash";
		manifest.counts.tweets = -1;
		writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
		appendFileSync(path.join(repoPath, "data/tweets/2024.jsonl"), "{broken\n");
		rmSync(path.join(repoPath, "data/profiles.jsonl"));

		const validation = await validateBackup(repoPath);

		expect(validation.ok).toBe(false);
		expect(validation.errors.join("\n")).toContain("data/profiles.jsonl");
		expect(validation.errors.join("\n")).toContain("data/tweets/2024.jsonl:2");
		expect(validation.errors.join("\n")).toContain("backup hash");
		expect(validation.errors.join("\n")).toContain("manifest counts");
	}, 20000);

	it("auto-updates from the configured backup repo only when stale", async () => {
		const previousAutoSyncEnv = process.env.BIRDCLAW_BACKUP_AUTO_SYNC;
		process.env.BIRDCLAW_BACKUP_AUTO_SYNC = "1";
		const remotePath = path.join(makeTempDir("birdclaw-remote-"), "remote.git");
		execFileSync("git", ["init", "--bare", remotePath]);

		try {
			process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-auto-src-");
			seedBackupFixture();
			await syncBackup({
				repoPath: makeTempDir("birdclaw-auto-push-"),
				remote: remotePath,
				message: "archive: auto sync seed",
			});

			resetDatabaseForTests();
			resetBirdclawPathsForTests();
			process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-auto-dst-");
			const repoPath = makeTempDir("birdclaw-auto-work-");
			writeFileSync(
				path.join(process.env.BIRDCLAW_HOME, "config.json"),
				JSON.stringify({
					backup: {
						repoPath,
						remote: remotePath,
						autoSync: true,
						staleAfterSeconds: 900,
					},
				}),
			);

			const first = await maybeAutoUpdateBackup();

			expect(first).toMatchObject({
				ok: true,
				enabled: true,
				skipped: false,
				imported: true,
			});
			expect(
				getNativeDb()
					.prepare(
						"select count(*) as count from tweets where id = 'tweet_2025'",
					)
					.get(),
			).toEqual({ count: 1 });

			const second = await maybeAutoUpdateBackup();

			expect(second).toMatchObject({
				ok: true,
				enabled: true,
				skipped: true,
				reason: "backup auto-sync is fresh",
			});
		} finally {
			if (previousAutoSyncEnv === undefined) {
				delete process.env.BIRDCLAW_BACKUP_AUTO_SYNC;
			} else {
				process.env.BIRDCLAW_BACKUP_AUTO_SYNC = previousAutoSyncEnv;
			}
		}
	}, 20000);

	it("skips automatic backup work when disabled or unconfigured", async () => {
		const previousAutoSyncEnv = process.env.BIRDCLAW_BACKUP_AUTO_SYNC;
		try {
			process.env.BIRDCLAW_BACKUP_AUTO_SYNC = "0";
			await expect(maybeAutoUpdateBackup()).resolves.toMatchObject({
				ok: true,
				enabled: false,
				skipped: true,
			});
			await expect(maybeAutoSyncBackup()).resolves.toMatchObject({
				ok: true,
				enabled: false,
				skipped: true,
			});

			process.env.BIRDCLAW_BACKUP_AUTO_SYNC = "1";
			process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-auto-unconfigured-");
			resetDatabaseForTests();
			resetBirdclawPathsForTests();

			await expect(maybeAutoUpdateBackup()).resolves.toMatchObject({
				ok: true,
				enabled: false,
				skipped: true,
				reason: "backup auto-sync is not configured",
			});
			await expect(maybeAutoSyncBackup()).resolves.toMatchObject({
				ok: true,
				enabled: false,
				skipped: true,
				reason: "backup auto-sync is not configured",
			});
		} finally {
			if (previousAutoSyncEnv === undefined) {
				delete process.env.BIRDCLAW_BACKUP_AUTO_SYNC;
			} else {
				process.env.BIRDCLAW_BACKUP_AUTO_SYNC = previousAutoSyncEnv;
			}
		}
	});

	it("handles backup auto-sync config variants and failures", async () => {
		const previousAutoSyncEnv = process.env.BIRDCLAW_BACKUP_AUTO_SYNC;
		process.env.BIRDCLAW_BACKUP_AUTO_SYNC = "1";
		try {
			process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-auto-off-");
			writeBackupConfig(process.env.BIRDCLAW_HOME, {
				repoPath: makeTempDir("birdclaw-auto-off-repo-"),
				autoSync: false,
			});

			await expect(maybeAutoUpdateBackup()).resolves.toMatchObject({
				ok: true,
				enabled: false,
				skipped: true,
			});

			resetDatabaseForTests();
			process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-auto-empty-config-");
			writeBackupConfig(process.env.BIRDCLAW_HOME, {});

			await expect(maybeAutoSyncBackup()).resolves.toMatchObject({
				ok: true,
				enabled: false,
				skipped: true,
			});

			resetDatabaseForTests();
			process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-auto-bad-config-");
			writeFileSync(
				path.join(process.env.BIRDCLAW_HOME, "config.json"),
				"{bad",
			);
			resetBirdclawPathsForTests();

			await expect(maybeAutoUpdateBackup()).resolves.toMatchObject({
				ok: false,
				enabled: true,
				skipped: false,
			});
			await expect(maybeAutoSyncBackup()).resolves.toMatchObject({
				ok: false,
				enabled: true,
				skipped: false,
			});

			resetDatabaseForTests();
			process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-auto-repo-only-");
			const repoOnlyPath = makeTempDir("birdclaw-auto-repo-only-work-");
			writeBackupConfig(process.env.BIRDCLAW_HOME, {
				repoPath: repoOnlyPath,
				staleAfterSeconds: -1,
			});

			const repoOnly = await maybeAutoUpdateBackup();

			expect(repoOnly).toMatchObject({
				ok: true,
				enabled: true,
				skipped: false,
				imported: false,
			});
			expect(repoOnly.remote).toBeUndefined();

			const db = getNativeDb();
			db.prepare(
				"update sync_cache set value_json = ? where cache_key = 'backup:auto-sync'",
			).run("{broken");
			const invalidState = await maybeAutoUpdateBackup();
			expect(invalidState).toMatchObject({
				ok: true,
				enabled: true,
				skipped: false,
			});

			db.prepare(
				"update sync_cache set value_json = ? where cache_key = 'backup:auto-sync'",
			).run(
				JSON.stringify({
					checkedAt: new Date(Date.now() + 60_000).toISOString(),
					ok: true,
				}),
			);
			const futureState = await maybeAutoUpdateBackup();
			expect(futureState).toMatchObject({
				ok: true,
				enabled: true,
				skipped: false,
			});

			resetDatabaseForTests();
			process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-auto-fail-update-");
			const fileRepoPath = path.join(process.env.BIRDCLAW_HOME, "not-a-dir");
			writeFileSync(fileRepoPath, "");
			writeBackupConfig(process.env.BIRDCLAW_HOME, { repoPath: fileRepoPath });

			await expect(maybeAutoUpdateBackup()).resolves.toMatchObject({
				ok: false,
				enabled: true,
				skipped: false,
				repoPath: fileRepoPath,
			});
			await expect(maybeAutoSyncBackup()).resolves.toMatchObject({
				ok: false,
				enabled: true,
				skipped: false,
				repoPath: fileRepoPath,
			});
		} finally {
			if (previousAutoSyncEnv === undefined) {
				delete process.env.BIRDCLAW_BACKUP_AUTO_SYNC;
			} else {
				process.env.BIRDCLAW_BACKUP_AUTO_SYNC = previousAutoSyncEnv;
			}
		}
	});

	it("auto-syncs local changes back to the configured backup repo", async () => {
		const previousAutoSyncEnv = process.env.BIRDCLAW_BACKUP_AUTO_SYNC;
		process.env.BIRDCLAW_BACKUP_AUTO_SYNC = "1";
		const remotePath = path.join(makeTempDir("birdclaw-remote-"), "remote.git");
		execFileSync("git", ["init", "--bare", remotePath]);

		try {
			process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-auto-write-");
			seedBackupFixture();
			const repoPath = makeTempDir("birdclaw-auto-write-work-");
			writeFileSync(
				path.join(process.env.BIRDCLAW_HOME, "config.json"),
				JSON.stringify({
					backup: {
						repoPath,
						remote: remotePath,
						autoSync: true,
						staleAfterSeconds: 900,
					},
				}),
			);
			resetBirdclawPathsForTests();

			const result = await maybeAutoSyncBackup();

			expect(result).toMatchObject({
				ok: true,
				enabled: true,
				skipped: false,
				imported: false,
			});
			expect(existsSync(path.join(repoPath, "manifest.json"))).toBe(true);
			expect(
				execFileSync(
					"git",
					["--git-dir", remotePath, "rev-list", "--count", "refs/heads/main"],
					{
						encoding: "utf8",
					},
				).trim(),
			).toBe("1");
		} finally {
			if (previousAutoSyncEnv === undefined) {
				delete process.env.BIRDCLAW_BACKUP_AUTO_SYNC;
			} else {
				process.env.BIRDCLAW_BACKUP_AUTO_SYNC = previousAutoSyncEnv;
			}
		}
	}, 20000);
});
