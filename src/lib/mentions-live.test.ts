// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { listTimelineItems } from "./queries";

const listMentionsViaXurlMock = vi.fn();

vi.mock("./xurl", () => ({
	listMentionsViaXurl: (...args: unknown[]) => listMentionsViaXurlMock(...args),
}));

const tempDirs: string[] = [];

function makeTempHome() {
	const tempDir = mkdtempSync(
		path.join(os.tmpdir(), "birdclaw-mentions-live-"),
	);
	tempDirs.push(tempDir);
	process.env.BIRDCLAW_HOME = tempDir;
	return tempDir;
}

describe("cached live mentions", () => {
	beforeEach(() => {
		listMentionsViaXurlMock.mockReset();
	});

	afterEach(() => {
		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		delete process.env.BIRDCLAW_HOME;

		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fetches live mentions, caches them, and syncs them into the local timeline", async () => {
		makeTempHome();
		listMentionsViaXurlMock.mockResolvedValueOnce({
			data: [
				{
					id: "tweet_live_1",
					author_id: "42",
					text: "Cached hello from xurl",
					created_at: "2026-03-09T02:00:00.000Z",
					conversation_id: "tweet_root_1",
					entities: {
						mentions: [
							{
								start: 7,
								end: 12,
								username: "sam",
								id: "42",
							},
						],
					},
					public_metrics: {
						like_count: 9,
					},
				},
			],
			includes: {
				users: [
					{
						id: "42",
						username: "sam",
						name: "Sam Altman",
						description: "builder",
						public_metrics: {
							followers_count: 100,
						},
					},
				],
			},
			meta: {
				result_count: 1,
			},
		});
		const { exportMentionsViaCachedXurl } = await import("./mentions-live");

		const payload = await exportMentionsViaCachedXurl({
			account: "acct_primary",
			limit: 5,
			refresh: true,
		});

		expect(payload.meta).toEqual({ result_count: 1 });
		expect(listMentionsViaXurlMock).toHaveBeenCalledWith({
			maxResults: 5,
			username: "steipete",
		});

		const mentions = listTimelineItems({
			resource: "mentions",
			search: "Cached",
			limit: 10,
		});
		expect(mentions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "tweet_live_1",
					text: "Cached hello from xurl",
					accountId: "acct_primary",
					author: expect.objectContaining({
						handle: "sam",
						displayName: "Sam Altman",
						followersCount: 100,
					}),
				}),
			]),
		);
	});

	it("reuses fresh cache without spending another xurl call", async () => {
		makeTempHome();
		listMentionsViaXurlMock.mockResolvedValue({
			data: [
				{
					id: "tweet_live_2",
					author_id: "7",
					text: "Cache me once",
					created_at: "2026-03-09T02:01:00.000Z",
				},
			],
			includes: {
				users: [{ id: "7", username: "amelia", name: "Amelia" }],
			},
			meta: {
				result_count: 1,
			},
		});
		const { exportMentionsViaCachedXurl } = await import("./mentions-live");

		await exportMentionsViaCachedXurl({
			account: "acct_primary",
			limit: 5,
			refresh: true,
		});
		const second = await exportMentionsViaCachedXurl({
			account: "acct_primary",
			limit: 5,
		});

		expect(second.meta).toEqual({ result_count: 1 });
		expect(listMentionsViaXurlMock).toHaveBeenCalledTimes(1);
	});

	it("returns filtered xurl-compatible payloads from the local cache", async () => {
		makeTempHome();
		listMentionsViaXurlMock.mockResolvedValueOnce({
			data: [
				{
					id: "tweet_live_3",
					author_id: "9",
					text: "Need a reply soon",
					created_at: "2026-03-09T02:02:00.000Z",
					entities: {
						urls: [
							{
								start: 10,
								end: 27,
								url: "https://t.co/demo",
								expanded_url: "https://example.com/demo",
								display_url: "example.com/demo",
							},
						],
					},
					public_metrics: {
						like_count: 4,
					},
				},
			],
			includes: {
				users: [{ id: "9", username: "ava", name: "Ava" }],
			},
			meta: {
				result_count: 1,
			},
		});
		const { exportMentionsViaCachedXurl } = await import("./mentions-live");

		await exportMentionsViaCachedXurl({
			account: "acct_primary",
			limit: 5,
			refresh: true,
		});
		getNativeDb()
			.prepare("update tweets set is_replied = 1 where id = ?")
			.run("tweet_live_3");

		const payload = await exportMentionsViaCachedXurl({
			account: "acct_primary",
			search: "reply",
			replyFilter: "replied",
			limit: 5,
		});

		expect(payload).toEqual({
			data: [
				expect.objectContaining({
					id: "tweet_live_3",
					author_id: "9",
					text: "Need a reply soon",
				}),
			],
			includes: {
				users: [{ id: "9", name: "Ava", username: "ava" }],
			},
			meta: {
				result_count: 1,
				newest_id: "tweet_live_3",
				oldest_id: "tweet_live_3",
			},
		});
		expect(listMentionsViaXurlMock).toHaveBeenCalledTimes(1);
	});

	it("falls back to stale cache when xurl read fails", async () => {
		makeTempHome();
		listMentionsViaXurlMock.mockResolvedValueOnce({
			data: [
				{
					id: "tweet_live_4",
					author_id: "11",
					text: "Old but still useful",
					created_at: "2026-03-09T02:03:00.000Z",
				},
			],
			includes: {
				users: [{ id: "11", username: "des", name: "Des" }],
			},
			meta: {
				result_count: 1,
			},
		});
		const { exportMentionsViaCachedXurl } = await import("./mentions-live");

		await exportMentionsViaCachedXurl({
			account: "acct_primary",
			limit: 5,
			refresh: true,
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		listMentionsViaXurlMock.mockRejectedValueOnce(new Error("rate limited"));

		const payload = await exportMentionsViaCachedXurl({
			account: "acct_primary",
			limit: 5,
			cacheTtlMs: 0,
		});

		expect(payload).toEqual({
			data: [
				{
					id: "tweet_live_4",
					author_id: "11",
					text: "Old but still useful",
					created_at: "2026-03-09T02:03:00.000Z",
				},
			],
			includes: {
				users: [{ id: "11", username: "des", name: "Des" }],
			},
			meta: {
				result_count: 1,
			},
		});
		expect(listMentionsViaXurlMock).toHaveBeenCalledTimes(2);
	});

	it("validates xurl limits", async () => {
		makeTempHome();
		const { exportMentionsViaCachedXurl } = await import("./mentions-live");

		await expect(
			exportMentionsViaCachedXurl({
				account: "acct_primary",
				limit: 4,
			}),
		).rejects.toThrow("xurl mode requires --limit between 5 and 100");
	});
});
