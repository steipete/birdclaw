// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
	insertTestAccount,
	insertTestProfile,
	insertTestTweet,
	useTestHome,
} from "../test/test-home";
import { exportBackup, importBackup } from "./backup";
import {
	BACKUP_TABLE_CODECS,
	buildBackupShardsFromRowSets,
	countBackupFiles,
	type BackupJsonRecord,
} from "./backup-table-codecs";
import { reassembleBackupRows } from "./backup-layout";
import { recordProfileSnapshot } from "./profile-history";
const home = useTestHome();
const hash = (content: string) =>
	createHash("sha256").update(content).digest("hex");

it("imports schema 8, migrates on export, and restores schema 9 byte-identically", async () => {
	const h = home();
	insertTestAccount(h.db);
	insertTestProfile(h.db);
	insertTestTweet(h.db);
	recordProfileSnapshot(h.db, "profile:test", "bird", "2026-01-01T00:00:00Z");
	// Produce a genuine legacy archive through the unchanged schema-8 codecs.
	const legacy = h.makeTempDir();
	const sets = BACKUP_TABLE_CODECS.map((codec) => ({
		logicalName: codec.name,
		rows: h.db.prepare(codec.exportSql).all() as BackupJsonRecord[],
	}));
	const files = [...buildBackupShardsFromRowSets(sets)].map(
		([relativePath, rows]) => {
			const text = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
			mkdirSync(path.dirname(path.join(legacy, relativePath)), {
				recursive: true,
			});
			writeFileSync(path.join(legacy, relativePath), text);
			return {
				path: relativePath,
				rows: rows.length,
				bytes: Buffer.byteLength(text),
				sha256: hash(text),
			};
		},
	);
	writeFileSync(
		path.join(legacy, "manifest.json"),
		JSON.stringify({
			app: "birdclaw",
			schemaVersion: 8,
			generatedAt: "2026-01-01T00:00:00Z",
			files,
			counts: countBackupFiles(files),
			backupHash: hash(
				files
					.map((f) => `${f.path}\t${f.rows}\t${f.bytes}\t${f.sha256}`)
					.sort()
					.join("\n"),
			),
		}),
	);
	h.switchHome();
	await importBackup({ repoPath: legacy, db: h.db });
	const repo = h.makeTempDir();
	const first = await exportBackup({ repoPath: repo, db: h.db });
	expect(first.manifest.schemaVersion).toBe(9);
	const before = new Map(
		[...first.manifest.files.map((f) => f.path), "manifest.json"].map((p) => [
			p,
			readFileSync(path.join(repo, p)),
		]),
	);
	h.switchHome();
	await importBackup({ repoPath: repo, db: h.db, mode: "replace" });
	await exportBackup({ repoPath: repo, db: h.db });
	for (const [p, bytes] of before)
		expect(readFileSync(path.join(repo, p))).toEqual(bytes);
}, 30000);

it("keeps content bytes fixed when only observations change and when a new day arrives", async () => {
	const h = home();
	insertTestAccount(h.db);
	insertTestProfile(h.db);
	insertTestTweet(h.db, { id: "old", createdAt: "2026-01-01T12:00:00Z" });
	recordProfileSnapshot(h.db, "profile:test", "bird", "2026-01-01T12:00:00Z");
	const repo = h.makeTempDir();
	const first = await exportBackup({ repoPath: repo, db: h.db });
	const bodies = new Map(
		first.manifest.files
			.filter((f) => !f.path.includes(".observations."))
			.map((f) => [f.path, readFileSync(path.join(repo, f.path))]),
	);
	h.db.prepare("update tweets set like_count = 20 where id = 'old'").run();
	recordProfileSnapshot(h.db, "profile:test", "bird", "2026-01-02T12:00:00Z");
	insertTestTweet(h.db, { id: "new", createdAt: "2026-01-02T12:00:00Z" });
	await exportBackup({ repoPath: repo, db: h.db });
	for (const [p, bytes] of bodies)
		expect(readFileSync(path.join(repo, p))).toEqual(bytes);
	h.switchHome();
	await importBackup({ repoPath: repo, db: h.db });
	expect(
		h.db.prepare("select like_count from tweets where id = 'old'").get(),
	).toEqual({ like_count: 20 });
	expect(
		h.db.prepare("select last_seen_at from profile_snapshots").get(),
	).toEqual({ last_seen_at: "2026-01-02T12:00:00Z" });
}, 30000);

it("rejects missing, duplicate and orphan observation records rather than losing data", () => {
	const body = { id: "t", text: "retained" },
		observation = { id: "t", like_count: 4 };
	expect(() => reassembleBackupRows("tweets", [body], [])).toThrow("Missing");
	expect(() => reassembleBackupRows("tweets", [], [observation])).toThrow(
		"Orphan",
	);
	expect(() =>
		reassembleBackupRows("tweets", [body], [observation, observation]),
	).toThrow("duplicate");
	expect(() =>
		reassembleBackupRows("tweets", [body, body], [observation]),
	).toThrow("Duplicate");
});
