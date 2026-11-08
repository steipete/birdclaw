// @vitest-environment node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTestHome } from "../test/test-home";
import {
	__test__,
	exportBackup,
	getBackupDatabaseFingerprint,
	importBackup,
	validateBackup,
} from "./backup";

const testHome = useTestHome({
	prefix: "birdclaw-backup-validation-",
	seedDemoData: false,
});
afterEach(() => __test__.setBeforeDatabaseOpen(undefined));

describe("backup input validation", () => {
	it.each(
		[undefined, "8", 1.5, {}, [8], true, null, 0, 9].map((version) => ({
			version,
		})),
	)(
		"rejects malformed or unsupported schema version $version before import",
		async ({ version }) => {
			const { db, makeTempDir } = testHome();
			const repoPath = makeTempDir("birdclaw-schema-");
			await exportBackup({ repoPath, db });
			const manifestPath = path.join(repoPath, "manifest.json");
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			manifest.schemaVersion = version;
			writeFileSync(manifestPath, JSON.stringify(manifest));
			const before = getBackupDatabaseFingerprint(db);
			const validation = await validateBackup(repoPath);
			expect(validation.ok).toBe(false);
			expect(validation.errors.join(" ")).toContain(
				"Unsupported backup schema version",
			);
			await expect(
				importBackup({ repoPath, db, mode: "replace" }),
			).rejects.toThrow("Unsupported backup schema version");
			expect(getBackupDatabaseFingerprint(db)).toEqual(before);
		},
	);
	it.each([1, 8])(
		"accepts supported integer schema version %i for an empty archive",
		async (version) => {
			const { db, makeTempDir } = testHome();
			const repoPath = makeTempDir("birdclaw-schema-valid-");
			await exportBackup({ repoPath, db });
			const manifestPath = path.join(repoPath, "manifest.json");
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			manifest.schemaVersion = version;
			writeFileSync(manifestPath, JSON.stringify(manifest));
			expect((await validateBackup(repoPath)).ok).toBe(true);
			await expect(importBackup({ repoPath, db })).resolves.toMatchObject({
				ok: true,
			});
		},
	);
	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects shard limit %s before opening the database or creating the export directory",
		async (maxShardBytes) => {
			const home = testHome();
			const repoPath = path.join(
				home.makeTempDir("birdclaw-invalid-export-"),
				"new-backup",
			);
			const opened = vi.fn();
			__test__.setBeforeDatabaseOpen(opened);
			await expect(exportBackup({ repoPath, maxShardBytes })).rejects.toThrow(
				"Backup shard byte limit must be a positive integer",
			);
			expect(opened).not.toHaveBeenCalled();
			expect(existsSync(repoPath)).toBe(false);
		},
	);
});
