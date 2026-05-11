// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { getLinkInsights } from "./link-insights";

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
		"2026-05-01T00:00:00.000Z",
	);
	for (const profile of [
		["profile_a", "alice", "Alice", 10_000, 1],
		["profile_b", "bob", "Bob", 100, 2],
		["profile_me", "steipete", "Peter", 5000, 3],
	] as const) {
		db.prepare(`
      insert into profiles (
        id, handle, display_name, bio, followers_count, following_count,
        avatar_hue, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
			profile[0],
			profile[1],
			profile[2],
			"",
			profile[3],
			0,
			profile[4],
			"2026-05-01T00:00:00.000Z",
		);
	}
	return db;
}

function insertTweet(
	db: TestDb,
	options: {
		id: string;
		authorProfileId: string;
		text: string;
		createdAt: string;
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
		options.authorProfileId,
		"home",
		options.text,
		options.createdAt,
		0,
		null,
		1,
		0,
		0,
		0,
		"{}",
		"[]",
		null,
	);
}

function insertDmMessage(
	db: TestDb,
	options: {
		id: string;
		senderProfileId: string;
		text: string;
		createdAt: string;
	},
) {
	db.prepare(`
    insert into dm_conversations (
      id, account_id, participant_profile_id, title, last_message_at,
      unread_count, needs_reply
    ) values (?, ?, ?, ?, ?, ?, ?)
  `).run("dm_bob", "acct_primary", "profile_b", "Bob", options.createdAt, 0, 0);
	db.prepare(`
    insert into dm_messages (
      id, conversation_id, sender_profile_id, text, created_at, direction,
      is_replied, media_count
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
		options.id,
		"dm_bob",
		options.senderProfileId,
		options.text,
		options.createdAt,
		"inbound",
		0,
		0,
	);
}

function insertExpansion(
	db: TestDb,
	options: {
		shortUrl: string;
		finalUrl: string;
		title?: string;
		description?: string;
	},
) {
	db.prepare(`
    insert into url_expansions (
      short_url, expanded_url, final_url, status, expanded_tweet_id,
      expanded_handle, title, description, error, source, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
		options.shortUrl,
		options.finalUrl,
		options.finalUrl,
		"hit",
		null,
		null,
		options.title ?? null,
		options.description ?? null,
		null,
		"test",
		"2026-05-11T00:00:00.000Z",
	);
}

function insertOccurrence(
	db: TestDb,
	options: {
		sourceKind: "dm" | "tweet";
		sourceId: string;
		shortUrl: string;
		createdAt: string;
	},
) {
	db.prepare(`
    insert into link_occurrences (
      source_kind, source_id, source_position, short_url, account_id,
      conversation_id, direction, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
		options.sourceKind,
		options.sourceId,
		0,
		options.shortUrl,
		"acct_primary",
		options.sourceKind === "dm" ? "dm_bob" : null,
		options.sourceKind === "dm" ? "inbound" : null,
		options.createdAt,
	);
}

describe("link insights", () => {
	beforeEach(() => {
		homeDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-link-insights-"));
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

	it("groups top links, strips shared URLs from comments, and splits videos", () => {
		const db = insertAccountFixture();
		insertTweet(db, {
			id: "tweet_1",
			authorProfileId: "profile_a",
			text: "This is the good discussion https://t.co/a",
			createdAt: "2026-05-10T10:00:00.000Z",
		});
		insertTweet(db, {
			id: "tweet_2",
			authorProfileId: "profile_b",
			text: "Follow-up thought http://example.com/story?utm_source=x",
			createdAt: "2026-05-10T11:00:00.000Z",
		});
		insertTweet(db, {
			id: "tweet_3",
			authorProfileId: "profile_b",
			text: "https://t.co/a",
			createdAt: "2026-05-10T11:30:00.000Z",
		});
		insertTweet(db, {
			id: "tweet_video",
			authorProfileId: "profile_a",
			text: "Watch this https://t.co/video",
			createdAt: "2026-05-10T12:00:00.000Z",
		});
		insertExpansion(db, {
			shortUrl: "https://t.co/a",
			finalUrl: "https://www.example.com/story?utm_source=x",
			title: "Short title",
		});
		insertExpansion(db, {
			shortUrl: "http://example.com/story?utm_source=x",
			finalUrl: "http://example.com/story?utm_source=x",
			title: "A much better article title",
		});
		insertExpansion(db, {
			shortUrl: "https://t.co/video",
			finalUrl: "https://youtu.be/abc123?utm_medium=social",
			title: "Demo video",
		});
		insertOccurrence(db, {
			sourceKind: "tweet",
			sourceId: "tweet_1",
			shortUrl: "https://t.co/a",
			createdAt: "2026-05-10T10:00:00.000Z",
		});
		insertOccurrence(db, {
			sourceKind: "tweet",
			sourceId: "tweet_2",
			shortUrl: "http://example.com/story?utm_source=x",
			createdAt: "2026-05-10T11:00:00.000Z",
		});
		insertOccurrence(db, {
			sourceKind: "tweet",
			sourceId: "tweet_3",
			shortUrl: "https://t.co/a",
			createdAt: "2026-05-10T11:30:00.000Z",
		});
		insertOccurrence(db, {
			sourceKind: "tweet",
			sourceId: "tweet_video",
			shortUrl: "https://t.co/video",
			createdAt: "2026-05-10T12:00:00.000Z",
		});

		const now = new Date("2026-05-11T12:00:00.000Z");
		const links = getLinkInsights({ kind: "links", range: "week", now });
		expect(links.items).toHaveLength(1);
		expect(links.items[0]).toMatchObject({
			displayUrl: "example.com/story",
			shareCount: 3,
			uniqueSharers: 2,
			title: "A much better article title",
			topSharer: expect.objectContaining({ handle: "alice" }),
			mentionCount: 3,
			commentCount: 2,
			pureShareCount: 1,
			hiddenMentionCount: 0,
		});
		expect(links.items[0]?.mentions[0]?.text).not.toContain("https://t.co/a");
		expect(links.items[0]?.mentions.at(-1)).toMatchObject({
			hasComment: false,
			isPureShare: true,
			sourceUrl: "https://x.com/bob/status/tweet_3",
		});
		expect(links.items[0]?.sharers.map((profile) => profile.handle)).toEqual([
			"alice",
			"bob",
		]);

		const clipped = getLinkInsights({
			kind: "links",
			range: "week",
			commentsLimit: 2,
			now,
		});
		expect(clipped.items[0]).toMatchObject({
			mentionCount: 3,
			hiddenMentionCount: 1,
		});
		expect(clipped.items[0]?.mentions).toHaveLength(2);

		const videos = getLinkInsights({ kind: "videos", range: "week", now });
		expect(videos.items).toEqual([
			expect.objectContaining({
				displayUrl: "youtu.be/abc123",
				host: "youtu.be",
				shareCount: 1,
			}),
		]);
	});

	it("derives readable titles from long slug URLs when metadata is missing", () => {
		const db = insertAccountFixture();
		insertTweet(db, {
			id: "tweet_forum_event",
			authorProfileId: "profile_a",
			text: "Codex event https://t.co/forum",
			createdAt: "2026-05-11T01:06:00.000Z",
		});
		insertExpansion(db, {
			shortUrl: "https://t.co/forum",
			finalUrl:
				"https://forum.openai.com/public/events/codex-is-for-everyone-why-codex-matters-beyond-code-fa40puy7wi?agenda_day=69ebc15673d8354297b24f73&agenda_view=list",
		});
		insertOccurrence(db, {
			sourceKind: "tweet",
			sourceId: "tweet_forum_event",
			shortUrl: "https://t.co/forum",
			createdAt: "2026-05-11T01:06:00.000Z",
		});

		const insights = getLinkInsights({
			range: "today",
			now: new Date("2026-05-11T12:00:00.000Z"),
		});

		expect(insights.items[0]).toMatchObject({
			host: "forum.openai.com",
			title: "Codex Is for Everyone Why Codex Matters Beyond Code",
		});
		expect(insights.items[0]?.displayUrl).toContain("agenda_view=list");
		expect(insights.items[0]?.title).not.toContain("agenda_day");
	});

	it("honors today bounds and source filters", () => {
		const db = insertAccountFixture();
		insertTweet(db, {
			id: "tweet_today",
			authorProfileId: "profile_a",
			text: "Today https://t.co/today",
			createdAt: "2026-05-11T09:00:00.000Z",
		});
		insertDmMessage(db, {
			id: "dm_yesterday",
			senderProfileId: "profile_b",
			text: "Yesterday https://t.co/yesterday",
			createdAt: "2026-05-10T22:00:00.000Z",
		});
		insertExpansion(db, {
			shortUrl: "https://t.co/today",
			finalUrl: "https://today.example/post",
		});
		insertExpansion(db, {
			shortUrl: "https://t.co/yesterday",
			finalUrl: "https://yesterday.example/post",
		});
		insertOccurrence(db, {
			sourceKind: "tweet",
			sourceId: "tweet_today",
			shortUrl: "https://t.co/today",
			createdAt: "2026-05-11T09:00:00.000Z",
		});
		insertOccurrence(db, {
			sourceKind: "dm",
			sourceId: "dm_yesterday",
			shortUrl: "https://t.co/yesterday",
			createdAt: "2026-05-10T22:00:00.000Z",
		});

		const today = getLinkInsights({
			range: "today",
			source: "all",
			now: new Date("2026-05-11T12:00:00.000Z"),
		});
		expect(today.items.map((item) => item.host)).toEqual(["today.example"]);

		const dm = getLinkInsights({
			range: "all",
			source: "dm",
			now: new Date("2026-05-11T12:00:00.000Z"),
		});
		expect(dm.items.map((item) => item.host)).toEqual(["yesterday.example"]);
		expect(dm.items[0]?.mentions[0]).toMatchObject({
			sourceKind: "dm",
			direction: "inbound",
			participant: expect.objectContaining({ handle: "bob" }),
		});
	});

	it("preserves http schemes on exposed link urls", () => {
		const db = insertAccountFixture();
		insertTweet(db, {
			id: "tweet_http",
			authorProfileId: "profile_a",
			text: "Local tool http://localhost:8080/dashboard",
			createdAt: "2026-05-10T10:00:00.000Z",
		});
		insertExpansion(db, {
			shortUrl: "http://localhost:8080/dashboard",
			finalUrl: "http://localhost:8080/dashboard",
		});
		insertOccurrence(db, {
			sourceKind: "tweet",
			sourceId: "tweet_http",
			shortUrl: "http://localhost:8080/dashboard",
			createdAt: "2026-05-10T10:00:00.000Z",
		});

		const now = new Date("2026-05-11T12:00:00.000Z");
		expect(
			getLinkInsights({ range: "week", limit: 1, now }).items[0]?.url,
		).toBe("http://localhost:8080/dashboard");
	});

	it("applies sort before limiting groups", () => {
		const db = insertAccountFixture();
		for (const id of ["rank_1", "rank_2", "rank_3"] as const) {
			insertTweet(db, {
				id,
				authorProfileId: "profile_a",
				text: "https://t.co/rank",
				createdAt: "2026-05-10T10:00:00.000Z",
			});
			insertOccurrence(db, {
				sourceKind: "tweet",
				sourceId: id,
				shortUrl: "https://t.co/rank",
				createdAt: "2026-05-10T10:00:00.000Z",
			});
		}
		insertTweet(db, {
			id: "comment_heavy",
			authorProfileId: "profile_b",
			text: "This one has the actual discussion https://t.co/comments",
			createdAt: "2026-05-09T10:00:00.000Z",
		});
		insertExpansion(db, {
			shortUrl: "https://t.co/rank",
			finalUrl: "https://popular.example/post",
		});
		insertExpansion(db, {
			shortUrl: "https://t.co/comments",
			finalUrl: "https://comments.example/post",
		});
		insertOccurrence(db, {
			sourceKind: "tweet",
			sourceId: "comment_heavy",
			shortUrl: "https://t.co/comments",
			createdAt: "2026-05-09T10:00:00.000Z",
		});

		const now = new Date("2026-05-11T12:00:00.000Z");
		expect(
			getLinkInsights({ range: "week", limit: 1, sort: "rank", now }).items[0]
				?.host,
		).toBe("popular.example");
		expect(
			getLinkInsights({ range: "week", limit: 1, sort: "comments", now })
				.items[0]?.host,
		).toBe("comments.example");
	});
});
