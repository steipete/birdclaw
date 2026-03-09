// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveProfileMock = vi.fn();
const listUserTweetsMock = vi.fn();

vi.mock("./moderation-target", () => ({
	resolveProfile: (...args: unknown[]) => resolveProfileMock(...args),
}));

vi.mock("./xurl", () => ({
	listUserTweets: (...args: unknown[]) => listUserTweetsMock(...args),
}));

describe("profile reply inspection", () => {
	beforeEach(() => {
		vi.resetModules();
		resolveProfileMock.mockReset();
		listUserTweetsMock.mockReset();
	});

	it("filters recent authored tweets down to replies", async () => {
		resolveProfileMock.mockResolvedValue({
			profile: {
				id: "profile_user_42",
				handle: "jpctan",
				displayName: "Jason Tan",
				bio: "",
				followersCount: 268,
				avatarHue: 18,
				createdAt: "2015-05-20T09:27:37.000Z",
			},
			externalUserId: "42",
		});
		listUserTweetsMock.mockResolvedValue({
			items: [
				{
					id: "tweet_1",
					text: "@sam one",
					created_at: "2026-03-09T00:00:00.000Z",
					conversation_id: "conv_1",
					referenced_tweets: [{ type: "replied_to", id: "root_1" }],
					public_metrics: { impression_count: 3 },
				},
				{
					id: "tweet_2",
					text: "standalone post",
					created_at: "2026-03-09T00:01:00.000Z",
				},
				{
					id: "tweet_3",
					text: "@ava two",
					created_at: "2026-03-09T00:02:00.000Z",
					referenced_tweets: [{ type: "replied_to", id: "root_2" }],
					public_metrics: {
						like_count: 1,
						reply_count: 2,
						retweet_count: 3,
						quote_count: 4,
						bookmark_count: 5,
						impression_count: 6,
					},
				},
			],
			nextToken: "next",
		});
		const { inspectProfileReplies } = await import("./profile-replies");

		await expect(
			inspectProfileReplies("@jpctan", { limit: 5 }),
		).resolves.toEqual({
			profile: expect.objectContaining({ handle: "jpctan" }),
			externalUserId: "42",
			items: [
				{
					id: "tweet_1",
					text: "@sam one",
					createdAt: "2026-03-09T00:00:00.000Z",
					conversationId: "conv_1",
					replyToTweetId: "root_1",
					likeCount: 0,
					replyCount: 0,
					retweetCount: 0,
					quoteCount: 0,
					bookmarkCount: 0,
					impressionCount: 3,
				},
				{
					id: "tweet_3",
					text: "@ava two",
					createdAt: "2026-03-09T00:02:00.000Z",
					replyToTweetId: "root_2",
					likeCount: 1,
					replyCount: 2,
					retweetCount: 3,
					quoteCount: 4,
					bookmarkCount: 5,
					impressionCount: 6,
				},
			],
			meta: {
				scannedCount: 3,
				returnedCount: 2,
				nextToken: "next",
			},
		});
		expect(listUserTweetsMock).toHaveBeenCalledWith("42", {
			maxResults: 20,
			excludeRetweets: true,
		});
	});

	it("fails fast when a profile has no external id", async () => {
		resolveProfileMock.mockResolvedValue({
			profile: {
				id: "profile_group_1",
				handle: "group",
				displayName: "Group",
				bio: "",
				followersCount: 0,
				avatarHue: 0,
				createdAt: "2026-03-09T00:00:00.000Z",
			},
			externalUserId: null,
		});
		const { inspectProfileReplies } = await import("./profile-replies");

		await expect(inspectProfileReplies("group")).rejects.toThrow(
			"Profile has no external X user id: group",
		);
		expect(listUserTweetsMock).not.toHaveBeenCalled();
	});

	it("caps the scan window and trims returned replies to the requested limit", async () => {
		resolveProfileMock.mockResolvedValue({
			profile: {
				id: "profile_user_99",
				handle: "patternbot",
				displayName: "Pattern Bot",
				bio: "",
				followersCount: 12,
				avatarHue: 120,
				createdAt: "2026-03-09T00:00:00.000Z",
			},
			externalUserId: "99",
		});
		listUserTweetsMock.mockResolvedValue({
			items: Array.from({ length: 4 }, (_, index) => ({
				id: `tweet_${index + 1}`,
				text: `@user_${index + 1} canned praise`,
				created_at: `2026-03-09T00:0${index}:00.000Z`,
				referenced_tweets: [{ type: "replied_to", id: `root_${index + 1}` }],
			})),
			nextToken: null,
		});
		const { inspectProfileReplies } = await import("./profile-replies");

		const result = await inspectProfileReplies("@patternbot", { limit: 2 });

		expect(listUserTweetsMock).toHaveBeenCalledWith("99", {
			maxResults: 20,
			excludeRetweets: true,
		});
		expect(result.items).toHaveLength(2);
		expect(result.meta).toEqual({
			scannedCount: 4,
			returnedCount: 2,
			nextToken: null,
		});
	});
});
