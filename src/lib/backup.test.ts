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
import { afterEach, describe, expect, it } from "vitest";
import {
	exportBackup,
	getBackupDatabaseFingerprint,
	importBackup,
	maybeAutoSyncBackup,
	maybeAutoUpdateBackup,
	syncBackup,
	validateBackup,
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
    delete from ai_scores;
    delete from tweet_actions;
    delete from tweet_collections;
    delete from blocks;
    delete from mutes;
    delete from dm_fts;
    delete from tweets_fts;
    delete from dm_messages;
    delete from dm_conversations;
    delete from tweets;
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
      id, handle, display_name, bio, followers_count, avatar_hue, avatar_url, created_at
    ) values
      ('profile_me', 'steipete', 'Peter Steinberger', 'Local-first builder', 1000, 42, 'https://img.example/me.jpg', '2009-03-19T22:54:05.000Z'),
      ('profile_friend', 'friend', 'Friend', 'Sends useful DMs', 50, 210, null, '2025-01-01T00:00:00.000Z');

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
  `);
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
			tweets: 3,
			collections_bookmarks: 1,
			collections_likes: 2,
			dm_conversations: 1,
			dm_messages: 2,
			blocks: 1,
			mutes: 1,
			tweet_actions: 1,
			ai_scores: 1,
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
			readFileSync(path.join(repoPath, "data/tweets/2025.jsonl"), "utf8"),
		).toContain('"bookmarked":1');

		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-backup-dst-");
		const imported = await importBackup({ repoPath, mode: "replace" });
		const after = getBackupDatabaseFingerprint();

		expect(imported.mode).toBe("replace");
		expect(imported.validation?.ok).toBe(true);
		expect(after).toEqual(before);
		expect(imported.fingerprint).toEqual(before);

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
		const second = await syncBackup({
			repoPath: makeTempDir("birdclaw-sync-other-"),
			remote: remotePath,
			message: "archive: roundtrip backup",
		});

		expect(second.imported).toBe(true);
		expect(second.importResult?.validation?.ok).toBe(true);
		expect(
			getNativeDb()
				.prepare(
					"select count(*) as count from tweets where id in ('tweet_2024', 'tweet_2025', 'tweet_unknown_date')",
				)
				.get(),
		).toEqual({ count: 3 });
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
