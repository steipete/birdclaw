import { describe, expect, it } from "vitest";
import { sanitizePublicEmbeddedTweet } from "./public-tweet";

describe("public tweet sanitization", () => {
	it("strips private state and enriched mention profiles", () => {
		const tweet = sanitizePublicEmbeddedTweet({
			id: "tweet_1",
			text: "@alice hello",
			createdAt: "2026-06-13T12:00:00.000Z",
			isReplied: true,
			bookmarked: true,
			liked: true,
			author: {
				id: "profile_author",
				handle: "author",
				displayName: "Author",
				bio: "",
				followersCount: 1,
				avatarHue: 1,
				createdAt: "2026-06-13T12:00:00.000Z",
			},
			entities: {
				mentions: [
					{
						username: "alice",
						start: 0,
						end: 6,
						profile: {
							id: "profile_private",
							handle: "alice",
							displayName: "Alice",
							bio: "private enrichment",
							followersCount: 42,
							avatarHue: 2,
							createdAt: "2026-06-13T12:00:00.000Z",
						},
					},
				],
			},
			media: [],
		});

		expect(tweet).toMatchObject({
			isReplied: false,
			bookmarked: false,
			liked: false,
			entities: {
				mentions: [{ username: "alice", start: 0, end: 6 }],
			},
		});
		expect(tweet.entities.mentions?.[0]).not.toHaveProperty("profile");
	});
});
