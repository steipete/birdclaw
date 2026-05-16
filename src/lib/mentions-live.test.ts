// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { listTimelineItems } from "./queries";

const listMentionsViaBirdMock = vi.fn();
const listMentionsViaXurlMock = vi.fn();
const lookupUsersByHandlesMock = vi.fn();

vi.mock("./bird", async () => {
	const { Effect } = await import("effect");
	return {
		listMentionsViaBird: (...args: unknown[]) =>
			listMentionsViaBirdMock(...args),
		listMentionsViaBirdEffect: (...args: unknown[]) =>
			Effect.tryPromise({
				try: () => listMentionsViaBirdMock(...args),
				catch: (error) => error,
			}),
	};
});

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

function clearLocalMentionRows() {
	const db = getNativeDb();
	db.exec("delete from tweet_account_edges where kind = 'mention'");
	db.exec("delete from tweets where kind = 'mention'");
}

function insertLocalMentionBaseline({
	tweetId = "1000",
	accountId = "acct_primary",
	tweetAccountId = accountId,
	source = "archive",
}: {
	tweetId?: string;
	accountId?: string;
	tweetAccountId?: string;
	source?: string;
} = {}) {
	const db = getNativeDb();
	db.prepare(
		`
    insert into tweets (
      id, account_id, author_profile_id, kind, text, created_at,
      is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
      entities_json, media_json, quoted_tweet_id
    ) values (
      ?, ?, 'profile_user_42', 'mention', 'archived mention',
      '2026-03-09T01:59:00.000Z', 0, null, 0, 0, 0, 0, '{}', '[]', null
    )
    `,
	).run(tweetId, tweetAccountId);
	db.prepare(
		`
    insert into tweet_account_edges (
      account_id, tweet_id, kind, first_seen_at, last_seen_at, seen_count,
      source, raw_json, updated_at
    ) values (
      ?, ?, 'mention', '2026-03-09T01:59:00.000Z',
      '2026-03-09T01:59:00.000Z', 1, ?, '{}',
      '2026-03-09T01:59:00.000Z'
    )
    `,
	).run(accountId, tweetId, source);
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

	it("builds mention sync effects lazily", async () => {
		makeTempHome();
		insertLocalMentionBaseline();
		const { syncMentionsEffect } = await import("./mentions-live");

		const effect = syncMentionsEffect({
			mode: "xurl",
			limit: 5,
			refresh: true,
		});

		expect(listMentionsViaXurlMock).not.toHaveBeenCalled();
		listMentionsViaXurlMock.mockResolvedValueOnce({
			data: [
				{
					id: "tweet_lazy_mention",
					author_id: "42",
					text: "lazy mention",
					created_at: "2026-03-09T02:00:00.000Z",
				},
			],
			includes: {
				users: [{ id: "42", username: "sam", name: "Sam" }],
			},
			meta: { result_count: 1 },
		});

		await expect(Effect.runPromise(effect)).resolves.toMatchObject({
			ok: true,
			source: "xurl",
			count: 1,
		});
		expect(listMentionsViaXurlMock).toHaveBeenCalledTimes(1);
	});

	it("validates mention sync effects only when run", async () => {
		makeTempHome();
		const { syncMentionsEffect } = await import("./mentions-live");

		const effect = syncMentionsEffect({ mode: "xurl", limit: 4 });

		await expect(Effect.runPromise(effect)).rejects.toThrow(
			"xurl mode requires --limit between 5 and 100",
		);
		expect(listMentionsViaXurlMock).not.toHaveBeenCalled();
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
		getNativeDb()
			.prepare(
				`
	    insert into tweets (
	      id, account_id, author_profile_id, kind, text, created_at,
	      is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
	      entities_json, media_json, quoted_tweet_id
	    ) values (
	      'tweet_media_mention', 'acct_primary', 'profile_user_42',
	      'home', 'mention with archived media', '2026-03-09T01:58:00.000Z',
	      0, null, 1, 1, 0, 0, '{}', '[{"url":"https://img.example/media.jpg","type":"image"}]', null
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
				{
					id: "tweet_media_mention",
					author_id: "42",
					text: "mention also appears without media expansions",
					created_at: "2026-03-09T02:00:00.000Z",
					public_metrics: { like_count: 5 },
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
			count: 3,
			partial: false,
			payload: {
				meta: { result_count: 3, page_count: 1, next_token: null },
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
		expect(
			getNativeDb()
				.prepare("select media_count, media_json from tweets where id = ?")
				.get("tweet_media_mention"),
		).toEqual({
			media_count: 1,
			media_json: '[{"url":"https://img.example/media.jpg","type":"image"}]',
		});
	});

	it("seeds first-run xurl mention sync from the newest archive mention id", async () => {
		makeTempHome();
		clearLocalMentionRows();
		insertLocalMentionBaseline();
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

	it("advances completed xurl mention syncs from live high-water", async () => {
		makeTempHome();
		clearLocalMentionRows();
		insertLocalMentionBaseline({ tweetId: "1000" });
		listMentionsViaXurlMock
			.mockResolvedValueOnce({
				data: [
					{
						id: "1050",
						author_id: "42",
						text: "first newer live mention",
						created_at: "2026-03-09T02:00:00.000Z",
					},
					{
						id: "1100",
						author_id: "43",
						text: "newest live mention",
						created_at: "2026-03-09T02:01:00.000Z",
					},
				],
				meta: { result_count: 2 },
			})
			.mockResolvedValueOnce({
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
		await syncMentions({
			account: "acct_primary",
			mode: "xurl",
			limit: 5,
			refresh: true,
		});

		expect(listMentionsViaXurlMock).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ sinceId: "1000" }),
		);
		expect(listMentionsViaXurlMock).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ sinceId: "1100" }),
		);
	});

	it("does not seed first-run xurl mention sync from live-only mention edges", async () => {
		makeTempHome();
		clearLocalMentionRows();
		insertLocalMentionBaseline({ tweetId: "2000", source: "xurl" });
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

	it("ignores nonnumeric local mention ids when seeding xurl since_id", async () => {
		makeTempHome();
		clearLocalMentionRows();
		insertLocalMentionBaseline({ tweetId: "tweet_005" });
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

	it("warns and scans without since_id when no local mention baseline exists", async () => {
		makeTempHome();
		clearLocalMentionRows();
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

	it("uses explicit start_time for xurl mention backfills instead of local since_id seeding", async () => {
		makeTempHome();
		clearLocalMentionRows();
		insertLocalMentionBaseline();
		listMentionsViaXurlMock.mockResolvedValueOnce({
			data: [
				{
					id: "900",
					author_id: "7",
					text: "historical backfill mention",
					created_at: "2026-03-09T02:00:00.000Z",
				},
			],
			meta: { result_count: 1 },
		});
		const { syncMentions } = await import("./mentions-live");

		await syncMentions({
			account: "acct_primary",
			mode: "xurl",
			limit: 5,
			startTime: "2026-03-01T00:00:00Z",
			refresh: true,
		});

		const call = listMentionsViaXurlMock.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(call).toMatchObject({
			maxResults: 5,
			username: "steipete",
			userId: "25401953",
			paginationToken: undefined,
			startTime: "2026-03-01T00:00:00Z",
		});
		expect(call).not.toHaveProperty("sinceId");
	});

	it("bypasses stale resume pagination when start_time is explicit", async () => {
		makeTempHome();
		clearLocalMentionRows();
		insertLocalMentionBaseline({ tweetId: "100" });
		listMentionsViaXurlMock.mockResolvedValueOnce({
			data: [],
			meta: { result_count: 0, next_token: "stale-page" },
		});
		const { syncMentions } = await import("./mentions-live");

		await syncMentions({
			mode: "xurl",
			maxPages: 1,
			refresh: true,
		});
		listMentionsViaXurlMock.mockResolvedValueOnce({
			data: [],
			meta: { result_count: 0, next_token: "backfill-page-2" },
		});
		await syncMentions({
			mode: "xurl",
			maxPages: 1,
			startTime: "2026-03-01T00:00:00Z",
			refresh: true,
		});

		const secondCall = listMentionsViaXurlMock.mock.calls[1]?.[0] as Record<
			string,
			unknown
		>;
		const resumeRow = getNativeDb()
			.prepare("select value_json from sync_cache where cache_key like ?")
			.get("%cursor:v2:%boundary=auto") as { value_json: string };
		expect(secondCall).toMatchObject({
			paginationToken: undefined,
			startTime: "2026-03-01T00:00:00Z",
		});
		expect(secondCall).not.toHaveProperty("sinceId");
		expect(JSON.parse(resumeRow.value_json)).toMatchObject({
			meta: { next_token: "stale-page" },
		});
	});

	it("resumes explicit start_time backfills with scoped pagination", async () => {
		makeTempHome();
		clearLocalMentionRows();
		insertLocalMentionBaseline({ tweetId: "100" });
		listMentionsViaXurlMock
			.mockResolvedValueOnce({
				data: [],
				meta: { result_count: 0, next_token: "generic-page-2" },
			})
			.mockResolvedValueOnce({
				data: [
					{
						id: "start_page_1",
						author_id: "7",
						text: "start time page one",
						created_at: "2026-03-09T02:00:00.000Z",
					},
				],
				meta: { result_count: 1, next_token: "start-page-2" },
			})
			.mockResolvedValueOnce({
				data: [
					{
						id: "start_page_2",
						author_id: "8",
						text: "start time page two",
						created_at: "2026-03-09T01:59:00.000Z",
					},
				],
				meta: { result_count: 1 },
			});
		const { syncMentions } = await import("./mentions-live");

		await syncMentions({
			mode: "xurl",
			maxPages: 1,
			refresh: true,
		});
		await syncMentions({
			mode: "xurl",
			maxPages: 1,
			startTime: "2026-03-01T00:00:00Z",
			refresh: true,
		});
		await syncMentions({
			mode: "xurl",
			maxPages: 1,
			startTime: "2026-03-01T00:00:00Z",
		});

		const genericResumeRow = getNativeDb()
			.prepare("select value_json from sync_cache where cache_key like ?")
			.get("%cursor:v2:%boundary=auto") as { value_json: string };
		const thirdCall = listMentionsViaXurlMock.mock.calls[2]?.[0] as Record<
			string,
			unknown
		>;
		expect(JSON.parse(genericResumeRow.value_json)).toMatchObject({
			meta: { next_token: "generic-page-2" },
		});
		expect(thirdCall).toMatchObject({
			paginationToken: "start-page-2",
			startTime: "2026-03-01T00:00:00Z",
		});
		expect(thirdCall).not.toHaveProperty("sinceId");
		expect(
			getNativeDb()
				.prepare("select kind from tweets where id = ?")
				.get("start_page_2"),
		).toEqual({ kind: "mention" });
	});

	it("does not reuse stale scoped partial cache after start_time resume completes", async () => {
		makeTempHome();
		clearLocalMentionRows();
		listMentionsViaXurlMock
			.mockResolvedValueOnce({
				data: [
					{
						id: "partial_start_page_1",
						author_id: "7",
						text: "partial start time page one",
						created_at: "2026-03-09T02:00:00.000Z",
					},
				],
				meta: { result_count: 1, next_token: "start-page-2" },
			})
			.mockResolvedValueOnce({
				data: [
					{
						id: "partial_start_page_2",
						author_id: "8",
						text: "partial start time page two",
						created_at: "2026-03-09T01:59:00.000Z",
					},
				],
				meta: { result_count: 1 },
			})
			.mockResolvedValueOnce({
				data: [
					{
						id: "partial_start_fresh",
						author_id: "9",
						text: "fresh start time page",
						created_at: "2026-03-09T01:58:00.000Z",
					},
				],
				meta: { result_count: 1 },
			});
		const { syncMentions } = await import("./mentions-live");

		await syncMentions({
			mode: "xurl",
			maxPages: 1,
			startTime: "2026-03-01T00:00:00Z",
			refresh: true,
		});
		await syncMentions({
			mode: "xurl",
			maxPages: 1,
			startTime: "2026-03-01T00:00:00Z",
		});
		const thirdResult = await syncMentions({
			mode: "xurl",
			maxPages: 1,
			startTime: "2026-03-01T00:00:00Z",
		});

		const thirdCall = listMentionsViaXurlMock.mock.calls[2]?.[0] as Record<
			string,
			unknown
		>;
		expect(listMentionsViaXurlMock).toHaveBeenCalledTimes(3);
		expect(thirdResult.source).toBe("xurl");
		expect(thirdCall).toMatchObject({
			paginationToken: undefined,
			startTime: "2026-03-01T00:00:00Z",
		});
		expect(thirdCall).not.toHaveProperty("sinceId");
	});

	it("clears completed scoped result cache when refresh writes a cursor", async () => {
		makeTempHome();
		clearLocalMentionRows();
		listMentionsViaXurlMock
			.mockResolvedValueOnce({
				data: [
					{
						id: "completed_start_page",
						author_id: "7",
						text: "completed start time result",
						created_at: "2026-03-09T02:00:00.000Z",
					},
				],
				meta: { result_count: 1 },
			})
			.mockResolvedValueOnce({
				data: [
					{
						id: "refreshed_start_page_1",
						author_id: "8",
						text: "refreshed start time page one",
						created_at: "2026-03-09T02:01:00.000Z",
					},
				],
				meta: { result_count: 1, next_token: "refresh-page-2" },
			})
			.mockResolvedValueOnce({
				data: [
					{
						id: "refreshed_start_page_2",
						author_id: "9",
						text: "refreshed start time page two",
						created_at: "2026-03-09T01:59:00.000Z",
					},
				],
				meta: { result_count: 1 },
			})
			.mockResolvedValueOnce({
				data: [
					{
						id: "fresh_after_refresh_resume",
						author_id: "10",
						text: "fresh after refresh resume",
						created_at: "2026-03-09T01:58:00.000Z",
					},
				],
				meta: { result_count: 1 },
			});
		const { syncMentions } = await import("./mentions-live");

		await syncMentions({
			mode: "xurl",
			maxPages: 1,
			startTime: "2026-03-01T00:00:00Z",
			refresh: true,
		});
		await syncMentions({
			mode: "xurl",
			maxPages: 1,
			startTime: "2026-03-01T00:00:00Z",
			refresh: true,
		});
		await syncMentions({
			mode: "xurl",
			maxPages: 1,
			startTime: "2026-03-01T00:00:00Z",
		});
		const fourthResult = await syncMentions({
			mode: "xurl",
			maxPages: 1,
			startTime: "2026-03-01T00:00:00Z",
		});

		const fourthCall = listMentionsViaXurlMock.mock.calls[3]?.[0] as Record<
			string,
			unknown
		>;
		expect(listMentionsViaXurlMock).toHaveBeenCalledTimes(4);
		expect(fourthResult.source).toBe("xurl");
		expect(fourthResult.payload.data.map((tweet) => tweet.id)).toEqual([
			"fresh_after_refresh_resume",
		]);
		expect(fourthCall).toMatchObject({
			paginationToken: undefined,
			startTime: "2026-03-01T00:00:00Z",
		});
		expect(fourthCall).not.toHaveProperty("sinceId");
	});

	it("resumes legacy mention cursors instead of reseeding from newest local mention", async () => {
		makeTempHome();
		clearLocalMentionRows();
		insertLocalMentionBaseline({ tweetId: "100" });
		insertLocalMentionBaseline({ tweetId: "250" });
		const db = getNativeDb();
		const legacyCursorKey =
			"mentions:sync:xurl:acct_primary:20:single:all-pages:no-since:no-start";
		db.prepare(
			`
      insert into sync_cache (cache_key, value_json, updated_at)
      values (?, ?, ?)
      `,
		).run(
			legacyCursorKey,
			JSON.stringify({
				data: [],
				meta: { result_count: 0, next_token: "legacy-page-2" },
			}),
			"2026-03-09T02:00:00.000Z",
		);
		listMentionsViaXurlMock.mockResolvedValueOnce({
			data: [
				{
					id: "180",
					author_id: "9",
					text: "legacy cursor page two mention",
					created_at: "2026-03-09T01:58:00.000Z",
				},
			],
			meta: { result_count: 1 },
		});
		const { syncMentions } = await import("./mentions-live");

		await syncMentions({ mode: "xurl" });

		const call = listMentionsViaXurlMock.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(call).toMatchObject({
			paginationToken: "legacy-page-2",
		});
		expect(call).not.toHaveProperty("sinceId");
		expect(
			db.prepare("select kind from tweets where id = ?").get("180"),
		).toEqual({ kind: "mention" });
		expect(
			db
				.prepare("select cache_key from sync_cache where cache_key = ?")
				.get(legacyCursorKey),
		).toBeUndefined();
	});

	it("keeps seeded sync mentions cache separate from unseeded exports", async () => {
		makeTempHome();
		clearLocalMentionRows();
		insertLocalMentionBaseline();
		listMentionsViaXurlMock
			.mockResolvedValueOnce({
				data: [
					{
						id: "1001",
						author_id: "7",
						text: "incremental sync mention",
						created_at: "2026-03-09T02:00:00.000Z",
					},
				],
				meta: { result_count: 1 },
			})
			.mockResolvedValueOnce({
				data: [
					{
						id: "full_export_mention",
						author_id: "8",
						text: "full export mention",
						created_at: "2026-03-09T01:00:00.000Z",
					},
				],
				meta: { result_count: 1 },
			});
		const { exportMentionsViaCachedXurl, syncMentions } =
			await import("./mentions-live");

		await syncMentions({
			account: "acct_primary",
			mode: "xurl",
			limit: 5,
			refresh: true,
		});
		const payload = await exportMentionsViaCachedXurl({
			account: "acct_primary",
			limit: 5,
		});

		expect(payload.data.map((tweet) => tweet.id)).toEqual([
			"full_export_mention",
		]);
		expect(listMentionsViaXurlMock).toHaveBeenCalledTimes(2);
		expect(listMentionsViaXurlMock.mock.calls[0]?.[0]).toMatchObject({
			sinceId: "1000",
		});
		expect(listMentionsViaXurlMock.mock.calls[1]?.[0]).not.toHaveProperty(
			"sinceId",
		);
	});

	it("resumes partial mention syncs and commits the page-one high-water", async () => {
		makeTempHome();
		clearLocalMentionRows();
		insertLocalMentionBaseline({ tweetId: "100" });
		listMentionsViaXurlMock
			.mockResolvedValueOnce({
				data: [
					{
						id: "200",
						author_id: "7",
						text: "new page one mention",
						created_at: "2026-03-09T02:00:00.000Z",
					},
					{
						id: "250",
						author_id: "8",
						text: "newest page one mention",
						created_at: "2026-03-09T02:01:00.000Z",
					},
				],
				meta: { result_count: 0, next_token: "page-2" },
			})
			.mockResolvedValueOnce({
				data: [
					{
						id: "180",
						author_id: "9",
						text: "older page two mention",
						created_at: "2026-03-09T01:58:00.000Z",
					},
					{
						id: "220",
						author_id: "10",
						text: "middle page two mention",
						created_at: "2026-03-09T01:59:00.000Z",
					},
				],
				meta: { result_count: 0 },
			})
			.mockResolvedValueOnce({
				data: [],
				meta: { result_count: 0 },
			});
		const { syncMentions } = await import("./mentions-live");

		await syncMentions({
			mode: "xurl",
			maxPages: 1,
			refresh: true,
		});
		const db = getNativeDb();
		const firstRunRows = db
			.prepare(
				"select id from tweets where id in ('100', '200', '250') order by id",
			)
			.all() as Array<{ id: string }>;
		const cacheRow = db
			.prepare("select value_json from sync_cache where value_json like ?")
			.get("%page-2%") as { value_json: string } | undefined;

		expect(firstRunRows.map((row) => row.id)).toEqual(["100", "200", "250"]);
		expect(JSON.parse(cacheRow?.value_json ?? "{}")).toMatchObject({
			meta: { next_token: "page-2" },
			birdclaw: {
				boundary: { kind: "since", sinceId: "100" },
				pendingNewestId: "250",
			},
		});
		await syncMentions({ mode: "xurl" });
		await syncMentions({ mode: "xurl", refresh: true });

		expect(listMentionsViaXurlMock).toHaveBeenCalledTimes(3);
		expect(listMentionsViaXurlMock.mock.calls[0]?.[0]).toMatchObject({
			sinceId: "100",
		});
		expect(listMentionsViaXurlMock.mock.calls[1]?.[0]).toMatchObject({
			paginationToken: "page-2",
			sinceId: "100",
		});
		expect(listMentionsViaXurlMock.mock.calls[2]?.[0]).toMatchObject({
			sinceId: "250",
		});
		expect(
			db.prepare("select kind from tweets where id = ?").get("180"),
		).toEqual({ kind: "mention" });
	});

	it("seeds from mention edges even when the tweet belongs to another account", async () => {
		makeTempHome();
		clearLocalMentionRows();
		const db = getNativeDb();
		db.prepare(
			"insert into accounts (id, name, handle, transport, is_default, created_at) values (?, ?, ?, ?, ?, ?)",
		).run(
			"acct_A",
			"Account A",
			"@accta",
			"archive",
			0,
			"2026-01-01T00:00:00.000Z",
		);
		db.prepare(
			"insert into accounts (id, name, handle, transport, is_default, created_at) values (?, ?, ?, ?, ?, ?)",
		).run(
			"acct_B",
			"Account B",
			"@acctb",
			"archive",
			0,
			"2026-01-01T00:00:00.000Z",
		);
		insertLocalMentionBaseline({
			tweetId: "2000",
			accountId: "acct_B",
			tweetAccountId: "acct_A",
		});
		listMentionsViaXurlMock.mockResolvedValueOnce({
			data: [],
			meta: { result_count: 0 },
		});
		const { syncMentions } = await import("./mentions-live");

		await syncMentions({
			account: "acct_B",
			mode: "xurl",
			limit: 5,
			refresh: true,
		});

		expect(listMentionsViaXurlMock).toHaveBeenCalledWith({
			maxResults: 5,
			username: "acctb",
			userId: "25401953",
			paginationToken: undefined,
			sinceId: "2000",
		});
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

	it("preserves existing media_json when a refreshed mention omits media details", async () => {
		makeTempHome();
		const existingMediaJson = JSON.stringify([
			{
				url: "https://pbs.twimg.com/media/existing.jpg",
				type: "image",
				variants: [{ url: "https://video.twimg.com/existing.mp4" }],
			},
		]);
		getNativeDb()
			.prepare(
				`
        insert into tweets (
          id, account_id, author_profile_id, kind, text, created_at,
          is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
          entities_json, media_json, quoted_tweet_id
        ) values (?, 'acct_primary', 'profile_user_999', 'mention', ?, ?, 0, null, 0, 1, 0, 0, '{}', ?, null)
        `,
			)
			.run(
				"tweet_live_partial_media",
				"old text",
				"2026-03-09T01:00:00.000Z",
				existingMediaJson,
			);
		listMentionsViaXurlMock.mockResolvedValueOnce({
			data: [
				{
					id: "tweet_live_partial_media",
					author_id: "999",
					text: "partial media mention",
					created_at: "2026-03-09T02:00:00.000Z",
					attachments: { media_keys: ["missing_media"] },
				},
			],
			meta: { result_count: 1 },
		});
		const { exportMentionsViaCachedXurl } = await import("./mentions-live");

		await exportMentionsViaCachedXurl({
			account: "acct_primary",
			limit: 5,
			refresh: true,
		});
		const row = getNativeDb()
			.prepare("select media_count, media_json from tweets where id = ?")
			.get("tweet_live_partial_media") as {
			media_count: number;
			media_json: string;
		};

		expect(row.media_count).toBe(1);
		expect(row.media_json).toBe(existingMediaJson);
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

	it("falls back to stale cache when live merge fails", async () => {
		makeTempHome();
		listMentionsViaXurlMock.mockResolvedValueOnce({
			data: [
				{
					id: "tweet_live_cached_before_merge_error",
					author_id: "11",
					text: "Cached before merge error",
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
		listMentionsViaXurlMock.mockResolvedValueOnce({
			data: [
				{
					id: null,
					author_id: "11",
					text: "bad live row",
					created_at: "2026-03-09T02:04:00.000Z",
				},
			],
			includes: {
				users: [{ id: "11", username: "des", name: "Des" }],
			},
			meta: { result_count: 1 },
		});

		const payload = await exportMentionsViaCachedXurl({
			account: "acct_primary",
			limit: 5,
			cacheTtlMs: 0,
		});

		expect(payload).toEqual({
			data: [
				{
					id: "tweet_live_cached_before_merge_error",
					author_id: "11",
					text: "Cached before merge error",
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
		await expect(
			syncMentions({
				account: "acct_primary",
				mode: "bird",
				limit: 5,
				sinceId: "1000",
			}),
		).rejects.toThrow("bird mode does not support --since-id or --start-time");
		expect(listMentionsViaBirdMock).not.toHaveBeenCalled();
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
