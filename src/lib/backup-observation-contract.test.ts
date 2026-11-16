// @vitest-environment node
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { it, expect } from "vitest";
import {
	useTestHome,
	insertTestAccount,
	insertTestProfile,
	insertTestTweet,
} from "../test/test-home";
import { exportBackup, importBackup, syncBackup } from "./backup";
import { recordProfileSnapshot } from "./profile-history";
import { NativeSqliteDatabase } from "./sqlite";
const home = useTestHome();
function snapshot(root: string) {
	const files: Record<string, string> = {};
	function visit(dir: string) {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			if (e.name === ".git") continue;
			const p = path.join(dir, e.name);
			if (e.isDirectory()) visit(p);
			else files[path.relative(root, p)] = readFileSync(p, "utf8");
		}
	}
	visit(root);
	return files;
}
it("syncs unchanged data twice without changing bytes or creating a commit", async () => {
	const h = home(),
		db = h.db;
	insertTestAccount(db);
	insertTestProfile(db);
	insertTestTweet(db);
	const remote = h.makeTempDir();
	execFileSync("git", ["init", "--bare", remote]);
	const repo = h.makeTempDir();
	await syncBackup({ repoPath: repo, remote, db });
	const before = snapshot(repo);
	const head = execFileSync("git", [
		"-C",
		repo,
		"rev-parse",
		"HEAD",
	]).toString();
	await syncBackup({ repoPath: repo, remote, db });
	await syncBackup({ repoPath: repo, remote, db });
	expect(snapshot(repo)).toEqual(before);
	expect(
		execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString(),
	).toBe(head);
}, 30000);
it("retains local-only rows and uses later observations when two instances disagree", async () => {
	const h = home();
	let a = h.db;
	const aPath = path.join(h.root, "birdclaw.sqlite");
	insertTestAccount(a);
	insertTestProfile(a, {
		id: "profile_user_42",
		handle: "alice",
		displayName: "A",
		rawJson: '{"id":"42","username":"alice"}',
	});
	insertTestTweet(a, { id: "only-a", authorProfileId: "profile_user_42" });
	recordProfileSnapshot(a, "profile_user_42", "bird", "2026-01-01T00:00:00Z");
	const before = a
		.prepare("select * from profiles where id='profile_user_42'")
		.get();
	// Same profile value at a later time is new freshness evidence.
	recordProfileSnapshot(a, "profile_user_42", "bird", "2026-01-03T00:00:00Z");
	expect(
		a.prepare("select * from profiles where id='profile_user_42'").get(),
	).toEqual(before);
	const ar = h.makeTempDir();
	await exportBackup({ repoPath: ar, db: a });
	h.switchHome();
	const b = h.db;
	insertTestAccount(b);
	insertTestProfile(b, {
		id: "profile_user_42",
		handle: "alice",
		displayName: "B",
		rawJson: '{"id":"42","username":"alice"}',
	});
	insertTestTweet(b, { id: "only-b", authorProfileId: "profile_user_42" });
	recordProfileSnapshot(b, "profile_user_42", "bird", "2026-01-02T00:00:00Z");
	await importBackup({ repoPath: ar, db: b });
	expect(
		b
			.prepare("select display_name from profiles where id='profile_user_42'")
			.get(),
	).toEqual({ display_name: "A" });
	const br = h.makeTempDir();
	await exportBackup({ repoPath: br, db: b });
	a = new NativeSqliteDatabase(aPath);
	try {
		await importBackup({ repoPath: br, db: a });
		expect(a.prepare("select id from tweets order by id").all()).toEqual([
			{ id: "only-a" },
			{ id: "only-b" },
		]);
		const merged = h.makeTempDir();
		await exportBackup({ repoPath: merged, db: a });
		const bytes = snapshot(merged);
		await importBackup({ repoPath: br, db: a });
		await exportBackup({ repoPath: merged, db: a });
		expect(snapshot(merged)).toEqual(bytes);
	} finally {
		a.close();
	}
}, 30000);
