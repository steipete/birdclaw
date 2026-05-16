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
      delete from identity_search_index;
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

	function insertGithubIdentityFixtures() {
		const db = getNativeDb();
		db.exec(`
      insert into profiles (
        id, handle, display_name, bio, followers_count, avatar_hue, url, created_at
      ) values
        ('profile_github_staff', 'staffer', 'GitHub Staffer', 'Developer advocacy at @github', 2000, 12, 'https://example.com/staffer', '2020-01-01T00:00:00.000Z'),
        ('profile_github_star', 'starperson', 'Star Person', 'Security researcher and GitHub Star. DevRel @snyksec', 5000, 13, 'https://example.com/star', '2020-01-01T00:00:00.000Z'),
        ('profile_github_link', 'linkperson', 'Link Person', 'Maintainer', 8000, 14, 'https://github.com/linkperson', '2020-01-01T00:00:00.000Z');

      insert into dm_conversations (
        id, account_id, participant_profile_id, title, last_message_at, unread_count, needs_reply
      ) values
        ('dm_github_staff', 'acct_primary', 'profile_github_staff', 'GitHub Staffer', '2026-05-04T00:00:00.000Z', 0, 0),
        ('dm_github_star', 'acct_primary', 'profile_github_star', 'Star Person', '2026-05-05T00:00:00.000Z', 0, 0),
        ('dm_github_link', 'acct_primary', 'profile_github_link', 'Link Person', '2026-05-06T00:00:00.000Z', 0, 0);

      insert into profile_affiliations (
        subject_profile_id, organization_profile_id, organization_name,
        organization_handle, badge_url, url, label, source, is_active,
        first_seen_at, last_seen_at, raw_json, updated_at
      ) values (
        'profile_github_staff', 'profile_org_github', 'GitHub',
        'github', null, 'https://twitter.com/github', 'GitHub', 'fixture', 1,
        '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z',
        '{"label":"GitHub"}', '2026-05-01T00:00:00.000Z'
      );

      insert into profile_bio_entities (
        profile_id, kind, value, source, is_active, first_seen_at, last_seen_at, raw_json
      ) values
        ('profile_github_staff', 'handle', '@github', 'bio', 1, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '{}'),
        ('profile_github_staff', 'company_phrase', 'github', 'bio_handle', 1, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '{}'),
        ('profile_github_star', 'handle', '@GitHub', 'bio', 1, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '{}'),
        ('profile_github_star', 'company_phrase', 'GitHub', 'bio_handle', 1, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '{}'),
        ('profile_github_link', 'domain', 'github.com', 'profile_url', 1, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '{}');
    `);
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

	it("ranks affiliation evidence above GitHub profile links and buckets ambiguity", async () => {
		insertGithubIdentityFixtures();
		const { formatWhois, runWhois } = await import("./whois");

		const result = await runWhois("github guy", {
			resolveProfiles: false,
			expandUrls: false,
			context: 1,
			limit: 6,
		});

		expect(
			result.candidates.map((candidate) => candidate.conversation.id),
		).toEqual(
			expect.arrayContaining([
				"dm_github_staff",
				"dm_github_star",
				"dm_github_link",
			]),
		);
		expect(result.candidates[0]).toMatchObject({
			category: "likely_affiliated",
			conversation: expect.objectContaining({ id: "dm_github_staff" }),
			profileEvidence: expect.arrayContaining([
				expect.objectContaining({ kind: "affiliation", value: "GitHub" }),
			]),
		});
		expect(
			result.candidates.find(
				(candidate) => candidate.conversation.id === "dm_github_star",
			)?.category,
		).toBe("ecosystem");
		expect(
			result.candidates.find(
				(candidate) => candidate.conversation.id === "dm_github_link",
			)?.category,
		).toBe("profile_or_link");
		expect(formatWhois(result)).toContain("Likely affiliated");
		expect(formatWhois(result)).toContain("Why: current affiliation GitHub");
	});

	it("explains uncommon evidence kinds for why lines", async () => {
		const { __test__ } = await import("./whois");

		expect(
			__test__.explainCandidate({
				profileEvidence: [
					{
						kind: "expanded_url",
						value: "https://github.com/example",
						source: "url",
					},
				],
				reasons: ["expanded URL matches query"],
			} as never),
		).toBe("expanded URL https://github.com/example");
		expect(
			__test__.explainCandidate({
				profileEvidence: [
					{ kind: "profile_name", value: "GitHub Person", source: "profile" },
				],
				reasons: ["profile matches query"],
			} as never),
		).toBe("profile name GitHub Person");
	});

	it("filters whois candidates by affiliation and domain-only evidence", async () => {
		insertGithubIdentityFixtures();
		const { runWhois } = await import("./whois");

		const current = await runWhois("github", {
			resolveProfiles: false,
			expandUrls: false,
			currentAffiliation: "github",
			limit: 6,
		});
		expect(
			current.candidates.map((candidate) => candidate.conversation.id),
		).toEqual(["dm_github_staff"]);

		const noDomainOnly = await runWhois("github", {
			resolveProfiles: false,
			expandUrls: false,
			excludeDomainOnly: true,
			limit: 6,
		});
		expect(
			noDomainOnly.candidates.map((candidate) => candidate.conversation.id),
		).not.toContain("dm_github_link");
	});

	it("covers profile scoring helper edge cases", async () => {
		const { __test__ } = await import("./whois");
		const profile = {
			id: "profile_user_42",
			handle: "founder",
			displayName: "Founder Person",
			bio: "Working on reliable CI",
			followersCount: 5000,
			avatarHue: 120,
			location: "London",
			url: "https://current.example",
			verifiedType: "business",
			entities: {
				description: {
					urls: [null, { expanded_url: "https://bio.example" }, { url: "" }],
				},
			},
			affiliations: [
				{
					organizationProfileId: "profile_user_current",
					organizationName: "CurrentCo",
					organizationHandle: "currentco",
					label: "CurrentCo",
					url: "https://current.example",
					source: "bird",
					firstSeenAt: "2026-05-01T00:00:00.000Z",
					lastSeenAt: "2026-05-01T00:00:00.000Z",
					isActive: true,
				},
			],
			createdAt: "2026-01-01T00:00:00.000Z",
		};
		const sender = {
			id: "profile_me",
			handle: "steipete",
			displayName: "Peter",
			bio: "",
			followersCount: 1,
			avatarHue: 1,
			createdAt: "2026-01-01T00:00:00.000Z",
		};
		const conversation = {
			id: "dm_helper",
			accountId: "acct_primary",
			accountHandle: "@steipete",
			title: "Founder Person",
			lastMessageAt: "2026-05-01T12:00:00.000Z",
			lastMessagePreview: "oldco link",
			unreadCount: 0,
			needsReply: false,
			influenceScore: 10,
			influenceLabel: "medium",
			participant: profile,
			matches: [
				{
					before: [
						{
							id: "m_before",
							conversationId: "dm_helper",
							text: "see https://t.co/old",
							createdAt: "2026-05-01T11:59:00.000Z",
							direction: "inbound" as const,
							isReplied: false,
							mediaCount: 0,
							sender: profile,
						},
					],
					message: {
						id: "m_hit",
						conversationId: "dm_helper",
						text: "oldco founder",
						createdAt: "2026-05-01T12:00:00.000Z",
						direction: "inbound" as const,
						isReplied: false,
						mediaCount: 0,
						sender: profile,
					},
					after: [
						{
							id: "m_after",
							conversationId: "dm_helper",
							text: "done",
							createdAt: "2026-05-01T12:01:00.000Z",
							direction: "outbound" as const,
							isReplied: true,
							mediaCount: 0,
							sender,
						},
					],
				},
			],
		};
		const snapshots = [
			{
				profileId: "profile_user_42",
				snapshotHash: "hash",
				observedAt: "2026-04-01T00:00:00.000Z",
				lastSeenAt: "2026-04-01T00:00:00.000Z",
				source: "bird",
				handle: "oldfounder",
				displayName: "Old Founder",
				bio: "OldCo co-founder",
				location: "Vienna",
				url: "https://oldco.example",
				verifiedType: "blue",
				followersCount: 4000,
				followingCount: 100,
				affiliations: [
					null,
					"bad",
					{
						organizationName: "OldCo",
						organizationHandle: "oldco",
						label: "OldCo",
						url: "https://oldco.example",
					},
				],
			},
		];
		const bioEntities = [
			{
				profileId: "profile_user_42",
				kind: "handle" as const,
				value: "@oldco",
				source: "bio",
				firstSeenAt: "2026-04-01T00:00:00.000Z",
				lastSeenAt: "2026-04-01T00:00:00.000Z",
				isActive: true,
			},
			{
				profileId: "profile_user_42",
				kind: "domain" as const,
				value: "oldco.example",
				source: "profile_url",
				firstSeenAt: "2026-04-01T00:00:00.000Z",
				lastSeenAt: "2026-04-01T00:00:00.000Z",
				isActive: true,
			},
			{
				profileId: "profile_user_42",
				kind: "company_phrase" as const,
				value: "OldCo",
				source: "affiliation",
				firstSeenAt: "2026-04-01T00:00:00.000Z",
				lastSeenAt: "2026-04-01T00:00:00.000Z",
				isActive: true,
			},
		];

		expect(__test__.getSignificantQueryTerms("who is @oldco guy?")).toEqual([
			"oldco",
		]);
		expect(__test__.matchesQueryText("oldco guy", "OldCo founder")).toBe(true);
		expect(__test__.matchesQueryText("oldco", null)).toBe(false);
		expect(__test__.getDmSearchQueries(" oldco guy ")).toEqual([
			"oldco guy",
			"oldco",
		]);
		expect(__test__.getUrlEntityExpandedUrl(null)).toBeUndefined();
		expect(__test__.getProfileBioUrls({ ...profile, entities: {} })).toEqual(
			[],
		);
		expect(
			__test__.getProfileBioUrls({
				...profile,
				entities: { description: { urls: "nope" } },
			}),
		).toEqual([]);
		expect(__test__.getSnapshotAffiliationTexts(snapshots[0])).toEqual([
			"OldCo",
			"oldco",
			"OldCo",
			"https://oldco.example",
		]);
		expect(__test__.getHistoricalSnapshotTexts(snapshots[0], profile)).toEqual(
			expect.arrayContaining([
				"previous handle: @oldfounder",
				"previous name: Old Founder",
				"previous bio: OldCo co-founder",
				"previous location: Vienna",
				"previous url: https://oldco.example",
				"previous verified: blue",
				expect.stringContaining("previous affiliations"),
			]),
		);

		const expansion = {
			url: "https://t.co/old",
			expandedUrl: "https://t.co/old",
			finalUrl: "https://oldco.example/jobs",
			status: "hit" as const,
			source: "cache" as const,
			updatedAt: "2026-05-01T00:00:00.000Z",
		};
		const score = __test__.scoreCandidate(
			"oldco guy",
			conversation,
			[expansion],
			bioEntities,
			snapshots,
		);

		expect(score.confidence).toBe(100);
		expect(score.reasons).toEqual(
			expect.arrayContaining([
				"resolved profile",
				"bio entity matches query",
				"profile history matches query",
				"cofounder language",
				"message text matches query",
				"expanded URL matches query",
			]),
		);
		expect(score.profileEvidence).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "bio_handle", value: "@oldco" }),
				expect.objectContaining({
					kind: "bio_domain",
					value: "oldco.example",
				}),
				expect.objectContaining({ kind: "bio_company", value: "OldCo" }),
				expect.objectContaining({ kind: "profile_history" }),
				expect.objectContaining({
					kind: "expanded_url",
					value: "https://oldco.example/jobs",
				}),
			]),
		);

		__test__.attachExpansionsToMatches(conversation, [expansion]);
		const attachedMatch = conversation.matches?.[0];
		expect(attachedMatch).toBeDefined();
		expect(
			(attachedMatch as { urlExpansions?: unknown[] }).urlExpansions,
		).toHaveLength(1);
		const merged = new Map();
		__test__.mergeConversations(merged, [conversation, conversation]);
		expect([...merged.keys()]).toEqual(["dm_helper"]);
		expect(
			__test__.scoreCandidate(
				"nobody",
				{ ...conversation, participant: { ...profile, handle: "id42" } },
				[],
			).reasons,
		).toEqual(["local DM match"]);
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

	it("builds whois lookups lazily as Effect programs", async () => {
		const { runEffectPromise } = await import("./effect-runtime");
		const { runWhoisEffect } = await import("./whois");
		const db = getNativeDb();

		const effect = runWhoisEffect("lazyprobe", {
			dms: false,
			tweets: true,
			resolveProfiles: false,
			expandUrls: false,
			limit: 2,
		});
		db.prepare(
			`
      insert into tweets (
        id, account_id, author_profile_id, kind, text, created_at,
        is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
        entities_json, media_json, quoted_tweet_id
      ) values ('tweet_lazyprobe', 'acct_primary', 'profile_user_42', 'home', 'lazyprobe public tweet', '2026-05-01T00:03:00.000Z', 0, null, 0, 0, 0, 0, '{}', '[]', null)
      `,
		).run();
		db.prepare("insert into tweets_fts (tweet_id, text) values (?, ?)").run(
			"tweet_lazyprobe",
			"lazyprobe public tweet",
		);

		const result = await runEffectPromise(effect);

		expect(result.relatedTweets).toEqual([
			expect.objectContaining({ id: "tweet_lazyprobe" }),
		]);
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
