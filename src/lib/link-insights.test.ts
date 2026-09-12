// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { getLinkInsights } from "./link-insights";

let homeDir = "";
type TestDb = ReturnType<typeof getNativeDb>;

function localDate(dayOffset = 0, hour = 12, minute = 0) {
	return new Date(2026, 4, 11 + dayOffset, hour, minute, 0, 0);
}

function localIso(dayOffset = 0, hour = 12, minute = 0) {
	return localDate(dayOffset, hour, minute).toISOString();
}

function withTimezone<T>(timezone: string, run: () => T) {
	const previous = process.env.TZ;
	process.env.TZ = timezone;
	try {
		return run();
	} finally {
		if (previous === undefined) {
			delete process.env.TZ;
		} else {
			process.env.TZ = previous;
		}
	}
}

function insertAccountFixture() {
	const db = getNativeDb({ seedDemoData: false });
	const insertAccount = db.prepare(`
	    insert into accounts (
	      id, name, handle, external_user_id, transport, is_default, created_at
	    ) values (?, ?, ?, ?, ?, ?, ?)
	  `);
	insertAccount.run(
		"acct_primary",
		"Peter",
		"steipete",
		"25401953",
		"bird",
		1,
		"2026-05-01T00:00:00.000Z",
	);
	insertAccount.run(
		"acct_secondary",
		"Alt",
		"alt",
		"999",
		"bird",
		0,
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
		accountId?: string;
		authorProfileId: string;
		text: string;
		createdAt: string;
	},
) {
	db.prepare(`
    insert into tweets (
      id, author_profile_id, text, created_at, is_replied,
      reply_to_id, like_count, media_count,
      entities_json, media_json, quoted_tweet_id
    ) values (?, ?, ?, ?, 0, null, 1, 0, '{}', '[]', null)
  `).run(options.id, options.authorProfileId, options.text, options.createdAt);
	db.prepare(`
		insert into tweet_account_edges (
			account_id, tweet_id, kind, first_seen_at, last_seen_at, seen_count,
			source, raw_json, updated_at
		) values (?, ?, 'home', ?, ?, 1, 'test', '{}', ?)
	`).run(
		options.accountId ?? "acct_primary",
		options.id,
		options.createdAt,
		options.createdAt,
		options.createdAt,
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
		accountId?: string;
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
		options.accountId ?? "acct_primary",
		options.sourceKind === "dm" ? "dm_bob" : null,
		options.sourceKind === "dm" ? "inbound" : null,
		options.createdAt,
	);
}

