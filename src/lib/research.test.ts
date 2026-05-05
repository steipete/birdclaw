// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";

const tempRoots: string[] = [];

function setupTempHome() {
	const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-research-"));
	tempRoots.push(tempRoot);
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
	return tempRoot;
}

function seedResearchThread() {
	const db = getNativeDb();

	db.prepare(
		"insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at) values (?, ?, ?, ?, ?, ?, ?)",
	).run(
		"acct_research",
		"Primary",
		"@researchsam",
		"42",
		"xurl",
		1,
		"2026-05-01T00:00:00.000Z",
	);

	db.prepare(
		"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, avatar_url, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
	).run(
		"profile_research_sam",
		"researchsam",
		"Research Sam",
		"",
		100,
		10,
		null,
		"2026-05-01T00:00:00.000Z",
	);
	db.prepare(
		"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, avatar_url, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
	).run(
		"profile_research_lee",
		"researchlee",
		"Research Lee",
		"",
		20,
		20,
		null,
		"2026-05-01T00:00:00.000Z",
	);
	db.prepare(
		"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, avatar_url, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
	).run(
		"profile_research_jules",
		"researchjules",
		"Research Jules",
		"",
		30,
		30,
		null,
		"2026-05-01T00:00:00.000Z",
	);

	db.prepare(
		`
      insert into tweets (
        id, account_id, author_profile_id, kind, text, created_at,
        is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
        entities_json, media_json, quoted_tweet_id
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
	).run(
		"tweet_root",
		"acct_research",
		"profile_research_sam",
		"bookmark",
		"Check https://t.co/demo with @researchlee",
		"2026-05-01T10:00:00.000Z",
		0,
		null,
		12,
		0,
		1,
		0,
		JSON.stringify({
			mentions: [
				{
					username: "researchlee",
					id: "profile_research_lee",
					start: 29,
					end: 41,
				},
			],
			urls: [
				{
					url: "https://t.co/demo",
					expanded_url: "https://github.com/steipete/birdclaw",
					display_url: "github.com/steipete/birdclaw",
					start: 6,
					end: 23,
				},
			],
		}),
		"[]",
		null,
	);

	db.prepare(
		`
      insert into tweets (
        id, account_id, author_profile_id, kind, text, created_at,
        is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
        entities_json, media_json, quoted_tweet_id
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
	).run(
		"tweet_reply_1",
		"acct_research",
		"profile_research_lee",
		"home",
		"I agree",
		"2026-05-01T10:05:00.000Z",
		1,
		"tweet_root",
		2,
		0,
		0,
		0,
		"{}",
		"[]",
		null,
	);

	db.prepare(
		`
      insert into tweets (
        id, account_id, author_profile_id, kind, text, created_at,
        is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
        entities_json, media_json, quoted_tweet_id
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
	).run(
		"tweet_reply_2",
		"acct_research",
		"profile_research_jules",
		"home",
		"Follow-up with details",
		"2026-05-01T10:10:00.000Z",
		1,
		"tweet_reply_1",
		3,
		0,
		0,
		0,
		"{}",
		"[]",
		null,
	);

	db.prepare(
		`
      insert into tweets (
        id, account_id, author_profile_id, kind, text, created_at,
        is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
        entities_json, media_json, quoted_tweet_id
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
	).run(
		"tweet_reply_3",
		"acct_research",
		"profile_research_lee",
		"home",
		"Another branch",
		"2026-05-01T10:06:00.000Z",
		1,
		"tweet_root",
		1,
		0,
		0,
		0,
		"{}",
		"[]",
		null,
	);
}

describe("research mode", () => {
	beforeEach(() => {
		setupTempHome();
		seedResearchThread();
	});

	afterEach(() => {
		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		delete process.env.BIRDCLAW_HOME;

		for (const tempRoot of tempRoots.splice(0)) {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	it("expands bookmarked threads into a markdown brief", async () => {
		const { runResearchMode } = await import("./research");

		const report = await runResearchMode({
			account: "acct_research",
			limit: 5,
			maxThreadDepth: 6,
		});

		expect(report.seedCount).toBe(1);
		expect(report.threadCount).toBe(1);
		expect(report.items[0]?.thread.map((node) => node.id)).toEqual([
			"tweet_root",
			"tweet_reply_1",
			"tweet_reply_2",
			"tweet_reply_3",
		]);
		expect(report.items[0]?.links).toContain(
			"https://github.com/steipete/birdclaw",
		);
		expect(report.items[0]?.handles).toContain("@researchlee");
		expect(report.markdown).toContain("# Birdclaw Research");
		expect(report.markdown).toContain("tweet_reply_2");
		expect(report.markdown).toContain("github.com/steipete/birdclaw");
		expect(report.markdown.indexOf("Follow-up with details")).toBeLessThan(
			report.markdown.indexOf("Another branch"),
		);
		expect(report.markdown).toContain(
			"    - [@researchjules](https://x.com/researchjules/status/tweet_reply_2)",
		);
	});

	it("honors the thread depth limit when expanding local descendants", async () => {
		const { runResearchMode } = await import("./research");

		const report = await runResearchMode({
			account: "acct_research",
			limit: 5,
			maxThreadDepth: 1,
		});

		expect(report.items[0]?.thread.map((node) => node.id)).toEqual([
			"tweet_root",
			"tweet_reply_1",
			"tweet_reply_3",
		]);
	});

	it("writes the markdown brief to disk when requested", async () => {
		const { runResearchMode } = await import("./research");
		const outputPath = path.join(process.env.BIRDCLAW_HOME ?? "", "brief.md");

		const report = await runResearchMode({
			account: "acct_research",
			limit: 1,
			maxThreadDepth: 4,
			outPath: outputPath,
		});

		expect(report.seedCount).toBe(1);
		expect(report.markdown).toContain("Birdclaw Research");
		expect(readFileSync(outputPath, "utf8")).toContain("Birdclaw Research");
	});
});
