// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

	const insertTweet = db.prepare(`
    insert into tweets (
      id, author_profile_id, text, created_at, is_replied, reply_to_id,
      like_count, media_count, entities_json, media_json, quoted_tweet_id
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', null)
  `);
	insertTweet.run(
		"tweet_root",
		"profile_research_sam",
		"Check https://t.co/demo with @researchlee",
		"2026-05-01T10:00:00.000Z",
		0,
		null,
		12,
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
	);
	insertTweet.run(
		"tweet_reply_1",
		"profile_research_lee",
		"I agree",
		"2026-05-01T10:05:00.000Z",
		1,
		"tweet_root",
		2,
		0,
		"{}",
	);
	insertTweet.run(
		"tweet_reply_2",
		"profile_research_jules",
		"Follow-up with details",
		"2026-05-01T10:10:00.000Z",
		1,
		"tweet_reply_1",
		3,
		0,
		"{}",
	);
	insertTweet.run(
		"tweet_reply_3",
		"profile_research_lee",
		"Another branch",
		"2026-05-01T10:06:00.000Z",
		1,
		"tweet_root",
		1,
		0,
		"{}",
	);

	db.prepare(
		`insert into tweet_collections (
			account_id, tweet_id, kind, collected_at, source, raw_json, updated_at
		) values (?, ?, 'bookmarks', ?, 'fixture', '{}', ?)`,
	).run(
		"acct_research",
		"tweet_root",
		"2026-05-01T10:00:00.000Z",
		"2026-05-01T10:00:00.000Z",
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

	it("keeps active research replies below a hidden intermediate reply", async () => {
		getNativeDb()
			.prepare(
				"update tweets set deleted_at = '2026-05-02T00:00:00.000Z' where id = 'tweet_reply_1'",
			)
			.run();
		const { runResearchMode } = await import("./research");

		const report = await runResearchMode({
			account: "acct_research",
			limit: 5,
			maxThreadDepth: 6,
		});

		expect(report.items[0]?.thread.map((node) => node.id)).toEqual([
			"tweet_root",
			"tweet_reply_3",
			"tweet_reply_2",
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

	it("builds research reports lazily as Effect programs", async () => {
		const { runEffectPromise } = await import("./effect-runtime");
		const { runResearchModeEffect } = await import("./research");
		const outputPath = path.join(
			process.env.BIRDCLAW_HOME ?? "",
			"lazy-brief.md",
		);

		const effect = runResearchModeEffect({
			account: "acct_research",
			limit: 1,
			maxThreadDepth: 4,
			outPath: outputPath,
		});

		expect(existsSync(outputPath)).toBe(false);
		const report = await runEffectPromise(effect);
		expect(report.seedCount).toBe(1);
		expect(readFileSync(outputPath, "utf8")).toContain("Birdclaw Research");
	});

	it("normalizes research helper edge cases", async () => {
		const { __test__ } = await import("./research");
		const baseRow = {
			id: "tweet_helper",
			account_id: "acct_research",
			account_handle: "@researchsam",
			kind: "home",
			text: "Ship https://t.co/demo with @someone #tag",
			created_at: "2026-05-01T12:00:00.000Z",
			is_replied: 0,
			like_count: 0,
			bookmarked: 0,
			liked: 0,
			reply_to_id: null,
			quoted_tweet_id: null,
			entities_json: JSON.stringify({
				mentions: [null, { username: "someone", start: 28, end: 36 }],
				urls: [
					null,
					{
						url: "https://t.co/demo",
						expandedUrl: "https://example.com",
						displayUrl: "example.com",
						start: 5,
						end: 22,
					},
				],
				hashtags: [null, { tag: "tag", start: 37, end: 41 }],
			}),
			author_handle: "researchsam",
			author_name: "Research Sam",
			author_bio: "",
			author_followers_count: 0,
			author_avatar_hue: 10,
			author_avatar_url: null,
			author_created_at: "2026-05-01T00:00:00.000Z",
		};

		expect(__test__.parseJsonField("", { fallback: true })).toEqual({
			fallback: true,
		});
		expect(__test__.parseJsonField("{bad json", ["fallback"])).toEqual([
			"fallback",
		]);
		expect(__test__.normalizeTweetEntities(null)).toEqual({});
		expect(
			__test__.normalizeTweetEntities({
				mentions: "bad",
				urls: "bad",
				hashtags: "bad",
			}),
		).toEqual({});
		expect(
			__test__.normalizeTweetEntities({
				mentions: [{ username: "camel", id: 42 }],
				urls: [
					{
						url: "https://t.co/snake",
						expanded_url: "https://snake.example",
						display_url: "snake.example",
					},
				],
				hashtags: [{ tag: "snake" }],
			}),
		).toEqual({
			mentions: [
				{
					username: "camel",
					id: undefined,
					start: 0,
					end: 0,
				},
			],
			urls: [
				{
					url: "https://t.co/snake",
					expandedUrl: "https://snake.example",
					displayUrl: "snake.example",
					start: 0,
					end: 0,
				},
			],
			hashtags: [
				{
					tag: "snake",
					start: 0,
					end: 0,
				},
			],
		});

		const node = __test__.toResearchNode(baseRow, "local");
		const fallbackNode = __test__.toResearchNode(
			{
				...baseRow,
				id: "tweet_fallback",
				like_count: null as unknown as number,
				author_followers_count: null as unknown as number,
				author_avatar_hue: null as unknown as number,
				author_avatar_url: "https://example.com/avatar.jpg",
				thread_depth: undefined,
			},
			"live",
		);
		const liveDuplicate = { ...node, source: "live" as const };
		const localDuplicate = { ...node, source: "local" as const };
		const sibling = {
			...node,
			id: "tweet_sibling",
			replyToTweetId: "tweet_helper",
			createdAt: "2026-05-01T12:01:00.000Z",
		};
		const orphan = {
			...node,
			id: "tweet_orphan",
			replyToTweetId: "missing",
			threadDepth: -1,
			createdAt: "2026-05-01T11:59:00.000Z",
		};

		expect(node.markdown).toContain("https://example.com");
		expect(fallbackNode).toEqual(
			expect.objectContaining({
				likeCount: 0,
				threadDepth: 0,
				source: "live",
			}),
		);
		expect(__test__.dedupeNodes([liveDuplicate, localDuplicate])).toEqual([
			localDuplicate,
		]);
		expect(
			__test__
				.orderThreadNodes("tweet_helper", [sibling, orphan, node])
				.map((item) => [item.id, item.threadDepth]),
		).toEqual([
			["tweet_helper", 0],
			["tweet_sibling", 1],
			["tweet_orphan", 0],
		]);
		expect(__test__.collectExternalLinks([node])).toEqual([
			"https://example.com",
		]);
		expect(__test__.collectHandles([node])).toEqual([
			"@researchsam",
			"@someone",
		]);
		expect(
			__test__.renderReportMarkdown({
				generatedAt: "2026-05-01T12:00:00.000Z",
				seedCount: 1,
				threadCount: 1,
				items: [
					{
						seedTweetId: node.id,
						seedUrl: node.url,
						seedText: node.plainText,
						threadRootId: node.id,
						thread: [node],
						links: [],
						handles: [],
					},
				],
			}),
		).toContain("- Query: (all bookmarks)");
		expect(
			__test__.renderReportMarkdown({
				query: "snake",
				account: "acct_research",
				generatedAt: "2026-05-01T12:00:00.000Z",
				seedCount: 1,
				threadCount: 1,
				items: [
					{
						seedTweetId: node.id,
						seedUrl: node.url,
						seedText: node.plainText,
						threadRootId: node.id,
						thread: [node],
						links: ["https://example.com"],
						handles: ["@researchsam"],
					},
				],
			}),
		).toContain("- Query: `snake`");
	});
});
