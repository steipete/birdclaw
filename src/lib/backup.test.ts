// @vitest-environment node
import { execFileSync, spawn } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	insertTestAccount,
	insertTestProfile,
	insertTestTweet,
	useTestHome,
} from "../test/test-home";
import {
	__test__,
	exportBackup,
	exportBackupEffect,
	getBackupDatabaseFingerprint,
	importBackup,
	importBackupEffect,
	maybeAutoSyncBackup,
	maybeAutoUpdateBackup,
	requestBackupAutoUpdate,
	syncBackup,
	updateBackupFromGitEffect,
	validateBackup,
	validateBackupEffect,
} from "./backup";
import { BACKUP_TABLE_CODECS } from "./backup-table-codecs";
import { getBirdclawPaths, resetBirdclawPathsForTests } from "./config";
import { getNativeDb } from "./db";
import NativeSqliteDatabase, { type Database } from "./sqlite";
import { acquireScheduledJobLock } from "./scheduled-job";

const testHome = useTestHome({ prefix: "birdclaw-backup-home-" });

function makeTempDir(prefix: string) {
	return testHome().makeTempDir(prefix);
}

function switchHome(prefix: string) {
	return testHome().switchHome(prefix).root;
}

function snapshotTree(root: string) {
	const files = new Map<string, Buffer>();
	const visit = (directory: string) => {
		for (const entry of readdirSync(directory).sort()) {
			if (
				entry === ".git" ||
				entry.startsWith(".birdclaw-backup-transaction")
			) {
				continue;
			}
			const fullPath = path.join(directory, entry);
			const relativePath = path.relative(root, fullPath);
			if (statSync(fullPath).isDirectory()) visit(fullPath);
			else files.set(relativePath, readFileSync(fullPath));
		}
	};
	visit(root);
	return files;
}

async function makeRecoveryJournalFixture(repoPath: string) {
	const transactionRoot = (await __test__.transactionRootPaths(repoPath))[0]!;
	mkdirSync(transactionRoot, { recursive: true, mode: 0o700 });
	const stagePath = path.join(transactionRoot, "stage-adversarial");
	const rollbackPath = path.join(transactionRoot, "rollback-adversarial");
	mkdirSync(stagePath, { mode: 0o700 });
	mkdirSync(rollbackPath, { mode: 0o700 });
	const rawIndexPath = execFileSync(
		"git",
		["-C", repoPath, "rev-parse", "--git-path", "index"],
		{ encoding: "utf8" },
	).trim();
	const gitIndexPath = path.isAbsolute(rawIndexPath)
		? rawIndexPath
		: path.resolve(repoPath, rawIndexPath);
	const gitIndexBackupPath = path.join(rollbackPath, "git-index");
	writeFileSync(gitIndexBackupPath, readFileSync(gitIndexPath));
	const headBefore = execFileSync(
		"git",
		["-C", repoPath, "rev-parse", "HEAD"],
		{ encoding: "utf8" },
	).trim();
	const repoStat = statSync(realpathSync(repoPath), { bigint: true });
	const repoDevice = Number(repoStat.dev);
	const repoInode = Number(repoStat.ino);
	if (!Number.isSafeInteger(repoDevice) || !Number.isSafeInteger(repoInode)) {
		throw new Error("test repository identity exceeds safe integer range");
	}
	const rawCommonDir = execFileSync(
		"git",
		["-C", repoPath, "rev-parse", "--git-common-dir"],
		{ encoding: "utf8" },
	).trim();
	const gitCommonDir = realpathSync(
		path.isAbsolute(rawCommonDir)
			? rawCommonDir
			: path.resolve(repoPath, rawCommonDir),
	);
	const commonStat = statSync(gitCommonDir);
	return {
		transactionRoot,
		journalPath: path.join(transactionRoot, "journal.json"),
		journal: {
			version: 1,
			repoPath: realpathSync(repoPath),
			repoDevice,
			repoInode,
			repoBirthTimeNs: repoStat.birthtimeNs.toString(),
			stagePath,
			rollbackPath,
			state: "committed",
			liveExisted: {
				data: true,
				"README.md": true,
				".gitattributes": true,
				"manifest.json": true,
			},
			gitIndexPath,
			gitIndexBackupPath,
			gitIndexExisted: true,
			headBefore,
			gitCommonDir,
			gitCommonDevice: commonStat.dev,
			gitCommonInode: commonStat.ino,
		},
	};
}

