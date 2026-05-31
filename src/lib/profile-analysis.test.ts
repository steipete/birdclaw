// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { streamProfileAnalysis } from "./profile-analysis";
import { listTimelineItems } from "./queries";

const mocks = vi.hoisted(() => ({
	listUserTweetsEffect: vi.fn(),
	lookupUsersByHandlesEffect: vi.fn(),
	searchRecentByConversationIdEffect: vi.fn(),
}));

vi.mock("./xurl", () => ({
	listUserTweetsEffect: (...args: unknown[]) =>
		mocks.listUserTweetsEffect(...args),
	lookupUsersByHandlesEffect: (...args: unknown[]) =>
		mocks.lookupUsersByHandlesEffect(...args),
	searchRecentByConversationIdEffect: (...args: unknown[]) =>
		mocks.searchRecentByConversationIdEffect(...args),
}));

const tempRoots: string[] = [];

function setupTempHome() {
	const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-profile-ai-"));
	tempRoots.push(tempRoot);
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
}

const profileUser = {
	id: "42",
	username: "alice",
	name: "Alice",
	description: "Builds quiet tools.",
	public_metrics: { followers_count: 1200, following_count: 50 },
	profile_image_url:
		"https://pbs.twimg.com/profile_images/42/avatar_normal.jpg",
};

