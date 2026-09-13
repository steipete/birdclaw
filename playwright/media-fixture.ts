import type { TimelineItem } from "../src/lib/types";

// Synthetic archive content shared by the playback and visual regression checks.
export const inlineMediaTweet: TimelineItem = {
	id: "2000000000000000900",
	accountId: "acct_primary",
	accountHandle: "@steipete",
	kind: "home",
	text: "A small experiment in motion.\n\nWatch the clip, then explore the field notes and tools behind it.",
	createdAt: "2026-09-13T17:45:00.000Z",
	isReplied: false,
	likeCount: 42,
	mediaCount: 1,
	bookmarked: false,
	liked: false,
	author: {
		id: "profile_media_fixture",
		handle: "motionnotes",
		displayName: "Motion Notes",
		bio: "Synthetic preview fixture",
		followersCount: 100,
		avatarHue: 22,
		createdAt: "2026-01-01T00:00:00.000Z",
	},
	media: [
		{
			type: "video",
			url: "/proof-poster.png",
			thumbnailUrl: "/proof-poster.png",
			width: 960,
			height: 540,
			altText: "A small experiment in motion",
			variants: [
				{ url: "/unsupported.m3u8", contentType: "application/x-mpegURL" },
				{ url: "/unavailable.mp4", contentType: "video/mp4", bitRate: 2000 },
				{ url: "/proof-video.webm", contentType: "video/webm", bitRate: 1000 },
			],
		},
	],
	entities: {
		urls: [
			{
				url: "https://example.com/field-notes",
				expandedUrl: "https://example.com/field-notes",
				displayUrl: "example.com/field-notes",
				title: "Small movements, thoughtful interfaces",
				description:
					"Field notes on rhythm, feedback, and making software feel a little more human.",
				imageUrl: "https://example.com/field-notes.png",
				siteName: "Field Notes",
				start: 0,
				end: 0,
			},
			{
				url: "https://tools.example.org",
				expandedUrl: "https://tools.example.org",
				displayUrl: "tools.example.org",
				title: "tools.example.org",
				description: "tools.example.org",
				start: 0,
				end: 0,
			},
			{
				url: "https://journal.example.net/stories/a-study-in-motion",
				expandedUrl: "https://journal.example.net/stories/a-study-in-motion",
				displayUrl: "journal.example.net/stories/a-study-in-motion",
				title: "journal.example.net/stories/a-study-in-motion",
				description: "journal.example.net/stories/a-study-in-motion",
				start: 0,
				end: 0,
			},
		],
	},
};
