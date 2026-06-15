// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { listTimelineItems } from "./queries";

const mocks = vi.hoisted(() => ({
	listThreadViaBird: vi.fn(),
	searchRecentByConversationId: vi.fn(),
	getTweetById: vi.fn(),
}));

vi.mock("./bird", () => ({
	listThreadViaBird: mocks.listThreadViaBird,
	listThreadViaBirdEffect: (options: unknown) =>
		Effect.tryPromise({
			try: () => mocks.listThreadViaBird(options),
			catch: (error) => error,
		}),
}));

vi.mock("./xurl", () => ({
	searchRecentByConversationId: mocks.searchRecentByConversationId,
	searchRecentByConversationIdEffect: (
		conversationId: string,
		options: unknown,
	) =>
		Effect.tryPromise({
			try: () => mocks.searchRecentByConversationId(conversationId, options),
			catch: (error) => error,
		}),
	getTweetById: mocks.getTweetById,
	getTweetByIdEffect: (id: string, options: unknown) =>
		Effect.tryPromise({
			try: () => mocks.getTweetById(id, options),
			catch: (error) => error,
		}),
}));

const tempRoots: string[] = [];

function setupTempHome() {
	const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-threads-"));
	tempRoots.push(tempRoot);
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
	const db = getNativeDb();
	db.exec(
		"delete from tweet_account_edges; delete from tweets; delete from tweets_fts;",
	);
	db.prepare(
		`
    insert into tweets (
      id, account_id, author_profile_id, kind, text, created_at,
      is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
      entities_json, media_json, quoted_tweet_id
    ) values (?, 'acct_primary', 'profile_user_42', 'mention', ?, ?, 0, null, 0, 0, 0, 0, '{}', '[]', null)
    `,
	).run("mention_1", "mention text", "2026-05-04T07:00:00.000Z");
}

function insertMention(id: string, text: string, createdAt: string) {
	getNativeDb()
		.prepare(
			`
    insert into tweets (
      id, account_id, author_profile_id, kind, text, created_at,
      is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
      entities_json, media_json, quoted_tweet_id
    ) values (?, 'acct_primary', 'profile_user_42', 'mention', ?, ?, 0, null, 0, 0, 0, 0, '{}', '[]', null)
    `,
		)
		.run(id, text, createdAt);
}

