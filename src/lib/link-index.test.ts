// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";

let homeDir = "";
type TestDb = ReturnType<typeof getNativeDb>;

function insertAccountFixture() {
	const db = getNativeDb({ seedDemoData: false });
	db.prepare(`
    insert into accounts (
      id, name, handle, external_user_id, transport, is_default, created_at
    ) values (?, ?, ?, ?, ?, ?, ?)
  `).run(
		"acct_primary",
		"Peter",
		"steipete",
		"25401953",
		"bird",
		1,
		"2026-04-01T00:00:00.000Z",
	);
	db.prepare(`
    insert into profiles (
      id, handle, display_name, bio, followers_count, following_count,
      avatar_hue, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
		"profile_me",
		"steipete",
		"Peter Steinberger",
		"",
		1,
		0,
		1,
		"2026-04-01T00:00:00.000Z",
	);
	db.prepare(`
    insert into profiles (
      id, handle, display_name, bio, followers_count, following_count,
      avatar_hue, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
		"profile_fernando",
		"fernandorojo",
		"Fernando Rojo",
		"",
		1,
		0,
		2,
		"2026-04-01T00:00:00.000Z",
	);
	db.prepare(`
    insert into profiles (
      id, handle, display_name, bio, followers_count, following_count,
      avatar_hue, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
		"profile_codetaur",
		"codetaur",
		"Codetard",
		"",
		1,
		0,
		3,
		"2026-04-01T00:00:00.000Z",
	);
	return db;
}

function insertDmConversation(db: TestDb, id = "dm_fernando") {
	db.prepare(`
      insert into dm_conversations (
        id, account_id, participant_profile_id, title, last_message_at,
        unread_count, needs_reply
      ) values (?, ?, ?, ?, ?, ?, ?)
    `).run(
		id,
		"acct_primary",
		"profile_fernando",
		"Fernando Rojo",
		"2026-04-02T02:52:36.464Z",
		0,
		0,
	);
}

function insertDmMessage(
	db: TestDb,
	options: {
		id: string;
		text: string;
		direction?: "inbound" | "outbound";
		createdAt?: string;
		conversationId?: string;
	},
) {
	db.prepare(`
      insert into dm_messages (
        id, conversation_id, sender_profile_id, text, created_at, direction,
        is_replied, media_count
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
		options.id,
		options.conversationId ?? "dm_fernando",
		"profile_me",
		options.text,
		options.createdAt ?? "2026-04-02T02:52:36.464Z",
		options.direction ?? "outbound",
		0,
		0,
	);
}

function insertTweet(
	db: TestDb,
	options: {
		id: string;
		text: string;
		authorProfileId?: string;
		kind?: string;
		createdAt?: string;
		likeCount?: number;
		mediaCount?: number;
		bookmarked?: number;
		liked?: number;
		entitiesJson?: string;
		mediaJson?: string;
	},
) {
	db.prepare(`
      insert into tweets (
        id, account_id, author_profile_id, kind, text, created_at, is_replied,
        reply_to_id, like_count, media_count, bookmarked, liked,
        entities_json, media_json, quoted_tweet_id
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
		options.id,
		"acct_primary",
		options.authorProfileId ?? "profile_me",
		options.kind ?? "home",
		options.text,
		options.createdAt ?? "2026-04-01T12:00:00.000Z",
		0,
		null,
		options.likeCount ?? 1,
		options.mediaCount ?? 0,
		options.bookmarked ?? 0,
		options.liked ?? 0,
		options.entitiesJson ?? "{}",
		options.mediaJson ?? "[]",
		null,
	);
}

describe("link index", () => {
	beforeEach(() => {
		homeDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-link-index-"));
		process.env.BIRDCLAW_HOME = homeDir;
		resetBirdclawPathsForTests();
		resetDatabaseForTests();
	});

	afterEach(() => {
		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		delete process.env.BIRDCLAW_HOME;
		rmSync(homeDir, { recursive: true, force: true });
	});

	it("keeps fresh demo link insights after rebuilding occurrences", async () => {
		getNativeDb();
		const { getLinkInsights } = await import("./link-insights");
		const { backfillLinkIndex } = await import("./link-index");
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: false,
			status: 404,
			url: "https://t.co/miss",
		} as Response);

		expect(getLinkInsights({ kind: "links" }).items).toHaveLength(2);
		expect(getLinkInsights({ kind: "videos" }).items).toHaveLength(1);
		expect(
			getLinkInsights({ kind: "videos" }).items[0]?.mentions[0]?.commentText,
		).not.toContain("https://t.co/");

		await backfillLinkIndex({ fetchImpl });

		expect(getLinkInsights({ kind: "links" }).items).toHaveLength(2);
		expect(getLinkInsights({ kind: "videos" }).items).toHaveLength(1);
		expect(
			getLinkInsights({ kind: "videos" }).items[0]?.mentions[0]?.commentText,
		).not.toContain("https://t.co/");
	});

	it("finds a DM t.co share through the expanded linked tweet", async () => {
		const db = insertAccountFixture();
		db.prepare(`
      insert into tweets (
        id, account_id, author_profile_id, kind, text, created_at, is_replied,
        reply_to_id, like_count, media_count, bookmarked, liked,
        entities_json, media_json, quoted_tweet_id
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
			"2039395915421942108",
			"acct_primary",
			"profile_codetaur",
			"bookmark",
			"asking a vibecoder in the throes of AI psychosis what their 100k lines of code do https://t.co/veTztOtK8Q",
			"2026-04-01T17:34:11.000Z",
			0,
			null,
			4478,
			1,
			1,
			1,
			"{}",
			JSON.stringify([
				{ type: "video", url: "https://pbs.twimg.com/video.jpg" },
			]),
			null,
		);
		db.prepare(`
      insert into dm_conversations (
        id, account_id, participant_profile_id, title, last_message_at,
        unread_count, needs_reply
      ) values (?, ?, ?, ?, ?, ?, ?)
    `).run(
			"dm_fernando",
			"acct_primary",
			"profile_fernando",
			"Fernando Rojo",
			"2026-04-02T02:52:36.464Z",
			0,
			0,
		);
		db.prepare(`
      insert into dm_messages (
        id, conversation_id, sender_profile_id, text, created_at, direction,
        is_replied, media_count
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
			"dm_msg_1",
			"dm_fernando",
			"profile_me",
			"https://t.co/WuQhCIi5r3",
			"2026-04-02T02:52:36.464Z",
			"outbound",
			0,
			0,
		);

		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			url: "https://x.com/codetaur/status/2039395915421942108",
		} as Response);
		const { backfillLinkIndex, searchLinks } = await import("./link-index");

		await expect(backfillLinkIndex({ fetchImpl })).resolves.toMatchObject({
			occurrences: 2,
			uniqueUrls: 2,
			networkExpansions: 2,
			remainingUnexpanded: 0,
		});
		expect(
			searchLinks("vibecoder", {
				direction: "outbound",
				mediaType: "video",
				since: "2026-04-01",
				until: "2026-04-03",
			}),
		).toEqual([
			expect.objectContaining({
				occurrence: expect.objectContaining({
					sourceKind: "dm",
					shortUrl: "https://t.co/WuQhCIi5r3",
				}),
				participant: expect.objectContaining({ handle: "fernandorojo" }),
				linkedTweet: expect.objectContaining({
					id: "2039395915421942108",
					text: expect.stringContaining("vibecoder"),
				}),
			}),
		]);
	});

	it("seeds tweet entity expansions without a network call", async () => {
		const db = insertAccountFixture();
		db.prepare(`
      insert into tweets (
        id, account_id, author_profile_id, kind, text, created_at, is_replied,
        reply_to_id, like_count, media_count, bookmarked, liked,
        entities_json, media_json, quoted_tweet_id
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
			"tweet_1",
			"acct_primary",
			"profile_me",
			"home",
			"read https://t.co/entity",
			"2026-04-01T12:00:00.000Z",
			0,
			null,
			1,
			0,
			0,
			0,
			JSON.stringify({
				urls: [
					{
						url: "https://t.co/entity",
						expandedUrl: "https://example.com/vibecoder-note",
						displayUrl: "example.com/vibecoder-note",
					},
				],
			}),
			"[]",
			null,
		);
		const fetchImpl = vi.fn();
		const { backfillLinkIndex, searchLinks } = await import("./link-index");

		await expect(backfillLinkIndex({ fetchImpl })).resolves.toMatchObject({
			occurrences: 1,
			uniqueUrls: 1,
			entityExpansions: 1,
			networkExpansions: 0,
		});
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(searchLinks("vibecoder")).toHaveLength(1);
	});

	it("keeps backfill effects lazy until run", async () => {
		const db = insertAccountFixture();
		insertDmConversation(db);
		insertDmMessage(db, { id: "dm_msg_1", text: "https://t.co/lazy" });
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			url: "https://x.com/codetaur/status/777",
		} as Response);
		const { backfillLinkIndexEffect } = await import("./link-index");

		const effect = backfillLinkIndexEffect({ fetchImpl, source: "dm" });

		expect(fetchImpl).not.toHaveBeenCalled();
		expect(
			db.prepare("select count(*) as count from link_occurrences").get(),
		).toEqual({ count: 0 });

		await expect(Effect.runPromise(effect)).resolves.toMatchObject({
			occurrences: 1,
			networkExpansions: 1,
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("retries failed expansion rows on normal backfills", async () => {
		const db = insertAccountFixture();
		insertDmConversation(db);
		insertDmMessage(db, { id: "dm_msg_1", text: "https://t.co/retry" });
		db.prepare(`
      insert into url_expansions (
        short_url, expanded_url, final_url, status, expanded_tweet_id,
        expanded_handle, title, description, error, source, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
			"https://t.co/retry",
			"https://t.co/retry",
			"https://t.co/retry",
			"error",
			null,
			null,
			null,
			null,
			"network timeout",
			"network",
			"2026-04-02T02:52:36.464Z",
		);
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			url: "https://x.com/codetaur/status/2039395915421942108",
		} as Response);
		const { backfillLinkIndex } = await import("./link-index");

		await expect(
			backfillLinkIndex({ fetchImpl, source: "dm" }),
		).resolves.toMatchObject({
			networkExpansions: 1,
			remainingUnexpanded: 0,
		});
		expect(
			db
				.prepare(
					"select status, expanded_tweet_id from url_expansions where short_url = ?",
				)
				.get("https://t.co/retry"),
		).toEqual({
			status: "hit",
			expanded_tweet_id: "2039395915421942108",
		});
	});

	it("indexes non-t.co links only when requested", async () => {
		const db = insertAccountFixture();
		insertDmConversation(db);
		insertDmMessage(db, {
			id: "dm_msg_1",
			text: "notes https://example.com/vibecoder and https://t.co/short",
		});
		const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			return {
				ok: true,
				status: 200,
				url:
					url === "https://t.co/short"
						? "https://x.com/codetaur/status/12345"
						: "https://example.com/vibecoder",
			} as Response;
		});
		const { backfillLinkIndex, searchLinks } = await import("./link-index");

		await expect(backfillLinkIndex({ fetchImpl })).resolves.toMatchObject({
			occurrences: 1,
			uniqueUrls: 1,
			networkExpansions: 1,
		});
		expect(searchLinks("example")).toHaveLength(1);

		await expect(
			backfillLinkIndex({ fetchImpl, includeAllUrls: true, refresh: true }),
		).resolves.toMatchObject({
			occurrences: 2,
			uniqueUrls: 2,
			networkExpansions: 2,
		});
		expect(
			searchLinks("example", { participant: "Fernando", limit: 1 }),
		).toHaveLength(1);
	});

	it("records Twitter URL target variants and unresolved misses", async () => {
		const db = insertAccountFixture();
		insertTweet(db, {
			id: "tweet_source",
			text: "links https://t.co/twitter https://t.co/mobile https://t.co/noid https://t.co/invalid https://t.co/offsite https://t.co/bad",
			entitiesJson: JSON.stringify({
				urls: [
					{ url: "https://t.co/twitter" },
					{
						url: "https://t.co/mobile",
						expanded_url: "https://mobile.twitter.com/i/status/67890",
						title: "mobile status",
						description: 123,
					},
					{ url: "https://example.com/skip-entity" },
					{ url: "not-a-url" },
					{ expandedUrl: "https://example.com/missing-url" },
				],
			}),
		});
		const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			const responseByUrl: Record<string, Partial<Response>> = {
				"https://t.co/twitter": {
					ok: true,
					status: 200,
					url: "https://twitter.com/codetaur/statuses/12345",
				},
				"https://t.co/noid": {
					ok: true,
					status: 200,
					url: "https://x.com/codetaur/status/",
				},
				"https://t.co/invalid": {
					ok: true,
					status: 200,
					url: "not a url",
				},
				"https://t.co/offsite": {
					ok: true,
					status: 200,
					url: "https://example.com/no-status",
				},
				"https://t.co/bad": {
					ok: false,
					status: 404,
					url: "https://t.co/bad",
				},
			};
			return responseByUrl[url] as Response;
		});
		const { backfillLinkIndex, searchLinks } = await import("./link-index");

		await expect(
			backfillLinkIndex({ fetchImpl, source: "tweet", concurrency: 100 }),
		).resolves.toMatchObject({
			occurrences: 6,
			uniqueUrls: 6,
			entityExpansions: 1,
			networkExpansions: 5,
			misses: 1,
			remainingUnexpanded: 1,
		});
		expect(
			db
				.prepare(
					"select short_url, status, expanded_tweet_id, expanded_handle from url_expansions order by short_url",
				)
				.all(),
		).toEqual([
			{
				short_url: "https://t.co/bad",
				status: "miss",
				expanded_tweet_id: null,
				expanded_handle: null,
			},
			{
				short_url: "https://t.co/invalid",
				status: "hit",
				expanded_tweet_id: null,
				expanded_handle: null,
			},
			{
				short_url: "https://t.co/mobile",
				status: "hit",
				expanded_tweet_id: "67890",
				expanded_handle: null,
			},
			{
				short_url: "https://t.co/noid",
				status: "hit",
				expanded_tweet_id: null,
				expanded_handle: null,
			},
			{
				short_url: "https://t.co/offsite",
				status: "hit",
				expanded_tweet_id: null,
				expanded_handle: null,
			},
			{
				short_url: "https://t.co/twitter",
				status: "hit",
				expanded_tweet_id: "12345",
				expanded_handle: "codetaur",
			},
		]);
		expect(
			searchLinks("", { account: "@steipete", source: "tweet", limit: 0 }),
		).toContainEqual(
			expect.objectContaining({
				sourceText: expect.stringContaining("https://t.co/bad"),
				sourceAuthor: expect.objectContaining({ handle: "steipete" }),
				linkedTweet: null,
			}),
		);
	});

	it("counts network errors and keeps them retryable", async () => {
		const db = insertAccountFixture();
		insertDmConversation(db);
		insertDmMessage(db, {
			id: "dm_msg_1",
			text: "broken https://t.co/error",
			direction: "inbound",
		});
		const fetchImpl = vi.fn(async () => {
			throw new Error("socket hang up");
		});
		const { backfillLinkIndex, searchLinks } = await import("./link-index");

		await expect(
			backfillLinkIndex({ fetchImpl, source: "dm", concurrency: 0 }),
		).resolves.toMatchObject({
			networkExpansions: 1,
			errors: 1,
			remainingUnexpanded: 1,
		});
		expect(searchLinks("broken", { direction: "inbound" })).toEqual([
			expect.objectContaining({
				expansion: expect.objectContaining({
					status: "error",
					error: "socket hang up",
				}),
			}),
		]);
	});

	it("uses cached expansions when the persistent index row is missing", async () => {
		const db = insertAccountFixture();
		insertDmConversation(db);
		insertDmMessage(db, { id: "dm_msg_1", text: "cached https://t.co/cache" });
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			url: "https://x.com/codetaur/status/777",
		} as Response);
		const { backfillLinkIndex, searchLinks } = await import("./link-index");

		await expect(
			backfillLinkIndex({ fetchImpl, source: "dm", limit: 1 }),
		).resolves.toMatchObject({
			networkExpansions: 1,
			cacheExpansions: 0,
		});
		db.prepare("delete from url_expansions where short_url = ?").run(
			"https://t.co/cache",
		);

		await expect(
			backfillLinkIndex({ fetchImpl, source: "dm" }),
		).resolves.toMatchObject({
			networkExpansions: 0,
			cacheExpansions: 1,
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(searchLinks("777")).toHaveLength(1);
	});

	it("returns sparse indexed rows without source or account joins", async () => {
		const db = insertAccountFixture();
		db.prepare("update profiles set entities_json = ? where id = ?").run(
			"",
			"profile_me",
		);
		insertTweet(db, {
			id: "777",
			text: "linked fallback",
			authorProfileId: "profile_me",
			entitiesJson: "{bad",
			mediaJson: "",
		});
		db.prepare("update tweets set account_id = ? where id = ?").run(
			"missing_account",
			"777",
		);
		db.prepare(`
      insert into url_expansions (
        short_url, expanded_url, final_url, status, expanded_tweet_id,
        expanded_handle, title, description, error, source, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
			"https://t.co/manual",
			"https://x.com/steipete/status/777",
			"https://x.com/steipete/status/777",
			"hit",
			"777",
			"steipete",
			null,
			null,
			null,
			"manual",
			"2026-04-02T02:52:36.464Z",
		);
		db.prepare(`
      insert into link_occurrences (
        source_kind, source_id, source_position, short_url, account_id,
        conversation_id, direction, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
			"tweet",
			"missing_source",
			0,
			"https://t.co/manual",
			null,
			null,
			null,
			"2026-04-03T00:00:00.000Z",
		);
		const { searchLinks } = await import("./link-index");

		expect(searchLinks("")).toEqual([
			expect.objectContaining({
				sourceText: "",
				occurrence: expect.objectContaining({
					accountId: null,
					shortUrl: "https://t.co/manual",
				}),
				linkedTweet: expect.objectContaining({
					accountHandle: "",
					entities: {},
					media: [],
				}),
			}),
		]);
	});
});
