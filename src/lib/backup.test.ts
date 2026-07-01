// @vitest-environment node
import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	insertTestAccount,
	insertTestProfile,
	insertTestTweet,
	useTestHome,
} from "../test/test-home";
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
import { getNativeDb } from "./db";

const testHome = useTestHome({ prefix: "birdclaw-backup-home-" });

function makeTempDir(prefix: string) {
	return testHome().makeTempDir(prefix);
}

function switchHome(prefix: string) {
	return testHome().switchHome(prefix).root;
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
      id, author_profile_id, text, created_at, is_replied,
      reply_to_id, like_count, media_count, entities_json,
      media_json, quoted_tweet_id
    ) values
      ('tweet_2024', 'profile_me', 'Shipping text backups https://t.co/shared', '2024-12-31T23:59:00.000Z', 0, null, 12, 0, '{"hashtags":[{"text":"backup"}],"urls":[{"url":"https://t.co/shared","expandedUrl":"https://example.com/demo","displayUrl":"example.com/demo","start":22,"end":41}]}', '[]', null),
      ('tweet_2025', 'profile_friend', 'Saved useful thing', '2025-01-02T08:00:00.000Z', 0, null, 5, 1, '{}', '[{"type":"photo"}]', 'tweet_quote'),
      ('tweet_unknown_date', 'profile_friend', 'Unknown creation date like', '1970-01-01T00:00:00.000Z', 0, null, 1, 0, '{}', '[]', null);

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
      ('acct_primary', 'tweet_2024', 'home', '2024-12-31T23:59:00.000Z', '2024-12-31T23:59:00.000Z', 1, 'archive', '{}', '2025-01-03T00:00:00.000Z'),
      ('acct_primary', 'tweet_2025', 'search', '2025-01-02T09:00:00.000Z', '2025-01-02T09:00:00.000Z', 1, 'bird', '{"query":"useful"}', '2025-01-03T00:00:00.000Z');

    insert into tweets_fts (tweet_id, text) values
      ('tweet_2024', 'Shipping text backups'),
      ('tweet_2025', 'Saved useful thing'),
      ('tweet_unknown_date', 'Unknown creation date like');

    insert into dm_conversations (
      id, account_id, participant_profile_id, title, inbox_kind, last_message_at, unread_count, needs_reply
    ) values (
      'dm:friend', 'acct_primary', 'profile_friend', 'Friend', 'request', '2025-01-05T10:00:00.000Z', 0, 1
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

describe("text backup", () => {
	it("builds backup Git update effects lazily", async () => {
		switchHome("birdclaw-backup-lazy-home-");
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
		switchHome("birdclaw-backup-effect-src-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-backup-effect-store-");

		const exported = await Effect.runPromise(exportBackupEffect({ repoPath }));
		const validation = await Effect.runPromise(validateBackupEffect(repoPath));

		switchHome("birdclaw-backup-effect-dst-");
		const imported = await Effect.runPromise(
			importBackupEffect({ repoPath, mode: "replace" }),
		);

		expect(exported.validation.ok).toBe(true);
		expect(validation.ok).toBe(true);
		expect(imported.ok).toBe(true);
		expect(imported.mode).toBe("replace");
	}, 20000);

	it("rejects backup export paths that traverse symlinked managed directories", async () => {
		switchHome("birdclaw-backup-symlink-src-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-backup-symlink-store-");
		const targetPath = makeTempDir("birdclaw-backup-symlink-target-");
		symlinkSync(targetPath, path.join(repoPath, "data"), "dir");

		await expect(
			Effect.runPromise(exportBackupEffect({ repoPath })),
		).rejects.toThrow("Backup path contains symlink");
		expect(existsSync(path.join(targetPath, "tweets"))).toBe(false);
	}, 20000);

	it("rejects backup validation paths that traverse symlinked directories", async () => {
		const repoPath = makeTempDir("birdclaw-backup-read-symlink-store-");
		const targetPath = makeTempDir("birdclaw-backup-read-symlink-target-");
		mkdirSync(path.join(targetPath, "tweets"), { recursive: true });
		writeFileSync(path.join(targetPath, "tweets", "2026.jsonl"), "{}\n");
		symlinkSync(targetPath, path.join(repoPath, "data"), "dir");
		writeFileSync(
			path.join(repoPath, "manifest.json"),
			JSON.stringify({
				app: "birdclaw",
				schemaVersion: 1,
				generatedAt: "2026-05-17T00:00:00.000Z",
				counts: {},
				files: [
					{
						path: "data/tweets/2026.jsonl",
						rows: 1,
						sha256: "bad",
						bytes: 3,
					},
				],
				backupHash: "bad",
			}) + "\n",
		);

		const validation = await Effect.runPromise(validateBackupEffect(repoPath));

		expect(validation.ok).toBe(false);
		expect(validation.errors.join("\n")).toContain(
			"Backup path contains symlink",
		);
	});

	it("builds backup import effects lazily", async () => {
		switchHome("birdclaw-backup-import-src-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-backup-import-store-");

		const effect = importBackupEffect({ repoPath, mode: "replace" });

		expect(existsSync(path.join(repoPath, "manifest.json"))).toBe(false);
		await exportBackup({ repoPath });

		switchHome("birdclaw-backup-import-dst-");
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
		switchHome("birdclaw-backup-src-");
		seedBackupFixture();
		const collectionRawJson = JSON.stringify({
			id: "tweet_2025",
			text: "line\u2028separator\u2029done",
		});
		getNativeDb()
			.prepare(
				`
        update tweet_collections
        set raw_json = ?
        where account_id = 'acct_primary'
          and tweet_id = 'tweet_2025'
          and kind = 'likes'
        `,
			)
			.run(collectionRawJson);
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
			timeline_edges_search: 1,
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
			readFileSync(
				path.join(repoPath, "data/collections/bookmarks.jsonl"),
				"utf8",
			),
		).toContain('"kind":"bookmarks"');
		const likesJsonl = readFileSync(
			path.join(repoPath, "data/collections/likes.jsonl"),
			"utf8",
		);
		expect(likesJsonl).not.toContain("\u2028");
		expect(likesJsonl).not.toContain("\u2029");
		expect(likesJsonl).toContain("\\u2028");
		expect(likesJsonl).toContain("\\u2029");
		expect(
			readFileSync(
				path.join(repoPath, "data/timeline_edges/search.jsonl"),
				"utf8",
			),
		).toContain('"kind":"search"');
		expect(
			readFileSync(
				path.join(repoPath, "data/links/url_expansions.jsonl"),
				"utf8",
			),
		).toContain('"expanded_tweet_id":"2039395915421942108"');
		expect(
			readFileSync(path.join(repoPath, "data/profiles.jsonl"), "utf8"),
		).toContain('"public_metrics_json"');
		expect(
			readFileSync(path.join(repoPath, "data/dms/conversations.jsonl"), "utf8"),
		).toContain('"inbox_kind":"request"');
		expect(existsSync(path.join(repoPath, "data/follow_snapshots.jsonl"))).toBe(
			true,
		);
		expect(existsSync(path.join(repoPath, "data/follow_edges.jsonl"))).toBe(
			true,
		);

		switchHome("birdclaw-backup-dst-");
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
					"select inbox_kind from dm_conversations where id = 'dm:friend'",
				)
				.get(),
		).toEqual({ inbox_kind: "request" });
		expect(
			getNativeDb({ seedDemoData: false })
				.prepare("select entities_json from tweets where id = 'tweet_2024'")
				.get(),
		).toEqual({
			entities_json:
				'{"hashtags":[{"text":"backup"}],"urls":[{"url":"https://t.co/shared","expandedUrl":"https://example.com/demo","displayUrl":"example.com/demo","start":22,"end":41}]}',
		});
		expect(
			getNativeDb({ seedDemoData: false })
				.prepare(
					`
          select raw_json
          from tweet_collections
          where account_id = 'acct_primary'
            and tweet_id = 'tweet_2025'
            and kind = 'likes'
          `,
				)
				.get(),
		).toEqual({ raw_json: collectionRawJson });
		expect(
			getNativeDb({ seedDemoData: false })
				.prepare(
					"select kind, source from tweet_account_edges where tweet_id = 'tweet_2025' and kind = 'search'",
				)
				.get(),
		).toEqual({ kind: "search", source: "bird" });
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

	it("emits byte-identical schema-v2 data and hashes for the same database", async () => {
		switchHome("birdclaw-backup-stable-src-");
		seedBackupFixture();
		const firstRepoPath = makeTempDir("birdclaw-backup-stable-first-");
		const secondRepoPath = makeTempDir("birdclaw-backup-stable-second-");

		const first = await exportBackup({ repoPath: firstRepoPath });
		const second = await exportBackup({ repoPath: secondRepoPath });

		expect(first.manifest.schemaVersion).toBe(2);
		expect(first.manifest.backupHash).toBe(
			"bec137fa89f0f39cef137e8e74dfc59a7a892972189019c7d5e841f9c4c17895",
		);
		expect(second.manifest.files).toEqual(first.manifest.files);
		expect(second.manifest.counts).toEqual(first.manifest.counts);
		expect(second.manifest.backupHash).toBe(first.manifest.backupHash);
		for (const file of first.manifest.files) {
			expect(readFileSync(path.join(secondRepoPath, file.path))).toEqual(
				readFileSync(path.join(firstRepoPath, file.path)),
			);
		}
	}, 20000);

	it("does not downgrade a fresh DM request when merging a stale backup", async () => {
		switchHome("birdclaw-backup-dm-merge-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-backup-dm-merge-repo-");
		await exportBackup({ repoPath });

		const conversationsPath = path.join(
			repoPath,
			"data/dms/conversations.jsonl",
		);
		writeFileSync(
			conversationsPath,
			readFileSync(conversationsPath, "utf8").replace(
				'"inbox_kind":"request"',
				'"inbox_kind":"accepted"',
			),
		);

		await importBackup({ repoPath, validate: false });

		expect(
			getNativeDb({ seedDemoData: false })
				.prepare(
					"select inbox_kind from dm_conversations where id = 'dm:friend'",
				)
				.get(),
		).toEqual({ inbox_kind: "request" });
	});

	it("merges backup rows without deleting local-only tweets", async () => {
		switchHome("birdclaw-backup-src-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-store-");
		await exportBackup({ repoPath });

		switchHome("birdclaw-backup-merge-");
		const db = getNativeDb();
		clearData();
		insertTestAccount(db, {
			id: "acct_primary",
			name: "Peter Steinberger",
			handle: "@steipete",
			externalUserId: "25401953",
			createdAt: "2009-03-19T22:54:05.000Z",
		});
		insertTestProfile(db, {
			id: "profile_me",
			handle: "steipete",
			displayName: "Peter Steinberger",
			bio: "",
			followersCount: 0,
			followingCount: 0,
			publicMetricsJson: "{}",
			createdAt: "2009-03-19T22:54:05.000Z",
		});
		insertTestTweet(db, {
			id: "local_only",
			authorProfileId: "profile_me",
			text: "Local-only tweet",
		});

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

		switchHome("birdclaw-sync-src-");
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

		switchHome("birdclaw-sync-dst-");
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
		expect(
			execFileSync(
				"git",
				[
					"-C",
					secondRepoPath,
					"show-ref",
					"--verify",
					"refs/remotes/origin/main",
				],
				{ encoding: "utf8" },
			).trim(),
		).toContain("refs/remotes/origin/main");
	}, 20000);

	it("isolates backup commits from an enclosing Git worktree", async () => {
		const parentPath = makeTempDir("birdclaw-parent-worktree-");
		execFileSync("git", ["-C", parentPath, "init"]);
		const repoPath = path.join(parentPath, "backup");
		mkdirSync(repoPath);
		writeFileSync(
			path.join(repoPath, ".gitattributes"),
			"*.md text eol=lf\ndata/**/*.jsonl text eol=crlf\n",
		);
		switchHome("birdclaw-nested-backup-");
		seedBackupFixture();

		const result = await exportBackup({ repoPath, commit: true });

		expect(result.git?.committed).toBe(true);
		expect(
			execFileSync("git", ["-C", repoPath, "rev-parse", "--show-toplevel"], {
				encoding: "utf8",
			}).trim(),
		).toBe(realpathSync(repoPath));
		expect(
			execFileSync(
				"git",
				["-C", parentPath, "diff", "--cached", "--name-only"],
				{
					encoding: "utf8",
				},
			),
		).toBe("");
		expect(readFileSync(path.join(repoPath, ".gitattributes"), "utf8")).toBe(
			[
				"*.md text eol=lf",
				"data/**/*.jsonl text eol=crlf",
				"",
				"# BEGIN birdclaw backup attributes",
				"# Backup hashes use the raw LF-delimited bytes written by Birdclaw.",
				"data/**/*.jsonl text eol=lf",
				"manifest.json text eol=lf",
				"# END birdclaw backup attributes",
				"",
			].join("\n"),
		);
		expect(
			execFileSync("git", ["-C", repoPath, "ls-files", ".gitattributes"], {
				encoding: "utf8",
			}).trim(),
		).toBe(".gitattributes");
		expect(
			execFileSync(
				"git",
				[
					"-C",
					repoPath,
					"check-attr",
					"eol",
					"--",
					"data/tweets/2026.jsonl",
					"manifest.json",
				],
				{ encoding: "utf8" },
			),
		).toBe("data/tweets/2026.jsonl: eol: lf\nmanifest.json: eol: lf\n");
	}, 20000);

	it("does not inherit commit signing for generated backup commits", async () => {
		switchHome("birdclaw-sync-signing-src-");
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

		switchHome("birdclaw-corrupt-src-");
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

	it("reports unowned data paths as validation errors", async () => {
		switchHome("birdclaw-unowned-src-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-unowned-store-");
		await exportBackup({ repoPath });

		const manifestPath = path.join(repoPath, "manifest.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			files: Array<{
				path: string;
				rows: number;
				sha256: string;
				bytes: number;
			}>;
		};
		const relativePath = "data/unowned.jsonl";
		const content = "{}\n";
		writeFileSync(path.join(repoPath, relativePath), content);
		manifest.files.push({
			path: relativePath,
			rows: 1,
			sha256: "unimportant",
			bytes: Buffer.byteLength(content),
		});
		writeFileSync(manifestPath, JSON.stringify(manifest));

		const validation = await validateBackup(repoPath);

		expect(validation.ok).toBe(false);
		expect(validation.errors).toContain(
			"No backup codec owns path: data/unowned.jsonl",
		);
	}, 20000);

	it("auto-updates from the configured backup repo only when stale", async () => {
		const previousAutoSyncEnv = process.env.BIRDCLAW_BACKUP_AUTO_SYNC;
		process.env.BIRDCLAW_BACKUP_AUTO_SYNC = "1";
		const remotePath = path.join(makeTempDir("birdclaw-remote-"), "remote.git");
		execFileSync("git", ["init", "--bare", remotePath]);

		try {
			switchHome("birdclaw-auto-src-");
			seedBackupFixture();
			await syncBackup({
				repoPath: makeTempDir("birdclaw-auto-push-"),
				remote: remotePath,
				message: "archive: auto sync seed",
			});

			switchHome("birdclaw-auto-dst-");
			const repoPath = makeTempDir("birdclaw-auto-work-");
			writeFileSync(
				path.join(testHome().root, "config.json"),
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
			switchHome("birdclaw-auto-unconfigured-");

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
			switchHome("birdclaw-auto-off-");
			writeBackupConfig(testHome().root, {
				repoPath: makeTempDir("birdclaw-auto-off-repo-"),
				autoSync: false,
			});

			await expect(maybeAutoUpdateBackup()).resolves.toMatchObject({
				ok: true,
				enabled: false,
				skipped: true,
			});

			switchHome("birdclaw-auto-empty-config-");
			writeBackupConfig(testHome().root, {});

			await expect(maybeAutoSyncBackup()).resolves.toMatchObject({
				ok: true,
				enabled: false,
				skipped: true,
			});

			switchHome("birdclaw-auto-bad-config-");
			writeFileSync(path.join(testHome().root, "config.json"), "{bad");
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

			switchHome("birdclaw-auto-repo-only-");
			const repoOnlyPath = makeTempDir("birdclaw-auto-repo-only-work-");
			writeBackupConfig(testHome().root, {
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

			switchHome("birdclaw-auto-fail-update-");
			const fileRepoPath = path.join(testHome().root, "not-a-dir");
			writeFileSync(fileRepoPath, "");
			writeBackupConfig(testHome().root, { repoPath: fileRepoPath });

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
			switchHome("birdclaw-auto-write-");
			seedBackupFixture();
			const repoPath = makeTempDir("birdclaw-auto-write-work-");
			writeFileSync(
				path.join(testHome().root, "config.json"),
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