function upsertMentionEdge(
	id: string,
	raw: Record<string, unknown>,
	seenAt = "2026-05-12T10:00:00.000Z",
	source = "xurl",
) {
	getNativeDb()
		.prepare(
			`
    insert into tweet_account_edges (
	      account_id, tweet_id, kind, first_seen_at, last_seen_at, seen_count,
	      source, raw_json, updated_at
	    ) values ('acct_primary', ?, 'mention', ?, ?, 1, ?, ?, ?)
	    on conflict(account_id, tweet_id, kind) do update set
	      raw_json = excluded.raw_json,
	      last_seen_at = excluded.last_seen_at,
	      updated_at = excluded.updated_at
	    `,
		)
		.run(id, seenAt, seenAt, source, JSON.stringify(raw), seenAt);
}

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	mocks.listThreadViaBird.mockReset();
	mocks.searchRecentByConversationId.mockReset();
	mocks.getTweetById.mockReset();
	for (const tempRoot of tempRoots.splice(0)) {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

describe("mention thread sync", () => {
	it("builds mention thread sync effects lazily", async () => {
		setupTempHome();
		const { syncMentionThreadsEffect } = await import("./mention-threads-live");

		const effect = syncMentionThreadsEffect({
			limit: 1,
			delayMs: 0,
			timeoutMs: 5000,
		});

		expect(mocks.listThreadViaBird).not.toHaveBeenCalled();
		mocks.listThreadViaBird.mockResolvedValue({
			data: [
				{
					id: "mention_1",
					author_id: "42",
					text: "mention text",
					created_at: "2026-05-04T07:00:00.000Z",
				},
			],
			meta: { result_count: 1 },
		});

		await expect(Effect.runPromise(effect)).resolves.toMatchObject({
			ok: true,
			source: "bird",
			threads: 1,
		});
		expect(mocks.listThreadViaBird).toHaveBeenCalledTimes(1);
	});

	it("validates mention thread sync effects only when run", async () => {
		setupTempHome();
		const { syncMentionThreadsEffect } = await import("./mention-threads-live");

		const effect = syncMentionThreadsEffect({ limit: 0 });

		await expect(Effect.runPromise(effect)).rejects.toThrow(
			"--limit must be at least 1",
		);
		expect(mocks.listThreadViaBird).not.toHaveBeenCalled();
	});

	it("fetches recent mention threads with timeout and stores conversation context", async () => {
		setupTempHome();
		mocks.listThreadViaBird.mockResolvedValue({
			data: [
				{
					id: "root_1",
					author_id: "25401953",
					text: "root post",
					created_at: "2026-05-04T06:00:00.000Z",
					conversation_id: "root_1",
					public_metrics: { like_count: 10 },
				},
				{
					id: "mention_1",
					author_id: "42",
					text: "mention text",
					created_at: "2026-05-04T07:00:00.000Z",
					conversation_id: "root_1",
					referenced_tweets: [{ type: "replied_to", id: "root_1" }],
					public_metrics: { like_count: 2 },
				},
				{
					id: "side_reply_1",
					author_id: "43",
					text: "side reply",
					created_at: "2026-05-04T07:01:00.000Z",
					conversation_id: "root_1",
					referenced_tweets: [{ type: "replied_to", id: "root_1" }],
				},
			],
			includes: {
				users: [
					{ id: "25401953", username: "steipete", name: "Peter" },
					{ id: "42", username: "sam", name: "Sam" },
					{ id: "43", username: "alex", name: "Alex" },
				],
			},
			meta: { result_count: 3 },
		});
		const { syncMentionThreads } = await import("./mention-threads-live");

		const result = await syncMentionThreads({
			limit: 1,
			delayMs: 0,
			timeoutMs: 5000,
		});
		const db = getNativeDb();
		const sideReply = db
			.prepare("select kind, reply_to_id from tweets where id = ?")
			.get("side_reply_1");
		const home = listTimelineItems({ resource: "home", limit: 10 });
		const mentions = listTimelineItems({ resource: "mentions", limit: 10 });

		expect(result).toMatchObject({
			ok: true,
			mentions: 1,
			succeeded: 1,
			failed: 0,
			mergedTweets: 3,
			uniqueTweets: 3,
		});
		expect(mocks.listThreadViaBird).toHaveBeenCalledWith({
			tweetId: "mention_1",
			all: false,
			maxPages: undefined,
			timeoutMs: 5000,
		});
		expect(home.find((item) => item.id === "root_1")).toMatchObject({
			kind: "home",
			author: { handle: "steipete" },
		});
		expect(mentions.find((item) => item.id === "mention_1")).toMatchObject({
			kind: "mention",
			replyToTweet: expect.objectContaining({ id: "root_1" }),
		});
		expect(sideReply).toEqual({ kind: "thread", reply_to_id: "root_1" });
	});

	it("hydrates explicit mention ids instead of the newest mentions", async () => {
		setupTempHome();
		insertMention("mention_newer", "newer mention", "2026-05-05T07:00:00.000Z");
		mocks.listThreadViaBird.mockResolvedValue({
			data: [
				{
					id: "mention_1",
					author_id: "42",
					text: "mention text",
					created_at: "2026-05-04T07:00:00.000Z",
				},
			],
			includes: {
				users: [{ id: "42", username: "sam", name: "Sam" }],
			},
			meta: { result_count: 1 },
		});
		const { syncMentionThreads } = await import("./mention-threads-live");
		const progress: unknown[] = [];

		const result = await syncMentionThreads({
			tweetIds: ["mention_1"],
			limit: 5,
			delayMs: 0,
			timeoutMs: 5000,
			onProgress: (value) => progress.push(value),
		});

		expect(result.options.tweetIds).toEqual(["mention_1"]);
		expect(progress).toEqual([
			expect.objectContaining({
				source: "bird",
				processed: 1,
				total: 1,
				fetched: 1,
				done: true,
			}),
		]);
		expect(mocks.listThreadViaBird).toHaveBeenCalledTimes(1);
		expect(mocks.listThreadViaBird).toHaveBeenCalledWith(
			expect.objectContaining({ tweetId: "mention_1" }),
		);
	});

	it("skips thread reads when explicit mention ids are empty", async () => {
		setupTempHome();
		const { syncMentionThreads } = await import("./mention-threads-live");

		const result = await syncMentionThreads({
			tweetIds: [],
			limit: 5,
			delayMs: 0,
			timeoutMs: 5000,
		});

		expect(result).toMatchObject({
			ok: true,
			mentions: 0,
			threads: 0,
			succeeded: 0,
		});
		expect(mocks.listThreadViaBird).not.toHaveBeenCalled();
	});

	it("persists thread video variants in media_json", async () => {
		setupTempHome();
		mocks.listThreadViaBird.mockResolvedValue({
			data: [
				{
					id: "mention_1",
					author_id: "42",
					text: "mention text",
					created_at: "2026-05-04T07:00:00.000Z",
					conversation_id: "mention_1",
					attachments: { media_keys: ["video_1"] },
				},
			],
			includes: {
				users: [{ id: "42", username: "sam", name: "Sam" }],
				media: [
					{
						media_key: "video_1",
						type: "video",
						preview_image_url:
							"https://pbs.twimg.com/ext_tw_video_thumb/video_1.jpg",
						duration_ms: 46947,
						variants: [
							{
								url: "https://video.twimg.com/ext_tw_video/high.mp4",
								content_type: "video/mp4",
								bit_rate: 2176000,
							},
						],
					},
				],
			},
			meta: { result_count: 1 },
		});
		const { syncMentionThreads } = await import("./mention-threads-live");

		await syncMentionThreads({ limit: 1, delayMs: 0, timeoutMs: 5000 });
		const row = getNativeDb()
			.prepare("select media_count, media_json from tweets where id = ?")
			.get("mention_1") as { media_count: number; media_json: string };

		expect(row.media_count).toBe(1);
		expect(JSON.parse(row.media_json)).toMatchObject([
			{
				type: "video",
				durationMs: 46947,
				variants: [{ bitRate: 2176000 }],
			},
		]);
	});

	it("preserves existing media_json when thread payload omits media details", async () => {
		setupTempHome();
		const existingMediaJson = JSON.stringify([
			{
				url: "https://pbs.twimg.com/media/existing.jpg",
				type: "image",
				variants: [{ url: "https://video.twimg.com/existing.mp4" }],
			},
		]);
		getNativeDb()
			.prepare("update tweets set media_count = 1, media_json = ? where id = ?")
			.run(existingMediaJson, "mention_1");
		mocks.listThreadViaBird.mockResolvedValue({
			data: [
				{
					id: "mention_1",
					author_id: "42",
					text: "mention text",
					created_at: "2026-05-04T07:00:00.000Z",
					conversation_id: "mention_1",
					attachments: { media_keys: ["missing_media"] },
				},
			],
			includes: {
				users: [{ id: "42", username: "sam", name: "Sam" }],
			},
			meta: { result_count: 1 },
		});
		const { syncMentionThreads } = await import("./mention-threads-live");

		await syncMentionThreads({ limit: 1, delayMs: 0, timeoutMs: 5000 });
		const row = getNativeDb()
			.prepare("select media_count, media_json from tweets where id = ?")
			.get("mention_1") as { media_count: number; media_json: string };

		expect(row.media_count).toBe(1);
		expect(row.media_json).toBe(existingMediaJson);
	});

	it("records failed thread fetches without failing the sync", async () => {
		setupTempHome();
		mocks.listThreadViaBird.mockRejectedValue(new Error("rate limited"));
		const { syncMentionThreads } = await import("./mention-threads-live");

		const result = await syncMentionThreads({
			limit: 1,
			delayMs: 0,
			timeoutMs: 1000,
		});

		expect(result).toMatchObject({
			ok: true,
			mentions: 1,
			succeeded: 0,
			failed: 1,
			failures: [{ tweetId: "mention_1", error: "rate limited" }],
		});
	});

	it("handles multiple mentions, delay, non-error failures, and stub authors", async () => {
		setupTempHome();
		insertMention("mention_2", "newer mention", "2026-05-04T08:00:00.000Z");
		mocks.listThreadViaBird
			.mockResolvedValueOnce({
				data: [
					{
						id: "mention_2",
						author_id: "42",
						text: "newer mention",
						created_at: "2026-05-04T08:00:00.000Z",
						entities: {
							urls: [
								{ media_key: "media_1" },
								{ media_key: false },
								"not an object",
							],
						},
					},
					{
						id: "unknown_reply",
						author_id: "77",
						text: "unknown author reply",
						created_at: "2026-05-04T08:01:00.000Z",
					},
				],
				meta: { result_count: 2 },
			})
			.mockRejectedValueOnce("temporary failure");
		const { syncMentionThreads } = await import("./mention-threads-live");

		const result = await syncMentionThreads({
			limit: 2,
			delayMs: 1,
			timeoutMs: 1200,
			all: true,
			maxPages: 3,
		});
		const row = getNativeDb()
			.prepare("select media_count, author_profile_id from tweets where id = ?")
			.get("unknown_reply");

		expect(result).toMatchObject({
			mentions: 2,
			succeeded: 1,
			failed: 1,
			mergedTweets: 2,
			uniqueTweets: 2,
			options: { delayMs: 1, timeoutMs: 1200, all: true, maxPages: 3 },
			failures: [{ tweetId: "mention_1", error: "temporary failure" }],
		});
		expect(mocks.listThreadViaBird).toHaveBeenNthCalledWith(1, {
			tweetId: "mention_2",
			all: true,
			maxPages: 3,
			timeoutMs: 1200,
		});
		expect(row).toMatchObject({
			media_count: 0,
			author_profile_id: "profile_user_77",
		});
	});

	it("keeps merge failures isolated to the current mention", async () => {
		setupTempHome();
		insertMention("mention_2", "second mention", "2026-05-04T08:00:00.000Z");
		mocks.listThreadViaBird
			.mockResolvedValueOnce({
				data: [
					{
						id: "bad_thread_row",
						author_id: "42",
						text: null,
						created_at: "2026-05-04T08:00:00.000Z",
					},
				],
				meta: { result_count: 1 },
			})
			.mockResolvedValueOnce({
				data: [
					{
						id: "mention_1",
						author_id: "42",
						text: "good thread row",
						created_at: "2026-05-04T07:00:00.000Z",
					},
				],
				meta: { result_count: 1 },
			});
		const { syncMentionThreads } = await import("./mention-threads-live");

		const result = await syncMentionThreads({
			limit: 2,
			delayMs: 0,
			timeoutMs: 5000,
		});

		expect(result).toMatchObject({
			threads: 2,
			succeeded: 1,
			failed: 1,
			mergedTweets: 1,
		});
		expect(result.failures[0]).toMatchObject({
			tweetId: "mention_2",
			ok: false,
		});
		expect(mocks.listThreadViaBird).toHaveBeenCalledTimes(2);
	});

	it("fetches xurl conversation search results and writes thread context edges", async () => {
		setupTempHome();
		insertMention(
			"mention_recent",
			"recent mention",
			"2026-05-12T10:00:00.000Z",
		);
		upsertMentionEdge("mention_recent", {
			id: "mention_recent",
			author_id: "42",
			text: "recent mention",
			created_at: "2026-05-12T10:00:00.000Z",
			conversation_id: "root_recent",
		});
		const payload = {
			data: [
				{
					id: "root_recent",
					author_id: "77",
					text: "root post",
					created_at: "2026-05-12T09:58:00.000Z",
					conversation_id: "root_recent",
					public_metrics: { like_count: 4 },
				},
				{
					id: "mention_recent",
					author_id: "42",
					text: "recent mention",
					created_at: "2026-05-12T10:00:00.000Z",
					conversation_id: "root_recent",
					referenced_tweets: [{ type: "replied_to", id: "root_recent" }],
					in_reply_to_user_id: "77",
				},
			],
			includes: {
				users: [
					{ id: "77", username: "alex", name: "Alex" },
					{ id: "42", username: "sam", name: "Sam" },
				],
			},
			meta: { result_count: 2 },
		};
		mocks.searchRecentByConversationId
			.mockResolvedValueOnce(payload)
			.mockResolvedValueOnce(payload);
		const { syncMentionThreads } = await import("./mention-threads-live");

		const result = await syncMentionThreads({
			mode: "xurl",
			limit: 1,
			delayMs: 0,
		});
		const db = getNativeDb();
		const edges = db
			.prepare(
				"select tweet_id, kind, source from tweet_account_edges where kind = 'thread_context' order by tweet_id",
			)
			.all();
		const root = db
			.prepare("select kind from tweets where id = ?")
			.get("root_recent");

		expect(result).toMatchObject({
			ok: true,
			source: "xurl",
			mentions: 1,
			succeeded: 1,
			failed: 0,
			mergedTweets: 2,
			uniqueTweets: 2,
			generalReadTweets: 2,
			results: [
				expect.objectContaining({
					tweetId: "mention_recent",
					conversationId: "root_recent",
					strategy: "conversation_search",
					count: 2,
					pages: 1,
				}),
			],
		});
		expect(mocks.searchRecentByConversationId).toHaveBeenCalledWith(
			"root_recent",
			{
				maxResults: 100,
				paginationToken: undefined,
				timeoutMs: expect.any(Number),
			},
		);
		expect(mocks.getTweetById).not.toHaveBeenCalled();
		expect(edges).toEqual([
			{ tweet_id: "mention_recent", kind: "thread_context", source: "xurl" },
			{ tweet_id: "root_recent", kind: "thread_context", source: "xurl" },
		]);
		expect(root).toEqual({ kind: "thread" });

		await syncMentionThreads({ mode: "xurl", limit: 1, delayMs: 0 });
		const edgeCount = db
			.prepare(
				"select count(*) as count from tweet_account_edges where kind = 'thread_context'",
			)
			.get() as { count: number };
		expect(edgeCount.count).toBe(2);
	});

	it("classifies xurl context tweets authored by the account as home", async () => {
		setupTempHome();
		getNativeDb()
			.prepare(
				"update accounts set handle = '@Steipete' where id = 'acct_primary'",
			)
			.run();
		insertMention(
			"mention_own_context",
			"reply to own context",
			"2026-05-12T10:00:00.000Z",
		);
		upsertMentionEdge("mention_own_context", {
			id: "mention_own_context",
			author_id: "42",
			text: "reply to own context",
			created_at: "2026-05-12T10:00:00.000Z",
			conversation_id: "own_context_root",
		});
		mocks.searchRecentByConversationId.mockResolvedValue({
			data: [
				{
					id: "own_context_root",
					author_id: "25401953",
					text: "own root post",
					created_at: "2026-05-12T09:58:00.000Z",
					conversation_id: "own_context_root",
				},
				{
					id: "mention_own_context",
					author_id: "42",
					text: "reply to own context",
					created_at: "2026-05-12T10:00:00.000Z",
					conversation_id: "own_context_root",
					referenced_tweets: [{ type: "replied_to", id: "own_context_root" }],
					in_reply_to_user_id: "25401953",
				},
			],
			includes: {
				users: [
					{ id: "25401953", username: "steipete", name: "Peter" },
					{ id: "42", username: "sam", name: "Sam" },
				],
			},
			meta: { result_count: 2 },
		});
		const { syncMentionThreads } = await import("./mention-threads-live");

		await syncMentionThreads({ mode: "xurl", limit: 1, delayMs: 0 });

		const row = getNativeDb()
			.prepare("select kind from tweets where id = ?")
			.get("own_context_root");
		const home = listTimelineItems({ resource: "home", limit: 10 });
		expect(row).toEqual({ kind: "home" });
		expect(home.find((item) => item.id === "own_context_root")).toMatchObject({
			kind: "home",
			author: { handle: "steipete" },
		});
	});

	it("treats xurl max-pages as a pagination request", async () => {
		setupTempHome();
		insertMention(
			"mention_paginated",
			"recent mention in large thread",
			"2026-05-12T10:00:00.000Z",
		);
		upsertMentionEdge("mention_paginated", {
			id: "mention_paginated",
			author_id: "42",
			text: "recent mention in large thread",
			created_at: "2026-05-12T10:00:00.000Z",
			conversation_id: "root_paginated",
		});
		mocks.searchRecentByConversationId
			.mockResolvedValueOnce({
				data: [
					{
						id: "side_reply_page_1",
						author_id: "42",
						text: "page one",
						created_at: "2026-05-12T10:00:00.000Z",
						conversation_id: "root_paginated",
					},
				],
				meta: { result_count: 1, next_token: "page-2" },
			})
			.mockResolvedValueOnce({
				data: [
					{
						id: "side_reply_page_2",
						author_id: "43",
						text: "page two",
						created_at: "2026-05-12T09:59:00.000Z",
						conversation_id: "root_paginated",
					},
				],
				meta: { result_count: 1, next_token: "page-3" },
			})
			.mockResolvedValueOnce({
				data: [
					{
						id: "root_paginated",
						author_id: "25401953",
						text: "root page three",
						created_at: "2026-05-12T09:50:00.000Z",
						conversation_id: "root_paginated",
					},
				],
				meta: { result_count: 1 },
			});
		const { syncMentionThreads } = await import("./mention-threads-live");

		const result = await syncMentionThreads({
			mode: "xurl",
			limit: 1,
			delayMs: 0,
			maxPages: 3,
		});

		expect(mocks.searchRecentByConversationId).toHaveBeenNthCalledWith(
			1,
			"root_paginated",
			{
				maxResults: 100,
				paginationToken: undefined,
				timeoutMs: expect.any(Number),
			},
		);
		expect(mocks.searchRecentByConversationId).toHaveBeenNthCalledWith(
			2,
			"root_paginated",
			{
				maxResults: 100,
				paginationToken: "page-2",
				timeoutMs: expect.any(Number),
			},
		);
		expect(mocks.searchRecentByConversationId).toHaveBeenNthCalledWith(
			3,
			"root_paginated",
			{
				maxResults: 100,
				paginationToken: "page-3",
				timeoutMs: expect.any(Number),
			},
		);
		expect(result).toMatchObject({
			mergedTweets: 3,
			results: [
				expect.objectContaining({
					tweetId: "mention_paginated",
					strategy: "conversation_search",
					pages: 3,
					count: 3,
				}),
			],
		});
	});

	it("does not mark default one-page xurl conversation scans as partial", async () => {
		setupTempHome();
		insertMention(
			"mention_large_default",
			"recent mention in large thread",
			"2026-05-12T10:00:00.000Z",
		);
		upsertMentionEdge("mention_large_default", {
			id: "mention_large_default",
			author_id: "42",
			text: "recent mention in large thread",
			created_at: "2026-05-12T10:00:00.000Z",
			conversation_id: "root_large_default",
		});
		mocks.searchRecentByConversationId.mockResolvedValue({
			data: [
				{
					id: "root_large_default",
					author_id: "25401953",
					text: "root in first page",
					created_at: "2026-05-12T09:58:00.000Z",
					conversation_id: "root_large_default",
				},
				{
					id: "mention_large_default",
					author_id: "42",
					text: "recent mention in large thread",
					created_at: "2026-05-12T10:00:00.000Z",
					conversation_id: "root_large_default",
					referenced_tweets: [{ type: "replied_to", id: "root_large_default" }],
					in_reply_to_user_id: "25401953",
				},
			],
			includes: {
				users: [
					{ id: "25401953", username: "steipete", name: "Peter" },
					{ id: "42", username: "sam", name: "Sam" },
				],
			},
			meta: { result_count: 2, next_token: "page-2" },
		});
		const { syncMentionThreads } = await import("./mention-threads-live");

		const result = await syncMentionThreads({
			mode: "xurl",
			limit: 1,
			delayMs: 0,
		});

		expect(mocks.searchRecentByConversationId).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			partial: false,
			results: [
				expect.objectContaining({
					tweetId: "mention_large_default",
					pages: 1,
					truncated: false,
				}),
			],
		});
	});

	it("marks xurl mention-thread syncs partial when max-pages leaves another page", async () => {
		setupTempHome();
		insertMention(
			"mention_truncated",
			"recent mention in a truncated thread",
			"2026-05-12T10:00:00.000Z",
		);
		upsertMentionEdge("mention_truncated", {
			id: "mention_truncated",
			author_id: "42",
			text: "recent mention in a truncated thread",
			created_at: "2026-05-12T10:00:00.000Z",
			conversation_id: "root_truncated",
		});
		mocks.searchRecentByConversationId.mockResolvedValue({
			data: [
				{
					id: "root_truncated",
					author_id: "25401953",
					text: "root in first truncated page",
					created_at: "2026-05-12T09:58:00.000Z",
					conversation_id: "root_truncated",
				},
				{
					id: "mention_truncated",
					author_id: "42",
					text: "recent mention in a truncated thread",
					created_at: "2026-05-12T10:00:00.000Z",
					conversation_id: "root_truncated",
					referenced_tweets: [{ type: "replied_to", id: "root_truncated" }],
					in_reply_to_user_id: "25401953",
				},
			],
			includes: {
				users: [
					{ id: "25401953", username: "steipete", name: "Peter" },
					{ id: "42", username: "sam", name: "Sam" },
				],
			},
			meta: { result_count: 1, next_token: "page-2" },
		});
		const { syncMentionThreads } = await import("./mention-threads-live");

		const result = await syncMentionThreads({
			mode: "xurl",
			limit: 1,
			delayMs: 0,
			maxPages: 1,
		});

		expect(result).toMatchObject({
			partial: true,
			results: [
				expect.objectContaining({
					tweetId: "mention_truncated",
					truncated: true,
				}),
			],
		});
	});

	it("passes timeout-ms to xurl thread fetches", async () => {
		vi.useFakeTimers();
		try {
			setupTempHome();
			insertMention(
				"mention_timeout",
				"timeout mention",
				"2026-05-12T10:00:00.000Z",
			);
			upsertMentionEdge("mention_timeout", {
				id: "mention_timeout",
				author_id: "42",
				text: "timeout mention",
				created_at: "2026-05-12T10:00:00.000Z",
				conversation_id: "root_timeout",
			});
			mocks.searchRecentByConversationId.mockImplementation(
				(_conversationId: string, options: { timeoutMs: number }) =>
					new Promise((_resolve, reject) => {
						setTimeout(
							() =>
								reject(
									new Error(`timed out after ${String(options.timeoutMs)}`),
								),
							options.timeoutMs,
						);
					}),
			);
			const { syncMentionThreads } = await import("./mention-threads-live");

			const resultPromise = syncMentionThreads({
				mode: "xurl",
				limit: 1,
				delayMs: 0,
				timeoutMs: 1000,
			});
			await vi.advanceTimersByTimeAsync(1000);
			const result = await resultPromise;

			expect(mocks.searchRecentByConversationId).toHaveBeenCalledWith(
				"root_timeout",
				{ maxResults: 100, paginationToken: undefined, timeoutMs: 1000 },
			);
			expect(result).toMatchObject({
				failed: 1,
				failures: [
					expect.objectContaining({
						tweetId: "mention_timeout",
						error: "timed out after 1000",
					}),
				],
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("uses one xurl timeout budget across paginated thread requests", async () => {
		vi.useFakeTimers();
		try {
			setupTempHome();
			insertMention(
				"mention_timeout_budget",
				"timeout budget mention",
				"2026-05-12T10:00:00.000Z",
			);
			upsertMentionEdge("mention_timeout_budget", {
				id: "mention_timeout_budget",
				author_id: "42",
				text: "timeout budget mention",
				created_at: "2026-05-12T10:00:00.000Z",
				conversation_id: "root_timeout_budget",
			});
			mocks.searchRecentByConversationId.mockImplementation(
				(
					_conversationId: string,
					options: { paginationToken?: string; timeoutMs: number },
				) =>
					new Promise((resolve, reject) => {
						if (!options.paginationToken) {
							setTimeout(
								() =>
									resolve({
										data: [
											{
												id: "first_timeout_budget_page",
												author_id: "42",
												text: "first page",
												created_at: "2026-05-12T10:00:00.000Z",
												conversation_id: "root_timeout_budget",
											},
										],
										meta: { next_token: "page-2" },
									}),
								700,
							);
							return;
						}
						setTimeout(
							() =>
								reject(
									new Error(`timed out after ${String(options.timeoutMs)}`),
								),
							options.timeoutMs,
						);
					}),
			);
			const { syncMentionThreads } = await import("./mention-threads-live");

			const resultPromise = syncMentionThreads({
				mode: "xurl",
				limit: 1,
				delayMs: 0,
				timeoutMs: 1000,
				maxPages: 2,
			});
			await vi.advanceTimersByTimeAsync(700);
			await vi.advanceTimersByTimeAsync(300);
			const result = await resultPromise;

			expect(mocks.searchRecentByConversationId).toHaveBeenNthCalledWith(
				1,
				"root_timeout_budget",
				{ maxResults: 100, paginationToken: undefined, timeoutMs: 1000 },
			);
			expect(mocks.searchRecentByConversationId).toHaveBeenNthCalledWith(
				2,
				"root_timeout_budget",
				{ maxResults: 100, paginationToken: "page-2", timeoutMs: 300 },
			);
			expect(result).toMatchObject({
				failed: 1,
				failures: [
					expect.objectContaining({
						tweetId: "mention_timeout_budget",
						error: "timed out after 300",
					}),
				],
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("walks parents when xurl search results omit ancestors", async () => {
		setupTempHome();
		insertMention(
			"mention_missing_root",
			"recent reply without root",
			"2026-05-12T10:00:00.000Z",
		);
		upsertMentionEdge("mention_missing_root", {
			id: "mention_missing_root",
			author_id: "42",
			text: "recent reply without root",
			created_at: "2026-05-12T10:00:00.000Z",
			conversation_id: "root_missing",
			referenced_tweets: [{ type: "replied_to", id: "parent_missing" }],
		});
		mocks.searchRecentByConversationId.mockResolvedValueOnce({
			data: [
				{
					id: "mention_missing_root",
					author_id: "42",
					text: "recent reply without root",
					created_at: "2026-05-12T10:00:00.000Z",
					conversation_id: "root_missing",
					referenced_tweets: [{ type: "replied_to", id: "parent_missing" }],
					in_reply_to_user_id: "43",
				},
			],
			includes: { users: [{ id: "42", username: "sam", name: "Sam" }] },
			meta: { result_count: 1 },
		});
		mocks.getTweetById
			.mockResolvedValueOnce({
				data: [
					{
						id: "parent_missing",
						author_id: "43",
						text: "missing parent",
						created_at: "2026-05-12T09:55:00.000Z",
						conversation_id: "root_missing",
						referenced_tweets: [{ type: "replied_to", id: "root_missing" }],
						in_reply_to_user_id: "25401953",
					},
				],
				includes: { users: [{ id: "43", username: "alex", name: "Alex" }] },
			})
			.mockResolvedValueOnce({
				data: [
					{
						id: "root_missing",
						author_id: "25401953",
						text: "missing root",
						created_at: "2026-05-12T09:50:00.000Z",
						conversation_id: "root_missing",
					},
				],
				includes: {
					users: [{ id: "25401953", username: "steipete", name: "Peter" }],
				},
			});
		const { syncMentionThreads } = await import("./mention-threads-live");

		const result = await syncMentionThreads({
			mode: "xurl",
			limit: 1,
			delayMs: 0,
		});
		const rows = getNativeDb()
			.prepare(
				"select id, reply_to_id from tweets where id in (?, ?, ?) order by id",
			)
			.all("mention_missing_root", "parent_missing", "root_missing");

		expect(mocks.getTweetById).toHaveBeenNthCalledWith(1, "parent_missing", {
			timeoutMs: expect.any(Number),
		});
		expect(mocks.getTweetById).toHaveBeenNthCalledWith(2, "root_missing", {
			timeoutMs: expect.any(Number),
		});
		expect(result).toMatchObject({
			mergedTweets: 3,
			generalReadTweets: 3,
			results: [
				expect.objectContaining({
					tweetId: "mention_missing_root",
					strategy: "conversation_search+parent_walk",
					fallbackDepth: 2,
					count: 3,
				}),
			],
			warnings: expect.arrayContaining([
				"recent search missed ancestor parent_missing for conversation root_missing; used parent walk",
			]),
		});
		expect(rows).toEqual([
			{ id: "mention_missing_root", reply_to_id: "parent_missing" },
			{ id: "parent_missing", reply_to_id: "root_missing" },
			{ id: "root_missing", reply_to_id: null },
		]);
	});

	it("preserves authored tweet kind when xurl context upserts the same tweet", async () => {
		setupTempHome();
		insertMention(
			"mention_to_authored",
			"reply to authored",
			"2026-05-12T10:00:00.000Z",
		);
		getNativeDb()
			.prepare(
				`
	    insert into tweets (
	      id, account_id, author_profile_id, kind, text, created_at,
	      is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
	      entities_json, media_json, quoted_tweet_id
	    ) values (
	      'authored_context', 'acct_primary', 'profile_user_25401953',
	      'authored', 'authored original', '2026-05-12T09:58:00.000Z',
	      0, null, 1, 1, 0, 0, '{}', '[{"url":"https://img.example/authored.jpg","type":"image"}]', null
	    )
	    `,
			)
			.run();
		upsertMentionEdge("mention_to_authored", {
			id: "mention_to_authored",
			author_id: "42",
			text: "reply to authored",
			created_at: "2026-05-12T10:00:00.000Z",
			conversation_id: "authored_context",
		});
		mocks.searchRecentByConversationId.mockResolvedValueOnce({
			data: [
				{
					id: "authored_context",
					author_id: "25401953",
					text: "authored original with fresh context",
					created_at: "2026-05-12T09:58:00.000Z",
					conversation_id: "authored_context",
					public_metrics: { like_count: 5 },
				},
				{
					id: "mention_to_authored",
					author_id: "42",
					text: "reply to authored",
					created_at: "2026-05-12T10:00:00.000Z",
					conversation_id: "authored_context",
					referenced_tweets: [{ type: "replied_to", id: "authored_context" }],
				},
			],
			includes: {
				users: [
					{ id: "25401953", username: "steipete", name: "Peter" },
					{ id: "42", username: "sam", name: "Sam" },
				],
			},
			meta: { result_count: 2 },
		});
		const { syncMentionThreads } = await import("./mention-threads-live");

		await syncMentionThreads({ mode: "xurl", limit: 1, delayMs: 0 });

		const row = getNativeDb()
			.prepare(
				"select kind, text, like_count, media_count, media_json from tweets where id = ?",
			)
			.get("authored_context");
		expect(row).toEqual({
			kind: "authored",
			text: "authored original with fresh context",
			like_count: 5,
			media_count: 1,
			media_json: '[{"url":"https://img.example/authored.jpg","type":"image"}]',
		});
	});

	it("prefers fetched anchor data when cached xurl mentions lack parent metadata", async () => {
		setupTempHome();
		insertMention(
			"mention_anchor_lookup",
			"cached mention without reference data",
			"2026-05-05T11:00:00.000Z",
		);
		upsertMentionEdge("mention_anchor_lookup", {
			id: "mention_anchor_lookup",
			author_id: "42",
			text: "cached mention without reference data",
			created_at: "2026-05-05T11:00:00.000Z",
			conversation_id: "root_anchor_lookup",
		});
		mocks.searchRecentByConversationId.mockResolvedValueOnce({
			data: [],
			meta: { result_count: 0 },
		});
		mocks.getTweetById
			.mockResolvedValueOnce({
				data: [
					{
						id: "mention_anchor_lookup",
						author_id: "42",
						text: "fresh mention with reference data",
						created_at: "2026-05-05T11:00:00.000Z",
						conversation_id: "root_anchor_lookup",
						referenced_tweets: [
							{ type: "replied_to", id: "parent_anchor_lookup" },
						],
						in_reply_to_user_id: "43",
					},
				],
				includes: { users: [{ id: "42", username: "sam", name: "Sam" }] },
			})
			.mockResolvedValueOnce({
				data: [
					{
						id: "parent_anchor_lookup",
						author_id: "43",
						text: "fresh parent",
						created_at: "2026-05-05T10:58:00.000Z",
						conversation_id: "root_anchor_lookup",
					},
				],
				includes: { users: [{ id: "43", username: "alex", name: "Alex" }] },
			});
		const { syncMentionThreads } = await import("./mention-threads-live");

		const result = await syncMentionThreads({
			mode: "xurl",
			limit: 1,
			delayMs: 0,
		});
		const row = getNativeDb()
			.prepare("select text, reply_to_id from tweets where id = ?")
			.get("mention_anchor_lookup");

		expect(mocks.getTweetById).toHaveBeenNthCalledWith(
			1,
			"mention_anchor_lookup",
			{ timeoutMs: expect.any(Number) },
		);
		expect(mocks.getTweetById).toHaveBeenNthCalledWith(
			2,
			"parent_anchor_lookup",
			{ timeoutMs: expect.any(Number) },
		);
		expect(result).toMatchObject({
			mergedTweets: 2,
			generalReadTweets: 2,
			results: [
				expect.objectContaining({
					tweetId: "mention_anchor_lookup",
					strategy: "parent_walk",
					fallbackDepth: 1,
					count: 2,
				}),
			],
		});
		expect(row).toEqual({
			text: "fresh mention with reference data",
			reply_to_id: "parent_anchor_lookup",
		});
	});

	it("walks parents for legacy mentions with reply ids but no conversation id", async () => {
		setupTempHome();
		insertMention(
			"mention_legacy_reply",
			"legacy mention with local reply id",
			"2026-05-05T11:00:00.000Z",
		);
		getNativeDb()
			.prepare("update tweets set is_replied = 1, reply_to_id = ? where id = ?")
			.run("parent_legacy_reply", "mention_legacy_reply");
		upsertMentionEdge("mention_legacy_reply", {
			id: "mention_legacy_reply",
			author_id: "42",
			text: "legacy mention with no conversation id",
			created_at: "2026-05-05T11:00:00.000Z",
		});
		mocks.getTweetById
			.mockResolvedValueOnce({
				data: [
					{
						id: "parent_legacy_reply",
						author_id: "43",
						text: "legacy parent",
						created_at: "2026-05-05T10:58:00.000Z",
						referenced_tweets: [
							{ type: "replied_to", id: "root_legacy_reply" },
						],
						in_reply_to_user_id: "25401953",
					},
				],
				includes: { users: [{ id: "43", username: "alex", name: "Alex" }] },
			})
			.mockResolvedValueOnce({
				data: [
					{
						id: "root_legacy_reply",
						author_id: "25401953",
						text: "legacy root",
						created_at: "2026-05-05T10:55:00.000Z",
					},
				],
				includes: {
					users: [{ id: "25401953", username: "steipete", name: "Peter" }],
				},
			});
		const { syncMentionThreads } = await import("./mention-threads-live");

		const result = await syncMentionThreads({
			mode: "xurl",
			limit: 1,
			delayMs: 0,
		});
		const rows = getNativeDb()
			.prepare(
				"select id, reply_to_id from tweets where id in (?, ?, ?) order by id",
			)
			.all("mention_legacy_reply", "parent_legacy_reply", "root_legacy_reply");

		expect(mocks.searchRecentByConversationId).not.toHaveBeenCalled();
		expect(mocks.getTweetById).toHaveBeenNthCalledWith(
			1,
			"parent_legacy_reply",
			{ timeoutMs: expect.any(Number) },
		);
		expect(mocks.getTweetById).toHaveBeenNthCalledWith(2, "root_legacy_reply", {
			timeoutMs: expect.any(Number),
		});
		expect(result).toMatchObject({
			mergedTweets: 3,
			generalReadTweets: 2,
			warnings: expect.arrayContaining([
				"missing conversation_id for mention_legacy_reply; used parent walk",
			]),
			results: [
				expect.objectContaining({
					tweetId: "mention_legacy_reply",
					strategy: "parent_walk",
					fallbackDepth: 2,
					count: 3,
				}),
			],
		});
		expect(rows).toEqual([
			{ id: "mention_legacy_reply", reply_to_id: "parent_legacy_reply" },
			{ id: "parent_legacy_reply", reply_to_id: "root_legacy_reply" },
			{ id: "root_legacy_reply", reply_to_id: null },
		]);
	});

	it("falls back to walking the xurl parent chain for older conversations", async () => {
		setupTempHome();
		insertMention("mention_old", "old mention", "2026-05-05T11:00:00.000Z");
		upsertMentionEdge(
			"mention_old",
			{
				id: "mention_old",
				author_id: "42",
				text: "old mention",
				created_at: "2026-05-05T11:00:00.000Z",
				conversation_id: "root_old",
				referenced_tweets: [{ type: "replied_to", id: "parent_old" }],
			},
			"2026-05-12T10:00:00.000Z",
			"bird",
		);
		mocks.searchRecentByConversationId.mockResolvedValueOnce({
			data: [],
			meta: { result_count: 0 },
		});
		mocks.getTweetById
			.mockResolvedValueOnce({
				data: [
					{
						id: "parent_old",
						author_id: "43",
						text: "parent post",
						created_at: "2026-05-01T09:55:00.000Z",
						conversation_id: "root_old",
						referenced_tweets: [{ type: "replied_to", id: "root_old" }],
						in_reply_to_user_id: "25401953",
					},
				],
				includes: { users: [{ id: "43", username: "alex", name: "Alex" }] },
			})
			.mockResolvedValueOnce({
				data: [
					{
						id: "root_old",
						author_id: "25401953",
						text: "root old",
						created_at: "2026-05-01T09:50:00.000Z",
						conversation_id: "root_old",
					},
				],
				includes: {
					users: [{ id: "25401953", username: "steipete", name: "Peter" }],
				},
			});
		const { syncMentionThreads } = await import("./mention-threads-live");

		const result = await syncMentionThreads({
			mode: "xurl",
			limit: 1,
			delayMs: 0,
		});
		const chainRows = getNativeDb()
			.prepare(
				"select id, kind, reply_to_id from tweets where id in (?, ?, ?) order by id",
			)
			.all("mention_old", "parent_old", "root_old");

		expect(mocks.searchRecentByConversationId).toHaveBeenCalledWith(
			"root_old",
			{
				maxResults: 100,
				paginationToken: undefined,
				timeoutMs: expect.any(Number),
			},
		);
		expect(mocks.getTweetById).toHaveBeenNthCalledWith(1, "parent_old", {
			timeoutMs: expect.any(Number),
		});
		expect(mocks.getTweetById).toHaveBeenNthCalledWith(2, "root_old", {
			timeoutMs: expect.any(Number),
		});
		expect(result).toMatchObject({
			source: "xurl",
			mergedTweets: 3,
			generalReadTweets: 2,
			results: [
				expect.objectContaining({
					tweetId: "mention_old",
					strategy: "parent_walk",
					fallbackDepth: 2,
					count: 3,
				}),
			],
		});
		expect(chainRows).toEqual([
			{ id: "mention_old", kind: "mention", reply_to_id: "parent_old" },
			{ id: "parent_old", kind: "thread", reply_to_id: "root_old" },
			{ id: "root_old", kind: "home", reply_to_id: null },
		]);
	});

	it("caps xurl fallback parent walks at twelve hops", async () => {
		setupTempHome();
		insertMention("mention_deep", "deep mention", "2026-05-05T11:00:00.000Z");
		upsertMentionEdge("mention_deep", {
			id: "mention_deep",
			author_id: "42",
			text: "deep mention",
			created_at: "2026-05-05T11:00:00.000Z",
			conversation_id: "root_deep",
			referenced_tweets: [{ type: "replied_to", id: "parent_1" }],
		});
		mocks.searchRecentByConversationId.mockResolvedValueOnce({
			data: [],
			meta: { result_count: 0 },
		});
		for (let index = 1; index <= 12; index += 1) {
			mocks.getTweetById.mockResolvedValueOnce({
				data: [
					{
						id: `parent_${String(index)}`,
						author_id: "42",
						text: `parent ${String(index)}`,
						created_at: "2026-05-01T09:00:00.000Z",
						conversation_id: "root_deep",
						referenced_tweets: [
							{ type: "replied_to", id: `parent_${String(index + 1)}` },
						],
						in_reply_to_user_id: "43",
					},
				],
			});
		}
		const { syncMentionThreads } = await import("./mention-threads-live");

		const result = await syncMentionThreads({
			mode: "xurl",
			limit: 1,
			delayMs: 0,
		});

		expect(mocks.getTweetById).toHaveBeenCalledTimes(12);
		expect(mocks.getTweetById).not.toHaveBeenCalledWith("parent_13");
		expect(result).toMatchObject({
			warnings: expect.arrayContaining([
				"fallback parent-chain depth cap reached for mention_deep after 12 hops",
			]),
			results: [
				expect.objectContaining({
					tweetId: "mention_deep",
					strategy: "parent_walk",
					fallbackDepth: 12,
					count: 13,
					warnings: expect.arrayContaining([
						"fallback parent-chain depth cap reached for mention_deep after 12 hops",
					]),
				}),
			],
		});
	});

	it("validates mention thread sync options", async () => {
		setupTempHome();
		const { syncMentionThreads } = await import("./mention-threads-live");

		await expect(syncMentionThreads({ limit: 0 })).rejects.toThrow(
			"--limit must be at least 1",
		);
		await expect(syncMentionThreads({ delayMs: -1 })).rejects.toThrow(
			"--delay-ms must be non-negative",
		);
		await expect(syncMentionThreads({ timeoutMs: 0 })).rejects.toThrow(
			"--timeout-ms must be at least 1",
		);
		await expect(syncMentionThreads({ maxPages: -1 })).rejects.toThrow(
			"--max-pages must be non-negative",
		);
		await expect(syncMentionThreads({ mode: "auto" })).rejects.toThrow(
			"--mode must be bird or xurl",
		);
		await expect(syncMentionThreads({ account: "missing" })).rejects.toThrow(
			"Unknown account: missing",
		);
	});
});
