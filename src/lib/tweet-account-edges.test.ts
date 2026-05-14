// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { upsertTweetAccountEdge } from "./tweet-account-edges";

const tempDirs: string[] = [];

function makeTempHome() {
	const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-edge-"));
	tempDirs.push(tempDir);
	process.env.BIRDCLAW_HOME = tempDir;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
}

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;

	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("tweet account edges", () => {
	it("preserves archive source when live sync upserts the same edge", () => {
		makeTempHome();
		const db = getNativeDb();

		upsertTweetAccountEdge(db, {
			accountId: "acct_primary",
			tweetId: "T1",
			kind: "home",
			source: "archive",
			seenAt: "2026-05-10T12:00:00.000Z",
		});
		upsertTweetAccountEdge(db, {
			accountId: "acct_primary",
			tweetId: "T1",
			kind: "home",
			source: "bird",
			seenAt: "2026-05-11T12:00:00.000Z",
		});

		expect(
			db
				.prepare(
					"select source, seen_count from tweet_account_edges where account_id = ? and tweet_id = ? and kind = ?",
				)
				.get("acct_primary", "T1", "home"),
		).toEqual({ source: "archive", seen_count: 2 });
	});
});
