// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";

let homeDir = "";

describe("whois", () => {
	beforeEach(() => {
		homeDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-whois-"));
		process.env.BIRDCLAW_HOME = homeDir;
		resetBirdclawPathsForTests();
		resetDatabaseForTests();
		const db = getNativeDb();
		db.exec(`
      delete from ai_scores;
      delete from tweet_actions;
      delete from dm_fts;
      delete from tweets_fts;
      delete from dm_messages;
      delete from dm_conversations;
      delete from tweets;
      delete from profile_bio_entities;
      delete from profile_snapshots;
      delete from profile_affiliations;
      delete from profiles;
      delete from accounts;
      delete from sync_cache;
    `);
		db.prepare(
			"insert into accounts (id, name, handle, transport, is_default, created_at) values ('acct_primary', 'Peter', '@steipete', 'archive', 1, '2009-03-19T22:54:05.000Z')",
		).run();
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, created_at) values ('profile_me', 'steipete', 'Peter', '', 1000, 18, '2009-03-19T22:54:05.000Z')",
		).run();
		db.prepare(
			`
      insert into profiles (
        id, handle, display_name, bio, followers_count, avatar_hue,
        location, url, verified_type, entities_json, created_at
      ) values (
        'profile_user_42', 'aditya', 'Aditya', 'Blacksmith cofounder building @useblacksmith', 5000, 210,
        'San Francisco', 'https://www.blacksmith.sh/team', 'business',
        '{"description":{"urls":[{"url":"https://t.co/bio","expanded_url":"https://www.blacksmith.sh"}]}}',
        '2020-01-01T00:00:00.000Z'
      )
      `,
		).run();
		db.prepare(
			`
      insert into profile_affiliations (
        subject_profile_id, organization_profile_id, organization_name,
        organization_handle, badge_url, url, label, source, is_active,
        first_seen_at, last_seen_at, raw_json, updated_at
      ) values (
        'profile_user_42', 'profile_org_blacksmith', 'Blacksmith',
        'blacksmith', 'https://cdn.example/blacksmith.png',
        'https://www.blacksmith.sh', 'Blacksmith', 'fixture', 1,
        '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z',
        '{"label":"Blacksmith"}', '2026-05-01T00:00:00.000Z'
      )
      `,
		).run();
		db.prepare(
			`
      insert into profile_bio_entities (
        profile_id, kind, value, source, is_active, first_seen_at, last_seen_at, raw_json
      ) values
        ('profile_user_42', 'handle', '@useblacksmith', 'bio', 1, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '{}'),
        ('profile_user_42', 'domain', 'blacksmith.sh', 'profile_url', 1, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '{}')
      `,
		).run();
		db.prepare(
			"insert into dm_conversations (id, account_id, participant_profile_id, title, last_message_at, unread_count, needs_reply) values ('dm_blacksmith', 'acct_primary', 'profile_user_42', 'Aditya', '2026-05-01T00:00:00.000Z', 0, 1)",
		).run();
		for (const message of [
			{
				id: "dm_before",
				text: "Hey Peter",
				createdAt: "2026-05-01T00:00:00.000Z",
				sender: "profile_user_42",
				direction: "inbound",
			},
			{
				id: "dm_match",
				text: "I am one of the Blacksmith cofounders, try the testboxes https://t.co/demo",
				createdAt: "2026-05-01T00:01:00.000Z",
				sender: "profile_user_42",
				direction: "inbound",
			},
		]) {
			db.prepare(
				`
        insert into dm_messages (
          id, conversation_id, sender_profile_id, text, created_at, direction, is_replied, media_count
        ) values (?, 'dm_blacksmith', ?, ?, ?, ?, 0, 0)
        `,
			).run(
				message.id,
				message.sender,
				message.text,
				message.createdAt,
				message.direction,
			);
			db.prepare("insert into dm_fts (message_id, text) values (?, ?)").run(
				message.id,
				message.text,
			);
		}
		db.prepare(
			`
      insert into tweets (
        id, account_id, author_profile_id, kind, text, created_at,
        is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
        entities_json, media_json, quoted_tweet_id
      ) values ('tweet_blacksmith', 'acct_primary', 'profile_user_42', 'home', 'Blacksmith public tweet', '2026-05-01T00:02:00.000Z', 0, null, 0, 0, 0, 0, '{}', '[]', null)
      `,
		).run();
		db.prepare("insert into tweets_fts (tweet_id, text) values (?, ?)").run(
			"tweet_blacksmith",
			"Blacksmith public tweet",
		);
		db.prepare(
			"insert into sync_cache (cache_key, value_json, updated_at) values (?, ?, ?)",
		).run(
			"url:expand:https://t.co/demo",
			JSON.stringify({
				expandedUrl: "https://www.blacksmith.sh/",
				finalUrl: "https://www.blacksmith.sh/",
				status: "hit",
			}),
			"2026-05-01T00:00:00.000Z",
		);
	});

	function insertLowConfidenceConversation() {
		const db = getNativeDb();
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, created_at) values ('profile_user_99', 'id99', 'id99', '', 0, 99, '2020-01-01T00:00:00.000Z')",
		).run();
		db.prepare(
			"insert into dm_conversations (id, account_id, participant_profile_id, title, last_message_at, unread_count, needs_reply) values ('dm_low', 'acct_primary', 'profile_user_99', 'id99', '2026-04-01T00:00:00.000Z', 0, 1)",
		).run();
		db.prepare(
			`
      insert into dm_messages (
        id, conversation_id, sender_profile_id, text, created_at, direction, is_replied, media_count
      ) values ('dm_low_match', 'dm_low', 'profile_user_99', 'blacksmith', '2026-04-01T00:00:00.000Z', 'inbound', 0, 0)
      `,
		).run();
		db.prepare("insert into dm_fts (message_id, text) values (?, ?)").run(
			"dm_low_match",
			"blacksmith",
		);
	}

	afterEach(() => {
		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		delete process.env.BIRDCLAW_HOME;
		rmSync(homeDir, { recursive: true, force: true });
	});

	it("clusters DM evidence into ranked identity candidates", async () => {
		insertLowConfidenceConversation();
		const { runWhois } = await import("./whois");

		const result = await runWhois("blacksmith", {
			resolveProfiles: false,
			expandUrls: false,
			context: 1,
		});

		expect(result.candidates[0]).toMatchObject({
			confidence: expect.any(Number),
			reasons: expect.arrayContaining([
				"resolved profile",
				"profile URL matches query",
				"affiliation matches query",
				"cofounder language",
				"message text matches query",
			]),
			conversation: expect.objectContaining({
				id: "dm_blacksmith",
				participant: expect.objectContaining({ handle: "aditya" }),
			}),
			evidence: [
				expect.objectContaining({
					messageId: "dm_match",
					text: expect.stringContaining("Blacksmith cofounders"),
				}),
			],
			profileEvidence: expect.arrayContaining([
				expect.objectContaining({
					kind: "profile_url",
					value: "https://www.blacksmith.sh/team",
				}),
				expect.objectContaining({
					kind: "affiliation",
					value: "Blacksmith",
				}),
			]),
		});
		expect(result.candidates[0]?.confidence).toBeGreaterThanOrEqual(80);
		expect(result.candidates[1]).toMatchObject({
			confidence: expect.any(Number),
			reasons: ["message text matches query"],
			conversation: expect.objectContaining({ id: "dm_low" }),
		});
	});

	it("resolves local profiles by default without xurl fallback", async () => {
		const { runWhois } = await import("./whois");

		const result = await runWhois("blacksmith", {
			xurlFallback: false,
			expandUrls: false,
			context: 1,
		});

		expect(result.profileResolution).toEqual([
			expect.objectContaining({
				profileId: "profile_user_42",
				status: "hit",
				source: "local",
			}),
		]);
	});

	it("uses significant terms and bio entities for fuzzy identity queries", async () => {
		const { runWhois } = await import("./whois");

		const result = await runWhois("blacksmith guy", {
			resolveProfiles: false,
			expandUrls: false,
			context: 1,
		});

		expect(result.candidates[0]).toMatchObject({
			conversation: expect.objectContaining({ id: "dm_blacksmith" }),
			reasons: expect.arrayContaining(["bio entity matches query"]),
			profileEvidence: expect.arrayContaining([
				expect.objectContaining({
					kind: "bio_handle",
					value: "@useblacksmith",
				}),
				expect.objectContaining({
					kind: "bio_domain",
					value: "blacksmith.sh",
				}),
			]),
		});
	});

	it("attaches cached URL expansions and formats identity reports", async () => {
		const { formatWhois, runWhois } = await import("./whois");

		const result = await runWhois("blacksmith", {
			resolveProfiles: false,
			context: 1,
		});

		expect(result.urlExpansions).toEqual([
			expect.objectContaining({
				url: "https://t.co/demo",
				finalUrl: "https://www.blacksmith.sh/",
				source: "cache",
				status: "hit",
			}),
		]);
		expect(result.candidates[0]?.reasons).toContain(
			"expanded URL matches query",
		);
		expect(result.candidates[0]?.evidence[0]?.urlExpansions).toEqual([
			expect.objectContaining({ finalUrl: "https://www.blacksmith.sh/" }),
		]);
		expect(formatWhois(result)).toContain(
			"https://t.co/demo -> https://www.blacksmith.sh/",
		);
	});

	it("can search only related tweets and formats empty DM candidates", async () => {
		const { formatWhois, runWhois } = await import("./whois");

		const result = await runWhois("blacksmith", {
			dms: false,
			tweets: true,
			resolveProfiles: false,
			expandUrls: false,
			limit: 2,
		});

		expect(result.candidates).toEqual([]);
		expect(result.relatedTweets).toEqual([
			expect.objectContaining({
				id: "tweet_blacksmith",
				text: "Blacksmith public tweet",
			}),
		]);
		expect(formatWhois(result)).toContain("No matching DM candidates.");
		expect(formatWhois(result)).toContain("Related tweets: 1");
	});
});
