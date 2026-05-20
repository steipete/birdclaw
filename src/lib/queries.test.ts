// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { listInboxItems } from "./inbox";
import {
	applyDmRequestMutationToLocalStore,
	createDmReply,
	createDmReplyEffect,
	createPost,
	createPostEffect,
	createTweetReply,
	createTweetReplyEffect,
	getConversationThread,
	getQueryEnvelope,
	getQueryEnvelopeEffect,
	getTweetConversation,
	listDmConversations,
	listTimelineItems,
	queryResource,
} from "./queries";

const mocks = vi.hoisted(() => ({
	findArchives: vi.fn(),
	getTransportStatus: vi.fn(),
	postViaXurl: vi.fn(),
	replyViaXurl: vi.fn(),
	dmViaXurl: vi.fn(),
	lookupAuthenticatedUser: vi.fn(),
}));

vi.mock("./archive-finder", async () => {
	const { Effect } = await import("effect");
	const toError = (error: unknown) =>
		error instanceof Error ? error : new Error(String(error));
	return {
		findArchives: mocks.findArchives,
		findArchivesEffect: () =>
			Effect.tryPromise({
				try: () => mocks.findArchives(),
				catch: toError,
			}),
	};
});

vi.mock("./xurl", async () => {
	const { Effect } = await import("effect");
	const toError = (error: unknown) =>
		error instanceof Error ? error : new Error(String(error));
	return {
		getTransportStatus: mocks.getTransportStatus,
		getTransportStatusEffect: () =>
			Effect.tryPromise({
				try: () => mocks.getTransportStatus(),
				catch: toError,
			}),
		postViaXurl: mocks.postViaXurl,
		postViaXurlEffect: (text: string) =>
			Effect.tryPromise({
				try: () => mocks.postViaXurl(text),
				catch: toError,
			}),
		replyViaXurl: mocks.replyViaXurl,
		replyViaXurlEffect: (tweetId: string, text: string) =>
			Effect.tryPromise({
				try: () => mocks.replyViaXurl(tweetId, text),
				catch: toError,
			}),
		dmViaXurl: mocks.dmViaXurl,
		dmViaXurlEffect: (handle: string, text: string) =>
			Effect.tryPromise({
				try: () => mocks.dmViaXurl(handle, text),
				catch: toError,
			}),
		lookupAuthenticatedUser: mocks.lookupAuthenticatedUser,
		lookupAuthenticatedUserFresh: mocks.lookupAuthenticatedUser,
	};
});

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
	mocks.findArchives.mockReset();
	mocks.getTransportStatus.mockReset();
	mocks.postViaXurl.mockReset();
	mocks.replyViaXurl.mockReset();
	mocks.dmViaXurl.mockReset();
	mocks.lookupAuthenticatedUser.mockReset();
	delete process.env.BIRDCLAW_DISABLE_LIVE_WRITES;
	delete process.env.BIRDCLAW_E2E;
	delete process.env.BIRDCLAW_E2E_FAKE_LIVE_WRITES;

	for (const tempRoot of tempRoots.splice(0)) {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

describe("birdclaw queries", () => {
	beforeEach(() => {
		mocks.findArchives.mockResolvedValue([
			{
				path: "/Users/steipete/Downloads/twitter-2026.zip",
				name: "twitter-2026.zip",
				size: 4_200_000,
				sizeFormatted: "4.2 MB",
				modifiedTime: "2026-03-08T08:00:00.000Z",
				dateFormatted: "Today",
			},
		]);
		mocks.getTransportStatus.mockResolvedValue({
			installed: true,
			availableTransport: "xurl",
			statusText: "xurl available",
			rawStatus: "ok",
		});
		mocks.postViaXurl.mockResolvedValue({ ok: true, output: "posted" });
		mocks.replyViaXurl.mockResolvedValue({ ok: true, output: "replied" });
		mocks.dmViaXurl.mockResolvedValue({ ok: true, output: "sent" });
		mocks.lookupAuthenticatedUser.mockResolvedValue({
			id: "25401953",
			username: "steipete",
		});
	});

	it("filters DM conversations by follower threshold and reply state", () => {
		setupTempHome();

		const unreplied = listDmConversations({
			replyFilter: "unreplied",
			minFollowers: 1000,
		});

		expect(unreplied.map((item) => item.id)).toEqual(["dm_001", "dm_003"]);
		expect(unreplied[0]?.participant.bio).toContain("AGI");
		expect(unreplied[0]?.participant.avatarUrl).toMatch(
			/^data:image\/svg\+xml/,
		);
	});

	it("filters DM conversations by derived influence score", () => {
		setupTempHome();

		const highSignal = listDmConversations({
			minInfluenceScore: 120,
			sort: "followers",
		});

		expect(highSignal.map((item) => item.id)).toEqual([
			"dm_001",
			"dm_004",
			"dm_002",
		]);
		expect(highSignal[0]?.influenceLabel).toBe("very high");
	});

	it("sorts DM conversations by follower count before applying the limit", () => {
		setupTempHome();
		const db = getNativeDb();
		db.prepare("update dm_conversations set last_message_at = ?").run(
			"2026-05-01T00:00:00.000Z",
		);
		db.prepare(
			"update dm_conversations set last_message_at = ? where id = 'dm_003'",
		).run("2026-05-03T00:00:00.000Z");

		const sorted = listDmConversations({
			sort: "followers",
			limit: 1,
		});

		expect(sorted.map((item) => item.id)).toEqual(["dm_001"]);
	});

	it("applies influence score filters before follower-sort limits", () => {
		setupTempHome();

		const filtered = listDmConversations({
			maxInfluenceScore: 100,
			sort: "followers",
			limit: 1,
		});

		expect(filtered.map((item) => item.id)).toEqual(["dm_003"]);
	});

	it("filters DM conversations by accepted/request inbox", () => {
		setupTempHome();
		const db = getNativeDb();
		db.prepare(
			"update dm_conversations set inbox_kind = 'request' where id = ?",
		).run("dm_003");

		expect(
			listDmConversations({ inbox: "requests" }).map((item) => item.id),
		).toEqual(["dm_003"]);
		expect(
			listDmConversations({ inbox: "accepted" })
				.map((item) => item.id)
				.includes("dm_003"),
		).toBe(false);
		expect(listDmConversations({ inbox: "requests" })[0]).toMatchObject({
			inboxKind: "request",
			isMessageRequest: true,
		});
	});

	it("applies live DM request mutations to the local store", () => {
		setupTempHome();
		const db = getNativeDb();
		db.prepare(
			"update dm_conversations set inbox_kind = 'request' where id = ?",
		).run("dm_003");

		expect(
			applyDmRequestMutationToLocalStore("dm_003", "accept"),
		).toBeGreaterThan(0);
		expect(listDmConversations({ inbox: "requests" })).toHaveLength(0);
		expect(listDmConversations({ inbox: "accepted" })).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "dm_003",
					inboxKind: "accepted",
					isMessageRequest: false,
				}),
			]),
		);

		db.prepare(
			"update dm_conversations set inbox_kind = 'request' where id = ?",
		).run("dm_003");
		db.prepare(
			"insert into sync_cache (cache_key, value_json, updated_at) values ('dms:bird:acct_primary:20:requests:max-pages:0', '{}', '2026-05-01T00:00:00.000Z')",
		).run();

		expect(
			applyDmRequestMutationToLocalStore("dm_003", "reject"),
		).toBeGreaterThan(0);
		expect(getConversationThread("dm_003")).toBeNull();
		expect(
			db
				.prepare(
					"select count(*) as count from sync_cache where cache_key like 'dms:bird:%'",
				)
				.get(),
		).toEqual({ count: 0 });
	});

	it("filters DM conversations by participant, search, and upper bounds", () => {
		setupTempHome();

		const filtered = listDmConversations({
			participant: "amelia",
			search: "context rail",
			maxFollowers: 10_000,
			maxInfluenceScore: 95,
			replyFilter: "unreplied",
		});

		expect(filtered.map((item) => item.id)).toEqual(["dm_003"]);
		expect(filtered[0]?.lastMessagePreview).toContain("context rail");
		expect(filtered[0]?.searchSnippet).toContain(
			"<mark>context</mark> <mark>rail</mark>",
		);
	});

	it("filters DM conversations by time before applying the limit", () => {
		setupTempHome();
		const db = getNativeDb();
		db.prepare(
			"update dm_conversations set last_message_at = ? where id in ('dm_001', 'dm_002', 'dm_003')",
		).run("2026-05-03T00:00:00.000Z");
		db.prepare(
			"update dm_conversations set last_message_at = ? where id = 'dm_004'",
		).run("2026-05-01T12:00:00.000Z");

		const filtered = listDmConversations({
			since: "2026-05-01T00:00:00.000Z",
			until: "2026-05-02T00:00:00.000Z",
			limit: 1,
		});

		expect(filtered.map((item) => item.id)).toEqual(["dm_004"]);
	});

	it("uses the latest matching DM message as the search snippet", () => {
		setupTempHome();
		const db = getNativeDb();

		const messages = [
			{
				id: "msg_dm_search_older",
				text: "older needleword snippet should not win",
				createdAt: "2026-03-08T09:00:00.000Z",
			},
			{
				id: "msg_dm_search_latest",
				text: "latest needleword snippet should win",
				createdAt: "2026-03-08T10:00:00.000Z",
			},
		];

		for (const message of messages) {
			db.prepare(
				`
        insert into dm_messages (
          id, conversation_id, sender_profile_id, text, created_at, direction, is_replied, media_count
        ) values (?, 'dm_003', 'profile_me', ?, ?, 'outbound', 1, 0)
        `,
			).run(message.id, message.text, message.createdAt);
			db.prepare("insert into dm_fts (message_id, text) values (?, ?)").run(
				message.id,
				message.text,
			);
		}

		db.prepare(
			"update dm_conversations set last_message_at = ? where id = 'dm_003'",
		).run(messages[1].createdAt);

		const filtered = listDmConversations({ search: "needleword" });

		expect(filtered.map((item) => item.id)).toEqual(["dm_003"]);
		expect(filtered[0]?.searchSnippet).toContain(
			"latest <mark>needleword</mark> snippet should win",
		);
	});

	it("returns nearby DM context when requested for search results", () => {
		setupTempHome();
		const db = getNativeDb();
		const messages = [
			{
				id: "msg_dm_context_before",
				text: "before the identity hint",
				createdAt: "2026-03-08T11:00:00.000Z",
			},
			{
				id: "msg_dm_context_match",
				text: "needlectx is the blacksmith cofounder",
				createdAt: "2026-03-08T11:01:00.000Z",
			},
			{
				id: "msg_dm_context_after",
				text: "after the identity hint",
				createdAt: "2026-03-08T11:02:00.000Z",
			},
		];

		for (const message of messages) {
			db.prepare(
				`
        insert into dm_messages (
          id, conversation_id, sender_profile_id, text, created_at, direction, is_replied, media_count
        ) values (?, 'dm_003', 'profile_me', ?, ?, 'outbound', 1, 0)
        `,
			).run(message.id, message.text, message.createdAt);
			db.prepare("insert into dm_fts (message_id, text) values (?, ?)").run(
				message.id,
				message.text,
			);
		}

		const filtered = listDmConversations({
			search: "needlectx",
			context: 1,
		});

		expect(filtered[0]?.matches?.[0]).toMatchObject({
			message: expect.objectContaining({
				id: "msg_dm_context_match",
				text: "needlectx is the blacksmith cofounder",
			}),
			before: [expect.objectContaining({ id: "msg_dm_context_before" })],
			after: [expect.objectContaining({ id: "msg_dm_context_after" })],
		});
	});

	it("sanitizes handle-shaped DM search queries for FTS", () => {
		setupTempHome();
		const db = getNativeDb();
		db.prepare(
			`
        insert into dm_messages (
          id, conversation_id, sender_profile_id, text, created_at, direction, is_replied, media_count
        ) values (?, 'dm_003', 'profile_me', ?, ?, 'outbound', 1, 0)
        `,
		).run(
			"msg_dm_handle_query",
			"ask @github about the identity clue",
			"2026-03-08T11:03:00.000Z",
		);
		db.prepare("insert into dm_fts (message_id, text) values (?, ?)").run(
			"msg_dm_handle_query",
			"ask @github about the identity clue",
		);

		const filtered = listDmConversations({
			search: "@github",
			context: 1,
		});

		expect(filtered.map((item) => item.id)).toEqual(["dm_003"]);
		expect(filtered[0]?.searchSnippet).toContain("<mark>github</mark>");
		expect(filtered[0]?.matches?.[0]?.message.id).toBe("msg_dm_handle_query");
	});

	it("treats punctuation-only DM search as an unfiltered query", () => {
		setupTempHome();

		const filtered = listDmConversations({
			search: "@",
			context: 1,
		});

		expect(filtered.map((item) => item.id)).toEqual([
			"dm_001",
			"dm_003",
			"dm_002",
			"dm_004",
		]);
		expect(
			filtered.every(
				(item) =>
					item.searchSnippet === null || item.searchSnippet === undefined,
			),
		).toBe(true);
		expect(filtered.every((item) => item.matches === undefined)).toBe(true);
	});

	it("omits DM search snippets when no query is provided", () => {
		setupTempHome();

		const items = listDmConversations({ limit: 1 });

		expect(items[0]).not.toHaveProperty("searchSnippet");
	});

	it("hydrates a selected conversation thread with sender context", () => {
		setupTempHome();

		const thread = getConversationThread("dm_003");

		expect(thread?.conversation.participant.handle).toBe("amelia");
		expect(thread?.messages.at(-1)?.sender.handle).toBe("amelia");
	});

	it("returns unreplied mention filters correctly", () => {
		setupTempHome();

		const mentions = listTimelineItems({
			resource: "mentions",
			replyFilter: "unreplied",
		});

		expect(mentions).toHaveLength(1);
		expect(mentions[0]?.author.handle).toBe("amelia");
	});

	it("filters timeline items by account, search, and replied state", () => {
		setupTempHome();

		const items = listTimelineItems({
			resource: "home",
			account: "acct_studio",
			search: "Agents",
			replyFilter: "unreplied",
		});

		expect(items.map((item) => item.id)).toEqual(["tweet_006"]);
		expect(items[0]?.accountId).toBe("acct_studio");
		expect(items[0]?.searchSnippet).toContain("<mark>Agents</mark>");
	});

	it("keeps timeline membership account-scoped for the same canonical tweet", () => {
		setupTempHome();
		const db = getNativeDb();
		db.prepare(
			`
      insert into tweet_account_edges (
        account_id, tweet_id, kind, first_seen_at, last_seen_at, seen_count,
        source, raw_json, updated_at
      ) values (
        'acct_studio', 'tweet_001', 'home', '2026-03-08T12:00:00.000Z',
        '2026-03-08T12:00:00.000Z', 1, 'test', '{}',
        '2026-03-08T12:00:00.000Z'
      )
      `,
		).run();

		const allItems = listTimelineItems({
			resource: "home",
			since: "2000-01-01T00:00:00.000Z",
			limit: 20,
		});
		const sharedItems = allItems.filter((item) => item.id === "tweet_001");
		const studioItems = listTimelineItems({
			resource: "home",
			account: "acct_studio",
			since: "2000-01-01T00:00:00.000Z",
			limit: 20,
		});

		expect(sharedItems.map((item) => item.accountId).sort()).toEqual([
			"acct_primary",
			"acct_studio",
		]);
		expect(studioItems.find((item) => item.id === "tweet_001")).toMatchObject({
			accountId: "acct_studio",
			accountHandle: "@birdclaw_lab",
			bookmarked: false,
			liked: false,
		});
	});

	it("omits timeline search snippets when no query is provided", () => {
		setupTempHome();

		const items = listTimelineItems({ resource: "home", limit: 1 });

		expect(items[0]).not.toHaveProperty("searchSnippet");
	});

	it("falls back when recent non-timeline tweets fill the fast window", () => {
		setupTempHome();
		const db = getNativeDb();
		db.exec(`
      delete from tweet_account_edges;
      delete from tweet_collections;
      delete from tweets_fts;
      delete from tweets;
    `);
		const insertTweet = db.prepare(`
      insert into tweets (
        id, account_id, author_profile_id, kind, text, created_at,
        is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
        entities_json, media_json, quoted_tweet_id
      ) values (?, 'acct_primary', 'profile_me', ?, ?, ?, 0, null, 0, 0, 0, 0, '{}', '[]', null)
    `);
		const insertEdge = db.prepare(`
      insert into tweet_account_edges (
        account_id, tweet_id, kind, first_seen_at, last_seen_at, seen_count,
        source, raw_json, updated_at
      ) values ('acct_primary', ?, 'home', ?, ?, 1, 'test', '{}', ?)
    `);
		insertTweet.run(
			"tweet_old_home",
			"home",
			"old but valid home item",
			"2026-01-01T00:00:00.000Z",
		);
		insertEdge.run(
			"tweet_old_home",
			"2026-01-01T00:00:00.000Z",
			"2026-01-01T00:00:00.000Z",
			"2026-01-01T00:00:00.000Z",
		);
		db.transaction(() => {
			for (let index = 0; index < 5000; index += 1) {
				insertTweet.run(
					`tweet_new_like_${String(index)}`,
					"like",
					`newer non-timeline tweet ${String(index)}`,
					`2026-02-${String(Math.floor(index / 200) + 1).padStart(2, "0")}T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
				);
			}
		})();

		const items = listTimelineItems({ resource: "home", limit: 18 });

		expect(items.map((item) => item.id)).toEqual(["tweet_old_home"]);
	});

	it("filters timeline items by liked and bookmarked state across collections", () => {
		setupTempHome();
		const db = getNativeDb();
		db.prepare(
			`
      insert into tweets (
        id, account_id, author_profile_id, kind, text, created_at,
        is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
        entities_json, media_json, quoted_tweet_id
      ) values ('tweet_saved_live', 'acct_primary', 'profile_me', 'bookmark', 'saved live item', '2026-03-09T00:00:00.000Z', 0, null, 0, 0, 1, 0, '{}', '[]', null)
      `,
		).run();

		const liked = listTimelineItems({ resource: "home", likedOnly: true });
		const bookmarked = listTimelineItems({
			resource: "home",
			bookmarkedOnly: true,
		});

		expect(liked.every((item) => item.liked)).toBe(true);
		expect(bookmarked.map((item) => item.id)).toContain("tweet_saved_live");
		expect(bookmarked.every((item) => item.bookmarked)).toBe(true);
	});

	it("hides low-quality timeline noise for summary queries", () => {
		setupTempHome();
		const db = getNativeDb();
		const insertTweet = db.prepare(`
      insert into tweets (
        id, account_id, author_profile_id, kind, text, created_at,
        is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
        entities_json, media_json, quoted_tweet_id
      ) values (?, 'acct_primary', 'profile_me', 'home', ?, ?, 0, null, ?, ?, 0, 0, '{}', '[]', null)
    `);

		insertTweet.run(
			"tweet_low_reply",
			"@sam yes",
			"2026-03-08T13:00:00.000Z",
			0,
			0,
		);
		insertTweet.run(
			"tweet_low_link",
			"Wow https://t.co/noise",
			"2026-03-08T13:01:00.000Z",
			1,
			0,
		);
		insertTweet.run(
			"tweet_low_rt",
			"RT @someone: borrowed context",
			"2026-03-08T13:02:00.000Z",
			120,
			0,
		);
		insertTweet.run(
			"tweet_good_short",
			"OMG PC GUY",
			"2026-03-08T13:03:00.000Z",
			100,
			0,
		);
		insertTweet.run(
			"tweet_good_media",
			"https://t.co/screenshot",
			"2026-03-08T13:04:00.000Z",
			0,
			1,
		);

		const items = listTimelineItems({
			resource: "home",
			account: "acct_primary",
			since: "2026-03-08T13:00:00.000Z",
			until: "2026-03-08T14:00:00.000Z",
			includeReplies: false,
			qualityFilter: "summary",
			limit: 20,
		});

		expect(items.map((item) => item.id)).toEqual([
			"tweet_good_media",
			"tweet_good_short",
		]);

		const strictItems = listTimelineItems({
			resource: "home",
			account: "acct_primary",
			since: "2026-03-08T13:00:00.000Z",
			until: "2026-03-08T14:00:00.000Z",
			includeReplies: false,
			qualityFilter: "summary",
			lowQualityThreshold: 5,
			limit: 20,
		});
		const noLikeGateItems = listTimelineItems({
			resource: "home",
			account: "acct_primary",
			since: "2026-03-08T13:00:00.000Z",
			until: "2026-03-08T14:00:00.000Z",
			includeReplies: false,
			qualityFilter: "summary",
			lowQualityThreshold: 0,
			limit: 20,
		});

		expect(strictItems.map((item) => item.id)).toEqual([
			"tweet_good_media",
			"tweet_good_short",
		]);
		expect(noLikeGateItems.map((item) => item.id)).toEqual([
			"tweet_good_media",
			"tweet_good_short",
			"tweet_low_link",
		]);
	});

	it("includes quality reasons only when requested", () => {
		setupTempHome();
		const db = getNativeDb();
		const insertTweet = db.prepare(`
      insert into tweets (
        id, account_id, author_profile_id, kind, text, created_at,
        is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
        entities_json, media_json, quoted_tweet_id
      ) values (?, 'acct_primary', 'profile_me', 'home', ?, ?, 0, null, ?, ?, 0, 0, '{}', '[]', null)
    `);

		insertTweet.run(
			"tweet_reason_rt",
			"RT @someone: borrowed context",
			"2026-03-08T15:00:00.000Z",
			120,
			0,
		);
		insertTweet.run(
			"tweet_reason_media",
			"https://t.co/screenshot",
			"2026-03-08T15:01:00.000Z",
			0,
			1,
		);
		insertTweet.run(
			"tweet_reason_liked",
			"short but liked",
			"2026-03-08T15:02:00.000Z",
			100,
			0,
		);

		const plainItems = listTimelineItems({
			resource: "home",
			account: "acct_primary",
			since: "2026-03-08T15:00:00.000Z",
			until: "2026-03-08T16:00:00.000Z",
			qualityFilter: "all",
			limit: 20,
		});
		const items = listTimelineItems({
			resource: "home",
			account: "acct_primary",
			since: "2026-03-08T15:00:00.000Z",
			until: "2026-03-08T16:00:00.000Z",
			qualityFilter: "all",
			includeQualityReason: true,
			limit: 20,
		});

		expect(plainItems[0]).not.toHaveProperty("qualityReason");
		expect(items.map((item) => [item.id, item.qualityReason])).toEqual([
			["tweet_reason_liked", "keep:high-likes"],
			["tweet_reason_media", "keep:has-media"],
			["tweet_reason_rt", "drop:rt"],
		]);
	});

	it("hydrates rich tweet entities, media, reply context, and quote context", () => {
		setupTempHome();
		const db = getNativeDb();
		db.prepare(
			`
      insert into profiles (
        id, handle, display_name, bio, followers_count, avatar_hue, created_at
      ) values (
        'profile_dimillian', 'Dimillian', 'Dominik Hauser', 'Mac and iOS apps',
        42000, 210, '2026-03-01T00:00:00.000Z'
      )
      `,
		).run();
		db.prepare(
			`
      insert into tweet_collections (
        account_id, tweet_id, kind, collected_at, source, raw_json, updated_at
      ) values
        (
          'acct_primary', 'tweet_retweeted_original', 'likes',
          '2026-03-09T12:02:00.000Z', 'test', '{}', '2026-03-09T12:02:00.000Z'
        ),
        (
          'acct_primary', 'tweet_retweeted_original', 'bookmarks',
          '2026-03-09T12:02:00.000Z', 'test', '{}', '2026-03-09T12:02:00.000Z'
        )
      `,
		).run();
		db.prepare(
			`
      insert into tweets (
        id, account_id, author_profile_id, kind, text, created_at,
        is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
        entities_json, media_json, quoted_tweet_id
      ) values (
        'tweet_raw_url', 'acct_primary', 'profile_me', 'home',
        'Check it: https://t.co/peek', '2026-03-09T12:00:00.000Z',
        0, null, 0, 0, 0, 0, '{}', '[]', null
      )
      `,
		).run();
		db.prepare(
			`
      insert into tweets (
        id, account_id, author_profile_id, kind, text, created_at,
        is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
        entities_json, media_json, quoted_tweet_id
      ) values (
        'tweet_raw_mention', 'acct_primary', 'profile_me', 'home',
        '@Dimillian Any ideas for Mac apps?', '2026-03-09T12:01:00.000Z',
        0, null, 0, 0, 0, 0, '{}', '[]', null
      )
      `,
		).run();
		db.prepare(
			`
      insert into tweets (
        id, account_id, author_profile_id, kind, text, created_at,
        is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
        entities_json, media_json, quoted_tweet_id
      ) values (
        'tweet_retweeted_original', 'acct_primary', 'profile_dimillian', 'thread',
        'Actual original tweet content', '2026-03-09T11:59:00.000Z',
        0, null, 19, 0, 0, 0, '{}', '[]', null
      )
      `,
		).run();
		db.prepare(
			`
      insert into tweets (
        id, account_id, author_profile_id, kind, text, created_at,
        is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
        entities_json, media_json, quoted_tweet_id
      ) values (
        'tweet_retweet_ref', 'acct_primary', 'profile_me', 'home',
        'RT @Dimillian: Actual original tweet content', '2026-03-09T12:02:00.000Z',
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
        'acct_primary', 'tweet_retweet_ref', 'home', '2026-03-09T12:02:00.000Z',
        '2026-03-09T12:02:00.000Z', 1, 'test',
        '{"referenced_tweets":[{"type":"retweeted","id":"tweet_retweeted_original"}]}',
        '2026-03-09T12:02:00.000Z'
      )
      `,
		).run();
		db.prepare(
			`
      insert into tweets (
        id, account_id, author_profile_id, kind, text, created_at,
        is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
        entities_json, media_json, quoted_tweet_id
      ) values (
        'tweet_retweet_missing_ref', 'acct_primary', 'profile_me', 'home',
        'RT @Dimillian: Missing original tweet content', '2026-03-09T12:03:00.000Z',
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
        'acct_primary', 'tweet_retweet_missing_ref', 'home', '2026-03-09T12:03:00.000Z',
        '2026-03-09T12:03:00.000Z', 1, 'test',
        '{"referenced_tweets":[{"type":"retweeted","id":"tweet_missing_original"}]}',
        '2026-03-09T12:03:00.000Z'
      )
      `,
		).run();
		db.prepare(
			`
      insert into url_expansions (
        short_url, expanded_url, final_url, status, title, description, source, updated_at
      ) values (
        'https://t.co/peek', 'https://peekaboo.boo/?ref=x',
        'https://peekaboo.boo/', 'hit', 'Peekaboo', 'Mac automation',
        'test', '2026-03-09T12:00:00.000Z'
      )
      `,
		).run();

		const items = listTimelineItems({
			resource: "home",
			limit: 20,
		});
		const rawUrlItem = items.find((item) => item.id === "tweet_raw_url");
		const rawMentionItem = items.find(
			(item) => item.id === "tweet_raw_mention",
		);
		const retweetItem = items.find((item) => item.id === "tweet_retweet_ref");
		const missingRetweetItem = items.find(
			(item) => item.id === "tweet_retweet_missing_ref",
		);
		const replyItem = items.find((item) => item.id === "tweet_002");
		const mediaItem = items.find((item) => item.id === "tweet_003");
		const quotedItem = items.find((item) => item.id === "tweet_006");

		expect(rawUrlItem?.entities.urls?.[0]).toMatchObject({
			url: "https://t.co/peek",
			expandedUrl: "https://peekaboo.boo/",
			displayUrl: "peekaboo.boo",
			title: "Peekaboo",
			description: "Mac automation",
		});
		expect(rawMentionItem?.entities.mentions?.[0]).toMatchObject({
			username: "Dimillian",
			start: 0,
			end: 10,
			profile: {
				handle: "Dimillian",
				displayName: "Dominik Hauser",
			},
		});
		expect(retweetItem?.retweetedTweet).toMatchObject({
			id: "tweet_retweeted_original",
			text: "Actual original tweet content",
			likeCount: 19,
			mediaCount: 0,
			bookmarked: true,
			liked: true,
			author: {
				handle: "Dimillian",
			},
		});
		expect(missingRetweetItem?.retweetedTweet).toMatchObject({
			id: "tweet_retweet_missing_ref:retweeted",
			text: "Missing original tweet content",
			likeCount: 0,
			mediaCount: 0,
			bookmarked: false,
			liked: false,
			author: {
				handle: "Dimillian",
			},
		});
		expect(replyItem?.replyToTweet?.id).toBe("tweet_001");
		expect(mediaItem?.media[0]?.altText).toBe("Pricing survey chart");
		expect(mediaItem?.entities.urls?.[0]?.title).toBe(
			"Developer platform pricing survey",
		);
		expect(quotedItem?.quotedTweet?.id).toBe("tweet_001");
		expect(quotedItem?.quotedTweet?.text).toContain("local-first");
		expect(quotedItem?.author.avatarUrl).toMatch(/^data:image\/svg\+xml/);
	});

	it("returns an archived tweet conversation from the root", () => {
		setupTempHome();
		const db = getNativeDb();
		const insertTweet = db.prepare(`
      insert into tweets (
        id, account_id, author_profile_id, kind, text, created_at,
        is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
        entities_json, media_json, quoted_tweet_id
      ) values (?, 'acct_primary', 'profile_me', 'home', ?, ?, 0, ?, 0, 0, 0, 0, '{}', '[]', null)
    `);

		insertTweet.run(
			"conv_root",
			"Root of the conversation",
			"2026-03-10T10:00:00.000Z",
			null,
		);
		insertTweet.run(
			"conv_anchor",
			"Clicked middle tweet",
			"2026-03-10T10:01:00.000Z",
			"conv_root",
		);
		insertTweet.run(
			"conv_child",
			"Reply after the clicked tweet",
			"2026-03-10T10:02:00.000Z",
			"conv_anchor",
		);

		const conversation = getTweetConversation("conv_anchor");

		expect(conversation?.anchorId).toBe("conv_anchor");
		expect(conversation?.items.map((tweet) => tweet.id)).toEqual([
			"conv_root",
			"conv_anchor",
			"conv_child",
		]);
		expect(conversation?.items[1]?.replyToId).toBe("conv_root");
	});

	it("preserves the selected reply chain before broad thread context", () => {
		setupTempHome();
		const db = getNativeDb();
		const insertTweet = db.prepare(`
      insert into tweets (
        id, account_id, author_profile_id, kind, text, created_at,
        is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
        entities_json, media_json, quoted_tweet_id
      ) values (?, 'acct_primary', 'profile_me', 'home', ?, ?, 0, ?, 0, 0, 0, 0, '{}', '[]', null)
    `);

		insertTweet.run("deep_root", "Root", "2026-03-10T10:00:00.000Z", null);
		for (let index = 0; index < 20; index += 1) {
			insertTweet.run(
				`deep_sibling_${String(index).padStart(2, "0")}`,
				`Popular sibling ${String(index)}`,
				`2026-03-10T10:${String(index + 1).padStart(2, "0")}:00.000Z`,
				"deep_root",
			);
		}

		let parentId = "deep_root";
		for (let depth = 1; depth <= 10; depth += 1) {
			const tweetId = depth === 10 ? "deep_anchor" : `deep_parent_${depth}`;
			insertTweet.run(
				tweetId,
				`Deep branch ${String(depth)}`,
				`2026-03-10T11:${String(depth).padStart(2, "0")}:00.000Z`,
				parentId,
			);
			parentId = tweetId;
		}
		insertTweet.run(
			"deep_child",
			"Focused child",
			"2026-03-10T11:11:00.000Z",
			"deep_anchor",
		);

		const conversation = getTweetConversation("deep_anchor", 12);
		const ids = conversation?.items.map((tweet) => tweet.id) ?? [];

		expect(ids).toContain("deep_root");
		expect(ids).toContain("deep_parent_1");
		expect(ids).toContain("deep_parent_9");
		expect(ids).toContain("deep_anchor");
		expect(ids).toContain("deep_child");
		expect(ids.indexOf("deep_parent_9")).toBeLessThan(
			ids.indexOf("deep_anchor"),
		);
		expect(ids.at(-1)).toBe("deep_child");
	});

	it("builds a mixed inbox with ranked mentions and dms", () => {
		setupTempHome();

		const inbox = listInboxItems({
			kind: "mixed",
			hideLowSignal: true,
			minScore: 40,
		});

		expect(inbox.items[0]?.entityKind).toBe("dm");
		expect(inbox.items.some((item) => item.entityKind === "mention")).toBe(
			true,
		);
		expect(inbox.stats.total).toBeGreaterThan(0);
	});

	it("returns envelope stats, archives, accounts, and transport", async () => {
		setupTempHome();

		const envelope = await getQueryEnvelope();

		expect(envelope.stats).toEqual({
			home: 4,
			mentions: 2,
			dms: 4,
			needsReply: 2,
			inbox: 4,
		});
		expect(envelope.accounts.map((account) => account.id)).toEqual([
			"acct_primary",
			"acct_studio",
		]);
		expect(envelope.archives).toHaveLength(1);
		expect(envelope.transport.availableTransport).toBe("xurl");
	});

	it("exposes the status envelope as a lazy Effect program", async () => {
		setupTempHome();

		const effect = getQueryEnvelopeEffect();

		expect(mocks.findArchives).not.toHaveBeenCalled();
		expect(mocks.getTransportStatus).not.toHaveBeenCalled();
		await expect(Effect.runPromise(effect)).resolves.toMatchObject({
			stats: { home: 4, mentions: 2 },
			transport: { availableTransport: "xurl" },
		});
		expect(mocks.findArchives).toHaveBeenCalledTimes(1);
		expect(mocks.getTransportStatus).toHaveBeenCalledTimes(1);
	});

	it("counts envelope timeline stats from account edges", async () => {
		setupTempHome();
		const db = getNativeDb();
		db.prepare(
			`
      insert into tweet_account_edges (
        account_id, tweet_id, kind, first_seen_at, last_seen_at, seen_count,
        source, raw_json, updated_at
      ) values
        (
          'acct_studio', 'tweet_001', 'home', '2026-03-08T12:00:00.000Z',
          '2026-03-08T12:00:00.000Z', 1, 'test', '{}',
          '2026-03-08T12:00:00.000Z'
        ),
        (
          'acct_studio', 'tweet_001', 'mention', '2026-03-08T12:01:00.000Z',
          '2026-03-08T12:01:00.000Z', 1, 'test', '{}',
          '2026-03-08T12:01:00.000Z'
        )
      `,
		).run();

		const envelope = await getQueryEnvelope();

		expect(envelope.stats.home).toBe(
			listTimelineItems({ resource: "home", limit: 20 }).length,
		);
		expect(envelope.stats.mentions).toBe(
			listTimelineItems({ resource: "mentions", limit: 20 }).length,
		);
		expect(envelope.stats).toMatchObject({
			home: 5,
			mentions: 3,
			inbox: 5,
		});
	});

	it("ignores stale timeline edges when counting envelope stats", async () => {
		setupTempHome();
		const db = getNativeDb();
		db.prepare(
			`
      insert into tweet_account_edges (
        account_id, tweet_id, kind, first_seen_at, last_seen_at, seen_count,
        source, raw_json, updated_at
      ) values (
        'acct_primary', 'tweet_missing', 'home', '2026-03-08T12:00:00.000Z',
        '2026-03-08T12:00:00.000Z', 1, 'test', '{}',
        '2026-03-08T12:00:00.000Z'
      )
      `,
		).run();

		const envelope = await getQueryEnvelope();

		expect(envelope.stats.home).toBe(
			listTimelineItems({ resource: "home", limit: 20 }).length,
		);
	});

	it("hydrates selected dms inside queryResource", () => {
		setupTempHome();

		const result = queryResource("dms", {
			replyFilter: "unreplied",
			conversationId: "dm_003",
			search: "context rail",
		});

		expect(result.resource).toBe("dms");
		expect(result.selectedConversation?.conversation.id).toBe("dm_003");
		expect(result.selectedConversation?.messages).toHaveLength(2);
	});

	it("hydrates selected dms with the active account filter", () => {
		setupTempHome();
		const db = getNativeDb();
		const insertConversation = db.prepare(`
      insert into dm_conversations (
        id, account_id, participant_profile_id, title, last_message_at, unread_count, needs_reply
      ) values (?, 'acct_primary', 'profile_sam', ?, ?, 0, 0)
    `);
		const insertMessage = db.prepare(`
      insert into dm_messages (
        id, conversation_id, sender_profile_id, text, created_at, direction, is_replied, media_count
      ) values (?, ?, 'profile_sam', ?, ?, 'inbound', 1, 0)
    `);

		for (let index = 0; index < 120; index += 1) {
			const id = `dm_bulk_${String(index).padStart(3, "0")}`;
			const createdAt = `2026-05-16T12:${String(index % 60).padStart(2, "0")}:00.000Z`;
			insertConversation.run(id, `Bulk ${String(index)}`, createdAt);
			insertMessage.run(
				`msg_${id}`,
				id,
				`Bulk conversation ${String(index)}`,
				createdAt,
			);
		}

		const result = queryResource("dms", {
			account: "acct_studio",
			conversationId: "dm_004",
		});

		expect(result.items.map((item) => item.id)).toEqual(["dm_004"]);
		expect(result.selectedConversation?.conversation.id).toBe("dm_004");
		expect(result.selectedConversation?.messages).toHaveLength(2);
	});

	it("returns a null selected conversation when dm filters empty the result set", () => {
		setupTempHome();

		const result = queryResource("dms", {
			participant: "nobody",
		});

		expect(result.items).toEqual([]);
		expect(result.selectedConversation).toBeNull();
		expect(getConversationThread("missing")).toBeNull();
	});

	it("creates posts locally and records outbound actions", async () => {
		setupTempHome();

		const result = await createPost("acct_primary", "Fresh local-first post");
		const db = getNativeDb();
		const action = db
			.prepare("select kind, body from tweet_actions where tweet_id = ?")
			.get(result.tweetId) as { kind: string; body: string } | undefined;
		const post = db
			.prepare("select text, kind from tweets where id = ?")
			.get(result.tweetId) as { text: string; kind: string } | undefined;

		expect(result.ok).toBe(true);
		expect(result.transport).toEqual({ ok: true, output: "posted" });
		expect(post).toEqual({
			text: "Fresh local-first post",
			kind: "home",
		});
		expect(action).toEqual({
			kind: "post",
			body: "Fresh local-first post",
		});
		expect(mocks.postViaXurl).toHaveBeenCalledWith("Fresh local-first post");
	});

	it("exposes local compose writes as lazy Effect programs", async () => {
		setupTempHome();
		const db = getNativeDb();

		const postEffect = createPostEffect("acct_primary", "Effect post");
		const replyEffect = createTweetReplyEffect(
			"acct_primary",
			"tweet_004",
			"Effect reply",
		);
		const dmEffect = createDmReplyEffect("dm_003", "Effect DM");

		expect(mocks.postViaXurl).not.toHaveBeenCalled();
		expect(mocks.replyViaXurl).not.toHaveBeenCalled();
		expect(mocks.dmViaXurl).not.toHaveBeenCalled();
		expect(
			db
				.prepare(
					"select count(*) as count from tweet_actions where body like ?",
				)
				.get("Effect%") as { count: number },
		).toEqual({ count: 0 });

		await expect(Effect.runPromise(postEffect)).resolves.toMatchObject({
			ok: true,
		});
		await expect(Effect.runPromise(replyEffect)).resolves.toMatchObject({
			ok: true,
		});
		await expect(Effect.runPromise(dmEffect)).resolves.toMatchObject({
			ok: true,
		});
		expect(mocks.postViaXurl).toHaveBeenCalledWith("Effect post");
		expect(mocks.replyViaXurl).toHaveBeenCalledWith(
			"tweet_004",
			"Effect reply",
		);
		expect(mocks.dmViaXurl).toHaveBeenCalledWith("amelia", "Effect DM");
	});

	it("rejects tweet writes when the local author profile is unavailable", async () => {
		setupTempHome();
		const db = getNativeDb();
		db.prepare("delete from profiles where id = ?").run("profile_me");

		await expect(createPost("acct_primary", "hello")).rejects.toThrow(
			"No local author profile for account",
		);
		await expect(
			createTweetReply("acct_primary", "tweet_004", "hello"),
		).rejects.toThrow("No local author profile for account");
	});

	it("does not persist tweet writes when transport fails", async () => {
		setupTempHome();
		const db = getNativeDb();
		mocks.postViaXurl.mockRejectedValueOnce(new Error("post failed"));
		mocks.replyViaXurl.mockRejectedValueOnce(new Error("reply failed"));

		await expect(createPost("acct_primary", "do not keep")).rejects.toThrow(
			"post failed",
		);
		await expect(
			createTweetReply("acct_primary", "tweet_004", "do not reply"),
		).rejects.toThrow("reply failed");
		mocks.postViaXurl.mockResolvedValueOnce({
			ok: false,
			output: "post denied",
		});
		mocks.replyViaXurl.mockResolvedValueOnce({
			ok: false,
			output: "reply denied",
		});

		await expect(
			createPost("acct_primary", "do not keep false"),
		).rejects.toThrow("post denied");
		await expect(
			createTweetReply("acct_primary", "tweet_004", "do not reply false"),
		).rejects.toThrow("reply denied");

		expect(
			db
				.prepare("select count(*) as count from tweets where text like ?")
				.get("do not%") as { count: number },
		).toEqual({ count: 0 });
		expect(
			db
				.prepare(
					"select count(*) as count from tweet_actions where body like ?",
				)
				.get("do not%") as { count: number },
		).toEqual({ count: 0 });
		expect(
			db.prepare("select is_replied from tweets where id = ?").get("tweet_004"),
		).toEqual({ is_replied: 0 });
	});

	it("does not call xurl whoami when live writes are disabled", async () => {
		setupTempHome();
		process.env.BIRDCLAW_DISABLE_LIVE_WRITES = "1";
		mocks.postViaXurl.mockResolvedValueOnce({
			ok: false,
			output: "live writes disabled",
		});

		await expect(createPost("acct_primary", "do not verify")).rejects.toThrow(
			"live writes disabled",
		);

		expect(mocks.lookupAuthenticatedUser).not.toHaveBeenCalled();
		expect(
			getNativeDb()
				.prepare("select count(*) as count from tweets where text = ?")
				.get("do not verify"),
		).toEqual({ count: 0 });
	});

	it("does not publish tweet writes when local persistence cannot be staged", async () => {
		setupTempHome();
		const db = getNativeDb();
		db.exec("drop table tweet_actions");

		await expect(
			createPost("acct_primary", "do not publish post"),
		).rejects.toThrow("tweet_actions");
		await expect(
			createTweetReply("acct_primary", "tweet_004", "do not publish reply"),
		).rejects.toThrow("tweet_actions");

		expect(mocks.postViaXurl).not.toHaveBeenCalled();
		expect(mocks.replyViaXurl).not.toHaveBeenCalled();
		expect(
			db
				.prepare("select count(*) as count from tweets where text like ?")
				.get("do not publish%") as { count: number },
		).toEqual({ count: 0 });
		expect(
			db.prepare("select is_replied from tweets where id = ?").get("tweet_004"),
		).toEqual({ is_replied: 0 });
	});

	it("creates tweet replies and flips the original item to replied", async () => {
		setupTempHome();

		const result = await createTweetReply(
			"acct_primary",
			"tweet_004",
			"Sync deserves an engine when replay matters.",
		);
		const db = getNativeDb();
		const original = db
			.prepare("select is_replied from tweets where id = ?")
			.get("tweet_004") as { is_replied: number } | undefined;
		const reply = db
			.prepare("select reply_to_id, is_replied from tweets where id = ?")
			.get(result.replyId) as
			| { reply_to_id: string; is_replied: number }
			| undefined;

		expect(original?.is_replied).toBe(1);
		expect(reply).toEqual({
			reply_to_id: "tweet_004",
			is_replied: 1,
		});
		expect(mocks.replyViaXurl).toHaveBeenCalledWith(
			"tweet_004",
			"Sync deserves an engine when replay matters.",
		);
	});

	it("creates dm replies and clears reply pressure on the thread", async () => {
		setupTempHome();

		const result = await createDmReply("dm_003", "Send it over.");
		const db = getNativeDb();
		const conversation = db
			.prepare(
				"select needs_reply, unread_count from dm_conversations where id = ?",
			)
			.get("dm_003") as
			| { needs_reply: number; unread_count: number }
			| undefined;
		const message = db
			.prepare(
				"select direction, sender_profile_id, text from dm_messages where id = ?",
			)
			.get(result.messageId) as
			| { direction: string; sender_profile_id: string; text: string }
			| undefined;

		expect(message).toEqual({
			direction: "outbound",
			sender_profile_id: "profile_me",
			text: "Send it over.",
		});
		expect(conversation).toEqual({
			needs_reply: 0,
			unread_count: 0,
		});
		expect(mocks.dmViaXurl).toHaveBeenCalledWith("amelia", "Send it over.");
	});

	it("clears dm reply pressure when the existing timestamp is future-dated", async () => {
		setupTempHome();
		const db = getNativeDb();
		const futureAt = "2099-01-01T00:00:00.000Z";
		db.prepare(
			"update dm_conversations set last_message_at = ?, unread_count = 2, needs_reply = 1 where id = 'dm_003'",
		).run(futureAt);

		await createDmReply("dm_003", "Reply to future state.");

		expect(
			db
				.prepare(
					"select last_message_at, needs_reply, unread_count from dm_conversations where id = ?",
				)
				.get("dm_003"),
		).toEqual({
			last_message_at: futureAt,
			needs_reply: 0,
			unread_count: 0,
		});
	});

	it("preserves newer dm sync state when it lands during live send", async () => {
		setupTempHome();
		const db = getNativeDb();
		const newerInboundAt = "2099-01-01T00:00:00.000Z";
		mocks.dmViaXurl.mockImplementationOnce(async () => {
			db.prepare(
				`
        insert into dm_messages (
          id, conversation_id, sender_profile_id, text, created_at, direction, is_replied, media_count
        ) values ('msg_newer_sync', 'dm_003', 'profile_amelia', 'newer inbound', ?, 'inbound', 0, 0)
        `,
			).run(newerInboundAt);
			db.prepare("insert into dm_fts (message_id, text) values (?, ?)").run(
				"msg_newer_sync",
				"newer inbound",
			);
			db.prepare(
				"update dm_conversations set last_message_at = ?, unread_count = 1, needs_reply = 1 where id = 'dm_003'",
			).run(newerInboundAt);
			return { ok: true, output: "sent" };
		});

		const result = await createDmReply("dm_003", "Reply after sync.");
		const conversation = db
			.prepare(
				"select last_message_at, needs_reply, unread_count from dm_conversations where id = ?",
			)
			.get("dm_003");
		const outbound = db
			.prepare("select direction, text from dm_messages where id = ?")
			.get(result.messageId);

		expect(outbound).toEqual({
			direction: "outbound",
			text: "Reply after sync.",
		});
		expect(conversation).toEqual({
			last_message_at: newerInboundAt,
			needs_reply: 1,
			unread_count: 1,
		});
	});

	it("does not persist dm replies when transport fails", async () => {
		setupTempHome();
		const db = getNativeDb();
		mocks.dmViaXurl.mockRejectedValueOnce(new Error("dm failed"));

		await expect(createDmReply("dm_003", "do not dm")).rejects.toThrow(
			"dm failed",
		);
		mocks.dmViaXurl.mockResolvedValueOnce({
			ok: false,
			output: "dm denied",
		});

		await expect(createDmReply("dm_003", "do not dm false")).rejects.toThrow(
			"dm denied",
		);

		expect(
			db
				.prepare(
					"select count(*) as count from dm_messages where text like ? and direction = 'outbound'",
				)
				.get("do not dm%") as { count: number },
		).toEqual({ count: 0 });
		expect(
			db
				.prepare(
					"select needs_reply, unread_count from dm_conversations where id = ?",
				)
				.get("dm_003"),
		).toEqual({ needs_reply: 1, unread_count: 2 });
	});

	it("does not publish dm replies when local persistence cannot be staged", async () => {
		setupTempHome();
		const db = getNativeDb();
		db.exec("drop table dm_fts");

		await expect(createDmReply("dm_003", "do not publish dm")).rejects.toThrow(
			"dm_fts",
		);

		expect(mocks.dmViaXurl).not.toHaveBeenCalled();
		expect(
			db
				.prepare(
					"select count(*) as count from dm_messages where text = ? and direction = 'outbound'",
				)
				.get("do not publish dm") as { count: number },
		).toEqual({ count: 0 });
		expect(
			db
				.prepare(
					"select needs_reply, unread_count from dm_conversations where id = ?",
				)
				.get("dm_003"),
		).toEqual({ needs_reply: 1, unread_count: 2 });
	});

	it("rejects dm replies for missing conversations", async () => {
		setupTempHome();

		await expect(createDmReply("missing", "hello")).rejects.toThrow(
			"Conversation not found",
		);
	});
});
