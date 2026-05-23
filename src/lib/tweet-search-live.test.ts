// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";

const mocks = vi.hoisted(() => ({
	searchTweetsViaBird: vi.fn(),
	searchRecentTweets: vi.fn(),
}));

vi.mock("./bird", async () => ({
	searchTweetsViaBirdEffect: (...args: unknown[]) =>
		Effect.tryPromise({
			try: () => mocks.searchTweetsViaBird(...args),
			catch: (error) =>
				error instanceof Error ? error : new Error(String(error)),
		}),
}));

vi.mock("./xurl", async () => ({
	searchRecentTweetsEffect: (...args: unknown[]) =>
		Effect.tryPromise({
			try: () => mocks.searchRecentTweets(...args),
			catch: (error) =>
				error instanceof Error ? error : new Error(String(error)),
		}),
}));

const tempRoots: string[] = [];

function setupTempHome() {
	const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-search-"));
	tempRoots.push(tempRoot);
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
}

function payload(ids: string[], nextToken?: string) {
	return {
		data: ids.map((id, index) => ({
			id,
			author_id: `user_${id}`,
			text: `Search result ${id} about local-first systems`,
			created_at: `2026-05-2${String(index)}T00:00:00.000Z`,
			conversation_id: id,
			entities: {},
			public_metrics: { like_count: 10 + index },
			edit_history_tweet_ids: [id],
		})),
		includes: {
			users: ids.map((id) => ({
				id: `user_${id}`,
				username: `handle_${id}`,
				name: `Handle ${id}`,
				description: "Search profile",
				public_metrics: { followers_count: 100 },
			})),
		},
		meta: {
			result_count: ids.length,
			page_count: 1,
			...(nextToken ? { next_token: nextToken } : {}),
		},
	};
}

beforeEach(() => {
	setupTempHome();
	mocks.searchTweetsViaBird.mockReset();
	mocks.searchRecentTweets.mockReset();
});

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	vi.clearAllMocks();
	for (const tempRoot of tempRoots.splice(0)) {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

describe("live tweet search sync", () => {
	it("stores bird search results as search edges and FTS rows", async () => {
		mocks.searchTweetsViaBird.mockResolvedValue(payload(["tweet_live_1"]));
		const { syncTweetSearch } = await import("./tweet-search-live");

		const result = await syncTweetSearch({
			query: "local-first",
			mode: "bird",
			refresh: true,
			limit: 100,
		});

		expect(result).toMatchObject({
			ok: true,
			source: "bird",
			count: 1,
			tweetIds: ["tweet_live_1"],
		});
		const db = getNativeDb();
		expect(
			db
				.prepare(
					"select kind, source from tweet_account_edges where tweet_id = ?",
				)
				.get("tweet_live_1"),
		).toEqual({ kind: "search", source: "bird" });
		expect(
			db
				.prepare("select count(*) as count from tweets_fts where tweet_id = ?")
				.get("tweet_live_1"),
		).toEqual({ count: 1 });
	});

	it("paginates xurl search and falls back from auto bird failures", async () => {
		mocks.searchTweetsViaBird.mockRejectedValue(new Error("bird unavailable"));
		mocks.searchRecentTweets
			.mockResolvedValueOnce(payload(["tweet_xurl_1"], "next"))
			.mockResolvedValueOnce(payload(["tweet_xurl_2"]));
		const { syncTweetSearch } = await import("./tweet-search-live");

		const result = await syncTweetSearch({
			query: "local-first",
			mode: "auto",
			refresh: true,
			limit: 150,
			maxPages: 2,
		});

		expect(result).toMatchObject({
			ok: true,
			source: "xurl",
			count: 2,
			tweetIds: ["tweet_xurl_1", "tweet_xurl_2"],
		});
		expect(mocks.searchRecentTweets).toHaveBeenCalledTimes(2);
		expect(
			getNativeDb()
				.prepare(
					"select count(*) as count from tweet_account_edges where kind = 'search' and source = 'xurl'",
				)
				.get(),
		).toEqual({ count: 2 });
	});

	it("caps persisted xurl results to the requested limit", async () => {
		mocks.searchRecentTweets.mockResolvedValue(
			payload(["tweet_xurl_1", "tweet_xurl_2", "tweet_xurl_3"]),
		);
		const { syncTweetSearch } = await import("./tweet-search-live");

		const result = await syncTweetSearch({
			query: "local-first",
			mode: "xurl",
			refresh: true,
			limit: 1,
			maxPages: 1,
		});

		expect(result).toMatchObject({
			ok: true,
			source: "xurl",
			count: 1,
			tweetIds: ["tweet_xurl_1"],
		});
		expect(
			getNativeDb()
				.prepare(
					"select count(*) as count from tweet_account_edges where kind = 'search'",
				)
				.get(),
		).toEqual({ count: 1 });
	});

	it("uses a fresh search cache without hitting live transports", async () => {
		mocks.searchTweetsViaBird.mockResolvedValue(payload(["tweet_cached_1"]));
		const { syncTweetSearch } = await import("./tweet-search-live");
		const options = {
			query: "local-first",
			mode: "bird" as const,
			limit: 100,
		};

		await syncTweetSearch({ ...options, refresh: true });
		const cached = await syncTweetSearch(options);

		expect(cached).toMatchObject({
			ok: true,
			source: "cache",
			count: 1,
			tweetIds: ["tweet_cached_1"],
		});
		expect(mocks.searchTweetsViaBird).toHaveBeenCalledTimes(1);
	});
});
