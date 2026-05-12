// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { listTimelineItems } from "./queries";

const mocks = vi.hoisted(() => ({
	listBookmarkedTweetsViaBird: vi.fn(),
	listHomeTimelineViaBird: vi.fn(),
	listLikedTweetsViaBird: vi.fn(),
	listBookmarkedTweetsViaXurl: vi.fn(),
	listLikedTweetsViaXurl: vi.fn(),
	lookupUsersByHandles: vi.fn(),
}));

vi.mock("./bird", () => ({
	listBookmarkedTweetsViaBird: mocks.listBookmarkedTweetsViaBird,
	listHomeTimelineViaBird: mocks.listHomeTimelineViaBird,
	listLikedTweetsViaBird: mocks.listLikedTweetsViaBird,
}));

vi.mock("./xurl", () => ({
	listBookmarkedTweetsViaXurl: mocks.listBookmarkedTweetsViaXurl,
	listLikedTweetsViaXurl: mocks.listLikedTweetsViaXurl,
	lookupUsersByHandles: mocks.lookupUsersByHandles,
}));

const tempRoots: string[] = [];

function makeTweet(id: string, text = id, authorId = "42") {
	return {
		id,
		author_id: authorId,
		text,
		created_at: "2026-04-26T13:43:34.000Z",
	};
}

function makeUser(id = "42", username = "sam") {
	return { id, username, name: username };
}

function insertCollectionRow({
	tweetId,
	kind = "likes",
	source = "archive",
	updatedAt = "2026-01-01T00:00:00.000Z",
}: {
	tweetId: string;
	kind?: "likes" | "bookmarks";
	source?: string;
	updatedAt?: string;
}) {
	getNativeDb()
		.prepare(
			`
      insert into tweet_collections (
        account_id, tweet_id, kind, collected_at, source, raw_json, updated_at
      ) values (?, ?, ?, null, ?, ?, ?)
      `,
		)
		.run(
			"acct_primary",
			tweetId,
			kind,
			source,
			JSON.stringify({ id: tweetId }),
			updatedAt,
		);
}