function insertTweetAccountEdge(
	db: TestDb,
	options: { accountId: string; tweetId: string; kind?: string },
) {
	db.prepare(`
    insert into tweet_account_edges (
      account_id, tweet_id, kind, first_seen_at, last_seen_at, source, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?)
  `).run(
		options.accountId,
		options.tweetId,
		options.kind ?? "home",
		"2026-05-11T00:00:00.000Z",
		"2026-05-11T00:00:00.000Z",
		"test",
		"2026-05-11T00:00:00.000Z",
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
			createdAt: localIso(0, 1, 6),
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
			createdAt: localIso(0, 1, 6),
		});

		const insights = getLinkInsights({
			range: "today",
			now: localDate(),
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
			createdAt: localIso(0, 9),
		});
		insertDmMessage(db, {
			id: "dm_yesterday",
			senderProfileId: "profile_b",
			text: "Yesterday https://t.co/yesterday",
			createdAt: localIso(-1, 22),
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
			createdAt: localIso(0, 9),
		});
		insertOccurrence(db, {
			sourceKind: "dm",
			sourceId: "dm_yesterday",
			shortUrl: "https://t.co/yesterday",
			createdAt: localIso(-1, 22),
		});

		const today = getLinkInsights({
			range: "today",
			source: "all",
			now: localDate(),
		});
		expect(today.items.map((item) => item.host)).toEqual(["today.example"]);

		const dm = getLinkInsights({
			range: "all",
			source: "dm",
			now: localDate(),
		});
		expect(dm.items.map((item) => item.host)).toEqual(["yesterday.example"]);
		expect(dm.items[0]?.mentions[0]).toMatchObject({
			sourceKind: "dm",
			direction: "inbound",
			participant: expect.objectContaining({ handle: "bob" }),
		});
	});

	it("anchors the today range to local midnight regardless of host timezone", () =>
		withTimezone("America/New_York", () => {
			// ISO timestamps store instants in UTC, but "today" is a local calendar
			// concept. Build both sides of local midnight before converting to ISO.
			const db = insertAccountFixture();
			insertTweet(db, {
				id: "tweet_after_local_midnight",
				authorProfileId: "profile_a",
				text: "Just after midnight https://t.co/after",
				createdAt: localIso(0, 0, 30),
			});
			insertTweet(db, {
				id: "tweet_before_local_midnight",
				authorProfileId: "profile_b",
				text: "Just before midnight https://t.co/before",
				createdAt: localIso(-1, 23, 30),
			});
			insertExpansion(db, {
				shortUrl: "https://t.co/after",
				finalUrl: "https://after.example/post",
			});
			insertExpansion(db, {
				shortUrl: "https://t.co/before",
				finalUrl: "https://before.example/post",
			});
			insertOccurrence(db, {
				sourceKind: "tweet",
				sourceId: "tweet_after_local_midnight",
				shortUrl: "https://t.co/after",
				createdAt: localIso(0, 0, 30),
			});
			insertOccurrence(db, {
				sourceKind: "tweet",
				sourceId: "tweet_before_local_midnight",
				shortUrl: "https://t.co/before",
				createdAt: localIso(-1, 23, 30),
			});

			const today = getLinkInsights({
				range: "today",
				now: localDate(),
			});
			expect(today.items.map((item) => item.host)).toEqual(["after.example"]);
		}));

	it("scopes results to the selected account", () => {
		const db = insertAccountFixture();
		insertTweet(db, {
			id: "tweet_primary",
			authorProfileId: "profile_a",
			text: "Primary link https://t.co/primary",
			createdAt: localIso(0, 9),
		});
		insertTweet(db, {
			id: "tweet_secondary",
			accountId: "acct_secondary",
			authorProfileId: "profile_b",
			text: "Secondary link https://t.co/secondary",
			createdAt: localIso(0, 10),
		});
		insertTweet(db, {
			id: "tweet_shared",
			authorProfileId: "profile_a",
			text: "Shared edge link https://t.co/shared",
			createdAt: localIso(0, 11),
		});
		insertExpansion(db, {
			shortUrl: "https://t.co/primary",
			finalUrl: "https://primary.example/post",
		});
		insertExpansion(db, {
			shortUrl: "https://t.co/secondary",
			finalUrl: "https://secondary.example/post",
		});
		insertExpansion(db, {
			shortUrl: "https://t.co/shared",
			finalUrl: "https://shared.example/post",
		});
		insertOccurrence(db, {
			sourceKind: "tweet",
			sourceId: "tweet_primary",
			shortUrl: "https://t.co/primary",
			createdAt: localIso(0, 9),
		});
		insertOccurrence(db, {
			sourceKind: "tweet",
			sourceId: "tweet_secondary",
			shortUrl: "https://t.co/secondary",
			accountId: "acct_secondary",
			createdAt: localIso(0, 10),
		});
		insertOccurrence(db, {
			sourceKind: "tweet",
			sourceId: "tweet_shared",
			shortUrl: "https://t.co/shared",
			createdAt: localIso(0, 11),
		});
		insertTweetAccountEdge(db, {
			accountId: "acct_secondary",
			tweetId: "tweet_shared",
		});

		const now = localDate();
		expect(
			getLinkInsights({
				account: "acct_primary",
				range: "today",
				now,
			}).items.map((item) => item.host),
		).toEqual(["shared.example", "primary.example"]);
		expect(
			getLinkInsights({
				account: "acct_secondary",
				range: "today",
				now,
			}).items.map((item) => item.host),
		).toEqual(["shared.example", "secondary.example"]);
		expect(
			new Set(
				getLinkInsights({ account: "all", range: "today", now }).items.map(
					(item) => item.host,
				),
			),
		).toEqual(
			new Set(["primary.example", "secondary.example", "shared.example"]),
		);
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

	it.each(["rank", "recent"] as const)(
		"resolves %s ties before full hydration and uses the DM sender's influence",
		(sort) => {
			const db = insertAccountFixture();
			const createdAt = "2026-05-10T10:00:00.000Z";
			for (let i = 0; i < 40; i++) {
				const id = `tie_${i}`;
				const shortUrl = `https://t.co/tie${i}`;
				insertTweet(db, {
					id,
					authorProfileId: i === 0 ? "profile_me" : "profile_b",
					text: shortUrl,
					createdAt,
				});
				insertExpansion(db, { shortUrl, finalUrl: `https://example.com/${i}` });
				insertOccurrence(db, {
					sourceKind: "tweet",
					sourceId: id,
					shortUrl,
					createdAt,
				});
			}
			insertDmMessage(db, {
				id: "dm_tie",
				senderProfileId: "profile_a",
				text: "https://t.co/dm-tie",
				createdAt,
			});
			insertExpansion(db, {
				shortUrl: "https://t.co/dm-tie",
				finalUrl: "https://example.com/dm",
			});
			insertOccurrence(db, {
				sourceKind: "dm",
				sourceId: "dm_tie",
				shortUrl: "https://t.co/dm-tie",
				createdAt,
			});
			insertExpansion(db, {
				shortUrl: "https://t.co/missing",
				finalUrl: "https://example.com/missing",
			});
			insertOccurrence(db, {
				sourceKind: "tweet",
				sourceId: "missing",
				shortUrl: "https://t.co/missing",
				createdAt,
			});
			const hydrated: number[] = [];
			const original = db.prepare.bind(db);
			const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
				const statement = original(sql);
				if (sql.includes("source_media_json")) {
					const all = statement.all.bind(statement);
					statement.all = (...args) => {
						const rows = all(...args);
						hydrated.push(rows.length);
						return rows;
					};
				}
				return statement;
			});
			try {
				const result = getLinkInsights({ range: "all", sort, limit: 3 });
				expect(result.items).toHaveLength(3);
				expect(result.items[0]).toMatchObject({
					url: "https://example.com/dm",
					topSharer: { id: "profile_a" },
				});
				expect(result.items[1]?.url).toBe("https://example.com/0");
				expect(hydrated).toEqual([3]);
				const all = getLinkInsights({ range: "all", sort, limit: 100 });
				expect(all.items[0]?.url).toBe(result.items[0]?.url);
				expect(all.items.at(-1)).toMatchObject({
					url: "https://example.com/missing",
					totalInfluence: 0,
				});
			} finally {
				spy.mockRestore();
			}
		},
	);

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
		insertTweet(db, {
			id: "recent_single",
			authorProfileId: "profile_b",
			text: "https://t.co/recent",
			createdAt: "2026-05-11T10:00:00.000Z",
		});
		insertExpansion(db, {
			shortUrl: "https://t.co/recent",
			finalUrl: "https://recent.example/post",
		});
		insertOccurrence(db, {
			sourceKind: "tweet",
			sourceId: "recent_single",
			shortUrl: "https://t.co/recent",
			createdAt: "2026-05-11T10:00:00.000Z",
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
		expect(
			getLinkInsights({ range: "week", limit: 1, sort: "recent", now }).items[0]
				?.host,
		).toBe("recent.example");
	});
});
