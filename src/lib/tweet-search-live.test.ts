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
	const db = getNativeDb();
	db.prepare("update accounts set bird_profile_name = ? where id = ?").run(
		"profile-primary",
		"acct_primary",
	);
	db.prepare("update accounts set bird_profile_name = ? where id = ?").run(
		"profile-studio",
		"acct_studio",
	);
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

	it("validates query, account, limit, and max-pages before live search", async () => {
		const { syncTweetSearch } = await import("./tweet-search-live");

		await expect(syncTweetSearch({ query: "  " })).rejects.toThrow(
			"Search query is required",
		);
		await expect(
			syncTweetSearch({ query: "local-first", limit: 0 }),
		).rejects.toThrow("--limit must be at least 1");
		await expect(
			syncTweetSearch({ query: "local-first", maxPages: 0 }),
		).rejects.toThrow("--max-pages must be at least 1");
		await expect(
			syncTweetSearch({ query: "local-first", account: "missing" }),
		).rejects.toThrow("Unknown account: missing");
		expect(mocks.searchTweetsViaBird).not.toHaveBeenCalled();
		expect(mocks.searchRecentTweets).not.toHaveBeenCalled();
	});

	it("returns a local no-op result without touching live transports", async () => {
		const { syncTweetSearch } = await import("./tweet-search-live");

		const result = await syncTweetSearch({
			query: "local-first",
			mode: "local",
			limit: 10,
		});

		expect(result).toMatchObject({
			ok: true,
			source: "cache",
			accountId: "acct_primary",
			query: "local-first",
			count: 0,
			pageCount: 0,
			tweetIds: [],
		});
		expect(mocks.searchTweetsViaBird).not.toHaveBeenCalled();
		expect(mocks.searchRecentTweets).not.toHaveBeenCalled();
	});

	it("captures explicit live transport failures", async () => {
		mocks.searchTweetsViaBird.mockRejectedValue(new Error("bird denied"));
		const { syncTweetSearch } = await import("./tweet-search-live");

		const result = await syncTweetSearch({
			query: "local-first",
			mode: "bird",
			refresh: true,
			limit: 10,
		});

		expect(result).toMatchObject({
			ok: false,
			source: "bird",
			accountId: "acct_primary",
			query: "local-first",
			error: "bird denied",
		});
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

	it("combines bird and xurl results for auto searches", async () => {
		mocks.searchTweetsViaBird.mockResolvedValue(
			payload(["tweet_bird_1", "tweet_shared", "tweet_bird_2"]),
		);
		mocks.searchRecentTweets.mockResolvedValueOnce(
			payload(["tweet_xurl_1", "tweet_shared"]),
		);
		const { syncTweetSearch } = await import("./tweet-search-live");

		const result = await syncTweetSearch({
			query: "local-first",
			mode: "auto",
			refresh: true,
			limit: 3,
			maxPages: 2,
		});

		expect(result).toMatchObject({
			ok: true,
			source: "bird+xurl",
			count: 3,
			tweetIds: ["tweet_bird_1", "tweet_shared", "tweet_bird_2"],
		});
		expect(mocks.searchTweetsViaBird).toHaveBeenCalled();
		expect(mocks.searchRecentTweets).toHaveBeenCalled();
	});

	it("passes selected time bounds through to xurl search", async () => {
		mocks.searchRecentTweets.mockResolvedValueOnce(payload(["tweet_time_1"]));
		const { syncTweetSearch } = await import("./tweet-search-live");

		await syncTweetSearch({
			query: "local-first",
			mode: "xurl",
			refresh: true,
			limit: 100,
			since: "2026-05-24T00:00:00Z",
			until: "2026-05-24T12:00:00Z",
		});

		expect(mocks.searchRecentTweets).toHaveBeenCalledWith(
			"local-first",
			expect.objectContaining({
				startTime: "2026-05-24T00:00:00.000Z",
				endTime: "2026-05-24T12:00:00.000Z",
			}),
		);
	});

	it("uses the default xurl OAuth user for recent search on non-default accounts", async () => {
		getNativeDb()
			.prepare(
				"insert into accounts (id, name, handle, transport, is_default, created_at) values (?, ?, ?, ?, ?, ?)",
			)
			.run(
				"acct_openclaw",
				"OpenClaw",
				"@openclaw",
				"archive",
				0,
				"2026-05-31T00:00:00.000Z",
			);
		mocks.searchRecentTweets.mockResolvedValueOnce(payload(["tweet_xurl_1"]));
		const { syncTweetSearch } = await import("./tweet-search-live");

		await syncTweetSearch({
			query: "openclaw",
			account: "acct_openclaw",
			mode: "xurl",
			refresh: true,
			limit: 100,
		});

		expect(mocks.searchRecentTweets).toHaveBeenCalledWith(
			"openclaw",
			expect.not.objectContaining({ username: "openclaw" }),
		);
	});

	it("uses only xurl for auto searches with selected time bounds", async () => {
		mocks.searchTweetsViaBird.mockResolvedValue(payload(["tweet_unbounded"]));
		mocks.searchRecentTweets.mockResolvedValueOnce(payload(["tweet_time_1"]));
		const { syncTweetSearch } = await import("./tweet-search-live");

		const result = await syncTweetSearch({
			query: "local-first",
			mode: "auto",
			refresh: true,
			limit: 100,
			since: "2026-05-24T00:00:00Z",
		});

		expect(result).toMatchObject({
			ok: true,
			source: "xurl",
			tweetIds: ["tweet_time_1"],
		});
		expect(mocks.searchTweetsViaBird).not.toHaveBeenCalled();
		expect(mocks.searchRecentTweets).toHaveBeenCalledWith(
			"local-first",
			expect.objectContaining({
				startTime: "2026-05-24T00:00:00.000Z",
			}),
		);
	});

	it("reports bounded auto failures without adding unbounded bird results", async () => {
		mocks.searchRecentTweets.mockRejectedValueOnce(new Error("xurl down"));
		mocks.searchTweetsViaBird.mockResolvedValueOnce(payload(["tweet_bird_1"]));
		const { syncTweetSearch } = await import("./tweet-search-live");

		const result = await syncTweetSearch({
			query: "local-first",
			mode: "auto",
			refresh: true,
			limit: 100,
			since: "2026-05-24T00:00:00Z",
		});

		expect(result).toMatchObject({
			ok: false,
			source: "auto",
			error: "xurl down",
		});
		expect(mocks.searchRecentTweets).toHaveBeenCalled();
		expect(mocks.searchTweetsViaBird).not.toHaveBeenCalled();
	});

	it("reports auto failure when both live transports fail", async () => {
		mocks.searchTweetsViaBird.mockRejectedValue(new Error("bird unavailable"));
		mocks.searchRecentTweets.mockRejectedValue(new Error("xurl unauthorized"));
		const { syncTweetSearch } = await import("./tweet-search-live");

		const result = await syncTweetSearch({
			query: "local-first",
			mode: "auto",
			refresh: true,
			limit: 10,
		});

		expect(result).toMatchObject({
			ok: false,
			source: "auto",
			accountId: "acct_primary",
			query: "local-first",
			error: "bird unavailable; xurl unauthorized",
		});
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

	it("caps bird results and reuses xurl cache entries", async () => {
		mocks.searchTweetsViaBird.mockResolvedValue(
			payload(["tweet_bird_1", "tweet_bird_2"]),
		);
		mocks.searchRecentTweets.mockResolvedValue(payload(["tweet_xurl_cached"]));
		const { syncTweetSearch } = await import("./tweet-search-live");

		const bird = await syncTweetSearch({
			query: "local-first",
			mode: "bird",
			refresh: true,
			limit: 1,
			maxPages: 3,
		});
		expect(bird).toMatchObject({
			ok: true,
			source: "bird",
			count: 1,
			tweetIds: ["tweet_bird_1"],
		});

		const firstXurl = await syncTweetSearch({
			query: "cached",
			mode: "xurl",
			refresh: true,
			limit: 10,
			cacheTtlMs: -1,
		});
		const cachedXurl = await syncTweetSearch({
			query: "cached",
			mode: "xurl",
			limit: 10,
			cacheTtlMs: Number.NaN,
		});

		expect(firstXurl).toMatchObject({ ok: true, source: "xurl" });
		expect(cachedXurl).toMatchObject({
			ok: true,
			source: "cache",
			tweetIds: ["tweet_xurl_cached"],
		});
		expect(mocks.searchRecentTweets).toHaveBeenCalledTimes(1);
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
