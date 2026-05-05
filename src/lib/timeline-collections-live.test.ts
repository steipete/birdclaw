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
	listLikedTweetsViaBird: vi.fn(),
	listBookmarkedTweetsViaXurl: vi.fn(),
	listLikedTweetsViaXurl: vi.fn(),
	lookupUsersByHandles: vi.fn(),
}));

vi.mock("./bird", () => ({
	listBookmarkedTweetsViaBird: mocks.listBookmarkedTweetsViaBird,
	listLikedTweetsViaBird: mocks.listLikedTweetsViaBird,
}));

vi.mock("./xurl", () => ({
	listBookmarkedTweetsViaXurl: mocks.listBookmarkedTweetsViaXurl,
	listLikedTweetsViaXurl: mocks.listLikedTweetsViaXurl,
	lookupUsersByHandles: mocks.lookupUsersByHandles,
}));

const tempRoots: string[] = [];

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
});
