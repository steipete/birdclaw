// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { listInboxItems } from "./inbox";
import {
	createDmReply,
	createPost,
	createTweetReply,
	getConversationThread,
	getQueryEnvelope,
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
}));

vi.mock("./archive-finder", () => ({
	findArchives: mocks.findArchives,
}));

vi.mock("./xurl", () => ({
	getTransportStatus: mocks.getTransportStatus,
	postViaXurl: mocks.postViaXurl,
	replyViaXurl: mocks.replyViaXurl,
	dmViaXurl: mocks.dmViaXurl,
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
	mocks.findArchives.mockReset();
	mocks.getTransportStatus.mockReset();
	mocks.postViaXurl.mockReset();
	mocks.replyViaXurl.mockReset();
	mocks.dmViaXurl.mockReset();

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
			sort: "influence",
		});

		expect(highSignal.map((item) => item.id)).toEqual([
			"dm_001",
			"dm_004",
			"dm_002",
		]);
		expect(highSignal[0]?.influenceLabel).toBe("very high");
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

	it("omits timeline search snippets when no query is provided", () => {
		setupTempHome();

		const items = listTimelineItems({ resource: "home", limit: 1 });

		expect(items[0]).not.toHaveProperty("searchSnippet");
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

		const items = listTimelineItems({
			resource: "home",
			limit: 10,
		});
		const replyItem = items.find((item) => item.id === "tweet_002");
		const mediaItem = items.find((item) => item.id === "tweet_003");
		const quotedItem = items.find((item) => item.id === "tweet_006");

		expect(replyItem?.replyToTweet?.id).toBe("tweet_001");
		expect(mediaItem?.media[0]?.altText).toBe("Pricing survey chart");
		expect(mediaItem?.entities.urls?.[0]?.title).toBe(
			"Developer platform pricing survey",
		);
		expect(quotedItem?.quotedTweet?.id).toBe("tweet_001");
		expect(quotedItem?.quotedTweet?.text).toContain("local-first");
		expect(quotedItem?.author.avatarUrl).toMatch(/^data:image\/svg\+xml/);
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

	it("rejects dm replies for missing conversations", async () => {
		setupTempHome();

		await expect(createDmReply("missing", "hello")).rejects.toThrow(
			"Conversation not found",
		);
	});
});