beforeEach(() => {
	setupTempHome();
	process.env.OPENAI_API_KEY = "test-key";
	process.env.BIRDCLAW_PROFILE_ANALYSIS_CONVERSATION_DELAY_MS = "0";
	process.env.BIRDCLAW_PROFILE_ANALYSIS_RATE_LIMIT_RETRY_MS = "0";
	process.env.BIRDCLAW_PROFILE_ANALYSIS_RATE_LIMIT_MAX_RETRIES = "0";
	mocks.lookupUsersByHandlesEffect.mockReset();
	mocks.listUserTweetsEffect.mockReset();
	mocks.searchRecentByConversationIdEffect.mockReset();
	mocks.lookupUsersByHandlesEffect.mockReturnValue(
		Effect.succeed([profileUser]),
	);
	mocks.listUserTweetsEffect.mockReturnValue(
		Effect.succeed({
			items: [
				{
					id: "tweet_1",
					author_id: "42",
					text: "Local tools should remember context.",
					created_at: "2026-05-20T10:00:00.000Z",
					conversation_id: "tweet_1",
					public_metrics: {
						like_count: 10,
						reply_count: 2,
						retweet_count: 1,
						quote_count: 0,
					},
				},
			],
			nextToken: null,
			includes: { users: [profileUser], media: [] },
		}),
	);
	mocks.searchRecentByConversationIdEffect.mockReturnValue(
		Effect.succeed({
			data: [
				{
					id: "reply_1",
					author_id: "99",
					text: "The memory part matters.",
					created_at: "2026-05-20T10:02:00.000Z",
					conversation_id: "tweet_1",
					public_metrics: { like_count: 3 },
				},
			],
			includes: {
				users: [
					profileUser,
					{
						id: "99",
						username: "bob",
						name: "Bob",
						description: "Replies to tools.",
						public_metrics: { followers_count: 40 },
					},
				],
				media: [],
			},
			meta: {},
		}),
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json({
				output_text:
					'# Alice\n\nBuilds local memory tools. (tweet_1)\n\n---\n{"title":"Alice","summary":"Builds local memory tools.","voice":"Practical","themes":[{"title":"Local memory","summary":"Recurring local-first tooling.","tweetIds":["tweet_1"],"handles":["alice"]}],"conversationStyle":"Direct","notableSignals":["Conversation replies reinforce memory angle."],"risks":[],"followUps":["Ask about sync."],"sourceTweetIds":["tweet_1"],"sourceHandles":["alice"]}',
			}),
		),
	);
});

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	delete process.env.OPENAI_API_KEY;
	delete process.env.BIRDCLAW_PROFILE_ANALYSIS_CONVERSATION_DELAY_MS;
	delete process.env.BIRDCLAW_PROFILE_ANALYSIS_RATE_LIMIT_RETRY_MS;
	delete process.env.BIRDCLAW_PROFILE_ANALYSIS_RATE_LIMIT_MAX_RETRIES;
	vi.unstubAllGlobals();
	for (const tempRoot of tempRoots.splice(0)) {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

describe("profile analysis", () => {
	it("backfills profile tweets and conversation context before caching the AI result", async () => {
		const events: string[] = [];
		const result = await streamProfileAnalysis(
			{
				handle: "@alice",
				maxPages: 1,
				maxTweets: 10,
				maxConversations: 1,
				maxConversationPages: 1,
			},
			{
				onEvent: (event) => {
					if (event.type === "status") events.push(event.label);
				},
			},
		);

		expect(result.markdown).toContain("Builds local memory tools");
		expect(result.context.counts).toMatchObject({
			tweets: 1,
			conversationsScanned: 1,
			conversationTweets: 1,
		});
		expect(events).toContain("Fetching profile tweets");
		expect(events).toContain("Fetching conversations");
		expect(
			getNativeDb()
				.prepare(
					"select count(*) as count from tweet_account_edges where kind = 'profile'",
				)
				.get(),
		).toEqual({ count: 1 });
		expect(
			getNativeDb()
				.prepare(
					"select count(*) as count from tweet_account_edges where kind = 'thread_context'",
				)
				.get(),
		).toEqual({ count: 1 });
		expect(
			listTimelineItems({
				resource: "search",
				search: "Local tools",
				limit: 10,
			}).map((item) => item.id),
		).not.toContain("tweet_1");

		const cached = await streamProfileAnalysis({
			handle: "alice",
			maxPages: 1,
			maxTweets: 10,
			maxConversations: 1,
			maxConversationPages: 1,
		});
		expect(cached.cached).toBe(true);
		expect(mocks.listUserTweetsEffect).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("keeps unchanged backfilled tweets to one FTS row", async () => {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			await streamProfileAnalysis({
				handle: "alice",
				maxPages: 1,
				maxTweets: 10,
				maxConversations: 1,
				maxConversationPages: 1,
				refresh: true,
			});
		}

		expect(
			getNativeDb()
				.prepare(
					"select tweet_id, count(*) as count from tweets_fts where tweet_id in ('tweet_1', 'reply_1') group by tweet_id order by tweet_id",
				)
				.all(),
		).toEqual([
			{ tweet_id: "reply_1", count: 1 },
			{ tweet_id: "tweet_1", count: 1 },
		]);
	});

	it("summarizes with partial context when conversation search is rate limited", async () => {
		mocks.searchRecentByConversationIdEffect.mockReturnValue(
			Effect.fail(
				new Error(
					'Command failed: xurl search\n{"title":"Too Many Requests","status":429}',
				),
			),
		);
		const events: string[] = [];

		const result = await streamProfileAnalysis(
			{
				handle: "alice",
				maxPages: 1,
				maxTweets: 10,
				maxConversations: 1,
				maxConversationPages: 1,
				refresh: true,
			},
			{
				onEvent: (event) => {
					if (event.type === "status") events.push(event.label);
				},
			},
		);

		expect(result.markdown).toContain("Builds local memory tools");
		expect(result.context.counts).toMatchObject({
			tweets: 1,
			conversationTweets: 0,
			conversationPages: 0,
		});
		expect(events).toContain("Conversation fetch rate limited");
		expect(
			getNativeDb()
				.prepare(
					"select count(*) as count from sync_cache where cache_key like 'profile-analysis:context:%'",
				)
				.get(),
		).toEqual({ count: 0 });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("retries conversation search once after a rate limit before using context", async () => {
		mocks.searchRecentByConversationIdEffect
			.mockReturnValueOnce(
				Effect.fail(
					new Error(
						'Command failed: xurl search\n{"title":"Too Many Requests","status":429}',
					),
				),
			)
			.mockReturnValueOnce(
				Effect.succeed({
					data: [
						{
							id: "reply_retry",
							author_id: "99",
							text: "Retry recovered the conversation.",
							created_at: "2026-05-20T10:03:00.000Z",
							conversation_id: "tweet_1",
							public_metrics: { like_count: 4 },
						},
					],
					includes: {
						users: [
							{
								id: "99",
								username: "bob",
								name: "Bob",
								description: "Replies to tools.",
								public_metrics: { followers_count: 40 },
							},
						],
						media: [],
					},
					meta: {},
				}),
			);
		const events: string[] = [];

		const result = await streamProfileAnalysis(
			{
				handle: "alice",
				maxPages: 1,
				maxTweets: 10,
				maxConversations: 1,
				maxConversationPages: 1,
				refresh: true,
				rateLimitRetryMs: 0,
				rateLimitMaxRetries: 1,
			},
			{
				onEvent: (event) => {
					if (event.type === "status") events.push(event.label);
				},
			},
		);

		expect(result.context.counts.conversationTweets).toBe(1);
		expect(result.context.conversations[0]?.id).toBe("reply_retry");
		expect(mocks.searchRecentByConversationIdEffect).toHaveBeenCalledTimes(2);
		expect(events).toContain("Conversation fetch rate limited");
	});

	it("invalidates the AI cache when prompt-visible metrics change", async () => {
		mocks.listUserTweetsEffect
			.mockReturnValueOnce(
				Effect.succeed({
					items: [
						{
							id: "tweet_1",
							author_id: "42",
							text: "Local tools should remember context.",
							created_at: "2026-05-20T10:00:00.000Z",
							conversation_id: "tweet_1",
							public_metrics: {
								like_count: 10,
								reply_count: 2,
								retweet_count: 1,
								quote_count: 0,
							},
						},
					],
					nextToken: null,
					includes: { users: [profileUser], media: [] },
				}),
			)
			.mockReturnValueOnce(
				Effect.succeed({
					items: [
						{
							id: "tweet_1",
							author_id: "42",
							text: "Local tools should remember context.",
							created_at: "2026-05-20T10:00:00.000Z",
							conversation_id: "tweet_1",
							public_metrics: {
								like_count: 10,
								reply_count: 2,
								retweet_count: 1,
								quote_count: 7,
							},
						},
					],
					nextToken: null,
					includes: { users: [profileUser], media: [] },
				}),
			);

		for (let attempt = 0; attempt < 2; attempt += 1) {
			await streamProfileAnalysis({
				handle: "alice",
				maxPages: 1,
				maxTweets: 10,
				maxConversations: 1,
				maxConversationPages: 1,
				refresh: true,
			});
		}

		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("honors tiny max tweet limits before storing fetched pages", async () => {
		mocks.listUserTweetsEffect.mockReturnValueOnce(
			Effect.succeed({
				items: Array.from({ length: 5 }, (_, index) => ({
					id: `tweet_${String(index + 1)}`,
					author_id: "42",
					text: `Tweet ${String(index + 1)}`,
					created_at: `2026-05-20T10:0${String(index)}:00.000Z`,
					conversation_id: `tweet_${String(index + 1)}`,
					public_metrics: { like_count: 1 },
				})),
				nextToken: null,
				includes: { users: [profileUser], media: [] },
			}),
		);

		const result = await streamProfileAnalysis({
			handle: "alice",
			maxPages: 1,
			maxTweets: 1,
			maxConversations: 1,
			maxConversationPages: 1,
			refresh: true,
		});

		expect(result.context.tweets.map((tweet) => tweet.id)).toEqual(["tweet_1"]);
		expect(
			getNativeDb()
				.prepare(
					"select count(*) as count from tweet_account_edges where kind = 'profile'",
				)
				.get(),
		).toEqual({ count: 1 });
	});

	it("stops before xurl backfill when the request is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(
			streamProfileAnalysis({
				handle: "alice",
				maxPages: 1,
				maxTweets: 10,
				maxConversations: 1,
				maxConversationPages: 1,
				signal: controller.signal,
			}),
		).rejects.toThrow("Profile analysis aborted");
		expect(mocks.lookupUsersByHandlesEffect).not.toHaveBeenCalled();
		expect(mocks.listUserTweetsEffect).not.toHaveBeenCalled();
	});
});
