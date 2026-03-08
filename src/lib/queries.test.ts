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
});