function setupTempHome() {
	const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-test-"));
	tempRoots.push(tempRoot);
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
}

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	for (const mock of Object.values(mocks)) {
		mock.mockReset();
	}
	for (const tempRoot of tempRoots.splice(0)) {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

describe("live timeline collection sync", () => {
	it("syncs liked tweets from xurl into local search filters", async () => {
		setupTempHome();
		mocks.listLikedTweetsViaXurl.mockResolvedValue({
			data: [
				{
					id: "liked_1",
					author_id: "42",
					text: "xurl liked item",
					created_at: "2026-04-26T13:43:34.000Z",
					public_metrics: { like_count: 12 },
					referenced_tweets: [
						{ type: "replied_to", id: "root_1" },
						{ type: "quoted", id: "quote_1" },
					],
				},
			],
			includes: {
				users: [{ id: "42", username: "sam", name: "Sam" }],
			},
			meta: { result_count: 1 },
		});
		const { syncTimelineCollection } =
			await import("./timeline-collections-live");

		const result = await syncTimelineCollection({
			kind: "likes",
			mode: "xurl",
			limit: 5,
			refresh: true,
		});
		const liked = listTimelineItems({ resource: "home", likedOnly: true });
		const syncedLiked = liked.find((item) => item.id === "liked_1");

		expect(result).toMatchObject({ ok: true, source: "xurl", count: 1 });
		expect(mocks.lookupUsersByHandles).not.toHaveBeenCalled();
		expect(mocks.listLikedTweetsViaXurl).toHaveBeenCalledWith(
			expect.objectContaining({ userId: "25401953" }),
		);
		expect(syncedLiked).toMatchObject({
			liked: true,
			bookmarked: false,
			author: { handle: "sam" },
		});
		expect(
			getNativeDb()
				.prepare(
					"select is_replied, reply_to_id, quoted_tweet_id from tweets where id = ?",
				)
				.get("liked_1"),
		).toMatchObject({
			is_replied: 1,
			reply_to_id: "root_1",
			quoted_tweet_id: "quote_1",
		});
	});

	it("paginates xurl collections and deduplicates tweets and users", async () => {
		setupTempHome();
		const db = getNativeDb();
		db.prepare("update accounts set external_user_id = null where id = ?").run(
			"acct_primary",
		);
		mocks.lookupUsersByHandles.mockResolvedValue([{ id: "25401953" }]);
		mocks.listLikedTweetsViaXurl
			.mockResolvedValueOnce({
				data: [
					{
						id: "liked_1",
						author_id: "42",
						text: "first page item",
						created_at: "2026-04-26T13:43:34.000Z",
					},
				],
				includes: {
					users: [{ id: "42", username: "sam", name: "Sam" }],
				},
				meta: { result_count: 1, next_token: "next-page" },
			})
			.mockResolvedValueOnce({
				data: [
					{
						id: "liked_1",
						author_id: "42",
						text: "duplicate item",
						created_at: "2026-04-26T13:43:34.000Z",
					},
					{
						id: "liked_2",
						author_id: "43",
						text: "second page item",
						created_at: "2026-04-26T14:43:34.000Z",
					},
				],
				includes: {
					users: [
						{ id: "42", username: "sam", name: "Sam" },
						{ id: "43", username: "jules", name: "Jules" },
					],
				},
				meta: { result_count: 2 },
			});
		const { syncTimelineCollection } =
			await import("./timeline-collections-live");

		const result = await syncTimelineCollection({
			kind: "likes",
			mode: "xurl",
			limit: 5,
			all: true,
			refresh: true,
		});

		expect(result).toMatchObject({
			ok: true,
			source: "xurl",
			count: 2,
			payload: {
				includes: {
					users: expect.arrayContaining([
						expect.objectContaining({ id: "43" }),
					]),
				},
				meta: { page_count: 2, oldest_id: "liked_2", newest_id: "liked_1" },
			},
		});
		expect(mocks.lookupUsersByHandles).toHaveBeenCalledWith(["steipete"]);
		expect(mocks.listLikedTweetsViaXurl).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ paginationToken: "next-page" }),
		);
		expect(
			listTimelineItems({ resource: "home", likedOnly: true }).filter((item) =>
				item.id.startsWith("liked_"),
			),
		).toHaveLength(2);
	});

	it("marks bookmark xurl walks as paginated for the max_results cap", async () => {
		setupTempHome();
		mocks.listBookmarkedTweetsViaXurl
			.mockResolvedValueOnce({
				data: [],
				meta: { next_token: "next-page" },
			})
			.mockResolvedValueOnce({
				data: [],
				meta: {},
			});
		const { syncTimelineCollection } =
			await import("./timeline-collections-live");

		await syncTimelineCollection({
			kind: "bookmarks",
			mode: "xurl",
			limit: 100,
			all: true,
			refresh: true,
		});

		expect(mocks.listBookmarkedTweetsViaXurl).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				maxResults: 100,
				isPaginatedWalk: true,
			}),
		);
		expect(mocks.listBookmarkedTweetsViaXurl).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				maxResults: 100,
				isPaginatedWalk: true,
				paginationToken: "next-page",
			}),
		);
	});

	it("stops xurl collection paging when a page is fully existing rows", async () => {
		setupTempHome();
		insertCollectionRow({ tweetId: "liked_existing" });
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		mocks.listLikedTweetsViaXurl.mockResolvedValue({
			data: [makeTweet("liked_existing", "already local")],
			includes: { users: [makeUser()] },
			meta: { result_count: 1, next_token: "wasteful-next-page" },
		});
		const { syncTimelineCollection } =
			await import("./timeline-collections-live");

		const result = await syncTimelineCollection({
			kind: "likes",
			mode: "xurl",
			limit: 5,
			earlyStop: true,
			refresh: true,
		});

		expect(result).toMatchObject({
			ok: true,
			source: "xurl",
			count: 0,
			saturated_at_page: 1,
			payload: { meta: { page_count: 1, saturated_at_page: 1 } },
		});
		expect(mocks.listLikedTweetsViaXurl).toHaveBeenCalledTimes(1);
		expect(consoleError).toHaveBeenCalledWith(
			"likes saturated at page 1 (100% existing rows)",
		);
		consoleError.mockRestore();
	});

	it("does not early-stop on a partially deduped page", async () => {
		setupTempHome();
		insertCollectionRow({ tweetId: "liked_existing_partial" });
		mocks.listLikedTweetsViaXurl
			.mockResolvedValueOnce({
				data: [
					makeTweet("liked_existing_partial", "already local"),
					makeTweet("liked_new_partial", "new on page one", "43"),
				],
				includes: { users: [makeUser(), makeUser("43", "jules")] },
				meta: { result_count: 2, next_token: "next-page" },
			})
			.mockResolvedValueOnce({
				data: [makeTweet("liked_new_second", "new on page two", "44")],
				includes: { users: [makeUser("44", "mira")] },
				meta: { result_count: 1 },
			});
		const { syncTimelineCollection } =
			await import("./timeline-collections-live");

		const result = await syncTimelineCollection({
			kind: "likes",
			mode: "xurl",
			limit: 5,
			earlyStop: true,
			refresh: true,
		});
		const existing = getNativeDb()
			.prepare(
				"select source from tweet_collections where tweet_id = ? and kind = ?",
			)
			.get("liked_existing_partial", "likes");

		expect(result).toMatchObject({
			count: 2,
			payload: { meta: { page_count: 2 } },
		});
		expect(result).not.toHaveProperty("saturated_at_page");
		expect(mocks.listLikedTweetsViaXurl).toHaveBeenCalledTimes(2);
		expect(existing).toEqual({ source: "archive" });
	});

	it("respects max-pages when early-stop never saturates", async () => {
		setupTempHome();
		mocks.listBookmarkedTweetsViaXurl
			.mockResolvedValueOnce({
				data: [makeTweet("bookmark_new_1", "new bookmark one")],
				includes: { users: [makeUser()] },
				meta: { result_count: 1, next_token: "page-2" },
			})
			.mockResolvedValueOnce({
				data: [makeTweet("bookmark_new_2", "new bookmark two", "43")],
				includes: { users: [makeUser("43", "jules")] },
				meta: { result_count: 1, next_token: "page-3" },
			});
		const { syncTimelineCollection } =
			await import("./timeline-collections-live");

		const result = await syncTimelineCollection({
			kind: "bookmarks",
			mode: "xurl",
			limit: 5,
			maxPages: 2,
			earlyStop: true,
			refresh: true,
		});

		expect(result).toMatchObject({
			count: 2,
			payload: { meta: { page_count: 2 } },
		});
		expect(result).not.toHaveProperty("saturated_at_page");
		expect(mocks.listBookmarkedTweetsViaXurl).toHaveBeenCalledTimes(2);
	});

	it("keeps an early-stop rerun idempotent for existing collection rows", async () => {
		setupTempHome();
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		mocks.listLikedTweetsViaXurl.mockResolvedValueOnce({
			data: [makeTweet("liked_rerun", "first sync")],
			includes: { users: [makeUser()] },
			meta: { result_count: 1 },
		});
		const { syncTimelineCollection } =
			await import("./timeline-collections-live");

		await syncTimelineCollection({
			kind: "likes",
			mode: "xurl",
			limit: 5,
			earlyStop: true,
			refresh: true,
		});
		getNativeDb()
			.prepare(
				"update tweet_collections set source = ?, updated_at = ? where tweet_id = ? and kind = ?",
			)
			.run("archive", "2026-01-01T00:00:00.000Z", "liked_rerun", "likes");
		const before = getNativeDb()
			.prepare(
				"select source, updated_at from tweet_collections where tweet_id = ? and kind = ?",
			)
			.get("liked_rerun", "likes");
		mocks.listLikedTweetsViaXurl.mockResolvedValueOnce({
			data: [makeTweet("liked_rerun", "second sync")],
			includes: { users: [makeUser()] },
			meta: { result_count: 1, next_token: "unused" },
		});

		const second = await syncTimelineCollection({
			kind: "likes",
			mode: "xurl",
			limit: 5,
			earlyStop: true,
			refresh: true,
		});
		const after = getNativeDb()
			.prepare(
				"select source, updated_at from tweet_collections where tweet_id = ? and kind = ?",
			)
			.get("liked_rerun", "likes");

		expect(second).toMatchObject({ count: 0, saturated_at_page: 1 });
		expect(after).toEqual(before);
		expect(mocks.listLikedTweetsViaXurl).toHaveBeenCalledTimes(2);
		consoleError.mockRestore();
	});

	it("falls back to bird for bookmarks when xurl fails", async () => {
		setupTempHome();
		mocks.lookupUsersByHandles.mockResolvedValue([{ id: "25401953" }]);
		mocks.listBookmarkedTweetsViaXurl.mockRejectedValue(
			new Error("xurl unauthorized"),
		);
		mocks.listBookmarkedTweetsViaBird.mockResolvedValue({
			data: [
				{
					id: "bookmark_1",
					author_id: "43",
					text: "bird bookmark item",
					created_at: "2026-04-26T13:43:34.000Z",
					public_metrics: { like_count: 7 },
				},
			],
			includes: {
				users: [{ id: "43", username: "amelia", name: "Amelia" }],
			},
			meta: { result_count: 1 },
		});
		const { syncTimelineCollection } =
			await import("./timeline-collections-live");

		const result = await syncTimelineCollection({
			kind: "bookmarks",
			mode: "auto",
			limit: 10,
			all: true,
			maxPages: 2,
			refresh: true,
		});
		const bookmarked = listTimelineItems({
			resource: "home",
			bookmarkedOnly: true,
		});
		const syncedBookmark = bookmarked.find((item) => item.id === "bookmark_1");

		expect(result).toMatchObject({ ok: true, source: "bird", count: 1 });
		expect(mocks.listBookmarkedTweetsViaBird).toHaveBeenCalledWith({
			maxResults: 10,
			all: true,
			maxPages: 2,
		});
		expect(syncedBookmark).toMatchObject({
			bookmarked: true,
			liked: false,
			author: { handle: "amelia" },
		});
	});

	it("keeps live saved-state scoped to the syncing account", async () => {
		setupTempHome();
		mocks.listLikedTweetsViaBird.mockResolvedValue({
			data: [
				{
					id: "tweet_003",
					author_id: "46",
					text: "other account liked this canonical tweet",
					created_at: "2026-04-26T13:43:34.000Z",
					public_metrics: { like_count: 7 },
				},
			],
			includes: {
				users: [{ id: "46", username: "mira", name: "Mira" }],
			},
			meta: { result_count: 1 },
		});
		const { syncTimelineCollection } =
			await import("./timeline-collections-live");

		await syncTimelineCollection({
			kind: "likes",
			account: "acct_studio",
			mode: "bird",
			limit: 10,
			refresh: true,
		});

		const primaryItems = listTimelineItems({
			resource: "home",
			account: "acct_primary",
			limit: 20,
		});
		const studioLiked = listTimelineItems({
			resource: "home",
			account: "acct_studio",
			likedOnly: true,
			limit: 5,
		});

		expect(primaryItems.find((item) => item.id === "tweet_003")).toMatchObject({
			accountId: "acct_primary",
			liked: false,
		});
		expect(studioLiked.find((item) => item.id === "tweet_003")).toMatchObject({
			accountId: "acct_studio",
			liked: true,
		});
		expect(
			getNativeDb()
				.prepare("select account_id, liked from tweets where id = ?")
				.get("tweet_003"),
		).toEqual({
			account_id: "acct_primary",
			liked: 0,
		});
	});

	it("uses bird directly for liked collections and caches the payload", async () => {
		setupTempHome();
		mocks.listLikedTweetsViaBird.mockResolvedValue({
			data: [
				{
					id: "bird_liked_1",
					author_id: "99",
					text: "bird liked item",
					created_at: "2026-04-26T13:43:34.000Z",
					entities: {
						urls: [{ media_key: "media_1" }, { media_key: 42 }, null],
					},
				},
			],
			meta: { result_count: 1 },
		});
		const { syncTimelineCollection } =
			await import("./timeline-collections-live");

		const fresh = await syncTimelineCollection({
			kind: "likes",
			mode: "bird",
			limit: 3,
			maxPages: 2,
			refresh: true,
			cacheTtlMs: 15_000,
		});
		const cached = await syncTimelineCollection({
			kind: "likes",
			mode: "bird",
			limit: 3,
			maxPages: 2,
			cacheTtlMs: 15_000,
		});
		const row = getNativeDb()
			.prepare("select media_count, author_profile_id from tweets where id = ?")
			.get("bird_liked_1");

		expect(fresh).toMatchObject({ source: "bird", count: 1 });
		expect(cached).toMatchObject({ source: "cache", count: 1 });
		expect(mocks.listLikedTweetsViaBird).toHaveBeenCalledTimes(1);
		expect(mocks.listLikedTweetsViaBird).toHaveBeenCalledWith({
			maxResults: 3,
			all: false,
			maxPages: 2,
		});
		expect(row).toMatchObject({
			media_count: 1,
			author_profile_id: "profile_user_99",
		});
	});

	it("validates collection sync options before fetching", async () => {
		setupTempHome();
		const { syncTimelineCollection } =
			await import("./timeline-collections-live");

		await expect(
			syncTimelineCollection({ kind: "likes", limit: 0 }),
		).rejects.toThrow("--limit must be at least 1");
		await expect(
			syncTimelineCollection({ kind: "likes", mode: "xurl", limit: 4 }),
		).rejects.toThrow("xurl mode requires --limit between 5 and 100");
		await expect(
			syncTimelineCollection({
				kind: "likes",
				mode: "bird",
				limit: 1,
				maxPages: 0,
			}),
		).rejects.toThrow("--max-pages must be at least 1");
	});

	it("does not fall back when xurl mode fails", async () => {
		setupTempHome();
		mocks.listLikedTweetsViaXurl.mockRejectedValue(new Error("xurl failed"));
		const { syncTimelineCollection } =
			await import("./timeline-collections-live");

		await expect(
			syncTimelineCollection({
				kind: "likes",
				mode: "xurl",
				limit: 5,
				refresh: true,
			}),
		).rejects.toThrow("xurl failed");
		expect(mocks.listLikedTweetsViaBird).not.toHaveBeenCalled();
	});

	it("syncs the bird following timeline into the local home feed", async () => {
		setupTempHome();
		mocks.listHomeTimelineViaBird.mockResolvedValue({
			data: [
				{
					id: "home_1",
					author_id: "44",
					text: "bird home item",
					created_at: "2026-05-04T07:19:34.000Z",
					public_metrics: { like_count: 15 },
				},
			],
			includes: {
				users: [{ id: "44", username: "jules", name: "Jules" }],
			},
			meta: { result_count: 1 },
		});
		const { syncHomeTimeline } = await import("./timeline-live");

		const result = await syncHomeTimeline({
			limit: 25,
			refresh: true,
		});
		const home = listTimelineItems({ resource: "home" });
		const syncedHomeItem = home.find((item) => item.id === "home_1");

		expect(result).toMatchObject({
			ok: true,
			source: "bird",
			feed: "following",
			count: 1,
		});
		expect(mocks.listHomeTimelineViaBird).toHaveBeenCalledWith({
			maxResults: 25,
			following: true,
		});
		expect(syncedHomeItem).toMatchObject({
			kind: "home",
			liked: false,
			bookmarked: false,
			author: { handle: "jules" },
		});
	});

	it("caches bird home timeline payloads by feed", async () => {
		setupTempHome();
		mocks.listHomeTimelineViaBird.mockResolvedValue({
			data: [
				{
					id: "home_cached_1",
					author_id: "45",
					text: "bird for you item",
					created_at: "2026-05-04T07:19:34.000Z",
					entities: {
						urls: [{ media_key: "media_1" }, { media_key: 17 }, undefined],
					},
				},
			],
			meta: { result_count: 1 },
		});
		const { syncHomeTimeline } = await import("./timeline-live");

		const fresh = await syncHomeTimeline({
			limit: 25,
			following: false,
			refresh: true,
			cacheTtlMs: 10_000,
		});
		const cached = await syncHomeTimeline({
			limit: 25,
			following: false,
			cacheTtlMs: 10_000,
		});
		const row = getNativeDb()
			.prepare("select media_count, author_profile_id from tweets where id = ?")
			.get("home_cached_1");

		expect(fresh).toMatchObject({ source: "bird", feed: "for-you" });
		expect(cached).toMatchObject({ source: "cache", feed: "for-you" });
		expect(mocks.listHomeTimelineViaBird).toHaveBeenCalledTimes(1);
		expect(mocks.listHomeTimelineViaBird).toHaveBeenCalledWith({
			maxResults: 25,
			following: false,
		});
		expect(row).toMatchObject({
			media_count: 1,
			author_profile_id: "profile_user_45",
		});
	});

	it("validates home timeline options before fetching", async () => {
		setupTempHome();
		const { syncHomeTimeline } = await import("./timeline-live");

		await expect(syncHomeTimeline({ limit: 0 })).rejects.toThrow(
			"--limit must be at least 1",
		);
		await expect(syncHomeTimeline({ account: "missing" })).rejects.toThrow(
			"Unknown account: missing",
		);
		getNativeDb().prepare("delete from accounts").run();
		await expect(syncHomeTimeline({})).rejects.toThrow(
			"Unknown account: default",
		);
	});
});