afterEach(() => {
	__test__.setBeforeStagedValidation(undefined);
	__test__.setAfterPublicationRename(undefined);
	__test__.setBeforeDatabaseOpen(undefined);
	__test__.setBeforeCommittedCleanup(undefined);
	__test__.setAfterPublication(undefined);
	__test__.setAfterRecoveryCleanupBoundary(undefined);
});

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
		delete from tweet_sources;
		delete from fxtwitter_observations;
		delete from fxtwitter_fetches;
    delete from link_occurrences;
    delete from url_expansions;
    delete from blocks;
    delete from mutes;
    delete from dm_fts;
    delete from tweets_fts;
		delete from dm_messages;
		delete from dm_conversations;
		delete from tweet_subordinate_tombstones;
		delete from tweet_revision_edges;
		delete from tweet_revisions;
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

    insert into tweet_sources (tweet_id, source, source_url, observed_at)
    values (
      'tweet_2024', 'fxtwitter',
      'https://api.fxtwitter.com/2/status/tweet_2024',
      '2025-01-03T00:00:00.000Z'
    );

		insert into fxtwitter_fetches (
			id, endpoint_family, request_key, source_url, retrieved_at,
			collection_state, partial_reasons_json, pages_fetched, items_observed,
			terminal_cursor, next_cursor, upstream_count, failure_json
		) values (
			'fx_fetch_1', 'search', 'local-first',
			'https://api.fxtwitter.com/2/search?q=local-first',
			'2025-01-03T00:00:00.000Z', 'partial', '["caller_limit"]',
			1, 1, null, 'next-cursor', null, null
		);

		insert into fxtwitter_observations (
			endpoint_family, request_key, item_kind, item_id, source_url,
			first_seen_at, last_seen_at, seen_count, last_fetch_id
		) values (
			'search', 'local-first', 'tweet', 'tweet_2024',
			'https://api.fxtwitter.com/2/search?q=local-first',
			'2025-01-03T00:00:00.000Z', '2025-01-03T00:00:00.000Z', 1,
			'fx_fetch_1'
		);

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
    ) values
    (
      'https://t.co/shared', 'https://x.com/friend/status/2039395915421942108',
      'https://x.com/friend/status/2039395915421942108', 'hit',
      '2039395915421942108', 'friend', 'Shared tweet', 'An expanded DM share',
      null, 'network', '2025-01-05T10:01:00.000Z'
    ),
    (
      'https://T.CO/shared', 'https://X.COM/friend/status/2039395915421942108',
      'https://X.COM/friend/status/2039395915421942108', 'hit',
      '2039395915421942108', 'friend', 'Shared tweet variant', 'Preserve valid URL spelling',
      null, 'network', '2025-01-05T10:02:00.000Z'
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
		const canonicalRepoPath =
			await __test__.canonicalizeBackupRepoPath(repoPath);

		const effect = updateBackupFromGitEffect({ repoPath });

		expect(existsSync(repoPath)).toBe(false);
		await expect(Effect.runPromise(effect)).resolves.toMatchObject({
			ok: true,
			repoPath: canonicalRepoPath,
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

	it("rejects ignored, non-Git, and dangling-symlink data extras before publication", async () => {
		switchHome("birdclaw-backup-extra-home-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-backup-extra-repo-");
		await exportBackup({ repoPath });
		const privatePath = path.join(repoPath, "data", "private.json");
		writeFileSync(privatePath, "private\n");
		await expect(validateBackup(repoPath)).resolves.toMatchObject({
			ok: false,
			errors: expect.arrayContaining([
				"Unexpected backup data file: data/private.json",
			]),
		});
		await expect(exportBackup({ repoPath })).rejects.toThrow(
			"Unexpected backup data file: data/private.json",
		);
		rmSync(privatePath);

		const danglingPath = path.join(repoPath, "data", "dangling.jsonl");
		symlinkSync(path.join(repoPath, "missing-target"), danglingPath);
		await expect(validateBackup(repoPath)).resolves.toMatchObject({
			ok: false,
			errors: expect.arrayContaining([
				"Unexpected symlink in backup data: data/dangling.jsonl",
			]),
		});
		await expect(exportBackup({ repoPath })).rejects.toThrow(
			"Unexpected symlink in backup data: data/dangling.jsonl",
		);
		rmSync(danglingPath);

		await exportBackup({ repoPath, commit: true });
		writeFileSync(path.join(repoPath, ".gitignore"), "data/private.json\n");
		execFileSync("git", ["-C", repoPath, "add", ".gitignore"]);
		execFileSync("git", [
			"-C",
			repoPath,
			"commit",
			"-m",
			"test: ignore private data",
		]);
		writeFileSync(privatePath, "ignored private\n");
		await expect(exportBackup({ repoPath })).rejects.toThrow(
			"Unexpected backup data file: data/private.json",
		);
	}, 20000);

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
			tweet_sources: 1,
			fxtwitter_fetches: 1,
			fxtwitter_observations: 1,
			timeline_edges_home: 1,
			timeline_edges_search: 1,
			collections_bookmarks: 1,
			collections_likes: 2,
			dm_conversations: 1,
			dm_messages: 2,
			url_expansions: 2,
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
		expect(existsSync(path.join(repoPath, "data/tweet_sources.jsonl"))).toBe(
			true,
		);
		expect(
			existsSync(path.join(repoPath, "data/fxtwitter/fetches.jsonl")),
		).toBe(true);
		expect(
			existsSync(path.join(repoPath, "data/fxtwitter/observations.jsonl")),
		).toBe(true);
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
				short_url: "https://T.CO/shared",
				expanded_tweet_id: "2039395915421942108",
			},
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
					"select source, source_url from tweet_sources where tweet_id = 'tweet_2024'",
				)
				.get(),
		).toEqual({
			source: "fxtwitter",
			source_url: "https://api.fxtwitter.com/2/status/tweet_2024",
		});
		expect(
			getNativeDb({ seedDemoData: false })
				.prepare(
					"select collection_state, partial_reasons_json, next_cursor from fxtwitter_fetches where id = 'fx_fetch_1'",
				)
				.get(),
		).toEqual({
			collection_state: "partial",
			partial_reasons_json: '["caller_limit"]',
			next_cursor: "next-cursor",
		});
		expect(
			getNativeDb({ seedDemoData: false })
				.prepare(
					"select endpoint_family, request_key, item_id from fxtwitter_observations where item_id = 'tweet_2024'",
				)
				.get(),
		).toEqual({
			endpoint_family: "search",
			request_key: "local-first",
			item_id: "tweet_2024",
		});
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

	it("exports and syncs a fresh empty store with a staged data directory", async () => {
		const remotePath = path.join(
			makeTempDir("birdclaw-empty-remote-"),
			"remote.git",
		);
		execFileSync("git", ["init", "--bare", remotePath]);
		switchHome("birdclaw-empty-store-home-");
		const db = getNativeDb({ seedDemoData: false });
		const exportPath = makeTempDir("birdclaw-empty-export-");
		const exported = await exportBackup({ repoPath: exportPath, db });
		expect(exported.validation.ok).toBe(true);
		expect(statSync(path.join(exportPath, "data")).isDirectory()).toBe(true);

		const syncPath = makeTempDir("birdclaw-empty-sync-");
		const synced = await syncBackup({
			repoPath: syncPath,
			remote: remotePath,
			db,
		});
		expect(synced.exportResult.validation.ok).toBe(true);
		expect(statSync(path.join(syncPath, "data")).isDirectory()).toBe(true);
	}, 20000);

	it("streams fingerprint rows instead of materializing every table", () => {
		let iterateCalls = 0;
		const database = {
			prepare(sql: string) {
				return {
					all() {
						throw new Error("fingerprinting must not materialize result sets");
					},
					iterate() {
						iterateCalls += 1;
						return [{ sql }].values();
					},
				};
			},
		} as unknown as Database;

		const fingerprint = getBackupDatabaseFingerprint(database);

		expect(iterateCalls).toBe(BACKUP_TABLE_CODECS.length);
		expect(Object.values(fingerprint.counts)).toEqual(
			BACKUP_TABLE_CODECS.map(() => 1),
		);
	});

	it("skips topology normalization for canonical singleton revisions", async () => {
		switchHome("birdclaw-backup-singleton-src-");
		seedBackupFixture();
		const sourceDb = getNativeDb({ seedDemoData: false });
		sourceDb.exec(`
			insert into tweet_revisions (
				root_tweet_id, revision_id, revision_index, payload_json, source, observed_at
			) values (
				'singleton', 'singleton', 0, null, 'xurl', '2026-08-01T00:00:00.000Z'
			)
		`);
		const repoPath = makeTempDir("birdclaw-singleton-store-");
		await exportBackup({ repoPath });

		switchHome("birdclaw-backup-singleton-dst-");
		const db = getNativeDb({ seedDemoData: false });
		let topologyQueries = 0;
		const instrumentedDb = new Proxy(db, {
			get(target, property, receiver) {
				if (property === "prepare") {
					return (sql: string) => {
						if (sql.includes("with recursive component")) topologyQueries += 1;
						return target.prepare(sql);
					};
				}
				const value = Reflect.get(target, property, receiver) as unknown;
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as Database;

		await importBackup({ repoPath, db: instrumentedDb, mode: "replace" });

		expect(topologyQueries).toBe(0);
	});

	it("emits byte-identical schema-v8 data and hashes for the same database", async () => {
		switchHome("birdclaw-backup-stable-src-");
		seedBackupFixture();
		const firstRepoPath = makeTempDir("birdclaw-backup-stable-first-");
		const secondRepoPath = makeTempDir("birdclaw-backup-stable-second-");

		const first = await exportBackup({ repoPath: firstRepoPath });
		const second = await exportBackup({ repoPath: secondRepoPath });

		expect(first.manifest.schemaVersion).toBe(8);
		expect(second.manifest.files).toEqual(first.manifest.files);
		expect(second.manifest.counts).toEqual(first.manifest.counts);
		expect(second.manifest.backupHash).toBe(first.manifest.backupHash);
		for (const file of first.manifest.files) {
			expect(readFileSync(path.join(secondRepoPath, file.path))).toEqual(
				readFileSync(path.join(firstRepoPath, file.path)),
			);
		}
	}, 20000);

	it("splits oversized logical shards into deterministic bounded part files", async () => {
		switchHome("birdclaw-backup-parts-src-");
		seedBackupFixture();
		const db = getNativeDb();
		const largeRawJson = JSON.stringify({ blob: "x".repeat(700_000) });
		db.prepare("update profiles set raw_json = ?").run(largeRawJson);
		const before = getBackupDatabaseFingerprint();
		const repoPath = makeTempDir("birdclaw-backup-parts-store-");

		const exported = await exportBackup({
			repoPath,
			maxShardBytes: 1_000_000,
		});
		const profileFiles = exported.manifest.files.filter((file) =>
			file.path.startsWith("data/profiles.part-"),
		);

		expect(profileFiles.map((file) => file.path)).toEqual([
			"data/profiles.part-0001.jsonl",
			"data/profiles.part-0002.jsonl",
		]);
		expect(profileFiles.every((file) => file.bytes <= 1_000_000)).toBe(true);
		expect(profileFiles.reduce((sum, file) => sum + file.rows, 0)).toBe(2);
		expect(existsSync(path.join(repoPath, "data/profiles.jsonl"))).toBe(false);
		expect(exported.validation.ok).toBe(true);

		switchHome("birdclaw-backup-parts-dst-");
		const imported = await importBackup({ repoPath, mode: "replace" });
		expect(imported.fingerprint).toEqual(before);
	}, 20000);

	it("does not downgrade a fresh DM request when merging a stale backup", async () => {
		switchHome("birdclaw-backup-dm-merge-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-backup-dm-merge-repo-");
		getNativeDb({ seedDemoData: false })
			.prepare(
				"update dm_conversations set inbox_kind = 'accepted' where id = 'dm:friend'",
			)
			.run();
		await exportBackup({ repoPath });
		getNativeDb({ seedDemoData: false })
			.prepare(
				"update dm_conversations set inbox_kind = 'request' where id = 'dm:friend'",
			)
			.run();

		await importBackup({ repoPath });

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

	it("round-trips tweet tombstones, subordinate deletions, and edit revisions", async () => {
		switchHome("birdclaw-backup-tombstone-src-");
		seedBackupFixture();
		const sourceDb = getNativeDb({ seedDemoData: false });
		sourceDb.exec(`
			insert into tweets (
				id, author_profile_id, text, created_at, is_replied, reply_to_id,
				like_count, media_count, entities_json, media_json, quoted_tweet_id,
				superseded_at, superseded_by_id
			) values (
				'tweet_2025_v1', 'profile_me', 'before edit',
				'2025-01-02T07:00:00.000Z', 0, null, 0, 0, '{}', '[]', null,
				'2025-01-02T08:00:00.000Z', 'tweet_2025'
			), (
				'tweet_2025_v2', 'profile_me', 'middle edit',
				'2025-01-02T07:30:00.000Z', 0, null, 0, 0, '{}', '[]', null,
				'2025-01-02T08:00:00.000Z', 'tweet_2025'
			);
			update tweets
			set deleted_at = '2026-07-18T12:00:00.000Z',
				deletion_source = 'twitter_archive',
				deletion_reason = 'explicit_deleted_tweet_record',
				media_json = '[{"media_key":"media-1","type":"photo"}]'
			where id = 'tweet_2025';
			insert into tweet_revisions (
				root_tweet_id, revision_id, revision_index, payload_json, source, observed_at
			) values
				('tweet_2025_v1', 'tweet_2025_v1', 0, null, 'xurl', '2025-01-02T07:00:00.000Z'),
				('tweet_2025_v1', 'tweet_2025_v2', 1, '{"text":"middle"}', 'xurl', '2025-01-02T07:30:00.000Z'),
				('tweet_2025_v1', 'tweet_2025', 2, '{"text":"after"}', 'xurl', '2025-01-02T08:00:00.000Z');
			insert into tweet_revisions (
				root_tweet_id, revision_id, revision_index, payload_json, source, observed_at
			) values
				('partial_root', 'partial_root', 0, null, 'xurl', '2025-01-02T07:00:00.000Z'),
				('partial_root', 'partial_left', 1, null, 'xurl', '2025-01-02T08:00:00.000Z'),
				('partial_root', 'partial_right', 1, null, 'xurl', '2025-01-02T08:00:00.000Z');
			insert into tweet_revision_edges (
				older_revision_id, newer_revision_id, source, observed_at
			) values
				('tweet_2025_v1', 'tweet_2025_v2', 'xurl', '2025-01-02T07:30:00.000Z'),
				('tweet_2025_v2', 'tweet_2025', 'xurl', '2025-01-02T08:00:00.000Z'),
				('partial_root', 'partial_left', 'xurl', '2025-01-02T08:00:00.000Z'),
				('partial_root', 'partial_right', 'xurl', '2025-01-02T08:00:00.000Z');
			insert into tweet_subordinate_tombstones (
				tweet_id, kind, subordinate_id, deleted_at, deletion_source, deletion_reason
			) values
				('tweet_2025', 'media', 'media-1', '2026-07-18T12:00:00.000Z', 'twitter_archive', 'parent_tweet_deleted'),
				('tweet_2025', 'quote', 'tweet_quote', '2026-07-18T12:00:00.000Z', 'twitter_archive', 'parent_tweet_deleted');
		`);
		const repoPath = makeTempDir("birdclaw-tombstone-store-");
		await exportBackup({ repoPath });

		switchHome("birdclaw-backup-tombstone-dst-");
		const db = getNativeDb({ seedDemoData: false });
		insertTestTweet(db, {
			id: "tweet_2025",
			authorProfileId: "profile_me",
			text: "later local copy",
		});
		db.exec(`
			update tweets
			set deleted_at = '2026-07-18T12:00:00.000Z',
				deletion_source = null,
				deletion_reason = null
			where id = 'tweet_2025';
			insert into tweet_subordinate_tombstones (
				tweet_id, kind, subordinate_id, deleted_at, deletion_source, deletion_reason
			) values
			(
				'tweet_2025', 'media', 'media-1', '2027-01-01T00:00:00.000Z',
				'local_later', 'later_local_event'
			),
			(
				'tweet_2025', 'quote', 'tweet_quote', '2026-07-18T12:00:00.000Z',
				null, 'parent_tweet_deleted'
			);
			insert into tweet_revisions (
				root_tweet_id, revision_id, revision_index, payload_json, source, observed_at
			) values
				('tweet_2025_v2', 'tweet_2025_v2', 0, null, 'xurl', '2025-01-02T07:30:00.000Z'),
				('tweet_2025_v2', 'tweet_2025', 1, null, 'xurl', '2025-01-02T08:00:00.000Z');
			insert into tweet_revision_edges (
				older_revision_id, newer_revision_id, source, observed_at
			) values
				('tweet_2025_v2', 'tweet_2025', 'xurl', '2025-01-02T08:00:00.000Z');
		`);
		const result = await importBackup({ repoPath });

		expect(result.mode).toBe("merge");
		expect(
			db
				.prepare(
					"select superseded_at, superseded_by_id from tweets where id = 'tweet_2025_v1'",
				)
				.get(),
		).toEqual({
			superseded_at: "2025-01-02T08:00:00.000Z",
			superseded_by_id: "tweet_2025",
		});
		expect(
			db
				.prepare(
					"select deleted_at, deletion_source, deletion_reason from tweets where id = 'tweet_2025'",
				)
				.get(),
		).toEqual({
			deleted_at: "2026-07-18T12:00:00.000Z",
			deletion_source: "twitter_archive",
			deletion_reason: "explicit_deleted_tweet_record",
		});
		expect(
			db
				.prepare(
					"select kind, subordinate_id, deleted_at, deletion_source, deletion_reason from tweet_subordinate_tombstones where tweet_id = 'tweet_2025' order by kind, subordinate_id",
				)
				.all(),
		).toEqual([
			{
				kind: "media",
				subordinate_id: "media-1",
				deleted_at: "2026-07-18T12:00:00.000Z",
				deletion_source: "twitter_archive",
				deletion_reason: "parent_tweet_deleted",
			},
			{
				kind: "quote",
				subordinate_id: "tweet_quote",
				deleted_at: "2026-07-18T12:00:00.000Z",
				deletion_source: "twitter_archive",
				deletion_reason: "parent_tweet_deleted",
			},
		]);
		expect(
			db
				.prepare(
					"select revision_id, revision_index, payload_json is not null as hydrated from tweet_revisions where root_tweet_id = 'tweet_2025_v1' order by revision_index",
				)
				.all(),
		).toEqual([
			{ revision_id: "tweet_2025_v1", revision_index: 0, hydrated: 0 },
			{ revision_id: "tweet_2025_v2", revision_index: 1, hydrated: 1 },
			{ revision_id: "tweet_2025", revision_index: 2, hydrated: 1 },
		]);
		expect(
			db
				.prepare(
					"select revision_id, revision_index from tweet_revisions where root_tweet_id = 'partial_root' order by revision_index, revision_id",
				)
				.all(),
		).toEqual([
			{ revision_id: "partial_root", revision_index: 0 },
			{ revision_id: "partial_left", revision_index: 1 },
			{ revision_id: "partial_right", revision_index: 1 },
		]);
		expect(
			db
				.prepare(
					"select count(*) as count from tweets_fts where tweet_id = 'tweet_2025'",
				)
				.get(),
		).toEqual({ count: 0 });
		expect(
			db
				.prepare(
					"select count(*) as count from tweets_fts where tweet_id = 'tweet_2025_v1'",
				)
				.get(),
		).toEqual({ count: 0 });
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
		expect(
			(await __test__.pendingPushReceiptPaths(repoPath)).some((receiptPath) =>
				existsSync(receiptPath),
			),
		).toBe(false);

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
			url_expansions: 2,
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

	it("adopts a validated non-Git export when syncing to an empty remote", async () => {
		const remotePath = path.join(
			makeTempDir("birdclaw-adopt-export-remote-"),
			"remote.git",
		);
		execFileSync("git", ["init", "--bare", remotePath]);
		switchHome("birdclaw-adopt-export-home-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-adopt-export-repo-");
		const exported = await exportBackup({ repoPath });
		expect(exported.validation.ok).toBe(true);
		expect(existsSync(path.join(repoPath, ".git"))).toBe(false);

		const synced = await syncBackup({ repoPath, remote: remotePath });
		const head = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
		expect(synced.exportResult.validation.ok).toBe(true);
		expect(synced.imported).toBe(true);
		expect(await validateBackup(repoPath)).toMatchObject({ ok: true });
		expect(
			execFileSync("git", ["-C", repoPath, "status", "--porcelain"], {
				encoding: "utf8",
			}),
		).toBe("");
		expect(
			execFileSync(
				"git",
				["--git-dir", remotePath, "rev-parse", "refs/heads/main"],
				{ encoding: "utf8" },
			).trim(),
		).toBe(head);
	}, 30000);

	it("retries non-Git promotion after staged validation fails", async () => {
		const remotePath = path.join(
			makeTempDir("birdclaw-adopt-retry-remote-"),
			"remote.git",
		);
		execFileSync("git", ["init", "--bare", remotePath]);
		switchHome("birdclaw-adopt-retry-home-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-adopt-retry-repo-");
		await exportBackup({ repoPath });
		const before = snapshotTree(repoPath);
		getNativeDb({ seedDemoData: false })
			.prepare(
				"update profiles set bio = 'retry generation' where id = 'profile_friend'",
			)
			.run();
		__test__.setBeforeStagedValidation(() => {
			throw new Error("synthetic promoted validation failure");
		});

		await expect(syncBackup({ repoPath, remote: remotePath })).rejects.toThrow(
			"synthetic promoted validation failure",
		);
		expect(existsSync(path.join(repoPath, ".git"))).toBe(false);
		expect(snapshotTree(repoPath)).toEqual(before);
		expect(await validateBackup(repoPath)).toMatchObject({ ok: true });
		expect(
			execFileSync(
				"git",
				[
					"--git-dir",
					remotePath,
					"for-each-ref",
					"--format=%(objectname)",
					"refs/heads/main",
				],
				{ encoding: "utf8" },
			),
		).toBe("");

		__test__.setBeforeStagedValidation(undefined);
		await expect(
			syncBackup({ repoPath, remote: remotePath }),
		).resolves.toMatchObject({
			ok: true,
		});
		expect(existsSync(path.join(repoPath, ".git"))).toBe(true);
		expect(await validateBackup(repoPath)).toMatchObject({ ok: true });
		expect(
			execFileSync(
				"git",
				["--git-dir", remotePath, "rev-parse", "refs/heads/main"],
				{ encoding: "utf8" },
			).trim(),
		).toBe(
			execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
				encoding: "utf8",
			}).trim(),
		);
	}, 30000);

	it("retains promoted Git when its initial push has a retry receipt", async () => {
		const remotePath = path.join(
			makeTempDir("birdclaw-adopt-push-retry-remote-"),
			"remote.git",
		);
		execFileSync("git", ["init", "--bare", remotePath]);
		switchHome("birdclaw-adopt-push-retry-home-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-adopt-push-retry-repo-");
		await exportBackup({ repoPath });
		const hookPath = path.join(remotePath, "hooks", "pre-receive");
		writeFileSync(hookPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

		await expect(syncBackup({ repoPath, remote: remotePath })).rejects.toThrow(
			"Command failed",
		);
		expect(existsSync(path.join(repoPath, ".git"))).toBe(true);
		expect(await validateBackup(repoPath)).toMatchObject({ ok: true });
		expect(await __test__.pendingPushReceiptPaths(repoPath)).toHaveLength(1);
		rmSync(hookPath);
		let staged = false;
		__test__.setBeforeStagedValidation(() => {
			staged = true;
		});

		await expect(
			syncBackup({ repoPath, remote: remotePath }),
		).resolves.toMatchObject({
			pushOnly: true,
		});
		expect(staged).toBe(false);
		expect(await __test__.pendingPushReceiptPaths(repoPath)).toHaveLength(0);
	}, 30000);

	it("rejects unexpected non-Git backup content before adoption", async () => {
		switchHome("birdclaw-adopt-invalid-home-");
		seedBackupFixture();
		for (const variant of ["root", "data"] as const) {
			const repoPath = makeTempDir(`birdclaw-adopt-${variant}-repo-`);
			await exportBackup({ repoPath });
			if (variant === "root") {
				writeFileSync(path.join(repoPath, "private.txt"), "unexpected\n");
			} else {
				writeFileSync(path.join(repoPath, "data", "unmanifested.json"), "{}\n");
			}
			const remotePath = path.join(
				makeTempDir(`birdclaw-adopt-${variant}-remote-`),
				"remote.git",
			);
			execFileSync("git", ["init", "--bare", remotePath]);

			await expect(
				syncBackup({ repoPath, remote: remotePath }),
			).rejects.toThrow(
				variant === "root"
					? "Unexpected non-Git backup root entry"
					: "Unexpected backup data file",
			);
			expect(existsSync(path.join(repoPath, ".git"))).toBe(false);
			expect(
				execFileSync(
					"git",
					[
						"--git-dir",
						remotePath,
						"for-each-ref",
						"--format=%(objectname)",
						"refs/heads/main",
					],
					{ encoding: "utf8" },
				),
			).toBe("");
		}
	}, 30000);

	it("rejects an independent process while it holds the repository lock", async () => {
		switchHome("birdclaw-backup-lock-home-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-backup-lock-repo-");
		const lockPath = __test__.backupLockPath(
			await __test__.canonicalizeBackupRepoPath(repoPath),
		);
		const child = spawn(
			process.execPath,
			[
				"-e",
				`const fs = require('node:fs'); const lock = process.argv[1];
				 const fd = fs.openSync(lock, 'wx');
				 fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\\n');
				 fs.closeSync(fd); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`,
				lockPath,
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		await new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.stdout.once("data", () => resolve());
		});

		try {
			await expect(exportBackup({ repoPath })).rejects.toThrow(
				"locked by another process",
			);
			expect(existsSync(path.join(repoPath, "manifest.json"))).toBe(false);
		} finally {
			child.kill("SIGTERM");
			rmSync(lockPath, { force: true });
		}
	}, 20000);

	it("uses one canonical lock identity through symlinked parent aliases", async () => {
		switchHome("birdclaw-backup-alias-home-");
		seedBackupFixture();
		const realParent = makeTempDir("birdclaw-backup-alias-parent-");
		const aliasParent = path.join(
			path.dirname(realParent),
			`${path.basename(realParent)}-alias`,
		);
		symlinkSync(realParent, aliasParent, "dir");
		const realRepoPath = path.join(realParent, "repo");
		const aliasRepoPath = path.join(aliasParent, "repo");
		const canonicalPath =
			await __test__.canonicalizeBackupRepoPath(realRepoPath);
		const release = await acquireScheduledJobLock(
			__test__.backupLockPath(canonicalPath),
			60_000,
		);

		try {
			for (const operation of [
				() => exportBackup({ repoPath: aliasRepoPath }),
				() => importBackup({ repoPath: aliasRepoPath }),
				() =>
					Effect.runPromise(
						updateBackupFromGitEffect({ repoPath: aliasRepoPath }),
					),
				() => syncBackup({ repoPath: aliasRepoPath }),
			]) {
				await expect(operation()).rejects.toThrow("locked by another process");
			}
		} finally {
			await release?.();
			rmSync(aliasParent, { force: true });
		}
	}, 20000);

	it("fails closed on dirty, index-locked, and manifest-mismatched checkouts", async () => {
		switchHome("birdclaw-backup-preflight-home-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-backup-preflight-repo-");
		await exportBackup({ repoPath, commit: true });
		const before = snapshotTree(repoPath);
		let databaseOpens = 0;
		__test__.setBeforeDatabaseOpen(() => {
			databaseOpens += 1;
		});
		writeFileSync(path.join(repoPath, "dirty.txt"), "dirty\n");

		await expect(exportBackup({ repoPath })).rejects.toThrow(
			"Backup checkout is dirty",
		);
		rmSync(path.join(repoPath, "dirty.txt"));
		expect(snapshotTree(repoPath)).toEqual(before);

		const rawIndexLockPath = execFileSync(
			"git",
			["-C", repoPath, "rev-parse", "--git-path", "index.lock"],
			{ encoding: "utf8" },
		).trim();
		const indexLockPath = path.isAbsolute(rawIndexLockPath)
			? rawIndexLockPath
			: path.resolve(repoPath, rawIndexLockPath);
		writeFileSync(indexLockPath, "locked\n");
		await expect(exportBackup({ repoPath })).rejects.toThrow(
			"Backup Git index is locked",
		);
		rmSync(indexLockPath);

		appendFileSync(path.join(repoPath, "data/profiles.jsonl"), "{}\n");
		execFileSync("git", ["-C", repoPath, "add", "data/profiles.jsonl"]);
		execFileSync("git", [
			"-C",
			repoPath,
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-m",
			"test: corrupt manifest generation",
		]);
		await expect(exportBackup({ repoPath })).rejects.toThrow(
			"Current backup manifest is invalid",
		);
		switchHome("birdclaw-backup-preflight-import-dst-");
		const destination = getNativeDb({ seedDemoData: false });
		const beforeAccounts = destination
			.prepare("select count(*) as count from accounts")
			.get();
		await expect(importBackup({ repoPath })).rejects.toThrow(
			"Current backup manifest is invalid",
		);
		expect(
			destination.prepare("select count(*) as count from accounts").get(),
		).toEqual(beforeAccounts);
		expect(databaseOpens).toBe(0);
	}, 20000);

	it("automatic dirty-check failures do not open or create a database", async () => {
		const previousAutoSyncEnv = process.env.BIRDCLAW_BACKUP_AUTO_SYNC;
		process.env.BIRDCLAW_BACKUP_AUTO_SYNC = "1";
		try {
			switchHome("birdclaw-backup-auto-preflight-source-");
			seedBackupFixture();
			const repoPath = makeTempDir("birdclaw-backup-auto-preflight-repo-");
			await exportBackup({ repoPath, commit: true });
			writeFileSync(path.join(repoPath, "dirty.txt"), "dirty\n");

			const cleanHome = switchHome("birdclaw-backup-auto-preflight-home-");
			writeBackupConfig(cleanHome, {
				repoPath,
				autoSync: true,
				staleAfterSeconds: 0,
			});
			let databaseOpens = 0;
			__test__.setBeforeDatabaseOpen(() => {
				databaseOpens += 1;
			});

			await expect(maybeAutoSyncBackup()).resolves.toMatchObject({ ok: false });
			await expect(maybeAutoUpdateBackup()).resolves.toMatchObject({
				ok: false,
			});
			expect(databaseOpens).toBe(0);
			expect(existsSync(path.join(cleanHome, "birdclaw.sqlite"))).toBe(false);
		} finally {
			if (previousAutoSyncEnv === undefined) {
				delete process.env.BIRDCLAW_BACKUP_AUTO_SYNC;
			} else {
				process.env.BIRDCLAW_BACKUP_AUTO_SYNC = previousAutoSyncEnv;
			}
		}
	}, 20000);

	it("reads auto-update freshness without opening or migrating the database", async () => {
		const previousAutoSyncEnv = process.env.BIRDCLAW_BACKUP_AUTO_SYNC;
		process.env.BIRDCLAW_BACKUP_AUTO_SYNC = "1";
		try {
			const home = switchHome("birdclaw-backup-fresh-readonly-home-");
			seedBackupFixture();
			const repoPath = makeTempDir("birdclaw-backup-fresh-readonly-repo-");
			await exportBackup({ repoPath, commit: true });
			writeBackupConfig(home, {
				repoPath,
				autoSync: true,
				staleAfterSeconds: 900,
			});
			getNativeDb({ seedDemoData: false })
				.prepare(
					`insert into sync_cache (cache_key, value_json, updated_at)
					 values ('backup:auto-sync', ?, ?)
					 on conflict(cache_key) do update set
					 value_json = excluded.value_json, updated_at = excluded.updated_at`,
				)
				.run(
					JSON.stringify({ checkedAt: new Date().toISOString(), ok: true }),
					new Date().toISOString(),
				);
			writeFileSync(
				path.join(repoPath, "dirty.txt"),
				"must remain untouched\n",
			);
			let databaseOpens = 0;
			__test__.setBeforeDatabaseOpen(() => {
				databaseOpens += 1;
			});

			await expect(maybeAutoUpdateBackup()).resolves.toMatchObject({
				ok: true,
				skipped: true,
				reason: "backup auto-sync is fresh",
			});
			expect(databaseOpens).toBe(0);
			expect(readFileSync(path.join(repoPath, "dirty.txt"), "utf8")).toBe(
				"must remain untouched\n",
			);
		} finally {
			if (previousAutoSyncEnv === undefined) {
				delete process.env.BIRDCLAW_BACKUP_AUTO_SYNC;
			} else {
				process.env.BIRDCLAW_BACKUP_AUTO_SYNC = previousAutoSyncEnv;
			}
		}
	}, 20000);

	it("exports all tables from one SQLite read transaction", async () => {
		switchHome("birdclaw-backup-snapshot-home-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-backup-snapshot-repo-");
		const contender = new NativeSqliteDatabase(getBirdclawPaths().dbPath);
		let mutated = false;
		const reader = new NativeSqliteDatabase(getBirdclawPaths().dbPath, {
			onStatement(sql) {
				if (mutated || !/from\s+accounts/i.test(sql)) return;
				mutated = true;
				contender
					.prepare(
						`insert into tweets (id, author_profile_id, text, created_at)
					 values ('tweet_between_reads', 'profile_me', 'between reads',
					 '2026-08-09T00:00:00.000Z')`,
					)
					.run();
			},
		});

		try {
			const result = await exportBackup({ repoPath, db: reader });
			expect(mutated).toBe(true);
			expect(result.manifest.counts.tweets).toBe(3);
			expect(
				contender.prepare("select count(*) as count from tweets").get(),
			).toEqual({ count: 4 });
			for (const file of result.manifest.files.filter((entry) =>
				entry.path.startsWith("data/tweets/"),
			)) {
				expect(
					readFileSync(path.join(repoPath, file.path), "utf8"),
				).not.toContain("tweet_between_reads");
			}
		} finally {
			reader.close();
			contender.close();
		}
	}, 20000);

	it("leaves the live generation byte-identical when staged validation fails", async () => {
		switchHome("birdclaw-backup-stage-home-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-backup-stage-repo-");
		await exportBackup({ repoPath });
		const before = snapshotTree(repoPath);
		getNativeDb({ seedDemoData: false })
			.prepare(
				"update profiles set bio = 'new generation' where id = 'profile_friend'",
			)
			.run();
		__test__.setBeforeStagedValidation((stagingPath) => {
			appendFileSync(path.join(stagingPath, "data/profiles.jsonl"), "{}\n");
		});

		await expect(exportBackup({ repoPath })).rejects.toThrow(
			"Backup validation failed",
		);
		expect(snapshotTree(repoPath)).toEqual(before);
	}, 20000);

	it("recovers one complete generation at every publication rename boundary", async () => {
		switchHome("birdclaw-backup-journal-home-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-backup-journal-repo-");
		await exportBackup({ repoPath, commit: true });
		const before = snapshotTree(repoPath);
		const cases = [
			"data",
			"README.md",
			".gitattributes",
			"manifest.json",
		].flatMap((relativePath) =>
			(["rollback", "install"] as const).map((phase) => ({
				relativePath,
				phase,
			})),
		);
		for (const { relativePath, phase } of cases) {
			let observedStagePath: string | undefined;
			let observedStageDevice: number | undefined;
			__test__.setBeforeStagedValidation((stagingPath) => {
				observedStagePath = stagingPath;
				observedStageDevice = statSync(stagingPath).dev;
			});
			__test__.setAfterPublicationRename((renamedPath, renamedPhase) => {
				if (renamedPath === relativePath && renamedPhase === phase) {
					throw new Error(
						`synthetic publication failure ${relativePath}:${phase}`,
					);
				}
			});
			await expect(exportBackup({ repoPath })).rejects.toThrow(
				`synthetic publication failure ${relativePath}:${phase}`,
			);
			expect(snapshotTree(repoPath)).toEqual(before);
			expect(
				execFileSync("git", ["-C", repoPath, "status", "--porcelain"], {
					encoding: "utf8",
				}),
			).toBe("");
			expect(observedStagePath).toBeTruthy();
			expect(observedStageDevice).toBe(statSync(repoPath).dev);
			expect(observedStagePath).toContain(`${path.sep}.git${path.sep}`);
			__test__.setBeforeStagedValidation(undefined);
			__test__.setAfterPublicationRename(undefined);
		}
	}, 120000);

	it("falls back when the preferred transaction root is not writable", async () => {
		switchHome("birdclaw-backup-root-fallback-home-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-backup-root-fallback-repo-");
		await exportBackup({ repoPath, commit: true });
		const roots = await __test__.transactionRootPaths(repoPath);
		const preferredRoot = roots[0]!;
		const fallbackRoot = roots.find((root) => root !== preferredRoot)!;
		mkdirSync(preferredRoot, { recursive: true, mode: 0o700 });
		const sentinel = path.join(preferredRoot, "sentinel.txt");
		writeFileSync(sentinel, "preferred untouched\n");
		chmodSync(preferredRoot, 0o500);
		let stagingPath = "";
		__test__.setBeforeStagedValidation((value) => {
			stagingPath = value;
		});
		getNativeDb({ seedDemoData: false })
			.prepare(
				"update profiles set bio = 'fallback root' where id = 'profile_friend'",
			)
			.run();

		try {
			await expect(
				exportBackup({ repoPath, commit: true }),
			).resolves.toMatchObject({
				ok: true,
			});
			expect(stagingPath.startsWith(`${fallbackRoot}${path.sep}`)).toBe(true);
			expect(readFileSync(sentinel, "utf8")).toBe("preferred untouched\n");
			expect(readdirSync(preferredRoot)).toEqual(["sentinel.txt"]);
		} finally {
			chmodSync(preferredRoot, 0o700);
		}
	}, 30000);

	it("recovers an interrupted publication journal on the next process", async () => {
		const home = switchHome("birdclaw-backup-restart-home-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-backup-restart-repo-");
		await exportBackup({ repoPath, commit: true });
		const before = snapshotTree(repoPath);
		const scriptPath = path.join(
			makeTempDir("birdclaw-backup-restart-script-"),
			"crash.mjs",
		);
		const backupModuleUrl = new URL("./backup.ts", import.meta.url).href;
		writeFileSync(
			scriptPath,
			`process.env.BIRDCLAW_HOME = process.argv[2];
			 const { __test__, exportBackup } = await import(${JSON.stringify(backupModuleUrl)});
			 __test__.setAfterPublicationRename((relativePath, phase) => {
			   if (relativePath === "data" && phase === "rollback") process.exit(86);
			 });
			 await exportBackup({ repoPath: process.argv[3] });`,
			"utf8",
		);
		const child = spawn(
			path.resolve("scripts/bun-canary.sh"),
			[scriptPath, home, repoPath],
			{ cwd: path.resolve("."), stdio: "pipe" },
		);
		const exitCode = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", resolve);
		});
		expect(exitCode).toBe(86);

		await importBackup({
			repoPath,
			db: getNativeDb({ seedDemoData: false }),
		});
		expect(snapshotTree(repoPath)).toEqual(before);
		expect(
			execFileSync("git", ["-C", repoPath, "status", "--porcelain"], {
				encoding: "utf8",
			}),
		).toBe("");
	}, 30000);

	it("refuses recovery after the repository directory is recreated", async () => {
		const home = switchHome("birdclaw-backup-recreated-repo-home-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-backup-recreated-repo-");
		await exportBackup({ repoPath });
		getNativeDb({ seedDemoData: false })
			.prepare(
				"update profiles set bio = 'replacement crash' where id = 'profile_friend'",
			)
			.run();
		const transactionRoots = await __test__.transactionRootPaths(repoPath);
		const scriptPath = path.join(
			makeTempDir("birdclaw-backup-recreated-script-"),
			"crash.mjs",
		);
		const backupModuleUrl = new URL("./backup.ts", import.meta.url).href;
		writeFileSync(
			scriptPath,
			`process.env.BIRDCLAW_HOME = process.argv[2];
			 const { __test__, exportBackup } = await import(${JSON.stringify(backupModuleUrl)});
			 __test__.setAfterPublication(() => process.exit(90));
			 await exportBackup({ repoPath: process.argv[3] });`,
			"utf8",
		);
		const child = spawn(
			path.resolve("scripts/bun-canary.sh"),
			[scriptPath, home, repoPath],
			{ cwd: path.resolve("."), stdio: "pipe" },
		);
		const exitCode = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", resolve);
		});
		expect(exitCode).toBe(90);
		expect(
			transactionRoots.some((root) =>
				existsSync(path.join(root, "journal.json")),
			),
		).toBe(true);

		rmSync(repoPath, { recursive: true });
		mkdirSync(path.join(repoPath, "data"), { recursive: true });
		const sentinel = path.join(repoPath, "data", "sentinel.txt");
		writeFileSync(sentinel, "new repository sentinel\n");
		writeFileSync(
			path.join(repoPath, "manifest.json"),
			"new repository manifest\n",
		);
		try {
			await expect(exportBackup({ repoPath })).rejects.toThrow(
				"repository identity changed",
			);
			expect(readFileSync(sentinel, "utf8")).toBe("new repository sentinel\n");
			expect(readFileSync(path.join(repoPath, "manifest.json"), "utf8")).toBe(
				"new repository manifest\n",
			);
			expect(
				transactionRoots.some((root) =>
					existsSync(path.join(root, "journal.json")),
				),
			).toBe(true);
		} finally {
			for (const root of transactionRoots) {
				rmSync(root, { recursive: true, force: true });
			}
		}
	}, 30000);

	it("rejects journal stage and rollback escapes without touching victims", async () => {
		switchHome("birdclaw-journal-escape-home-");
		seedBackupFixture();
		for (const field of ["stagePath", "rollbackPath"] as const) {
			const repoPath = makeTempDir(`birdclaw-journal-${field}-repo-`);
			await exportBackup({ repoPath, commit: true });
			const fixture = await makeRecoveryJournalFixture(repoPath);
			const victim = makeTempDir(`birdclaw-journal-${field}-victim-`);
			const sentinel = path.join(victim, "sentinel.txt");
			writeFileSync(sentinel, "untouched\n");
			writeFileSync(
				fixture.journalPath,
				JSON.stringify({ ...fixture.journal, [field]: victim }),
			);

			await expect(
				importBackup({ repoPath, db: getNativeDb({ seedDemoData: false }) }),
			).rejects.toThrow("Backup transaction");
			expect(readFileSync(sentinel, "utf8")).toBe("untouched\n");
			expect(existsSync(victim)).toBe(true);
		}
	}, 30000);

	it("falls back from a symlinked preferred transaction root without touching its target", async () => {
		switchHome("birdclaw-journal-root-symlink-home-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-journal-root-symlink-repo-");
		await exportBackup({ repoPath, commit: true });
		const transactionRoot = (await __test__.transactionRootPaths(repoPath))[0]!;
		const victim = makeTempDir("birdclaw-journal-root-symlink-victim-");
		const sentinel = path.join(victim, "stage-keep");
		mkdirSync(sentinel);
		writeFileSync(path.join(sentinel, "sentinel.txt"), "untouched\n");
		symlinkSync(victim, transactionRoot, "dir");

		await expect(
			importBackup({ repoPath, db: getNativeDb({ seedDemoData: false }) }),
		).resolves.toMatchObject({ ok: true });
		expect(readFileSync(path.join(sentinel, "sentinel.txt"), "utf8")).toBe(
			"untouched\n",
		);
	}, 30000);

	it("rejects a forged recovery index path before copying or removing files", async () => {
		switchHome("birdclaw-journal-index-home-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-journal-index-repo-");
		await exportBackup({ repoPath, commit: true });
		const fixture = await makeRecoveryJournalFixture(repoPath);
		const victim = path.join(
			makeTempDir("birdclaw-journal-index-victim-"),
			"victim-index",
		);
		writeFileSync(victim, "untouched index\n");
		writeFileSync(
			fixture.journalPath,
			JSON.stringify({ ...fixture.journal, gitIndexPath: victim }),
		);

		await expect(
			importBackup({ repoPath, db: getNativeDb({ seedDemoData: false }) }),
		).rejects.toThrow("Git index path is invalid");
		expect(readFileSync(victim, "utf8")).toBe("untouched index\n");
		expect(existsSync(fixture.journalPath)).toBe(true);
	}, 30000);

	it("does not mistake an unrelated HEAD advance for the published backup", async () => {
		const home = switchHome("birdclaw-backup-unrelated-head-home-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-backup-unrelated-head-repo-");
		await exportBackup({ repoPath, commit: true });
		const managedSnapshot = () =>
			new Map(
				[...snapshotTree(repoPath)].filter(
					([relativePath]) =>
						relativePath === ".gitattributes" ||
						relativePath === "README.md" ||
						relativePath === "manifest.json" ||
						relativePath.startsWith(`data${path.sep}`),
				),
			);
		const before = managedSnapshot();
		getNativeDb({ seedDemoData: false })
			.prepare(
				`insert into tweets (id, author_profile_id, text, created_at)
				 values ('tweet_uncommitted_publication', 'profile_me', 'new generation',
				 '2026-08-09T00:20:00.000Z')`,
			)
			.run();
		const scriptPath = path.join(
			makeTempDir("birdclaw-backup-unrelated-head-script-"),
			"crash.mjs",
		);
		const backupModuleUrl = new URL("./backup.ts", import.meta.url).href;
		writeFileSync(
			scriptPath,
			`process.env.BIRDCLAW_HOME = process.argv[2];
			 const { __test__, exportBackup } = await import(${JSON.stringify(backupModuleUrl)});
			 __test__.setAfterPublication(() => process.exit(88));
			 await exportBackup({ repoPath: process.argv[3], commit: true });`,
			"utf8",
		);
		const child = spawn(
			path.resolve("scripts/bun-canary.sh"),
			[scriptPath, home, repoPath],
			{ cwd: path.resolve("."), stdio: "pipe" },
		);
		const exitCode = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", resolve);
		});
		expect(exitCode).toBe(88);
		expect(managedSnapshot()).not.toEqual(before);
		expect(
			execFileSync("git", ["-C", repoPath, "status", "--porcelain"], {
				encoding: "utf8",
			}),
		).toContain("manifest.json");

		const unrelatedPath = path.join(repoPath, "unrelated-note.txt");
		writeFileSync(unrelatedPath, "unrelated HEAD advance\n");
		execFileSync("git", ["-C", repoPath, "add", "unrelated-note.txt"]);
		execFileSync("git", [
			"-C",
			repoPath,
			"commit",
			"-m",
			"test: unrelated commit during backup recovery",
		]);
		const advancedHead = execFileSync(
			"git",
			["-C", repoPath, "rev-parse", "HEAD"],
			{ encoding: "utf8" },
		).trim();

		await expect(
			importBackup({ repoPath, db: getNativeDb({ seedDemoData: false }) }),
		).resolves.toMatchObject({ ok: true });
		expect(managedSnapshot()).toEqual(before);
		expect(readFileSync(unrelatedPath, "utf8")).toBe(
			"unrelated HEAD advance\n",
		);
		expect(
			execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
				encoding: "utf8",
			}).trim(),
		).toBe(advancedHead);
		expect(
			execFileSync("git", ["-C", repoPath, "status", "--porcelain"], {
				encoding: "utf8",
			}),
		).toBe("");
		const transactionRoots = await __test__.transactionRootPaths(repoPath);
		expect(
			transactionRoots.some((root) =>
				existsSync(path.join(root, "journal.json")),
			),
		).toBe(false);
	}, 30000);

	it("preserves unrelated staged index state while rolling back publication", async () => {
		const home = switchHome("birdclaw-backup-staged-recovery-home-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-backup-staged-recovery-repo-");
		await exportBackup({ repoPath, commit: true });
		const unrelatedPath = path.join(repoPath, "unrelated-note.txt");
		writeFileSync(unrelatedPath, "base\n");
		execFileSync("git", ["-C", repoPath, "add", "unrelated-note.txt"]);
		execFileSync("git", [
			"-C",
			repoPath,
			"commit",
			"-m",
			"test: add unrelated tracked file",
		]);
		const managedSnapshot = () =>
			new Map(
				[...snapshotTree(repoPath)].filter(
					([relativePath]) =>
						relativePath === ".gitattributes" ||
						relativePath === "README.md" ||
						relativePath === "manifest.json" ||
						relativePath.startsWith(`data${path.sep}`),
				),
			);
		const before = managedSnapshot();
		getNativeDb({ seedDemoData: false })
			.prepare(
				`insert into tweets (id, author_profile_id, text, created_at)
				 values ('tweet_staged_recovery', 'profile_me', 'new generation',
				 '2026-08-09T00:25:00.000Z')`,
			)
			.run();
		const scriptPath = path.join(
			makeTempDir("birdclaw-backup-staged-recovery-script-"),
			"crash.mjs",
		);
		const backupModuleUrl = new URL("./backup.ts", import.meta.url).href;
		writeFileSync(
			scriptPath,
			`process.env.BIRDCLAW_HOME = process.argv[2];
			 const { __test__, exportBackup } = await import(${JSON.stringify(backupModuleUrl)});
			 __test__.setAfterPublication(() => process.exit(89));
			 await exportBackup({ repoPath: process.argv[3], commit: true });`,
			"utf8",
		);
		const child = spawn(
			path.resolve("scripts/bun-canary.sh"),
			[scriptPath, home, repoPath],
			{ cwd: path.resolve("."), stdio: "pipe" },
		);
		const exitCode = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", resolve);
		});
		expect(exitCode).toBe(89);

		writeFileSync(unrelatedPath, "staged change\n");
		execFileSync("git", ["-C", repoPath, "add", "unrelated-note.txt"]);
		const stagedBlob = execFileSync(
			"git",
			["-C", repoPath, "show", ":unrelated-note.txt"],
			{ encoding: "utf8" },
		);
		writeFileSync(unrelatedPath, "unstaged change\n");

		await expect(
			importBackup({ repoPath, db: getNativeDb({ seedDemoData: false }) }),
		).rejects.toThrow("Backup checkout is dirty");
		expect(managedSnapshot()).toEqual(before);
		expect(
			execFileSync("git", ["-C", repoPath, "show", ":unrelated-note.txt"], {
				encoding: "utf8",
			}),
		).toBe(stagedBlob);
		expect(readFileSync(unrelatedPath, "utf8")).toBe("unstaged change\n");
		expect(
			execFileSync("git", ["-C", repoPath, "diff", "--cached", "--name-only"], {
				encoding: "utf8",
			}).trim(),
		).toBe("unrelated-note.txt");
		expect(
			execFileSync("git", ["-C", repoPath, "diff", "--name-only"], {
				encoding: "utf8",
			}).trim(),
		).toBe("unrelated-note.txt");
		const transactionRoots = await __test__.transactionRootPaths(repoPath);
		expect(
			transactionRoots.some((root) =>
				existsSync(path.join(root, "journal.json")),
			),
		).toBe(false);
	}, 30000);

	it("finds a pre-Git crash journal after external Git initialization", async () => {
		const home = switchHome("birdclaw-backup-pre-git-restart-home-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-backup-pre-git-restart-repo-");
		const [preGitTransactionRoot] =
			await __test__.transactionRootPaths(repoPath);
		await exportBackup({ repoPath });
		const before = snapshotTree(repoPath);
		const scriptPath = path.join(
			makeTempDir("birdclaw-backup-pre-git-script-"),
			"crash.mjs",
		);
		const backupModuleUrl = new URL("./backup.ts", import.meta.url).href;
		writeFileSync(
			scriptPath,
			`process.env.BIRDCLAW_HOME = process.argv[2];
			 const { __test__, exportBackup } = await import(${JSON.stringify(backupModuleUrl)});
			 __test__.setAfterPublicationRename((relativePath, phase) => {
			   if (relativePath === "data" && phase === "rollback") process.exit(87);
			 });
			 await exportBackup({ repoPath: process.argv[3] });`,
			"utf8",
		);
		const child = spawn(
			path.resolve("scripts/bun-canary.sh"),
			[scriptPath, home, repoPath],
			{ cwd: path.resolve("."), stdio: "pipe" },
		);
		const exitCode = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", resolve);
		});
		expect(exitCode).toBe(87);
		execFileSync("git", ["-C", repoPath, "init"]);

		await expect(
			importBackup({ repoPath, db: getNativeDb({ seedDemoData: false }) }),
		).rejects.toThrow("Backup checkout is dirty");
		expect(snapshotTree(repoPath)).toEqual(before);
		expect(preGitTransactionRoot && existsSync(preGitTransactionRoot)).toBe(
			false,
		);
		execFileSync("git", ["-C", repoPath, "add", "."]);
		execFileSync("git", [
			"-C",
			repoPath,
			"-c",
			"user.name=Backup Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"-m",
			"test: adopt recovered backup",
		]);
		await expect(
			importBackup({ repoPath, db: getNativeDb({ seedDemoData: false }) }),
		).resolves.toMatchObject({ ok: true });
	}, 30000);

	it("does not report failure when committed-journal cleanup is deferred", async () => {
		switchHome("birdclaw-backup-cleanup-home-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-backup-cleanup-repo-");
		__test__.setBeforeCommittedCleanup(() => {
			throw new Error("synthetic cleanup failure");
		});

		const result = await exportBackup({ repoPath, commit: true });
		expect(result.git?.committed).toBe(true);
		expect(
			execFileSync("git", ["-C", repoPath, "status", "--porcelain"], {
				encoding: "utf8",
			}),
		).toBe("");
		const [transactionRoot] = await __test__.transactionRootPaths(repoPath);
		const journalPath = path.join(transactionRoot!, "journal.json");
		expect(existsSync(journalPath)).toBe(true);

		__test__.setBeforeCommittedCleanup(undefined);
		await importBackup({
			repoPath,
			db: getNativeDb({ seedDemoData: false }),
		});
		expect(existsSync(journalPath)).toBe(false);
	}, 20000);

	it("recovers when rollback cleanup stops after deleting the journal", async () => {
		switchHome("birdclaw-backup-rollback-cleanup-home-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-backup-rollback-cleanup-repo-");
		await exportBackup({ repoPath, commit: true });
		const before = snapshotTree(repoPath);
		__test__.setAfterPublicationRename((relativePath, phase) => {
			if (relativePath === "data" && phase === "install") {
				throw new Error("synthetic publication interruption");
			}
		});
		__test__.setAfterRecoveryCleanupBoundary((boundary) => {
			if (boundary === "journal") {
				throw new Error("synthetic post-journal cleanup interruption");
			}
		});

		await expect(exportBackup({ repoPath })).rejects.toThrow(
			"recovery material remains",
		);
		expect(snapshotTree(repoPath)).toEqual(before);
		const transactionRoot = (await __test__.transactionRootPaths(repoPath))[0]!;
		expect(existsSync(path.join(transactionRoot, "journal.json"))).toBe(false);
		expect(existsSync(transactionRoot)).toBe(true);

		__test__.setAfterPublicationRename(undefined);
		__test__.setAfterRecoveryCleanupBoundary(undefined);
		await expect(exportBackup({ repoPath })).resolves.toMatchObject({
			ok: true,
		});
		expect(existsSync(transactionRoot)).toBe(false);
		expect(snapshotTree(repoPath)).toEqual(before);
	}, 20000);

	it("exports current database changes when a local commit has no push receipt", async () => {
		const remotePath = path.join(
			makeTempDir("birdclaw-no-receipt-remote-"),
			"remote.git",
		);
		execFileSync("git", ["init", "--bare", remotePath]);
		switchHome("birdclaw-no-receipt-home-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-no-receipt-repo-");
		await syncBackup({ repoPath, remote: remotePath });
		const db = getNativeDb({ seedDemoData: false });
		db.prepare(
			`insert into tweets (id, author_profile_id, text, created_at)
			 values ('tweet_local_commit', 'profile_me', 'local commit',
			 '2026-08-09T00:30:00.000Z')`,
		).run();
		const localExport = await exportBackup({ repoPath, commit: true });
		const unpushedHead = execFileSync(
			"git",
			["-C", repoPath, "rev-parse", "HEAD"],
			{ encoding: "utf8" },
		).trim();
		expect(localExport.git).toMatchObject({ committed: true, pushed: false });
		expect(
			(await __test__.pendingPushReceiptPaths(repoPath)).some((receiptPath) =>
				existsSync(receiptPath),
			),
		).toBe(false);
		db.prepare(
			`insert into tweets (id, author_profile_id, text, created_at)
			 values ('tweet_after_local_commit', 'profile_me', 'current database',
			 '2026-08-09T00:45:00.000Z')`,
		).run();
		let databaseOpens = 0;
		__test__.setBeforeDatabaseOpen(() => {
			databaseOpens += 1;
		});

		const synced = await syncBackup({ repoPath, remote: remotePath });
		const syncedHead = execFileSync(
			"git",
			["-C", repoPath, "rev-parse", "HEAD"],
			{ encoding: "utf8" },
		).trim();
		expect(synced.pushOnly).not.toBe(true);
		expect(databaseOpens).toBeGreaterThan(0);
		expect(syncedHead).not.toBe(unpushedHead);
		expect(
			readFileSync(path.join(repoPath, "data", "tweets", "2026.jsonl"), "utf8"),
		).toContain("tweet_after_local_commit");
		expect(
			execFileSync(
				"git",
				["--git-dir", remotePath, "rev-parse", "refs/heads/main"],
				{ encoding: "utf8" },
			).trim(),
		).toBe(syncedHead);
	}, 30000);

	it("retries a receipt-owned first push when origin main remains absent", async () => {
		const remotePath = path.join(
			makeTempDir("birdclaw-empty-push-retry-remote-"),
			"remote.git",
		);
		execFileSync("git", ["init", "--bare", remotePath]);
		const hookPath = path.join(remotePath, "hooks", "pre-receive");
		writeFileSync(hookPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		switchHome("birdclaw-empty-push-retry-home-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-empty-push-retry-repo-");

		await expect(syncBackup({ repoPath, remote: remotePath })).rejects.toThrow(
			"Command failed",
		);
		const receiptPath = (await __test__.pendingPushReceiptPaths(repoPath)).find(
			(candidate) => existsSync(candidate),
		);
		expect(receiptPath).toBeDefined();
		const receipt = JSON.parse(readFileSync(receiptPath!, "utf8")) as {
			commit: string;
			remoteBranch: { kind: string };
		};
		const aheadHead = execFileSync(
			"git",
			["-C", repoPath, "rev-parse", "HEAD"],
			{ encoding: "utf8" },
		).trim();
		expect(receipt).toMatchObject({
			commit: aheadHead,
			remoteBranch: { kind: "absent" },
		});
		expect(
			execFileSync(
				"git",
				[
					"--git-dir",
					remotePath,
					"for-each-ref",
					"--format=%(objectname)",
					"refs/heads/main",
				],
				{ encoding: "utf8" },
			),
		).toBe("");
		const aheadManifest = readFileSync(
			path.join(repoPath, "manifest.json"),
			"utf8",
		);
		getNativeDb({ seedDemoData: false })
			.prepare(
				`insert into tweets (id, author_profile_id, text, created_at)
				 values ('tweet_not_in_empty_retry', 'profile_me', 'must not export',
				 '2026-08-09T00:50:00.000Z')`,
			)
			.run();
		rmSync(hookPath);
		let databaseOpens = 0;
		__test__.setBeforeDatabaseOpen(() => {
			databaseOpens += 1;
		});

		const retried = await syncBackup({ repoPath, remote: remotePath });
		expect(retried.pushOnly).toBe(true);
		expect(retried.imported).toBe(false);
		expect(databaseOpens).toBe(0);
		expect(readFileSync(path.join(repoPath, "manifest.json"), "utf8")).toBe(
			aheadManifest,
		);
		expect(
			execFileSync(
				"git",
				["--git-dir", remotePath, "rev-parse", "refs/heads/main"],
				{ encoding: "utf8" },
			).trim(),
		).toBe(aheadHead);
		expect(existsSync(receiptPath!)).toBe(false);
	}, 30000);

	it("retries only the push after a committed generation failed to push", async () => {
		const remotePath = path.join(
			makeTempDir("birdclaw-push-retry-remote-"),
			"remote.git",
		);
		execFileSync("git", ["init", "--bare", remotePath]);
		switchHome("birdclaw-push-retry-home-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-push-retry-repo-");
		await syncBackup({ repoPath, remote: remotePath });
		getNativeDb({ seedDemoData: false })
			.prepare(
				`insert into tweets (id, author_profile_id, text, created_at)
				 values ('tweet_committed_generation', 'profile_me', 'committed generation',
				 '2026-08-09T01:00:00.000Z')`,
			)
			.run();
		const hookPath = path.join(remotePath, "hooks", "pre-receive");
		writeFileSync(hookPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

		await expect(syncBackup({ repoPath, remote: remotePath })).rejects.toThrow(
			"Command failed",
		);
		const receiptPath = (await __test__.pendingPushReceiptPaths(repoPath)).find(
			(candidate) => existsSync(candidate),
		);
		expect(receiptPath).toBeDefined();
		const receipt = JSON.parse(readFileSync(receiptPath!, "utf8")) as {
			commit: string;
			remote: string;
			remoteRef: string;
			remoteBranch: { kind: string; commit?: string };
		};
		const observedRemoteHead = execFileSync(
			"git",
			["--git-dir", remotePath, "rev-parse", "refs/heads/main"],
			{ encoding: "utf8" },
		).trim();
		const aheadHead = execFileSync(
			"git",
			["-C", repoPath, "rev-parse", "HEAD"],
			{
				encoding: "utf8",
			},
		).trim();
		expect(receipt).toMatchObject({
			commit: aheadHead,
			remote: "origin",
			remoteRef: "refs/heads/main",
			remoteBranch: { kind: "commit", commit: observedRemoteHead },
		});
		const aheadManifest = readFileSync(
			path.join(repoPath, "manifest.json"),
			"utf8",
		);
		const aheadTree = snapshotTree(repoPath);
		const receiptBytes = readFileSync(receiptPath!);
		expect(
			execFileSync("git", ["-C", repoPath, "status", "--porcelain"], {
				encoding: "utf8",
			}),
		).toBe("");
		getNativeDb({ seedDemoData: false })
			.prepare(
				`insert into tweets (id, author_profile_id, text, created_at)
				 values ('tweet_must_not_export', 'profile_me', 'must not be exported',
				 '2026-08-09T02:00:00.000Z')`,
			)
			.run();
		let retryDatabaseOpens = 0;
		__test__.setBeforeDatabaseOpen(() => {
			retryDatabaseOpens += 1;
		});
		let staged = false;
		__test__.setBeforeStagedValidation(() => {
			staged = true;
		});
		await expect(
			exportBackup({ repoPath, commit: true, push: false }),
		).rejects.toThrow("pending push receipt");
		expect(retryDatabaseOpens).toBe(0);
		expect(staged).toBe(false);
		expect(snapshotTree(repoPath)).toEqual(aheadTree);
		expect(readFileSync(receiptPath!)).toEqual(receiptBytes);
		expect(
			execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
				encoding: "utf8",
			}).trim(),
		).toBe(aheadHead);

		rmSync(hookPath);

		const retried = await syncBackup({ repoPath, remote: remotePath });
		expect(retried.imported).toBe(false);
		expect(retried.exportResult.git).toMatchObject({
			committed: false,
			pushed: true,
		});
		expect(staged).toBe(false);
		expect(
			execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
				encoding: "utf8",
			}).trim(),
		).toBe(aheadHead);
		expect(retryDatabaseOpens).toBe(0);
		expect(readFileSync(path.join(repoPath, "manifest.json"), "utf8")).toBe(
			aheadManifest,
		);
		expect(
			execFileSync(
				"git",
				["--git-dir", remotePath, "rev-parse", "refs/heads/main"],
				{ encoding: "utf8" },
			).trim(),
		).toBe(aheadHead);
		expect(existsSync(receiptPath!)).toBe(false);
	}, 30000);

	it("matches pending-push remote identity across credential rotation", async () => {
		const repoPath = makeTempDir("birdclaw-remote-identity-repo-");
		const oldCredential = await __test__.canonicalBackupRemoteIdentity(
			repoPath,
			"https://oldtoken@example.com:443/team/archive.git?access_token=old",
		);
		const newCredential = await __test__.canonicalBackupRemoteIdentity(
			repoPath,
			"https://newtoken:newpassword@example.com/team/archive.git?access_token=new",
		);
		const otherHost = await __test__.canonicalBackupRemoteIdentity(
			repoPath,
			"https://newtoken@other.example.com/team/archive.git",
		);
		const otherPath = await __test__.canonicalBackupRemoteIdentity(
			repoPath,
			"https://newtoken@example.com/team/other.git",
		);
		const tenantA = await __test__.canonicalBackupRemoteIdentity(
			repoPath,
			"https://example.com/team/archive.git?tenant=a&token=one",
		);
		const tenantB = await __test__.canonicalBackupRemoteIdentity(
			repoPath,
			"https://example.com/team/archive.git?token=two&tenant=b",
		);
		const tokenRotation = await __test__.canonicalBackupRemoteIdentity(
			repoPath,
			"https://example.com/team/archive.git?tenant=a&token=rotated",
		);
		const sshAlice = await __test__.canonicalBackupRemoteIdentity(
			repoPath,
			"ssh://alice@example.com:22/team/archive.git",
		);
		const sshBob = await __test__.canonicalBackupRemoteIdentity(
			repoPath,
			"ssh://bob@example.com/team/archive.git",
		);

		expect(newCredential).toBe(oldCredential);
		expect(otherHost).not.toBe(oldCredential);
		expect(otherPath).not.toBe(oldCredential);
		expect(tokenRotation).toBe(tenantA);
		expect(tenantB).not.toBe(tenantA);
		expect(sshBob).not.toBe(sshAlice);
		expect(oldCredential).toMatch(/^[0-9a-f]{64}$/u);
	});

	it("ignores symlinked receipt roots and files while using a safe fallback", async () => {
		const createPendingPush = async (label: string) => {
			const remotePath = path.join(
				makeTempDir(`birdclaw-receipt-symlink-${label}-remote-`),
				"remote.git",
			);
			execFileSync("git", ["init", "--bare", remotePath]);
			switchHome(`birdclaw-receipt-symlink-${label}-home-`);
			seedBackupFixture();
			const repoPath = makeTempDir(`birdclaw-receipt-symlink-${label}-repo-`);
			await syncBackup({ repoPath, remote: remotePath });
			getNativeDb({ seedDemoData: false })
				.prepare(
					`insert into tweets (id, author_profile_id, text, created_at)
					 values (?, 'profile_me', 'pending receipt', '2026-08-09T05:00:00.000Z')`,
				)
				.run(`tweet_receipt_${label}`);
			const hookPath = path.join(remotePath, "hooks", "pre-receive");
			writeFileSync(hookPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
			await expect(
				syncBackup({ repoPath, remote: remotePath }),
			).rejects.toThrow("Command failed");
			rmSync(hookPath);
			const receiptPath = (
				await __test__.pendingPushReceiptPaths(repoPath)
			)[0]!;
			return {
				repoPath,
				remotePath,
				receiptPath,
				receiptBytes: readFileSync(receiptPath),
				roots: await __test__.transactionRootPaths(repoPath),
			};
		};

		const rootCase = await createPendingPush("root");
		const preferredRoot = path.dirname(rootCase.receiptPath);
		const fallbackRoot = rootCase.roots.find(
			(root) => root !== preferredRoot && !existsSync(root),
		)!;
		renameSync(preferredRoot, fallbackRoot);
		const rootVictim = makeTempDir("birdclaw-receipt-root-victim-");
		const rootVictimReceipt = path.join(rootVictim, "pending-push.json");
		writeFileSync(rootVictimReceipt, rootCase.receiptBytes);
		symlinkSync(rootVictim, preferredRoot, "dir");
		await expect(
			syncBackup({ repoPath: rootCase.repoPath, remote: rootCase.remotePath }),
		).resolves.toMatchObject({ pushOnly: true });
		expect(readFileSync(rootVictimReceipt)).toEqual(rootCase.receiptBytes);
		expect(existsSync(path.join(fallbackRoot, "pending-push.json"))).toBe(
			false,
		);

		const fileCase = await createPendingPush("file");
		const filePreferredRoot = path.dirname(fileCase.receiptPath);
		const fileFallbackRoot = fileCase.roots.find(
			(root) => root !== filePreferredRoot && !existsSync(root),
		)!;
		mkdirSync(fileFallbackRoot, { recursive: true, mode: 0o700 });
		writeFileSync(
			path.join(fileFallbackRoot, "pending-push.json"),
			fileCase.receiptBytes,
			{ mode: 0o600 },
		);
		rmSync(fileCase.receiptPath);
		const fileVictim = path.join(
			makeTempDir("birdclaw-receipt-file-victim-"),
			"victim-receipt.json",
		);
		writeFileSync(fileVictim, fileCase.receiptBytes);
		symlinkSync(fileVictim, fileCase.receiptPath);
		await expect(
			syncBackup({ repoPath: fileCase.repoPath, remote: fileCase.remotePath }),
		).resolves.toMatchObject({ pushOnly: true });
		expect(readFileSync(fileVictim)).toEqual(fileCase.receiptBytes);
		expect(existsSync(path.join(fileFallbackRoot, "pending-push.json"))).toBe(
			false,
		);
	}, 60000);

	it("refuses push-only recovery for mismatched receipts and divergence", async () => {
		const createFailedPushState = async (label: string) => {
			const remotePath = path.join(
				makeTempDir(`birdclaw-receipt-${label}-remote-`),
				"remote.git",
			);
			execFileSync("git", ["init", "--bare", remotePath]);
			switchHome(`birdclaw-receipt-${label}-home-`);
			seedBackupFixture();
			const repoPath = makeTempDir(`birdclaw-receipt-${label}-repo-`);
			await syncBackup({ repoPath, remote: remotePath });
			getNativeDb({ seedDemoData: false })
				.prepare(
					`insert into tweets (id, author_profile_id, text, created_at)
					 values (?, 'profile_me', ?, '2026-08-09T04:00:00.000Z')`,
				)
				.run(`tweet_${label}`, label);
			const hookPath = path.join(remotePath, "hooks", "pre-receive");
			writeFileSync(hookPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
			try {
				await expect(
					syncBackup({ repoPath, remote: remotePath }),
				).rejects.toThrow("Command failed");
			} finally {
				rmSync(hookPath, { force: true });
			}
			const receiptPath = (
				await __test__.pendingPushReceiptPaths(repoPath)
			).find((candidate) => existsSync(candidate));
			expect(receiptPath).toBeDefined();
			return { remotePath, repoPath, receiptPath: receiptPath! };
		};

		const mismatchedCommit = await createFailedPushState("commit_mismatch");
		writeFileSync(
			path.join(mismatchedCommit.repoPath, "local-note.txt"),
			"new local head\n",
		);
		execFileSync("git", [
			"-C",
			mismatchedCommit.repoPath,
			"add",
			"local-note.txt",
		]);
		execFileSync("git", [
			"-C",
			mismatchedCommit.repoPath,
			"commit",
			"-m",
			"test: change head after failed push",
		]);
		let databaseOpens = 0;
		__test__.setBeforeDatabaseOpen(() => {
			databaseOpens += 1;
		});
		await expect(
			syncBackup({ repoPath: mismatchedCommit.repoPath }),
		).rejects.toThrow("receipt does not match local HEAD");
		expect(databaseOpens).toBe(0);
		expect(existsSync(mismatchedCommit.receiptPath)).toBe(true);

		__test__.setBeforeDatabaseOpen(undefined);
		const mismatchedRemote = await createFailedPushState("remote_mismatch");
		const otherRemotePath = path.join(
			makeTempDir("birdclaw-receipt-other-remote-"),
			"remote.git",
		);
		execFileSync("git", ["init", "--bare", otherRemotePath]);
		execFileSync("git", [
			"-C",
			mismatchedRemote.repoPath,
			"remote",
			"set-url",
			"origin",
			otherRemotePath,
		]);
		databaseOpens = 0;
		__test__.setBeforeDatabaseOpen(() => {
			databaseOpens += 1;
		});
		await expect(
			syncBackup({ repoPath: mismatchedRemote.repoPath }),
		).rejects.toThrow("receipt does not match origin/main");
		expect(databaseOpens).toBe(0);
		expect(existsSync(mismatchedRemote.receiptPath)).toBe(true);

		__test__.setBeforeDatabaseOpen(undefined);
		const diverged = await createFailedPushState("diverged");
		const otherPath = makeTempDir("birdclaw-receipt-diverged-other-");
		rmSync(otherPath, { recursive: true, force: true });
		execFileSync("git", [
			"clone",
			"-b",
			"main",
			diverged.remotePath,
			otherPath,
		]);
		execFileSync("git", [
			"-C",
			otherPath,
			"config",
			"user.email",
			"test@example.invalid",
		]);
		execFileSync("git", [
			"-C",
			otherPath,
			"config",
			"user.name",
			"Backup Test",
		]);
		writeFileSync(path.join(otherPath, "remote-note.txt"), "remote side\n");
		execFileSync("git", ["-C", otherPath, "add", "remote-note.txt"]);
		execFileSync("git", [
			"-C",
			otherPath,
			"commit",
			"-m",
			"test: diverge after failed push",
		]);
		execFileSync("git", ["-C", otherPath, "push", "origin", "HEAD:main"]);
		databaseOpens = 0;
		__test__.setBeforeDatabaseOpen(() => {
			databaseOpens += 1;
		});
		await expect(syncBackup({ repoPath: diverged.repoPath })).rejects.toThrow(
			"histories have diverged",
		);
		expect(databaseOpens).toBe(0);
		expect(existsSync(diverged.receiptPath)).toBe(true);
	}, 90000);

	it("fails closed when local and remote backup histories diverge", async () => {
		const remotePath = path.join(
			makeTempDir("birdclaw-diverged-remote-"),
			"remote.git",
		);
		execFileSync("git", ["init", "--bare", remotePath]);
		switchHome("birdclaw-diverged-home-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-diverged-repo-");
		await syncBackup({ repoPath, remote: remotePath });
		writeFileSync(path.join(repoPath, "local-note.txt"), "local\n");
		execFileSync("git", ["-C", repoPath, "add", "local-note.txt"]);
		execFileSync("git", ["-C", repoPath, "commit", "-m", "test: local side"]);

		const otherPath = makeTempDir("birdclaw-diverged-other-");
		rmSync(otherPath, { recursive: true, force: true });
		execFileSync("git", ["clone", "-b", "main", remotePath, otherPath]);
		execFileSync("git", [
			"-C",
			otherPath,
			"config",
			"user.email",
			"test@example.invalid",
		]);
		execFileSync("git", [
			"-C",
			otherPath,
			"config",
			"user.name",
			"Backup Test",
		]);
		writeFileSync(path.join(otherPath, "remote-note.txt"), "remote\n");
		execFileSync("git", ["-C", otherPath, "add", "remote-note.txt"]);
		execFileSync("git", ["-C", otherPath, "commit", "-m", "test: remote side"]);
		execFileSync("git", ["-C", otherPath, "push", "origin", "HEAD:main"]);
		let divergedDatabaseOpens = 0;
		__test__.setBeforeDatabaseOpen(() => {
			divergedDatabaseOpens += 1;
		});

		await expect(syncBackup({ repoPath, remote: remotePath })).rejects.toThrow(
			"histories have diverged",
		);
		expect(divergedDatabaseOpens).toBe(0);
	}, 30000);

	it("validates a fetched fast-forward before changing the live checkout", async () => {
		const remotePath = path.join(
			makeTempDir("birdclaw-corrupt-remote-"),
			"remote.git",
		);
		execFileSync("git", ["init", "--bare", remotePath]);
		switchHome("birdclaw-corrupt-home-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-corrupt-repo-");
		await syncBackup({ repoPath, remote: remotePath });
		const originalHead = execFileSync(
			"git",
			["-C", repoPath, "rev-parse", "HEAD"],
			{
				encoding: "utf8",
			},
		).trim();
		const originalTree = snapshotTree(repoPath);

		const otherPath = makeTempDir("birdclaw-corrupt-other-");
		rmSync(otherPath, { recursive: true, force: true });
		execFileSync("git", ["clone", "-b", "main", remotePath, otherPath]);
		execFileSync("git", [
			"-C",
			otherPath,
			"config",
			"user.email",
			"test@example.invalid",
		]);
		execFileSync("git", [
			"-C",
			otherPath,
			"config",
			"user.name",
			"Backup Test",
		]);
		appendFileSync(path.join(otherPath, "data", "profiles.jsonl"), "{}\n");
		execFileSync("git", ["-C", otherPath, "add", "data/profiles.jsonl"]);
		execFileSync("git", [
			"-C",
			otherPath,
			"commit",
			"-m",
			"test: corrupt remote backup",
		]);
		execFileSync("git", ["-C", otherPath, "push", "origin", "HEAD:main"]);

		await expect(syncBackup({ repoPath, remote: remotePath })).rejects.toThrow(
			"Fetched backup commit is invalid",
		);
		expect(
			execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
				encoding: "utf8",
			}).trim(),
		).toBe(originalHead);
		expect(snapshotTree(repoPath)).toEqual(originalTree);

		execFileSync("git", [
			"--git-dir",
			remotePath,
			"update-ref",
			"refs/heads/main",
			originalHead,
		]);
		await expect(
			syncBackup({ repoPath, remote: remotePath }),
		).resolves.toMatchObject({
			ok: true,
			pulled: false,
		});
	}, 30000);

	it("validates a fresh main-default remote before creating the checkout", async () => {
		const remotePath = path.join(
			makeTempDir("birdclaw-fresh-corrupt-remote-"),
			"remote.git",
		);
		execFileSync("git", ["init", "--bare", remotePath]);
		switchHome("birdclaw-fresh-corrupt-source-home-");
		seedBackupFixture();
		const sourcePath = makeTempDir("birdclaw-fresh-corrupt-source-");
		await syncBackup({ repoPath: sourcePath, remote: remotePath });
		const validHead = execFileSync(
			"git",
			["--git-dir", remotePath, "rev-parse", "refs/heads/main"],
			{ encoding: "utf8" },
		).trim();

		const otherPath = makeTempDir("birdclaw-fresh-corrupt-other-");
		rmSync(otherPath, { recursive: true, force: true });
		execFileSync("git", ["clone", "-b", "main", remotePath, otherPath]);
		execFileSync("git", [
			"-C",
			otherPath,
			"config",
			"user.email",
			"test@example.invalid",
		]);
		execFileSync("git", [
			"-C",
			otherPath,
			"config",
			"user.name",
			"Backup Test",
		]);
		rmSync(path.join(otherPath, "README.md"));
		mkdirSync(path.join(otherPath, "README.md"));
		writeFileSync(path.join(otherPath, "README.md", "note"), "invalid\n");
		execFileSync("git", ["-C", otherPath, "add", "-A"]);
		execFileSync("git", [
			"-C",
			otherPath,
			"commit",
			"-m",
			"test: corrupt fresh remote backup",
		]);
		execFileSync("git", ["-C", otherPath, "push", "origin", "HEAD:main"]);
		execFileSync("git", [
			"--git-dir",
			remotePath,
			"symbolic-ref",
			"HEAD",
			"refs/heads/main",
		]);

		const freshPath = makeTempDir("birdclaw-fresh-corrupt-checkout-");
		rmSync(freshPath, { recursive: true, force: true });
		switchHome("birdclaw-fresh-corrupt-destination-home-");
		await expect(
			syncBackup({ repoPath: freshPath, remote: remotePath }),
		).rejects.toThrow("Fetched backup commit contains an invalid managed path");
		expect(existsSync(path.join(freshPath, ".git"))).toBe(true);
		expect(() =>
			execFileSync("git", ["-C", freshPath, "rev-parse", "--verify", "HEAD"]),
		).toThrow("Command failed");
		expect(existsSync(path.join(freshPath, "manifest.json"))).toBe(false);
		expect(existsSync(path.join(freshPath, "data"))).toBe(false);

		execFileSync("git", [
			"--git-dir",
			remotePath,
			"update-ref",
			"refs/heads/main",
			validHead,
		]);
		await expect(
			syncBackup({ repoPath: freshPath, remote: remotePath }),
		).resolves.toMatchObject({ ok: true });
		expect(
			execFileSync("git", ["-C", freshPath, "rev-parse", "HEAD"], {
				encoding: "utf8",
			}).trim(),
		).toBe(validHead);
	}, 30000);

	it("streams fetched backup shards larger than the former restoration ceiling", async () => {
		const remotePath = path.join(
			makeTempDir("birdclaw-large-remote-"),
			"remote.git",
		);
		execFileSync("git", ["init", "--bare", remotePath]);
		switchHome("birdclaw-large-source-home-");
		seedBackupFixture();
		const sourceDb = getNativeDb({ seedDemoData: false });
		sourceDb
			.prepare("update profiles set raw_json = ? where id = 'profile_friend'")
			.run(
				JSON.stringify({
					id: "friend",
					padding: "x".repeat(50 * 1024 * 1024),
				}),
			);
		const sourcePath = makeTempDir("birdclaw-large-source-");
		execFileSync("git", ["-C", sourcePath, "init"]);
		execFileSync("git", [
			"-C",
			sourcePath,
			"remote",
			"add",
			"origin",
			remotePath,
		]);
		await exportBackup({
			repoPath: sourcePath,
			db: sourceDb,
			commit: true,
			push: true,
			maxShardBytes: 64 * 1024 * 1024,
		});
		expect(
			statSync(path.join(sourcePath, "data", "profiles.jsonl")).size,
		).toBeGreaterThan(49 * 1024 * 1024);

		switchHome("birdclaw-large-destination-home-");
		const destinationPath = makeTempDir("birdclaw-large-destination-");
		const result = await Effect.runPromise(
			updateBackupFromGitEffect({
				repoPath: destinationPath,
				remote: remotePath,
			}),
		);
		expect(result.imported).toBe(true);
		expect(result.importResult?.validation?.ok).toBe(true);
	}, 120000);

	it("rejects NUL-safe fetched inventory with a newline managed path", async () => {
		const remotePath = path.join(
			makeTempDir("birdclaw-newline-remote-"),
			"remote.git",
		);
		execFileSync("git", ["init", "--bare", remotePath]);
		switchHome("birdclaw-newline-home-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-newline-repo-");
		await syncBackup({ repoPath, remote: remotePath });
		const originalHead = execFileSync(
			"git",
			["-C", repoPath, "rev-parse", "HEAD"],
			{
				encoding: "utf8",
			},
		).trim();
		const originalTree = snapshotTree(repoPath);
		const otherPath = makeTempDir("birdclaw-newline-other-");
		rmSync(otherPath, { recursive: true, force: true });
		execFileSync("git", ["clone", "-b", "main", remotePath, otherPath]);
		execFileSync("git", [
			"-C",
			otherPath,
			"config",
			"user.email",
			"test@example.invalid",
		]);
		execFileSync("git", [
			"-C",
			otherPath,
			"config",
			"user.name",
			"Backup Test",
		]);
		const maliciousPath = path.join(
			otherPath,
			"data",
			"malicious\nentry.jsonl",
		);
		writeFileSync(maliciousPath, "{}\n");
		execFileSync("git", ["-C", otherPath, "add", "--", maliciousPath]);
		execFileSync("git", [
			"-C",
			otherPath,
			"commit",
			"-m",
			"test: malicious managed path",
		]);
		execFileSync("git", ["-C", otherPath, "push", "origin", "HEAD:main"]);

		await expect(syncBackup({ repoPath, remote: remotePath })).rejects.toThrow(
			"unsafe managed path",
		);
		expect(
			execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
				encoding: "utf8",
			}).trim(),
		).toBe(originalHead);
		expect(snapshotTree(repoPath)).toEqual(originalTree);
	}, 30000);

	it("pushes backup commits to origin main despite upstream misdirection", async () => {
		const originPath = path.join(makeTempDir("birdclaw-origin-"), "origin.git");
		const upstreamPath = path.join(
			makeTempDir("birdclaw-upstream-"),
			"upstream.git",
		);
		execFileSync("git", ["init", "--bare", originPath]);
		execFileSync("git", ["init", "--bare", upstreamPath]);
		switchHome("birdclaw-push-origin-home-");
		seedBackupFixture();
		const repoPath = makeTempDir("birdclaw-push-origin-repo-");
		await syncBackup({ repoPath, remote: originPath });
		const firstHead = execFileSync(
			"git",
			["-C", repoPath, "rev-parse", "HEAD"],
			{
				encoding: "utf8",
			},
		).trim();
		execFileSync("git", [
			"-C",
			repoPath,
			"remote",
			"add",
			"upstream",
			upstreamPath,
		]);
		execFileSync("git", [
			"-C",
			repoPath,
			"config",
			"branch.main.remote",
			"upstream",
		]);
		execFileSync("git", [
			"-C",
			repoPath,
			"config",
			"remote.pushDefault",
			"upstream",
		]);
		getNativeDb({ seedDemoData: false })
			.prepare(
				`insert into tweets (id, author_profile_id, text, created_at)
				 values ('tweet_origin_only', 'profile_me', 'origin only',
				 '2026-08-09T03:00:00.000Z')`,
			)
			.run();

		await syncBackup({ repoPath, remote: originPath });
		const secondHead = execFileSync(
			"git",
			["-C", repoPath, "rev-parse", "HEAD"],
			{
				encoding: "utf8",
			},
		).trim();
		expect(secondHead).not.toBe(firstHead);
		expect(
			execFileSync(
				"git",
				["--git-dir", originPath, "rev-parse", "refs/heads/main"],
				{ encoding: "utf8" },
			).trim(),
		).toBe(secondHead);
		expect(() =>
			execFileSync("git", [
				"--git-dir",
				upstreamPath,
				"rev-parse",
				"refs/heads/main",
			]),
		).toThrow("Command failed");
	}, 30000);

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

	it("imports a changed automatic backup once and skips an unchanged manifest", async () => {
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
						staleAfterSeconds: 0,
					},
				}),
			);

			const first = await maybeAutoUpdateBackup();

			expect(first).toMatchObject({
				ok: true,
				enabled: true,
				skipped: false,
				imported: true,
				backupHash: expect.any(String),
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
				reason: "backup auto-sync manifest is unchanged",
				imported: false,
				backupHash: first.backupHash,
			});
		} finally {
			if (previousAutoSyncEnv === undefined) {
				delete process.env.BIRDCLAW_BACKUP_AUTO_SYNC;
			} else {
				process.env.BIRDCLAW_BACKUP_AUTO_SYNC = previousAutoSyncEnv;
			}
		}
	}, 20000);

	it("requests web backup updates without blocking or rejecting the caller", async () => {
		const previousAutoSyncEnv = process.env.BIRDCLAW_BACKUP_AUTO_SYNC;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.useFakeTimers();
		try {
			process.env.BIRDCLAW_BACKUP_AUTO_SYNC = "1";
			switchHome("birdclaw-auto-background-");
			writeFileSync(path.join(testHome().root, "config.json"), "{bad");
			resetBirdclawPathsForTests();

			expect(requestBackupAutoUpdate()).toBeUndefined();
			expect(requestBackupAutoUpdate()).toBeUndefined();
			expect(errorSpy).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(5_000);
			await Promise.resolve();
			expect(errorSpy).toHaveBeenCalledTimes(1);
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining("birdclaw backup auto-sync failed"),
			);
		} finally {
			vi.useRealTimers();
			errorSpy.mockRestore();
			if (previousAutoSyncEnv === undefined) {
				delete process.env.BIRDCLAW_BACKUP_AUTO_SYNC;
			} else {
				process.env.BIRDCLAW_BACKUP_AUTO_SYNC = previousAutoSyncEnv;
			}
		}
	});

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
