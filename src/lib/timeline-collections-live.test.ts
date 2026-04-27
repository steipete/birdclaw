// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { resetDatabaseForTests } from "./db";
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
					entities: {
						urls: [
							{
								start: 0,
								end: 18,
								url: "https://t.co/site",
								expanded_url: "https://example.com/post",
								display_url: "example.com/post",
							},
							{
								start: 19,
								end: 23,
								url: "https://t.co/media",
								expanded_url: "https://pbs.twimg.com/media/bookmark.jpg",
								display_url: "pbs.twimg.com/media/bookmark.jpg",
								media_key: "bird_media_0",
							},
						],
					},
					media: [
						{
							url: "https://pbs.twimg.com/media/bookmark.jpg",
							type: "image",
							thumbnailUrl: "https://pbs.twimg.com/media/bookmark.jpg:small",
						},
					],
					quotedTweet: {
						id: "quoted_1",
						author_id: "44",
						text: "quoted context",
						created_at: "2026-04-26T12:43:34.000Z",
						public_metrics: { like_count: 3 },
						media: [
							{
								url: "https://pbs.twimg.com/media/quoted.jpg",
								type: "image",
							},
						],
					},
					public_metrics: { like_count: 7 },
				},
			],
			includes: {
				users: [
					{ id: "43", username: "amelia", name: "Amelia" },
					{ id: "44", username: "quoted_author", name: "Quoted Author" },
				],
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
		expect(syncedBookmark?.entities.urls).toHaveLength(1);
		expect(syncedBookmark).toMatchObject({
			bookmarked: true,
			liked: false,
			author: { handle: "amelia" },
			mediaCount: 1,
			media: [
				expect.objectContaining({
					url: "https://pbs.twimg.com/media/bookmark.jpg",
					type: "image",
				}),
			],
			entities: {
				urls: [
					expect.objectContaining({
						url: "https://t.co/site",
						expandedUrl: "https://example.com/post",
						displayUrl: "example.com/post",
					}),
				],
			},
			quotedTweet: expect.objectContaining({
				id: "quoted_1",
				text: "quoted context",
				author: expect.objectContaining({ handle: "quoted_author" }),
				media: [
					expect.objectContaining({
						url: "https://pbs.twimg.com/media/quoted.jpg",
						type: "image",
					}),
				],
			}),
		});
	});
});
