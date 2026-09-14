import { describe, expect, it } from "vitest";
import {
	actionRequestSchema,
	actionResponseSchemaFor,
	blockListResponseSchema,
	inboxResponseSchema,
	linkInsightResponseSchema,
	linkPreviewResponseSchema,
	liveDataSourcesResponseSchema,
	networkMapResponseSchema,
	profileHydrationResponseSchema,
	queryResponseSchema,
	tweetMediaSchema,
	tweetConversationResponseSchema,
	webSyncJobSchema,
	xurlRateLimitSnapshotSchema,
} from "./api-contracts";

describe("API contracts", () => {
	it("preserves nested defaults, media normalization, and stripping in compiled feeds", () => {
		const input = {
			resource: "home",
			ignored: true,
			items: [
				{
					id: "tweet_demo",
					text: "Demo",
					ignored: true,
					media: [
						{
							url: "https://example.com/demo.mp4",
							type: "animated_gif",
							ignored: true,
						},
					],
					quotedTweet: {
						id: "quoted",
						text: "Quote",
						media: [{ url: "https://example.com/demo.jpg", type: "photo" }],
					},
				},
			],
		};
		const result = queryResponseSchema.parse(input);
		expect(result).toEqual(queryResponseSchema.clone().parse(input));
		expect(result).not.toHaveProperty("ignored");
		expect(result.items[0]).not.toHaveProperty("ignored");
		expect(result.items[0]).toMatchObject({
			accountId: "acct_primary",
			author: { handle: "unknown" },
			media: [{ url: "https://example.com/demo.mp4", type: "gif" }],
			quotedTweet: { media: [{ type: "image" }] },
		});
		expect(input.items[0].media[0].type).toBe("animated_gif");
	});

	it.each([
		{
			resource: "home",
			items: [
				{
					id: "tweet_demo",
					text: "Demo",
					media: [{ url: "https://example.com/demo", type: "invalid" }],
				},
			],
		},
		{
			resource: "dms",
			items: [],
			selectedConversation: {
				conversation: { id: "dm_demo", accountId: "acct_demo", title: "Demo" },
				messages: [{ id: "message_demo", text: 42 }],
			},
		},
		{ resource: "invalid", items: [] },
	])(
		"retains runtime issue details for malformed responses: $resource",
		(input) => {
			const result = queryResponseSchema.safeParse(input);
			const runtime = queryResponseSchema.clone().safeParse(input);
			expect(result.success).toBe(false);
			expect(runtime.success).toBe(false);
			if (result.success || runtime.success)
				throw new Error("expected invalid response");
			expect(result.error.issues).toEqual(runtime.error.issues);
			expect(() => queryResponseSchema.parse(input)).toThrow(
				runtime.error.message,
			);
		},
	);

	it("accepts search timeline responses", () => {
		const result = queryResponseSchema.safeParse({
			resource: "search",
			items: [],
		});

		expect(result.success).toBe(true);
	});

	it("normalizes legacy media types at the API boundary", () => {
		expect(
			tweetMediaSchema.parse({
				url: "https://example.com/photo.jpg",
				type: "photo",
			}),
		).toMatchObject({ type: "image" });
		expect(
			tweetMediaSchema.parse({
				url: "https://example.com/animation.mp4",
				type: "animated_gif",
			}),
		).toMatchObject({ type: "gif" });
	});

	it("rejects malformed nested query items", () => {
		const result = queryResponseSchema.safeParse({
			resource: "dms",
			items: [{ id: "conversation-1" }],
		});

		expect(result.success).toBe(false);
	});

	it("narrows query responses by their resource discriminator", () => {
		const result = queryResponseSchema.parse({
			resource: "dms",
			items: [],
			selectedConversation: null,
		});

		if (result.resource !== "dms") throw new Error("expected a DM response");
		expect(result.selectedConversation).toBeNull();
		expect(result.items).toEqual([]);
	});

	it("validates empty collection responses and rejects malformed variants", () => {
		expect(blockListResponseSchema.parse({ items: [], matches: [] })).toEqual({
			items: [],
			matches: [],
		});
		expect(
			inboxResponseSchema.parse({
				items: [],
				stats: { total: 0, openai: 0, heuristic: 0 },
			}),
		).toMatchObject({ stats: { total: 0 } });
		expect(
			linkInsightResponseSchema.parse({
				kind: "links",
				range: "week",
				sort: "rank",
				source: "all",
				since: null,
				until: null,
				items: [],
				stats: { occurrences: 0, groups: 0 },
			}),
		).toMatchObject({ kind: "links", items: [] });
		expect(
			inboxResponseSchema.safeParse({ items: [], stats: { total: "0" } })
				.success,
		).toBe(false);
	});

	it("validates operational status wire responses", () => {
		expect(
			liveDataSourcesResponseSchema.parse({
				generatedAt: "2026-06-18T00:00:00.000Z",
				sources: [],
				capabilities: [],
			}),
		).toMatchObject({ sources: [] });
		expect(
			networkMapResponseSchema.parse({
				type: "FeatureCollection",
				features: [],
				meta: {
					accountId: "acct_primary",
					type: "all",
					totalProfiles: 0,
					profilesWithLocation: 0,
					meaningfulProfiles: 0,
					locatedProfiles: 0,
					missingGeocodes: 0,
					geocodedThisRun: 0,
					suppressedGeocodes: 0,
					opencageConfigured: false,
					mapboxTokenConfigured: false,
				},
				config: { mapboxToken: null },
			}),
		).toMatchObject({ features: [] });
		expect(
			xurlRateLimitSnapshotSchema.parse({
				generatedAt: "2026-06-18T00:00:00.000Z",
				windowMs: 900_000,
				docsUrl: "https://docs.x.com",
				summary: {
					totalCallsLastWindow: 0,
					rateLimitedLastWindow: 0,
					errorLastWindow: 0,
					criticalEndpoints: 0,
					lastEventAt: null,
				},
				endpoints: [],
				events: [],
				throttle: {
					conversationDelayMs: 3_100,
					rateLimitRetryMs: 60_000,
					rateLimitMaxRetries: 1,
				},
			}),
		).toMatchObject({ events: [] });
	});

	it("validates profile, preview, and conversation response envelopes", () => {
		const profile = {
			id: "profile_alice",
			handle: "alice",
			displayName: "Alice",
			bio: "",
			followersCount: 1,
			avatarHue: 20,
			createdAt: "2026-01-01T00:00:00.000Z",
		};
		expect(
			profileHydrationResponseSchema.parse({
				ok: true,
				results: [{ handle: "alice", status: "hit", source: "bird", profile }],
				hydratedProfiles: 1,
			}),
		).toMatchObject({ hydratedProfiles: 1 });
		expect(
			linkPreviewResponseSchema.parse({
				ok: true,
				preview: {
					url: "https://example.com",
					title: null,
					description: null,
					imageUrl: null,
					siteName: null,
				},
			}),
		).toMatchObject({ ok: true });
		expect(
			tweetConversationResponseSchema.parse({
				ok: true,
				anchorId: "tweet_1",
				items: [{ id: "tweet_1", text: "hello", author: profile }],
			}),
		).toMatchObject({ anchorId: "tweet_1" });
	});

	it("derives action requests and action-specific results from schemas", () => {
		const request = actionRequestSchema.parse({ kind: "replyTweet" });
		expect(request).toEqual({
			kind: "replyTweet",
			tweetId: "",
			text: "",
		});
		expect(actionResponseSchemaFor("scoreInbox").parse({ ok: true })).toEqual({
			ok: true,
			scored: 0,
			items: [],
		});
		expect(
			actionResponseSchemaFor("replyTweet").safeParse({
				ok: true,
				replyId: 42,
			}).success,
		).toBe(false);
	});

	it("validates completed sync job results", () => {
		const result = webSyncJobSchema.safeParse({
			id: "sync_timeline_1",
			kind: "timeline",
			status: "succeeded",
			startedAt: "2026-06-15T12:00:00.000Z",
			finishedAt: "2026-06-15T12:00:01.000Z",
			summary: "Synced 1 item",
			inProgress: false,
			result: {
				ok: true,
				kind: "timeline",
				startedAt: "2026-06-15T12:00:00.000Z",
				finishedAt: "2026-06-15T12:00:01.000Z",
				summary: "Synced 1 item",
				steps: [
					{
						kind: "timeline",
						label: "Home timeline",
						count: 1,
					},
				],
			},
		});

		expect(result.success).toBe(true);
	});
});
