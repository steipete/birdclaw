// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const listTimelineItemsMock = vi.hoisted(() => vi.fn());

vi.mock("./queries", () => ({
	listTimelineItems: (...args: unknown[]) => listTimelineItemsMock(...args),
}));

describe("mention export", () => {
	it("builds mention export items with plain-text and markdown fields", async () => {
		listTimelineItemsMock.mockReturnValueOnce([
			{
				id: "tweet_1",
				accountId: "acct_primary",
				accountHandle: "@steipete",
				kind: "mentions",
				text: "Hi @sam https://t.co/demo",
				createdAt: "2026-03-09T00:00:00.000Z",
				isReplied: false,
				likeCount: 4,
				mediaCount: 0,
				bookmarked: false,
				liked: false,
				author: {
					id: "profile_1",
					handle: "sam",
					displayName: "Sam Altman",
					bio: "",
					followersCount: 1,
					avatarHue: 1,
					createdAt: "2026-03-09T00:00:00.000Z",
				},
				entities: {
					mentions: [
						{
							username: "sam",
							start: 3,
							end: 7,
							profile: {
								id: "profile_1",
								handle: "sam",
								displayName: "Sam Altman",
								bio: "",
								followersCount: 1,
								avatarHue: 1,
								createdAt: "2026-03-09T00:00:00.000Z",
							},
						},
					],
					urls: [
						{
							url: "https://t.co/demo",
							expandedUrl: "https://example.com/demo",
							displayUrl: "example.com/demo",
							start: 8,
							end: 25,
						},
					],
				},
				media: [],
				replyToTweet: null,
				quotedTweet: {
					id: "tweet_q",
					text: "quoted",
					createdAt: "2026-03-09T00:00:00.000Z",
					author: {
						id: "profile_q",
						handle: "ava",
						displayName: "Ava",
						bio: "",
						followersCount: 1,
						avatarHue: 1,
						createdAt: "2026-03-09T00:00:00.000Z",
					},
					entities: {},
					media: [],
				},
			},
		]);
		const { exportMentionItems } = await import("./mentions-export");

		const result = exportMentionItems({
			search: "sam",
			replyFilter: "unreplied",
			limit: 5,
		});

		expect(listTimelineItemsMock).toHaveBeenCalledWith({
			resource: "mentions",
			account: undefined,
			search: "sam",
			replyFilter: "unreplied",
			limit: 5,
		});
		expect(result).toEqual([
			expect.objectContaining({
				id: "tweet_1",
				url: "https://x.com/sam/status/tweet_1",
				plainText: "Hi @sam https://example.com/demo",
				markdown:
					"Hi [@sam](https://x.com/sam) [example\\.com/demo](https://example.com/demo)",
				quotedTweetId: "tweet_q",
				replyToTweetId: null,
			}),
		]);
	});

	it("serializes local mention items into xurl-compatible payloads", async () => {
		listTimelineItemsMock.mockReturnValueOnce([
			{
				id: "tweet_live_1",
				accountId: "acct_primary",
				accountHandle: "@steipete",
				kind: "mentions",
				text: "Hello @sam https://t.co/demo",
				createdAt: "2026-03-09T00:00:00.000Z",
				isReplied: true,
				likeCount: 7,
				mediaCount: 0,
				bookmarked: true,
				liked: false,
				author: {
					id: "profile_user_42",
					handle: "sam",
					displayName: "Sam Altman",
					bio: "",
					followersCount: 1,
					avatarHue: 1,
					createdAt: "2026-03-09T00:00:00.000Z",
				},
				entities: {
					mentions: [
						{
							username: "sam",
							id: "profile_user_42",
							start: 6,
							end: 10,
						},
					],
					urls: [
						{
							url: "https://t.co/demo",
							expandedUrl: "https://example.com/demo",
							displayUrl: "example.com/demo",
							start: 11,
							end: 28,
						},
					],
				},
				media: [],
				replyToTweet: null,
				quotedTweet: null,
			},
		]);
		const { serializeMentionItemsAsXurlCompatible } = await import(
			"./mentions-export"
		);
		const { listTimelineItems } = await import("./queries");

		const payload = serializeMentionItemsAsXurlCompatible(
			listTimelineItems({
				resource: "mentions",
				limit: 1,
			}),
		);

		expect(payload).toEqual({
			data: [
				{
					id: "tweet_live_1",
					author_id: "42",
					text: "Hello @sam https://t.co/demo",
					created_at: "2026-03-09T00:00:00.000Z",
					conversation_id: "tweet_live_1",
					entities: {
						mentions: [
							{
								start: 6,
								end: 10,
								username: "sam",
								id: "42",
							},
						],
						urls: [
							{
								start: 11,
								end: 28,
								url: "https://t.co/demo",
								expanded_url: "https://example.com/demo",
								display_url: "example.com/demo",
							},
						],
					},
					public_metrics: {
						retweet_count: 0,
						reply_count: 1,
						like_count: 7,
						quote_count: 0,
						bookmark_count: 1,
						impression_count: 0,
					},
					edit_history_tweet_ids: ["tweet_live_1"],
				},
			],
			includes: {
				users: [
					{
						id: "42",
						name: "Sam Altman",
						username: "sam",
					},
				],
			},
			meta: {
				result_count: 1,
				newest_id: "tweet_live_1",
				oldest_id: "tweet_live_1",
			},
		});
	});
});
