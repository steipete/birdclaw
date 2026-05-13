// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { listTimelineItems } from "./queries";

const listMentionsViaBirdMock = vi.fn();
const listMentionsViaXurlMock = vi.fn();
const lookupUsersByHandlesMock = vi.fn();

vi.mock("./bird", () => ({
	listMentionsViaBird: (...args: unknown[]) => listMentionsViaBirdMock(...args),
}));

vi.mock("./xurl", () => ({
	listMentionsViaXurl: (...args: unknown[]) => listMentionsViaXurlMock(...args),
	lookupUsersByHandles: (...args: unknown[]) =>
		lookupUsersByHandlesMock(...args),
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
		listMentionsViaBirdMock.mockReset();
		listMentionsViaXurlMock.mockReset();
		lookupUsersByHandlesMock.mockReset();
		lookupUsersByHandlesMock.mockResolvedValue([{ id: "25401953" }]);
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
				result_count: 2,
				page_count: 1,
				next_token: null,
			},
		});
		const { exportMentionsViaCachedXurl } = await import("./mentions-live");

		const payload = await exportMentionsViaCachedXurl({
			account: "acct_primary",
			limit: 5,
			refresh: true,
		});

		expect(payload.meta).toEqual(
			expect.objectContaining({
				result_count: 1,
				page_count: 1,
				next_token: null,
			}),
		);
		expect(listMentionsViaXurlMock).toHaveBeenCalledWith({
			maxResults: 5,
			username: "steipete",
			userId: "25401953",
			paginationToken: undefined,
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
		expect(mentions[0]?.entities.mentions).toEqual([
			expect.objectContaining({
				username: "sam",
				id: "42",
			}),
		]);
		expect(
			getNativeDb()
				.prepare(
					"select account_id, kind, source from tweet_account_edges where tweet_id = ?",
				)
				.get("tweet_live_1"),
		).toEqual({
			account_id: "acct_primary",
			kind: "mention",
			source: "xurl",
		});
	});

	it("syncs xurl mentions into the local store and preserves authored kind", async () => {
		makeTempHome();
		getNativeDb()
			.prepare(
				`
	    insert into tweets (
	      id, account_id, author_profile_id, kind, text, created_at,
	      is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
	      entities_json, media_json, quoted_tweet_id
	    ) values (
	      'tweet_authored_mention', 'acct_primary', 'profile_user_42',
	      'authored', 'authored original', '2026-03-09T01:59:00.000Z',
	      0, null, 1, 0, 0, 0, '{}', '[]', null
	    )
	    `,
			)
			.run();
		listMentionsViaXurlMock.mockResolvedValueOnce({
			data: [
				{
					id: "tweet_sync_mention_1",
					author_id: "42",
					text: "Synced mention from xurl",
					created_at: "2026-03-09T02:00:00.000Z",
					conversation_id: "tweet_sync_root_1",
					public_metrics: { like_count: 3 },
				},
				{
					id: "tweet_authored_mention",
					author_id: "42",
					text: "authored tweet also appears as mention",
					created_at: "2026-03-09T02:00:00.000Z",
					public_metrics: { like_count: 8 },
				},
			],
			includes: {
				users: [{ id: "42", username: "sam", name: "Sam Altman" }],
			},
			meta: {
				result_count: 1,
				page_count: 1,
				next_token: null,
			},
		});
		const { syncMentions } = await import("./mentions-live");

		const result = await syncMentions({
			account: "acct_primary",
			mode: "xurl",
			limit: 5,
			refresh: true,
		});

		expect(result).toMatchObject({
			ok: true,
			source: "xurl",
			kind: "mentions",
			accountId: "acct_primary",
			count: 2,
			partial: false,
			payload: {
				meta: { result_count: 2, page_count: 1, next_token: null },
			},
		});
		expect(
			getNativeDb()
				.prepare("select kind, text, like_count from tweets where id = ?")
				.get("tweet_sync_mention_1"),
		).toEqual({
			kind: "mention",
			text: "Synced mention from xurl",
			like_count: 3,
		});
		expect(
			getNativeDb()
				.prepare(
					"select account_id, kind, source from tweet_account_edges where tweet_id = ?",
				)
				.get("tweet_sync_mention_1"),
		).toEqual({
			account_id: "acct_primary",
			kind: "mention",
			source: "xurl",
		});
		expect(
			getNativeDb()
				.prepare("select kind, text, like_count from tweets where id = ?")
				.get("tweet_authored_mention"),
		).toEqual({
			kind: "authored",
			text: "authored tweet also appears as mention",
			like_count: 8,
		});
	});

	it("seeds first-run xurl mention sync from the newest local mention id", async () => {
		makeTempHome();
		const db = getNativeDb();
		db.exec("delete from tweet_account_edges where kind = 'mention'");
		db.exec("delete from tweets where kind = 'mention'");
		db.prepare(
			`
	    insert into tweets (
	      id, account_id, author_profile_id, kind, text, created_at,
	      is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
	      entities_json, media_json, quoted_tweet_id
	    ) values (
	      '1000', 'acct_primary', 'profile_user_42', 'mention',
	      'archived mention', '2026-03-09T01:59:00.000Z',
	      0, null, 0, 0, 0, 0, '{}', '[]', null
	    )
	    `,
		).run();
		db.prepare(
			`
	    insert into tweet_account_edges (
	      account_id, tweet_id, kind, first_seen_at, last_seen_at, seen_count,
	      source, raw_json, updated_at
	    ) values (
	      'acct_primary', '1000', 'mention', '2026-03-09T01:59:00.000Z',
	      '2026-03-09T01:59:00.000Z', 1, 'archive', '{}',
	      '2026-03-09T01:59:00.000Z'
	    )
	    `,
		).run();
		listMentionsViaXurlMock.mockResolvedValueOnce({
			data: [],
			meta: { result_count: 0 },
		});
		const { syncMentions } = await import("./mentions-live");

		await syncMentions({
			account: "acct_primary",
			mode: "xurl",
			limit: 5,
			refresh: true,
		});

		expect(listMentionsViaXurlMock).toHaveBeenCalledWith({
			maxResults: 5,
			username: "steipete",
			userId: "25401953",
			paginationToken: undefined,
			sinceId: "1000",
		});
	});

	it("warns and scans without since_id when no local mention baseline exists", async () => {
		makeTempHome();
		const db = getNativeDb();
		db.exec("delete from tweet_account_edges where kind = 'mention'");
		db.exec("delete from tweets where kind = 'mention'");
		const consoleErrorMock = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		listMentionsViaXurlMock.mockResolvedValueOnce({
			data: [],
			meta: { result_count: 0 },
		});
		const { syncMentions } = await import("./mentions-live");

		try {
			await syncMentions({
				account: "acct_primary",
				mode: "xurl",
				limit: 5,
				refresh: true,
			});
			expect(consoleErrorMock).toHaveBeenCalledWith(
				"No local mention baseline found; syncing mentions from the newest page backwards.",
			);
		} finally {
			consoleErrorMock.mockRestore();
		}

		const call = listMentionsViaXurlMock.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(call).toMatchObject({
			maxResults: 5,
			username: "steipete",
			userId: "25401953",
			paginationToken: undefined,
		});
		expect(call).not.toHaveProperty("sinceId");
	});

	it("creates stub authors and counts media urls when includes are missing", async () => {
		makeTempHome();
		listMentionsViaXurlMock.mockResolvedValueOnce({
			data: [
				{
					id: "tweet_live_stub",
					author_id: "999",
					text: "stub author mention",
					created_at: "2026-03-09T02:00:00.000Z",
					entities: {
						urls: [
							{
								url: "https://t.co/demo",
								expanded_url: "https://example.com/demo",
								display_url: "example.com/demo",
								start: 0,
								end: 19,
								media_key: "3_123",
							},
						],
					},
				},
			],
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

		expect(
			listTimelineItems({
				resource: "mentions",
				search: "stub",
				limit: 5,
			}),
		).toEqual([
			expect.objectContaining({
				id: "tweet_live_stub",
				mediaCount: 1,
				author: expect.objectContaining({
					id: "profile_user_999",
					handle: "user_999",
				}),
			}),
		]);
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

		expect(second.meta).toEqual(
			expect.objectContaining({
				result_count: 1,
				page_count: 1,
				next_token: null,
			}),
		);
		expect(listMentionsViaXurlMock).toHaveBeenCalledTimes(1);
	});

	it("fetches bird mentions, caches them, and syncs them into the local timeline", async () => {
		makeTempHome();
		listMentionsViaBirdMock.mockResolvedValueOnce({
			data: [
				{
					id: "tweet_live_bird_1",
					author_id: "88",
					text: "Cached hello from bird",
					created_at: "2026-03-09T02:00:00.000Z",
					conversation_id: "tweet_root_1",
					public_metrics: {
						like_count: 4,
					},
				},
			],
			includes: {
				users: [
					{
						id: "88",
						username: "birdsam",
						name: "Bird Sam",
					},
				],
			},
			meta: {
				result_count: 1,
				page_count: 1,
				next_token: null,
			},
		});
		const { exportMentionsViaCachedBird } = await import("./mentions-live");

		const payload = await exportMentionsViaCachedBird({
			account: "acct_primary",
			limit: 5,
			refresh: true,
		});

		expect(payload.meta).toEqual(
			expect.objectContaining({
				result_count: 1,
				page_count: 1,
				next_token: null,
			}),
		);
		expect(listMentionsViaBirdMock).toHaveBeenCalledWith({
			maxResults: 5,
		});
		expect(lookupUsersByHandlesMock).not.toHaveBeenCalled();

		const mentions = listTimelineItems({
			resource: "mentions",
			search: "bird",
			limit: 10,
		});
		expect(mentions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "tweet_live_bird_1",
					text: "Cached hello from bird",
					accountId: "acct_primary",
					author: expect.objectContaining({
						handle: "birdsam",
						displayName: "Bird Sam",
					}),
				}),
			]),
		);
	});

	it("can merge every retrievable xurl mention page into one payload", async () => {
		makeTempHome();
		listMentionsViaXurlMock
			.mockResolvedValueOnce({
				data: [
					{
						id: "tweet_live_page_1",
						author_id: "7",
						text: "page one",
						created_at: "2026-03-09T02:01:00.000Z",
					},
				],
				includes: {
					users: [{ id: "7", username: "amelia", name: "Amelia" }],
				},
				meta: {
					result_count: 1,
					next_token: "page-2",
				},
			})
			.mockResolvedValueOnce({
				data: [
					{
						id: "tweet_live_page_2",
						author_id: "9",
						text: "page two",
						created_at: "2026-03-09T02:02:00.000Z",
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

		const payload = await exportMentionsViaCachedXurl({
			account: "acct_primary",
			limit: 5,
			all: true,
			refresh: true,
		});

		expect(payload.data.map((item) => item.id)).toEqual([
			"tweet_live_page_1",
			"tweet_live_page_2",
		]);
		expect(payload.includes?.users?.map((item) => item.username)).toEqual([
			"amelia",
			"ava",
		]);
		expect(payload.meta).toEqual(
			expect.objectContaining({
				result_count: 2,
				page_count: 2,
				next_token: null,
			}),
		);
		expect(listMentionsViaXurlMock).toHaveBeenNthCalledWith(1, {
			maxResults: 5,
			username: "steipete",
			userId: "25401953",
			paginationToken: undefined,
		});
		expect(listMentionsViaXurlMock).toHaveBeenNthCalledWith(2, {
			maxResults: 5,
			username: "steipete",
			userId: "25401953",
			paginationToken: "page-2",
		});
		expect(
			listTimelineItems({
				resource: "mentions",
				search: "page",
				limit: 10,
			}).map((item) => item.id),
		).toEqual(["tweet_live_page_2", "tweet_live_page_1"]);
	});

	it("treats maxPages as a paged xurl mention scan", async () => {
		makeTempHome();
		listMentionsViaXurlMock.mockResolvedValueOnce({
			data: [
				{
					id: "tweet_live_capped",
					author_id: "7",
					text: "capped page",
					created_at: "2026-03-09T02:01:00.000Z",
				},
			],
			includes: {
				users: [{ id: "7", username: "amelia", name: "Amelia" }],
			},
			meta: {
				result_count: 1,
				next_token: "page-2",
			},
		});
		const { exportMentionsViaCachedXurl } = await import("./mentions-live");

		const payload = await exportMentionsViaCachedXurl({
			account: "acct_primary",
			limit: 5,
			maxPages: 1,
			refresh: true,
		});

		expect(payload.meta).toEqual(
			expect.objectContaining({
				result_count: 1,
				page_count: 1,
				next_token: "page-2",
			}),
		);
		expect(listMentionsViaXurlMock).toHaveBeenCalledTimes(1);
	});

	it("marks sync mentions partial when max-pages leaves another page", async () => {
		makeTempHome();
		listMentionsViaXurlMock.mockResolvedValueOnce({
			data: [
				{
					id: "tweet_sync_capped",
					author_id: "7",
					text: "capped sync page",
					created_at: "2026-03-09T02:01:00.000Z",
				},
			],
			includes: {
				users: [{ id: "7", username: "amelia", name: "Amelia" }],
			},
			meta: {
				result_count: 1,
				next_token: "page-2",
			},
		});
		const { syncMentions } = await import("./mentions-live");

		const result = await syncMentions({
			account: "acct_primary",
			mode: "xurl",
			limit: 5,
			maxPages: 1,
			refresh: true,
		});

		expect(result).toMatchObject({
			ok: true,
			source: "xurl",
			kind: "mentions",
			count: 1,
			partial: true,
			payload: { meta: { page_count: 1, next_token: "page-2" } },
		});
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
				page_count: 1,
				next_token: null,
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
				page_count: 1,
				next_token: null,
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
				page_count: 1,
				next_token: null,
			},
		});
		expect(listMentionsViaXurlMock).toHaveBeenCalledTimes(2);
	});

	it("validates xurl limits", async () => {
		makeTempHome();
		const { exportMentionsViaCachedXurl, syncMentions } =
			await import("./mentions-live");

		await expect(
			exportMentionsViaCachedXurl({
				account: "acct_primary",
				limit: 4,
			}),
		).rejects.toThrow("xurl mode requires --limit between 5 and 100");
		await expect(
			exportMentionsViaCachedXurl({
				account: "acct_primary",
				limit: 5,
				maxPages: 0,
			}),
		).rejects.toThrow("--max-pages must be at least 1");
		await expect(
			syncMentions({
				account: "acct_primary",
				mode: "weird",
				limit: 5,
			}),
		).rejects.toThrow("--mode must be bird or xurl");
	});

	it("throws for unknown accounts and refresh failures without cache fallback", async () => {
		makeTempHome();
		listMentionsViaXurlMock.mockRejectedValueOnce(new Error("transport down"));
		const { exportMentionsViaCachedXurl } = await import("./mentions-live");

		await expect(
			exportMentionsViaCachedXurl({
				account: "acct_missing",
				limit: 5,
			}),
		).rejects.toThrow("Unknown account: acct_missing");
		await expect(
			exportMentionsViaCachedXurl({
				account: "acct_primary",
				limit: 5,
				refresh: true,
			}),
		).rejects.toThrow("transport down");
	});
});
