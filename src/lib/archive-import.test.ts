// @vitest-environment node
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	insertTestAccount,
	insertTestDmConversation,
	insertTestDmMessage,
	insertTestProfile,
	insertTestTweet,
	useTestHome,
} from "../test/test-home";
import { __test__, importArchive, importArchiveEffect } from "./archive-import";
import { getBirdclawPaths } from "./config";
import { getNativeDb } from "./db";
import { listFollowEvents, listUnfollowedSince } from "./follow-graph";
import {
	getConversationThread,
	getQueryEnvelope,
	listDmConversations,
	listTimelineItems,
} from "./queries";

const testHome = useTestHome({ prefix: "birdclaw-home-" });

function makeArchive({
	following = [],
	likeText = "liked archive item",
}: { following?: string[]; likeText?: string } = {}) {
	const root = testHome().makeTempDir("birdclaw-archive-");
	const archiveDir = path.join(root, "sample", "data");
	mkdirSync(archiveDir, { recursive: true });

	writeFileSync(
		path.join(archiveDir, "account.js"),
		`window.YTD.account.part0 = [
  { "account": { "accountId": "25401953", "username": "steipete", "accountDisplayName": "Peter Steinberger", "createdAt": "2009-03-19T22:54:05.000Z" } }
]`,
	);
	writeFileSync(
		path.join(archiveDir, "profile.js"),
		`window.YTD.profile.part0 = [
  { "profile": { "description": { "bio": "Local-first builder" } } }
]`,
	);
	writeFileSync(
		path.join(archiveDir, "tweets.js"),
		`window.YTD.tweets.part0 = [
  {
    "tweet": {
      "id_str": "100",
      "created_at": "Tue Jun 03 19:32:20 +0000 2025",
      "full_text": "@sam archive-first still wins https://t.co/local #birdclaw",
      "favorite_count": "12",
      "in_reply_to_status_id_str": "99",
      "quoted_status_id_str": "101",
      "in_reply_to_user_id_str": "42",
      "in_reply_to_screen_name": "sam",
      "entities": {
        "user_mentions": [
          { "id_str": "42", "screen_name": "sam", "name": "Sam Altman", "indices": [0, 4] }
        ],
        "urls": [
          {
            "url": "https://t.co/local",
            "expanded_url": "https://birdclaw.dev/archive",
            "display_url": "birdclaw.dev/archive",
            "indices": [30, 48]
          }
        ],
        "hashtags": [
          { "text": "birdclaw", "indices": [49, 58] }
        ],
        "media": [
          {
            "media_url_https": "https://img.example.com/archive.png",
            "url": "https://t.co/media",
            "type": "photo",
            "ext_alt_text": "Archive chart"
          }
        ]
      },
      "extended_entities": {
        "media": [
          {
            "media_url_https": "https://img.example.com/archive.png",
            "url": "https://t.co/media",
            "type": "photo",
            "ext_alt_text": "Archive chart"
          }
        ]
      }
    }
  }
]`,
	);
	writeFileSync(
		path.join(archiveDir, "note-tweet.js"),
		`window.YTD.note_tweet.part0 = [
  {
    "noteTweet": {
      "noteTweetId": "101",
      "createdAt": "2025-06-04T10:00:00.000Z",
      "core": { "text": "Longer archive note" }
    }
  }
]`,
	);
	writeFileSync(
		path.join(archiveDir, "like.js"),
		`window.YTD.like.part0 = [
  { "like": { "tweetId": "5", "fullText": ${JSON.stringify(likeText)}, "likedAt": "2025-06-03T20:00:00.000Z" } }
]`,
	);
	writeFileSync(
		path.join(archiveDir, "bookmark.js"),
		`window.YTD.bookmark.part0 = [
  { "bookmark": { "tweetId": "6", "fullText": "saved archive item", "bookmarkedAt": "2025-06-03T21:00:00.000Z" } }
]`,
	);
	writeFileSync(
		path.join(archiveDir, "direct-messages.js"),
		`window.YTD.direct_messages.part0 = [
  {
    "dmConversation": {
      "conversationId": "dm-1",
      "messages": [
        {
          "messageCreate": {
            "id": "m1",
            "senderId": "42",
            "recipientId": "25401953",
            "createdAt": "2025-06-03T20:00:00.000Z",
            "text": "Need a local archive tool",
            "mediaUrls": []
          }
        },
        {
          "messageCreate": {
            "id": "m2",
            "senderId": "25401953",
            "recipientId": "42",
            "createdAt": "2025-06-03T20:05:00.000Z",
            "text": "Building one now",
            "mediaUrls": []
          }
        }
      ]
    }
  }
]`,
	);
	if (following.length > 0) {
		writeFileSync(
			path.join(archiveDir, "following.js"),
			`window.YTD.following.part0 = ${JSON.stringify(
				following.map((id) => ({
					following: {
						accountId: id,
						userLink: `https://twitter.com/intent/user?user_id=${id}`,
					},
				})),
			)}`,
		);
	}

	const archivePath = path.join(root, "archive.zip");
	execFileSync("zip", ["-qr", archivePath, "sample"], { cwd: root });
	return archivePath;
}

function makeArchiveWithoutAccount() {
	const root = testHome().makeTempDir("birdclaw-archive-empty-");
	const archiveDir = path.join(root, "sample", "data");
	mkdirSync(archiveDir, { recursive: true });
	writeFileSync(
		path.join(archiveDir, "tweets.js"),
		'window.YTD.tweets.part0 = [{ "tweet": { "id_str": "1", "created_at": "Tue Jun 03 19:32:20 +0000 2025", "full_text": "hello" } }]',
	);
	const archivePath = path.join(root, "archive.zip");
	execFileSync("zip", ["-qr", archivePath, "sample"], { cwd: root });
	return archivePath;
}

function makeRootDataArchive() {
	const root = testHome().makeTempDir("birdclaw-archive-root-");
	const archiveDir = path.join(root, "data");
	mkdirSync(archiveDir, { recursive: true });
	mkdirSync(path.join(archiveDir, "tweets_media"), { recursive: true });

	writeFileSync(
		path.join(archiveDir, "account.js"),
		'window.YTD.account.part0 = [{ "account": { "accountId": "25401953", "username": "steipete" } }]',
	);
	writeFileSync(
		path.join(archiveDir, "tweets.js"),
		'window.YTD.tweets.part0 = [{ "tweet": { "id_str": "root-1", "created_at": "Tue Jun 03 19:32:20 +0000 2025", "full_text": "root level archive search term" } }]',
	);
	writeFileSync(
		path.join(archiveDir, "direct-messages.js"),
		`window.YTD.direct_messages.part0 = [
  {
    "dmConversation": {
      "conversationId": "root-dm",
      "messages": [
        {
          "messageCreate": {
            "id": "root-m1",
            "senderId": "42",
            "recipientId": "25401953",
            "createdAt": "2025-06-03T20:00:00.000Z",
            "text": "root dm search term"
          }
        }
      ]
    }
  }
]`,
	);
	writeFileSync(
		path.join(archiveDir, "tweets_media", "rootmedia-archive.jpg"),
		"root-media",
	);
	const archivePath = path.join(root, "archive.zip");
	execFileSync("zip", ["-qr", archivePath, "data"], { cwd: root });
	return archivePath;
}

function makeTweetRetentionArchive({
	includeEditable = true,
	includeVanishing = true,
	deleteEditable = false,
	deletedRevisionId = "edit-2",
}: {
	includeEditable?: boolean;
	includeVanishing?: boolean;
	deleteEditable?: boolean;
	deletedRevisionId?: "edit-1" | "edit-2";
} = {}) {
	const root = testHome().makeTempDir("birdclaw-archive-retention-");
	const archiveDir = path.join(root, "sample", "data");
	mkdirSync(archiveDir, { recursive: true });
	writeFileSync(
		path.join(archiveDir, "account.js"),
		'window.YTD.account.part0 = [{ "account": { "accountId": "25401953", "username": "steipete" } }]',
	);
	const tweets = [
		...(includeEditable
			? [
					{
						tweet: {
							id_str: "edit-2",
							created_at: "Tue Jun 03 19:32:20 +0000 2025",
							full_text: "edited tweet with retained media",
							quoted_status_id_str: "quote-1",
							edit_info: {
								edit: {
									initialTweetId: "edit-1",
									editControlInitial: {
										editTweetIds: ["edit-1", "edit-2"],
									},
								},
							},
							entities: {
								media: [
									{
										id_str: "media-1",
										media_url_https: "https://img.example.com/deleted.jpg",
										type: "photo",
									},
								],
							},
							extended_entities: {
								media: [
									{
										id_str: "media-1",
										media_url_https: "https://img.example.com/deleted.jpg",
										type: "photo",
									},
								],
							},
						},
					},
				]
			: []),
		...(includeVanishing
			? [
					{
						tweet: {
							id_str: "vanishing",
							created_at: "Wed Jun 04 19:32:20 +0000 2025",
							full_text: "absence from a later snapshot is not deletion",
						},
					},
				]
			: []),
	];
	writeFileSync(
		path.join(archiveDir, "tweets.js"),
		`window.YTD.tweets.part0 = ${JSON.stringify(tweets)}`,
	);
	if (deleteEditable) {
		writeFileSync(
			path.join(archiveDir, "deleted-tweets.js"),
			`window.YTD.deleted_tweets.part0 = ${JSON.stringify([
				{
					tweet: {
						id_str: deletedRevisionId,
						created_at: "Tue Jun 03 19:32:20 +0000 2025",
						full_text:
							deletedRevisionId === "edit-1"
								? "original body"
								: "edited tweet with retained media",
					},
				},
			])}`,
		);
		writeFileSync(
			path.join(archiveDir, "deleted-tweet-headers.js"),
			`window.YTD.deleted_tweet_headers.part0 = ${JSON.stringify([
				{
					tweet: {
						tweetId: deletedRevisionId,
						userId: "25401953",
						createdAt: "2025-06-03T19:32:20.000Z",
						deletedAt: "2026-07-18T12:00:00.000Z",
					},
				},
				{
					tweet: {
						tweetId: "header-only",
						userId: "25401953",
						createdAt: "2025-06-02T19:32:20.000Z",
						deletedAt: "2026-07-17T12:00:00.000Z",
					},
				},
			])}`,
		);
	}
	const archivePath = path.join(root, "archive.zip");
	execFileSync("zip", ["-qr", archivePath, "sample"], { cwd: root });
	return archivePath;
}

function makeLateDeletedTweetBodyArchive() {
	const root = testHome().makeTempDir("birdclaw-archive-late-tombstone-body-");
	const archiveDir = path.join(root, "sample", "data");
	mkdirSync(archiveDir, { recursive: true });
	writeFileSync(
		path.join(archiveDir, "account.js"),
		'window.YTD.account.part0 = [{ "account": { "accountId": "25401953", "username": "steipete" } }]',
	);
	writeFileSync(
		path.join(archiveDir, "tweets.js"),
		`window.YTD.tweets.part0 = ${JSON.stringify([
			{
				tweet: {
					id_str: "header-only",
					created_at: "Mon Jun 02 19:32:20 +0000 2025",
					full_text: "late body for an already deleted tweet",
					quoted_status_id_str: "late-quote",
					entities: {
						media: [
							{
								media_url_https: "https://img.example.com/late.jpg",
								type: "photo",
							},
						],
					},
					extended_entities: {
						media: [
							{
								media_url_https: "https://img.example.com/late.jpg",
								type: "photo",
							},
						],
					},
				},
			},
			{
				tweet: {
					id_str: "legacy-unknown-source",
					created_at: "Sun Jun 01 19:32:20 +0000 2025",
					full_text: "late body for a legacy source-less tombstone",
					entities: {
						media: [
							{
								media_url_https: "https://img.example.com/legacy.jpg",
								type: "photo",
							},
						],
					},
					extended_entities: {
						media: [
							{
								media_url_https: "https://img.example.com/legacy.jpg",
								type: "photo",
							},
						],
					},
				},
			},
		])}`,
	);
	const archivePath = path.join(root, "archive.zip");
	execFileSync("zip", ["-qr", archivePath, "sample"], { cwd: root });
	return archivePath;
}

function makeWeirdArchive({ followers = [] }: { followers?: string[] } = {}) {
	const root = testHome().makeTempDir("birdclaw-archive-weird-");
	const archiveDir = path.join(root, "sample", "data");
	mkdirSync(archiveDir, { recursive: true });

	writeFileSync(
		path.join(archiveDir, "account.js"),
		'window.YTD.account.part0 = [{ "account": { "accountId": "25401953", "username": "steipete" } }]',
	);
	writeFileSync(
		path.join(archiveDir, "community-tweet.js"),
		'window.YTD.community_tweet.part0 = [{ "bad": true }]',
	);
	writeFileSync(
		path.join(archiveDir, "note-tweet.js"),
		'window.YTD.note_tweet.part0 = [{ "noteTweet": { "createdAt": "not-a-date", "core": { "text": "fallback note" } } }]',
	);
	writeFileSync(
		path.join(archiveDir, "likes-part1.js"),
		'window.YTD.likes.part1 = [{ "like": { "tweetId": "5", "likedAt": "2025-06-03T20:00:00.000Z" } }]',
	);
	writeFileSync(
		path.join(archiveDir, "direct-messages-group.js"),
		`window.YTD.direct_messages_group.part0 = [
  {
    "dmConversation": {
      "conversationId": "group-empty",
      "name": "Crew",
      "messages": [
        {
          "participantsJoin": {
            "initiatingUserId": "42",
            "userIds": ["43"],
            "createdAt": "2025-06-03T20:00:00.000Z"
          }
        }
      ]
    }
  },
  {
    "dmConversation": {
      "conversationId": "group-live",
      "name": "Core Team",
      "messages": [
        {
          "joinConversation": {
            "initiatingUserId": "42",
            "participantsSnapshot": ["25401953", "42", "43"],
            "createdAt": "2025-06-03T20:00:00.000Z"
          }
        },
        {
          "messageCreate": {
            "id": "gm1",
            "senderId": "42",
            "createdAt": "2025-06-03T20:01:00.000Z",
            "text": "hello team",
            "mediaUrls": ["https://example.com/a.jpg"]
          }
        },
        {
          "participantsLeave": {
            "initiatingUserId": "43",
            "userIds": ["43"],
            "createdAt": "2025-06-03T20:02:00.000Z"
          }
        }
      ]
    }
  }
]`,
	);
	if (followers.length > 0) {
		writeFileSync(
			path.join(archiveDir, "follower.js"),
			`window.YTD.follower.part0 = ${JSON.stringify(
				followers.map((id) => ({
					follower: {
						accountId: id,
						userLink: `https://twitter.com/intent/user?user_id=${id}`,
					},
				})),
			)}`,
		);
	}

	const archivePath = path.join(root, "archive.zip");
	execFileSync("zip", ["-qr", archivePath, "sample"], { cwd: root });
	return archivePath;
}

function makeFollowArchive({
	followers = [],
	following = [],
	includeFollowers = true,
	includeFollowing = true,
}: {
	followers?: string[];
	following?: string[];
	includeFollowers?: boolean;
	includeFollowing?: boolean;
}) {
	const root = testHome().makeTempDir("birdclaw-archive-follow-");
	const archiveDir = path.join(root, "sample", "data");
	mkdirSync(archiveDir, { recursive: true });

	writeFileSync(
		path.join(archiveDir, "account.js"),
		'window.YTD.account.part0 = [{ "account": { "accountId": "25401953", "username": "steipete" } }]',
	);
	if (includeFollowers) {
		writeFileSync(
			path.join(archiveDir, "follower.js"),
			`window.YTD.follower.part0 = ${JSON.stringify(
				followers.map((id) => ({
					follower: {
						accountId: id,
						userLink: `https://twitter.com/intent/user?user_id=${id}`,
					},
				})),
			)}`,
		);
	}
	if (includeFollowing) {
		writeFileSync(
			path.join(archiveDir, "following.js"),
			`window.YTD.following.part0 = ${JSON.stringify(
				following.map((id) => ({
					following: {
						accountId: id,
						userLink: `https://twitter.com/intent/user?user_id=${id}`,
					},
				})),
			)}`,
		);
	}

	const archivePath = path.join(root, "archive.zip");
	execFileSync("zip", ["-qr", archivePath, "sample"], { cwd: root });
	return archivePath;
}

function makeFollowDmArchive(userId: string) {
	const root = testHome().makeTempDir("birdclaw-archive-follow-dm-");
	const archiveDir = path.join(root, "sample", "data");
	mkdirSync(archiveDir, { recursive: true });

	writeFileSync(
		path.join(archiveDir, "account.js"),
		'window.YTD.account.part0 = [{ "account": { "accountId": "25401953", "username": "steipete" } }]',
	);
	writeFileSync(
		path.join(archiveDir, "follower.js"),
		`window.YTD.follower.part0 = ${JSON.stringify([
			{
				follower: {
					accountId: userId,
					userLink: `https://twitter.com/intent/user?user_id=${userId}`,
				},
			},
		])}`,
	);
	writeFileSync(
		path.join(archiveDir, "direct-messages.js"),
		`window.YTD.direct_messages.part0 = ${JSON.stringify([
			{
				dmConversation: {
					conversationId: `dm-${userId}`,
					messages: [
						{
							messageCreate: {
								id: `m-${userId}`,
								senderId: userId,
								recipientId: "25401953",
								createdAt: "2025-06-03T20:00:00.000Z",
								text: "hello from a follower",
								mediaUrls: [],
							},
						},
					],
				},
			},
		])}`,
	);

	const archivePath = path.join(root, "archive.zip");
	execFileSync("zip", ["-qr", archivePath, "sample"], { cwd: root });
	return archivePath;
}

function makeMediaArchive() {
	const root = testHome().makeTempDir("birdclaw-archive-media-");
	const archiveDir = path.join(root, "sample", "data");
	mkdirSync(path.join(archiveDir, "tweets_media"), { recursive: true });
	mkdirSync(path.join(archiveDir, "direct_messages_media"), {
		recursive: true,
	});
	mkdirSync(path.join(archiveDir, "profile_media"), { recursive: true });

	writeFileSync(
		path.join(archiveDir, "account.js"),
		'window.YTD.account.part0 = [{ "account": { "accountId": "25401953", "username": "steipete" } }]',
	);
	writeFileSync(
		path.join(
			archiveDir,
			"tweets_media",
			"1727738789982839193-F_opG9tXYAACOd3.jpg",
		),
		"tweet-media",
	);
	writeFileSync(
		path.join(archiveDir, "direct_messages_media", "m1-demo.png"),
		"dm-media",
	);
	writeFileSync(
		path.join(archiveDir, "profile_media", "profile-banner.jpg"),
		"profile-media",
	);

	const archivePath = path.join(root, "archive.zip");
	execFileSync("zip", ["-qr", archivePath, "sample"], { cwd: root });
	return archivePath;
}

function makeMediaVariantsArchive() {
	const root = testHome().makeTempDir("birdclaw-archive-variants-");
	const archiveDir = path.join(root, "sample", "data");
	mkdirSync(archiveDir, { recursive: true });

	writeFileSync(
		path.join(archiveDir, "account.js"),
		'window.YTD.account.part0 = [{ "account": { "accountId": "25401953", "username": "steipete" } }]',
	);
	writeFileSync(
		path.join(archiveDir, "tweets.js"),
		`window.YTD.tweets.part0 = [
  {
    "tweet": {
      "id_str": "video-1",
      "created_at": "Tue Jun 03 19:32:20 +0000 2025",
      "full_text": "video",
      "extended_entities": {
        "media": [{
          "media_url_https": "https://pbs.twimg.com/video-thumb.jpg",
          "type": "video",
          "sizes": { "large": { "w": 1920, "h": 1080 } },
          "video_info": {
            "duration_millis": 46947,
            "variants": [
              { "bitrate": "832000", "content_type": "video/mp4", "url": "https://video.twimg.com/640.mp4" },
              { "content_type": "application/x-mpegURL", "url": "https://video.twimg.com/playlist.m3u8" },
              { "bitrate": "2176000", "content_type": "video/mp4", "url": "https://video.twimg.com/1280.mp4" }
            ]
          }
        }]
      }
    }
  },
  {
    "tweet": {
      "id_str": "gif-1",
      "created_at": "Tue Jun 03 19:33:20 +0000 2025",
      "full_text": "gif",
      "extended_entities": {
        "media": [{
          "media_url_https": "https://pbs.twimg.com/gif-thumb.jpg",
          "type": "animated_gif",
          "video_info": {
            "variants": [
              { "bitrate": "256000", "content_type": "video/mp4", "url": "https://video.twimg.com/gif.mp4" }
            ]
          }
        }]
      }
    }
  },
  {
    "tweet": {
      "id_str": "photo-1",
      "created_at": "Tue Jun 03 19:34:20 +0000 2025",
      "full_text": "photo https://t.co/photo",
      "entities": {
        "media": [{
          "url": "https://t.co/photo",
          "expanded_url": "https://x.com/steipete/status/photo-1/photo/1",
          "display_url": "pic.twitter.com/photo",
          "indices": [6, 24],
          "media_url_https": "https://pbs.twimg.com/photo.jpg"
        }]
      },
      "extended_entities": {
        "media": [{
          "media_url_https": "https://pbs.twimg.com/photo.jpg",
          "type": "photo",
          "sizes": { "large": { "w": 1200, "h": 800 } },
          "ext_alt_text": "Photo alt"
        }]
      }
    }
  }
]`,
	);

	const archivePath = path.join(root, "archive.zip");
	execFileSync("zip", ["-qr", archivePath, "sample"], { cwd: root });
	return archivePath;
}

describe("archive import", () => {
	it("retains explicit tweet tombstones without inferring deletion from absence", async () => {
		const initialArchive = makeTweetRetentionArchive();
		await importArchive(initialArchive, { restore: true });
		const db = getNativeDb({ seedDemoData: false });
		db.exec(`
			insert into tweets (
				id, author_profile_id, text, created_at, is_replied, reply_to_id,
				like_count, media_count, entities_json, media_json, quoted_tweet_id
			) values (
				'edit-1', 'profile_me', 'original body', '2025-06-03T19:30:20.000Z',
				0, null, 0, 0, '{}', '[]', null
			);
			insert into tweet_account_edges (
				account_id, tweet_id, kind, first_seen_at, last_seen_at, seen_count,
				source, raw_json, updated_at
			) values (
				'acct_primary', 'edit-1', 'authored', '2025-06-03T19:30:20.000Z',
				'2025-06-03T19:30:20.000Z', 1, 'archive', '{}',
				'2025-06-03T19:30:20.000Z'
			);
			insert into tweets_fts (tweet_id, text) values ('edit-1', 'original body');
		`);
		await importArchive(initialArchive);
		expect(
			db
				.prepare(
					"select superseded_at is not null as superseded, superseded_by_id from tweets where id = 'edit-1'",
				)
				.get(),
		).toEqual({ superseded: 1, superseded_by_id: "edit-2" });
		expect(
			db
				.prepare(
					"select count(*) as count from tweets_fts where tweet_id = 'edit-1'",
				)
				.get(),
		).toEqual({ count: 0 });
		db.prepare(
			`update tweets
			 set deleted_at = '2027-01-01T00:00:00.000Z',
			     deletion_source = 'local_later',
			     deletion_reason = 'later_local_event'
			 where id = 'edit-1'`,
		).run();
		insertTestTweet(db, {
			id: "header-only",
			authorProfileId: "profile_me",
			text: "header placeholder",
			createdAt: "2025-06-02T19:32:20.000Z",
		});
		db.prepare(
			"update tweets set deleted_at = '2026-07-17T12:00:00.000Z' where id = 'header-only'",
		).run();

		const deletionArchive = makeTweetRetentionArchive({
			includeEditable: false,
			includeVanishing: false,
			deleteEditable: true,
			deletedRevisionId: "edit-1",
		});
		const result = await importArchive(deletionArchive);

		expect(result.mode).toBe("merge");
		expect(
			db
				.prepare(
					"select created_at, deleted_at, deletion_source, deletion_reason, media_json, quoted_tweet_id from tweets where id = 'edit-2'",
				)
				.get(),
		).toMatchObject({
			created_at: "2025-06-03T19:32:20.000Z",
			deleted_at: "2026-07-18T12:00:00.000Z",
			deletion_source: "twitter_archive",
			deletion_reason: "explicit_deleted_tweet_record",
			quoted_tweet_id: "quote-1",
		});
		expect(
			db
				.prepare(
					"select kind, subordinate_id, deletion_reason from tweet_subordinate_tombstones where tweet_id = 'edit-2' order by kind, subordinate_id",
				)
				.all(),
		).toEqual([
			{
				kind: "media",
				subordinate_id: "https://img.example.com/deleted.jpg",
				deletion_reason: "parent_tweet_deleted",
			},
			{
				kind: "quote",
				subordinate_id: "quote-1",
				deletion_reason: "parent_tweet_deleted",
			},
		]);
		expect(
			db
				.prepare(
					"select revision_id, payload_json, created_at, deleted_at, deletion_source, deletion_reason from tweet_revisions join tweets on tweets.id = tweet_revisions.revision_id where revision_id = 'header-only'",
				)
				.get(),
		).toEqual({
			revision_id: "header-only",
			payload_json: null,
			created_at: "2025-06-02T19:32:20.000Z",
			deleted_at: "2026-07-17T12:00:00.000Z",
			deletion_source: "twitter_archive",
			deletion_reason: "explicit_deleted_tweet_record",
		});
		expect(
			db
				.prepare(
					"select revision_id, revision_index, payload_json is not null as hydrated from tweet_revisions where root_tweet_id = 'edit-1' order by revision_index",
				)
				.all(),
		).toEqual([
			{ revision_id: "edit-1", revision_index: 0, hydrated: 1 },
			{ revision_id: "edit-2", revision_index: 1, hydrated: 1 },
		]);
		expect(
			listTimelineItems({ resource: "home", limit: 10 }).map(
				(tweet) => tweet.id,
			),
		).toEqual(["vanishing"]);
		expect(
			db
				.prepare(
					"select count(*) as count from tweets_fts where tweet_id = 'edit-2'",
				)
				.get(),
		).toEqual({ count: 0 });

		insertTestTweet(db, {
			id: "legacy-unknown-source",
			authorProfileId: "profile_me",
			text: "legacy placeholder",
			createdAt: "2025-06-01T19:32:20.000Z",
		});
		db.prepare(
			"update tweets set deleted_at = '2020-01-01T00:00:00.000Z' where id = 'legacy-unknown-source'",
		).run();
		await importArchive(makeLateDeletedTweetBodyArchive());
		expect(
			db
				.prepare(
					"select kind, subordinate_id, deletion_source from tweet_subordinate_tombstones where tweet_id = 'header-only' order by kind, subordinate_id",
				)
				.all(),
		).toEqual([
			{
				kind: "media",
				subordinate_id: "https://img.example.com/late.jpg",
				deletion_source: "twitter_archive",
			},
			{
				kind: "quote",
				subordinate_id: "late-quote",
				deletion_source: "twitter_archive",
			},
		]);
		expect(
			db
				.prepare(
					"select deleted_at, deletion_source from tweet_subordinate_tombstones where tweet_id = 'legacy-unknown-source' and kind = 'media'",
				)
				.get(),
		).toEqual({
			deleted_at: "2020-01-01T00:00:00.000Z",
			deletion_source: null,
		});
		db.prepare(
			"update tweet_subordinate_tombstones set deletion_source = 'trusted_existing' where tweet_id = 'header-only' and kind = 'media'",
		).run();
		await importArchive(makeLateDeletedTweetBodyArchive());
		expect(
			db
				.prepare(
					"select deletion_source from tweet_subordinate_tombstones where tweet_id = 'header-only' and kind = 'media'",
				)
				.get(),
		).toEqual({ deletion_source: "trusted_existing" });

		await importArchive(initialArchive);
		expect(
			db.prepare("select deleted_at from tweets where id = 'edit-2'").get(),
		).toEqual({ deleted_at: "2026-07-18T12:00:00.000Z" });

		const emptyRestore = makeTweetRetentionArchive({
			includeEditable: false,
			includeVanishing: false,
		});
		const restoreResult = await importArchive(emptyRestore, {
			restore: true,
			select: ["tweets"],
		});
		expect(restoreResult.mode).toBe("restore");
		expect(
			db
				.prepare(
					"select count(*) as count from tweets where id in ('edit-2', 'vanishing')",
				)
				.get(),
		).toEqual({ count: 0 });
		expect(
			db
				.prepare(
					"select count(*) as count from tweet_subordinate_tombstones where tweet_id = 'edit-2'",
				)
				.get(),
		).toEqual({ count: 0 });
		expect(
			db
				.prepare(
					"select count(*) as count from tweet_revisions where root_tweet_id = 'edit-1'",
				)
				.get(),
		).toEqual({ count: 0 });
		expect(
			db.prepare("select count(*) as count from tweet_revision_edges").get(),
		).toEqual({ count: 0 });
	});

	it("imports tweets, dms, profiles, and envelope stats from a zip archive", async () => {
		const archivePath = makeArchive();
		const staleDb = getNativeDb();
		staleDb.exec(`
      insert into url_expansions (
        short_url, expanded_url, final_url, status, source, updated_at
      ) values (
        'https://t.co/stale', 'https://x.com/stale/status/1', 'https://x.com/stale/status/1', 'hit', 'network', '2026-04-01T00:00:00.000Z'
      );
      insert into link_occurrences (
        source_kind, source_id, source_position, short_url, created_at
      ) values (
        'dm', 'deleted-message', 0, 'https://t.co/stale', '2026-04-01T00:00:00.000Z'
      );
    `);

		const result = await importArchive(archivePath, { restore: true });
		const db = getNativeDb();
		const envelope = await getQueryEnvelope({ includeArchives: false });
		const tweets = listTimelineItems({ resource: "home", limit: 10 });
		const liked = listTimelineItems({ resource: "home", likedOnly: true });
		const bookmarked = listTimelineItems({
			resource: "home",
			bookmarkedOnly: true,
		});
		const dms = listDmConversations({ limit: 10 });
		const archivedTweet = tweets.find((item) => item.id === "100");
		const dmMessageCount = (
			db.prepare("select count(*) as count from dm_messages").get() as {
				count: number;
			}
		).count;

		expect(result.counts.tweets).toBe(2);
		expect(result.counts.likes).toBe(1);
		expect(result.counts.bookmarks).toBe(1);
		expect(result.counts.followers).toBe(0);
		expect(result.counts.following).toBe(0);
		expect(envelope.stats.home).toBe(2);
		expect(envelope.stats.dms).toBe(1);
		expect(tweets.map((item) => item.text)).toEqual([
			"Longer archive note",
			"@sam archive-first still wins https://t.co/local #birdclaw",
		]);
		expect(dms).toHaveLength(1);
		expect(dms[0]?.participant.handle).toBe("sam");
		expect(dmMessageCount).toBe(2);
		expect(
			db
				.prepare(
					"select participant_profile_id from dm_conversations where id = 'dm-1'",
				)
				.get(),
		).toEqual({ participant_profile_id: "profile_user_42" });
		expect(
			db
				.prepare("select handle from profiles where id = 'profile_user_42'")
				.get(),
		).toEqual({ handle: "sam" });
		expect(archivedTweet?.entities.mentions?.[0]?.username).toBe("sam");
		expect(archivedTweet?.entities.urls?.[0]?.expandedUrl).toBe(
			"https://birdclaw.dev/archive",
		);
		expect(archivedTweet?.entities.hashtags?.[0]?.tag).toBe("birdclaw");
		expect(archivedTweet?.media[0]?.altText).toBe("Archive chart");
		expect(archivedTweet?.quotedTweet?.id).toBe("101");
		expect(archivedTweet?.quotedTweet?.text).toBe("Longer archive note");
		expect(liked.map((item) => item.text)).toEqual(["liked archive item"]);
		expect(bookmarked.map((item) => item.text)).toEqual(["saved archive item"]);
	}, 30000);

	it("extracts archive media files into media originals", async () => {
		const archivePath = makeMediaArchive();

		const result = await importArchive(archivePath);
		const { mediaOriginalsDir } = getBirdclawPaths();
		const tweetMediaPath = path.join(
			mediaOriginalsDir,
			"archive",
			"tweets",
			"1727738789982839193",
			"1727738789982839193-F_opG9tXYAACOd3.jpg",
		);
		const dmMediaPath = path.join(
			mediaOriginalsDir,
			"archive",
			"dms",
			"m1",
			"m1-demo.png",
		);
		const profileMediaPath = path.join(
			mediaOriginalsDir,
			"archive",
			"profile",
			"profile",
			"profile-banner.jpg",
		);
		const tweetMediaMtime = statSync(tweetMediaPath).mtimeMs;

		expect(result.counts.mediaFiles).toEqual({
			tweets: 1,
			dms: 1,
			community: 0,
			profile: 1,
			deleted: 0,
			moments: 0,
			dmGroup: 0,
		});
		expect(readFileSync(tweetMediaPath, "utf8")).toBe("tweet-media");
		expect(readFileSync(dmMediaPath, "utf8")).toBe("dm-media");
		expect(readFileSync(profileMediaPath, "utf8")).toBe("profile-media");

		await importArchive(archivePath);
		expect(statSync(tweetMediaPath).mtimeMs).toBe(tweetMediaMtime);
	});

	it("exposes archive import as a lazy Effect", async () => {
		const archivePath = makeArchiveWithoutAccount();

		const effect = importArchiveEffect(archivePath);

		expect(() => effect).not.toThrow();
		await expect(Effect.runPromise(effect)).rejects.toThrow(
			"Archive missing data/account.js",
		);
	});

	it("skips archive media extraction for unrelated selected slices", async () => {
		const archivePath = makeRootDataArchive();

		const result = await importArchive(archivePath, {
			select: ["followers", "following"],
		});
		const rootMediaPath = path.join(
			getBirdclawPaths().mediaOriginalsDir,
			"archive",
			"tweets",
			"rootmedia",
			"rootmedia-archive.jpg",
		);

		expect(result.counts.mediaFiles).toEqual({
			tweets: 0,
			dms: 0,
			community: 0,
			profile: 0,
			deleted: 0,
			moments: 0,
			dmGroup: 0,
		});
		expect(existsSync(rootMediaPath)).toBe(false);
	});

	it("imports archive video variants into tweet media json", async () => {
		const archivePath = makeMediaVariantsArchive();

		await importArchive(archivePath);
		const rows = getNativeDb()
			.prepare("select id, entities_json, media_json from tweets order by id")
			.all() as Array<{
			id: string;
			entities_json: string;
			media_json: string;
		}>;
		const mediaByTweet = new Map(
			rows.map((row) => [row.id, JSON.parse(row.media_json)]),
		);
		const entitiesByTweet = new Map(
			rows.map((row) => [row.id, JSON.parse(row.entities_json)]),
		);

		expect(mediaByTweet.get("video-1")).toEqual([
			{
				url: "https://pbs.twimg.com/video-thumb.jpg",
				type: "video",
				altText: undefined,
				thumbnailUrl: "https://pbs.twimg.com/video-thumb.jpg",
				width: 1920,
				height: 1080,
				durationMs: 46947,
				variants: [
					{
						url: "https://video.twimg.com/1280.mp4",
						contentType: "video/mp4",
						bitRate: 2176000,
					},
					{
						url: "https://video.twimg.com/640.mp4",
						contentType: "video/mp4",
						bitRate: 832000,
					},
				],
			},
		]);
		expect(mediaByTweet.get("gif-1")).toEqual([
			{
				url: "https://pbs.twimg.com/gif-thumb.jpg",
				type: "gif",
				altText: undefined,
				thumbnailUrl: "https://pbs.twimg.com/gif-thumb.jpg",
				variants: [
					{
						url: "https://video.twimg.com/gif.mp4",
						contentType: "video/mp4",
						bitRate: 256000,
					},
				],
			},
		]);
		expect(mediaByTweet.get("photo-1")).toEqual([
			{
				url: "https://pbs.twimg.com/photo.jpg",
				type: "image",
				altText: "Photo alt",
				thumbnailUrl: "https://pbs.twimg.com/photo.jpg",
				width: 1200,
				height: 800,
			},
		]);
		expect(entitiesByTweet.get("photo-1")).toEqual({
			urls: [
				{
					url: "https://t.co/photo",
					expandedUrl: "https://x.com/steipete/status/photo-1/photo/1",
					displayUrl: "pic.twitter.com/photo",
					start: 6,
					end: 24,
					description: null,
					imageUrl: "https://pbs.twimg.com/photo.jpg",
				},
			],
		});
	});

	it("clears mention sync state on an explicit full archive restore", async () => {
		const archivePath = makeArchive();
		const db = getNativeDb();
		db.prepare(
			"insert into sync_cache (cache_key, value_json, updated_at) values (?, ?, ?)",
		).run(
			"mentions:sync:high-water:v1:mode=xurl:account=acct_primary",
			'{"sinceId":"2000"}',
			"2026-05-01T00:00:00.000Z",
		);

		await importArchive(archivePath, { restore: true });

		expect(
			db
				.prepare(
					"select count(*) as count from sync_cache where cache_key like 'mentions:sync:%'",
				)
				.get(),
		).toEqual({ count: 0 });
	});

	it("imports only selected archive slices", async () => {
		const archivePath = makeArchive();

		const result = await importArchive(archivePath, { select: ["likes"] });
		const db = getNativeDb();

		expect(result.counts).toMatchObject({
			tweets: 0,
			likes: 1,
			bookmarks: 0,
			dmConversations: 0,
			dmMessages: 0,
			followers: 0,
			following: 0,
		});
		expect(db.prepare("select id from tweets where id = '5'").all()).toEqual([
			{ id: "5" },
		]);
		expect(
			(
				db
					.prepare(
						"select count(*) as count from tweet_collections where tweet_id = '5' and kind = 'likes'",
					)
					.get() as { count: number }
			).count,
		).toBe(1);

		db.prepare(
			"update tweet_collections set source = 'legacy' where tweet_id = '5' and kind = 'likes'",
		).run();
		await importArchive(makeRootDataArchive(), {
			select: ["likes"],
			restore: true,
		});

		expect(
			db.prepare("select id from tweets where id = '5'").get(),
		).toBeUndefined();
		expect(
			(
				db
					.prepare(
						"select count(*) as count from tweets_fts where tweet_id = '5'",
					)
					.get() as { count: number }
			).count,
		).toBe(0);
	});

	it("preserves collection-only tweets referenced by retained tweets", async () => {
		const archivePath = makeArchive();

		await importArchive(archivePath, { select: ["likes"] });
		const db = getNativeDb();
		db.exec(`
      insert into tweets (
        id, author_profile_id, text, created_at, is_replied,
        reply_to_id, like_count, media_count, entities_json, media_json,
        quoted_tweet_id
      ) values (
        '200', 'profile_me', 'kept quote', '2026-01-02T00:00:00.000Z',
        0, null, 1, 0, '{}', '[]', '5'
      );
      insert into tweet_account_edges (
        account_id, tweet_id, kind, first_seen_at, last_seen_at, seen_count, source,
        raw_json, updated_at
      ) values (
        'acct_primary', '200', 'home', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z',
        1, 'bird', '{}', '2026-01-02T00:00:00.000Z'
      );
    `);

		await importArchive(makeRootDataArchive(), { select: ["likes"] });

		expect(db.prepare("select text from tweets where id = '5'").get()).toEqual({
			text: "liked archive item",
		});
		expect(
			listTimelineItems({ resource: "home", limit: 10 }).find(
				(item) => item.id === "200",
			)?.quotedTweet?.text,
		).toBe("liked archive item");
	});

	it("preserves existing account metadata during selected imports", async () => {
		const archivePath = makeArchive();
		const db = getNativeDb({ seedDemoData: false });
		insertTestAccount(db, {
			id: "acct_primary",
			name: "Live Primary",
			handle: "@steipete",
			externalUserId: "25401953",
			transport: "xurl",
			isDefault: 0,
		});

		await importArchive(archivePath, { select: ["likes"] });

		expect(
			db
				.prepare(
					"select name, handle, transport, is_default, created_at from accounts where id = 'acct_primary'",
				)
				.get(),
		).toEqual({
			name: "Live Primary",
			handle: "@steipete",
			transport: "xurl",
			is_default: 0,
			created_at: "2026-01-01T00:00:00.000Z",
		});
	});

	it("rejects selected imports for a different existing primary account", async () => {
		const archivePath = makeArchive();
		const db = getNativeDb({ seedDemoData: false });
		insertTestAccount(db, {
			id: "acct_primary",
			name: "Other Primary",
			handle: "@other",
			externalUserId: "999",
			transport: "xurl",
		});

		await expect(
			importArchive(archivePath, { select: ["likes"] }),
		).rejects.toThrow("does not match archive account 25401953");
		expect(
			db.prepare("select id from tweets where id = '5'").get(),
		).toBeUndefined();
	});

	it("rejects full merge imports for a different existing primary account", async () => {
		const archivePath = makeArchive();
		const db = getNativeDb({ seedDemoData: false });
		insertTestAccount(db, {
			id: "acct_primary",
			name: "Other Primary",
			handle: "@other",
			externalUserId: "999",
			transport: "xurl",
		});

		await expect(importArchive(archivePath)).rejects.toThrow(
			"does not match archive account 25401953",
		);
		expect(
			db.prepare("select id from tweets where id = '100'").get(),
		).toBeUndefined();
	});

	it("refreshes existing local profile metadata when selected", async () => {
		const archivePath = makeArchive();
		const db = getNativeDb({ seedDemoData: false });
		insertTestAccount(db, {
			id: "acct_primary",
			name: "Primary",
			handle: "@steipete",
			externalUserId: "25401953",
			transport: "xurl",
		});
		insertTestProfile(db, {
			id: "profile_user_25401953",
			handle: "steipete",
			displayName: "Live Peter",
			bio: "stale bio",
			followersCount: 10,
			followingCount: 11,
			publicMetricsJson: '{"followers_count":10}',
			avatarHue: 12,
			avatarUrl: "https://img.example.com/live.jpg",
			location: "Vienna",
			url: "https://example.com",
			verifiedType: "blue",
		});

		await importArchive(archivePath, { select: ["profiles"] });

		expect(
			db
				.prepare(
					"select id, handle, display_name, bio, followers_count, avatar_url from profiles where id = 'profile_user_25401953'",
				)
				.get(),
		).toEqual({
			id: "profile_user_25401953",
			handle: "steipete",
			display_name: "Peter Steinberger",
			bio: "Local-first builder",
			followers_count: 10,
			avatar_url: "https://img.example.com/live.jpg",
		});
		expect(
			db.prepare("select id from profiles where id = 'profile_me'").get(),
		).toBeUndefined();
	});

	it("keeps collection-only tweets on the synthetic unknown profile", async () => {
		const archivePath = makeArchive();
		const db = getNativeDb({ seedDemoData: false });
		insertTestProfile(db, {
			id: "profile_real_unknown",
			handle: "unknown",
			displayName: "Real Unknown",
			bio: "real profile",
			followersCount: 50,
			avatarHue: 12,
		});

		await importArchive(archivePath, { select: ["likes"] });

		expect(
			db.prepare("select author_profile_id from tweets where id = '5'").get(),
		).toEqual({ author_profile_id: "profile_unknown" });
		expect(
			db
				.prepare(
					"select display_name, bio from profiles where id = 'profile_real_unknown'",
				)
				.get(),
		).toEqual({ display_name: "Real Unknown", bio: "real profile" });
		expect(
			db
				.prepare("select handle from profiles where id = 'profile_unknown'")
				.get(),
		).toEqual({ handle: "unknown_archive" });
		expect(
			listTimelineItems({ resource: "home", likedOnly: true }).map(
				(item) => item.id,
			),
		).toContain("5");
	});

	it("preserves unselected slices when re-importing a selection", async () => {
		const archivePath = makeArchive();

		await importArchive(archivePath);
		await importArchive(archivePath, { select: ["likes"] });
		const db = getNativeDb();

		expect(
			(
				db.prepare("select count(*) as count from dm_messages").get() as {
					count: number;
				}
			).count,
		).toBe(2);
		expect(
			(
				db
					.prepare(
						"select count(*) as count from tweet_collections where kind = 'likes'",
					)
					.get() as { count: number }
			).count,
		).toBe(1);
		expect(
			(
				db
					.prepare(
						"select count(*) as count from tweet_collections where kind = 'bookmarks'",
					)
					.get() as { count: number }
			).count,
		).toBe(1);
	});

	it("preserves live collection rows when re-importing archive collections", async () => {
		const archivePath = makeArchive();
		const db = getNativeDb();
		db.exec(`
      insert or replace into accounts (id, name, handle, external_user_id, transport, is_default, created_at)
      values ('acct_primary', 'Primary', '@primary', '25401953', 'xurl', 1, '2026-01-01T00:00:00.000Z');
      insert into profiles (
        id, handle, display_name, bio, followers_count, following_count,
        public_metrics_json, avatar_hue, avatar_url, location, url, verified_type,
        entities_json, raw_json, created_at
      ) values (
        'profile_live', 'live', 'Live', '', 0, 0, '{}', 12, null, null, null, null,
        '{}', '{}', '2026-01-01T00:00:00.000Z'
      );
      insert into tweets (
        id, author_profile_id, text, created_at, is_replied,
        reply_to_id, like_count, media_count, entities_json, media_json,
        quoted_tweet_id
	      ) values
	        (
	          'live-like', 'profile_live', 'live liked item',
	          '2026-01-01T00:00:00.000Z', 0, null, 1, 0, '{}', '[]', null
	        ),
	        (
	          '5', 'profile_live', 'hydrated live liked item',
	          '2026-01-02T00:00:00.000Z', 0, null, 1, 0, '{}', '[]', null
	        );
      insert into tweet_collections (
        account_id, tweet_id, kind, collected_at, source, raw_json, updated_at
	      ) values
	        (
	          'acct_primary', 'live-like', 'likes', '2026-01-01T00:00:00.000Z',
	          'bird', '{}', '2026-01-01T00:00:00.000Z'
	        ),
	        (
	          'acct_primary', '5', 'likes', '2026-01-01T00:00:00.000Z',
	          'bird', '{"source":"live"}', '2026-01-01T00:00:00.000Z'
	        );
	    `);

		await importArchive(archivePath, { select: ["likes"] });

		expect(
			db
				.prepare(
					"select tweet_id, source, raw_json from tweet_collections where kind = 'likes' and tweet_id in ('5', 'live-like') order by tweet_id",
				)
				.all(),
		).toEqual([
			{ tweet_id: "5", source: "bird", raw_json: '{"source":"live"}' },
			{ tweet_id: "live-like", source: "bird", raw_json: "{}" },
		]);
		expect(
			listTimelineItems({ resource: "home", likedOnly: true }).map(
				(item) => item.id,
			),
		).toEqual(expect.arrayContaining(["5", "live-like"]));
		expect(
			db.prepare("select text, created_at from tweets where id = '5'").get(),
		).toEqual({
			text: "hydrated live liked item",
			created_at: "2026-01-02T00:00:00.000Z",
		});
	});

	it("scopes selected direct message re-imports to the archive account", async () => {
		const archivePath = makeArchive();
		const db = getNativeDb();
		insertTestAccount(db, {
			id: "acct_other",
			name: "Other",
			handle: "@other",
			externalUserId: "other",
			transport: "xurl",
			isDefault: 0,
		});
		insertTestProfile(db, {
			id: "profile_other",
			handle: "other",
			displayName: "Other",
			bio: "",
			followersCount: 0,
			followingCount: 0,
			publicMetricsJson: "{}",
			avatarHue: 12,
		});
		insertTestDmConversation(db, {
			id: "dm-stale",
			accountId: "acct_primary",
			participantProfileId: "profile_other",
			title: "Stale",
		});
		insertTestDmMessage(db, {
			id: "m-stale",
			conversationId: "dm-stale",
			senderProfileId: "profile_other",
			text: "stale primary dm",
			direction: "incoming",
		});
		insertTestDmConversation(db, {
			id: "dm-other",
			accountId: "acct_other",
			participantProfileId: "profile_other",
			title: "Other",
		});
		insertTestDmMessage(db, {
			id: "m-other",
			conversationId: "dm-other",
			senderProfileId: "profile_other",
			text: "keep other dm",
			direction: "incoming",
		});
		db.exec(`
	      insert into link_occurrences (
	        source_kind, source_id, source_position, short_url, account_id, conversation_id, created_at
	      ) values (
	        'dm', 'm-stale', 0, 'https://t.co/stale-dm', 'acct_primary', 'dm-stale', '2026-01-01T00:00:00.000Z'
	      );
	      insert into dm_fts (message_id, text) values ('m-other', 'keep other dm');
	      insert into link_occurrences (
	        source_kind, source_id, source_position, short_url, account_id, conversation_id, created_at
	      ) values (
	        'dm', 'm-other', 0, 'https://t.co/other-dm', 'acct_other', 'dm-other', '2026-01-01T00:00:00.000Z'
	      );
	    `);

		await importArchive(archivePath, {
			select: ["directMessages"],
			restore: true,
		});

		expect(
			(
				db
					.prepare(
						"select count(*) as count from dm_messages where conversation_id = 'dm-other'",
					)
					.get() as { count: number }
			).count,
		).toBe(1);
		expect(
			(
				db
					.prepare(
						"select count(*) as count from dm_fts where dm_fts match 'other'",
					)
					.get() as { count: number }
			).count,
		).toBe(1);
		expect(
			(
				db
					.prepare(
						"select count(*) as count from link_occurrences where source_kind = 'dm' and source_id = 'm-stale'",
					)
					.get() as { count: number }
			).count,
		).toBe(0);
		expect(
			(
				db
					.prepare(
						"select count(*) as count from link_occurrences where source_kind = 'dm' and source_id = 'm-other'",
					)
					.get() as { count: number }
			).count,
		).toBe(1);
	});

	it("remaps selected direct message ids that collide with another account", async () => {
		const archivePath = makeArchive();
		const db = getNativeDb({ seedDemoData: false });
		db.exec(`
      insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at)
      values
        ('acct_primary', 'Primary', '@steipete', '25401953', 'xurl', 1, '2026-01-01T00:00:00.000Z'),
        ('acct_other', 'Other', '@other', 'other', 'xurl', 0, '2026-01-01T00:00:00.000Z');
      insert into profiles (
        id, handle, display_name, bio, followers_count, following_count,
        public_metrics_json, avatar_hue, avatar_url, location, url, verified_type,
        entities_json, raw_json, created_at
      ) values (
        'profile_other', 'other', 'Other', '', 0, 0, '{}', 12, null, null, null, null,
        '{}', '{}', '2026-01-01T00:00:00.000Z'
      );
      insert into dm_conversations (
        id, account_id, participant_profile_id, title, last_message_at, unread_count, needs_reply
      ) values (
        'dm-1', 'acct_other', 'profile_other', 'Other copy', '2026-01-01T00:00:00.000Z', 0, 0
      );
      insert into dm_messages (
        id, conversation_id, sender_profile_id, text, created_at, direction, is_replied, media_count
      ) values (
        'm1', 'dm-1', 'profile_other', 'other account copy', '2026-01-01T00:00:00.000Z',
        'incoming', 0, 0
      );
    `);

		await importArchive(archivePath, { select: ["directMessages"] });

		expect(
			db
				.prepare(
					"select id, account_id from dm_conversations order by account_id, id",
				)
				.all(),
		).toEqual([
			{ id: "dm-1", account_id: "acct_other" },
			{ id: "acct_primary:dm-1", account_id: "acct_primary" },
		]);
		expect(
			db
				.prepare(
					"select id, conversation_id, text from dm_messages order by conversation_id, id",
				)
				.all(),
		).toEqual([
			{
				id: "acct_primary:m1",
				conversation_id: "acct_primary:dm-1",
				text: "Need a local archive tool",
			},
			{
				id: "acct_primary:m2",
				conversation_id: "acct_primary:dm-1",
				text: "Building one now",
			},
			{
				id: "m1",
				conversation_id: "dm-1",
				text: "other account copy",
			},
		]);
		expect(
			listDmConversations({ account: "acct_primary", limit: 10 }).map(
				(item) => item.id,
			),
		).toEqual(["acct_primary:dm-1"]);
		expect(
			listDmConversations({ account: "acct_other", limit: 10 }).map(
				(item) => item.id,
			),
		).toEqual(["dm-1"]);
	});

	it("preserves profile and timeline tweet state during collection re-imports", async () => {
		const archivePath = makeArchive();
		const db = getNativeDb();
		db.exec(`
      insert or replace into accounts (id, name, handle, external_user_id, transport, is_default, created_at)
      values ('acct_primary', 'Primary', '@primary', '25401953', 'xurl', 1, '2026-01-01T00:00:00.000Z');
      insert into profiles (
        id, handle, display_name, bio, followers_count, following_count,
        public_metrics_json, avatar_hue, avatar_url, location, url, verified_type,
        entities_json, raw_json, created_at
      ) values (
        'profile_unknown', 'unknown', 'Hydrated Unknown', 'live bio', 123, 45,
        '{"followers_count":123}', 42, 'https://img.example.com/live.jpg', 'Vienna',
        'https://example.com', 'blue', '{"url":true}', '{"live":true}',
        '2026-01-01T00:00:00.000Z'
      );
      insert into tweets (
        id, author_profile_id, text, created_at, is_replied,
        reply_to_id, like_count, media_count, entities_json, media_json,
        quoted_tweet_id
      ) values (
	        '5', 'profile_unknown', 'full live root text',
	        '2025-01-01T00:00:00.000Z', 0, null, 9, 0, '{}', '[]', null
      );
      insert into tweet_account_edges (
        account_id, tweet_id, kind, first_seen_at, last_seen_at, seen_count,
        source, raw_json, updated_at
      ) values (
        'acct_primary', '5', 'home', '2025-01-01T00:00:00.000Z',
        '2025-01-01T00:00:00.000Z', 1, 'xurl', '{}', '2025-01-01T00:00:00.000Z'
      );
      insert into tweets_fts (tweet_id, text) values ('5', 'full live root text');
    `);

		await importArchive(archivePath, { select: ["likes"] });
		const tweet = db
			.prepare("select text, created_at from tweets where id = '5'")
			.get() as {
			text: string;
			created_at: string;
		};
		const profile = db
			.prepare(
				"select display_name, followers_count, avatar_url, raw_json from profiles where id = 'profile_unknown'",
			)
			.get() as {
			display_name: string;
			followers_count: number;
			avatar_url: string;
			raw_json: string;
		};

		expect(tweet).toEqual({
			text: "full live root text",
			created_at: "2025-01-01T00:00:00.000Z",
		});
		expect(
			db
				.prepare(
					"select account_id, kind from tweet_collections where tweet_id = '5' and kind = 'likes'",
				)
				.all(),
		).toEqual([{ account_id: "acct_primary", kind: "likes" }]);
		expect(profile).toEqual({
			display_name: "Hydrated Unknown",
			followers_count: 123,
			avatar_url: "https://img.example.com/live.jpg",
			raw_json: '{"live":true}',
		});
		expect(
			(
				db
					.prepare(
						"select count(*) as count from tweets_fts where tweets_fts match 'root'",
					)
					.get() as { count: number }
			).count,
		).toBe(1);
	});

	it("preserves existing account-scoped tweet state during selected imports", async () => {
		const archivePath = makeArchive();
		const db = getNativeDb();
		db.exec(`
      insert or replace into accounts (id, name, handle, external_user_id, transport, is_default, created_at)
      values
        ('acct_primary', 'Primary', '@primary', '25401953', 'xurl', 1, '2026-01-01T00:00:00.000Z'),
        ('acct_other', 'Other', '@other', 'other', 'xurl', 0, '2026-01-01T00:00:00.000Z');
      insert into profiles (
        id, handle, display_name, bio, followers_count, following_count,
        public_metrics_json, avatar_hue, avatar_url, location, url, verified_type,
        entities_json, raw_json, created_at
      ) values (
        'profile_other', 'other', 'Other', '', 0, 0, '{}', 12, null, null, null, null,
        '{}', '{}', '2026-01-01T00:00:00.000Z'
      );
      insert into tweets (
        id, author_profile_id, text, created_at, is_replied,
        reply_to_id, like_count, media_count, entities_json, media_json,
        quoted_tweet_id
      ) values (
	        '5', 'profile_other', 'other account text',
	        '2026-01-01T00:00:00.000Z', 0, null, 1, 0, '{}', '[]', null
      );
      insert into tweet_account_edges (
        account_id, tweet_id, kind, first_seen_at, last_seen_at, seen_count,
        source, raw_json, updated_at
      ) values (
        'acct_other', '5', 'home', '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z', 1, 'xurl', '{}', '2026-01-01T00:00:00.000Z'
      );
    `);

		await importArchive(archivePath, { select: ["likes"] });

		expect(
			db
				.prepare("select author_profile_id, text from tweets where id = '5'")
				.get(),
		).toEqual({
			author_profile_id: "profile_other",
			text: "other account text",
		});
		expect(
			db
				.prepare(
					"select account_id, kind from tweet_account_edges where tweet_id = '5'",
				)
				.all(),
		).toEqual([{ account_id: "acct_other", kind: "home" }]);
		expect(
			db
				.prepare(
					"select account_id, source from tweet_collections where tweet_id = '5' and kind = 'likes'",
				)
				.all(),
		).toEqual([{ account_id: "acct_primary", source: "archive" }]);
		expect(
			listTimelineItems({
				resource: "home",
				account: "acct_primary",
				likedOnly: true,
				limit: 10,
			}).map((item) => item.id),
		).toContain("5");
		expect(
			listTimelineItems({
				resource: "home",
				account: "acct_other",
				likedOnly: true,
				limit: 10,
			}).map((item) => item.id),
		).not.toContain("5");

		db.prepare(
			`insert into tweet_collections (
				account_id, tweet_id, kind, collected_at, source, raw_json, updated_at
			) values ('acct_other', '5', 'likes', null, 'bird', '{}', '2026-01-02T00:00:00.000Z')`,
		).run();
		await importArchive(makeRootDataArchive(), {
			select: ["likes"],
			restore: true,
		});

		expect(
			db
				.prepare("select author_profile_id, text from tweets where id = '5'")
				.get(),
		).toEqual({
			author_profile_id: "profile_other",
			text: "other account text",
		});
		expect(
			db
				.prepare(
					"select account_id from tweet_collections where tweet_id = '5' and kind = 'likes'",
				)
				.all(),
		).toEqual([{ account_id: "acct_other" }]);
		expect(
			listTimelineItems({
				resource: "home",
				account: "acct_other",
				likedOnly: true,
			}).map((item) => item.id),
		).toContain("5");
	});

	it("uses an existing same-handle profile for selected local-account tweets", async () => {
		const archivePath = makeArchive();
		const db = getNativeDb({ seedDemoData: false });
		db.exec(`
      insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at)
      values ('acct_primary', 'Primary', '@steipete', '25401953', 'xurl', 1, '2026-01-01T00:00:00.000Z');
      insert into profiles (
        id, handle, display_name, bio, followers_count, following_count,
        public_metrics_json, avatar_hue, avatar_url, location, url, verified_type,
        entities_json, raw_json, created_at
      ) values (
        'profile_user_25401953', 'steipete', 'Live Peter', '', 0, 0, '{}', 12,
        null, null, null, null, '{}', '{}', '2026-01-01T00:00:00.000Z'
      );
    `);

		await importArchive(archivePath, {
			select: ["tweets"],
			restore: true,
		});

		expect(
			db.prepare("select id from profiles where id = 'profile_me'").get(),
		).toBeUndefined();
		expect(
			db.prepare("select author_profile_id from tweets where id = '100'").get(),
		).toEqual({ author_profile_id: "profile_user_25401953" });
		expect(
			listTimelineItems({ resource: "home", limit: 10 }).map((item) => item.id),
		).toEqual(expect.arrayContaining(["100"]));
	});

	it("uses an existing same-handle profile for selected local-account DMs", async () => {
		const archivePath = makeArchive();
		const db = getNativeDb({ seedDemoData: false });
		db.exec(`
	      insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at)
	      values ('acct_primary', 'Primary', '@steipete', '25401953', 'xurl', 1, '2026-01-01T00:00:00.000Z');
	      insert into profiles (
	        id, handle, display_name, bio, followers_count, following_count,
	        public_metrics_json, avatar_hue, avatar_url, location, url, verified_type,
	        entities_json, raw_json, created_at
	      ) values (
	        'profile_user_25401953', 'steipete', 'Live Peter', '', 0, 0, '{}', 12,
	        null, null, null, null, '{}', '{}', '2026-01-01T00:00:00.000Z'
	      );
	    `);

		await importArchive(archivePath, { select: ["directMessages"] });

		expect(
			db
				.prepare("select sender_profile_id from dm_messages where id = 'm2'")
				.get(),
		).toEqual({ sender_profile_id: "profile_user_25401953" });
		expect(
			getConversationThread("dm-1")?.messages.map((message) => message.id),
		).toEqual(["m1", "m2"]);
	});

	it("uses an existing same-handle participant profile during selected imports", async () => {
		const archivePath = makeArchive();
		const db = getNativeDb({ seedDemoData: false });
		db.exec(`
      insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at)
      values ('acct_primary', 'Primary', '@steipete', '25401953', 'xurl', 1, '2026-01-01T00:00:00.000Z');
      insert into profiles (
        id, handle, display_name, bio, followers_count, following_count,
        public_metrics_json, avatar_hue, avatar_url, location, url, verified_type,
        entities_json, raw_json, created_at
      ) values (
        'profile_sam', 'sam', 'Existing Sam', 'live bio', 100, 10, '{}', 12,
        null, null, null, null, '{}', '{}', '2026-01-01T00:00:00.000Z'
      );
    `);

		await importArchive(archivePath, { select: ["tweets", "directMessages"] });

		expect(
			db
				.prepare(
					"select participant_profile_id from dm_conversations where id = 'dm-1'",
				)
				.get(),
		).toEqual({ participant_profile_id: "profile_sam" });
		expect(
			db
				.prepare("select sender_profile_id from dm_messages where id = 'm1'")
				.get(),
		).toEqual({ sender_profile_id: "profile_sam" });
		expect(
			db.prepare("select id from profiles where id = 'profile_user_42'").get(),
		).toBeUndefined();
		expect(
			getConversationThread("dm-1")?.messages.map((message) => message.id),
		).toEqual(["m1", "m2"]);
	});

	it("replaces the visible archive timeline when re-importing only tweets", async () => {
		const archivePath = makeArchive();
		const nextArchivePath = makeRootDataArchive();

		await importArchive(archivePath);
		getNativeDb().exec(`
      update tweet_account_edges
      set source = 'legacy'
      where account_id = 'acct_primary' and tweet_id in ('100', '101');

	      insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at)
	      values ('acct_other', 'Other', '@other', 'other', 'xurl', 0, '2026-01-01T00:00:00.000Z');
	      insert into tweets (
        id, author_profile_id, text, created_at, is_replied,
        reply_to_id, like_count, media_count, entities_json, media_json,
        quoted_tweet_id
      ) values
        (
	          '200', 'profile_me', 'mentioned elsewhere',
	          '2026-01-02T00:00:00.000Z', 0, null, 1, 0, '{}', '[]', null
        ),
        (
	          '300', 'profile_me', 'liked elsewhere',
	          '2026-01-03T00:00:00.000Z', 0, null, 1, 0, '{}', '[]', null
        );
      insert into tweet_account_edges (
        account_id, tweet_id, kind, first_seen_at, last_seen_at, seen_count, source,
        raw_json, updated_at
      ) values
        (
          'acct_other', '100', 'home', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
          1, 'xurl', '{}', '2026-01-01T00:00:00.000Z'
        ),
        (
          'acct_primary', '200', 'home', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z',
          1, 'archive', '{}', '2026-01-02T00:00:00.000Z'
        ),
        (
          'acct_primary', '200', 'mention', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z',
          1, 'bird', '{}', '2026-01-02T00:00:00.000Z'
        ),
        (
          'acct_primary', '300', 'home', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z',
          1, 'archive', '{}', '2026-01-03T00:00:00.000Z'
        );
	      insert into link_occurrences (
	        source_kind, source_id, source_position, short_url, account_id, created_at
	      ) values (
	        'tweet', '100', 0, 'https://t.co/local', 'acct_primary', '2026-01-01T00:00:00.000Z'
	      );
	      insert into tweet_collections (
	        account_id, tweet_id, kind, collected_at, source, raw_json, updated_at
	      ) values (
	        'acct_primary', '100', 'likes', '2026-01-01T00:00:00.000Z', 'bird', '{}', '2026-01-01T00:00:00.000Z'
	      );
      insert into tweet_collections (
        account_id, tweet_id, kind, collected_at, source, raw_json, updated_at
      ) values (
        'acct_other', '300', 'likes', '2026-01-03T00:00:00.000Z', 'bird', '{}', '2026-01-03T00:00:00.000Z'
      );
	    `);
		await importArchive(nextArchivePath, {
			select: ["tweets"],
			restore: true,
		});
		const db = getNativeDb();

		expect(
			listTimelineItems({
				resource: "home",
				account: "acct_primary",
				limit: 10,
			}).map((item) => item.id),
		).toEqual(["root-1"]);
		expect(listTimelineItems({ resource: "home", likedOnly: true })).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "5" }),
				expect.objectContaining({ id: "100" }),
			]),
		);
		expect(
			listTimelineItems({
				resource: "home",
				account: "acct_other",
				limit: 10,
			}).map((item) => item.id),
		).toEqual(["100"]);
		expect(
			listTimelineItems({
				resource: "mentions",
				account: "acct_primary",
				limit: 10,
			}).map((item) => item.id),
		).toEqual(["200"]);
		expect(
			listTimelineItems({
				resource: "home",
				account: "acct_other",
				likedOnly: true,
				limit: 10,
			}).map((item) => item.id),
		).toEqual(["300"]);
		expect(
			(
				db
					.prepare(
						"select count(*) as count from link_occurrences where source_kind = 'tweet' and source_id = '100'",
					)
					.get() as { count: number }
			).count,
		).toBe(1);
		expect(db.prepare("select id from tweets where id = '101'").get()).toEqual({
			id: "101",
		});
		expect(
			db
				.prepare(
					"select count(*) as count from tweet_account_edges where account_id = 'acct_primary' and tweet_id = '101' and kind in ('home', 'authored')",
				)
				.get(),
		).toEqual({ count: 0 });
		expect(
			listTimelineItems({ resource: "home", likedOnly: true }).find(
				(item) => item.id === "100",
			)?.quotedTweet?.text,
		).toBe("Longer archive note");
	});

	it("creates authored edges for archive-imported account tweets", async () => {
		const archivePath = makeArchive();

		await importArchive(archivePath);
		const db = getNativeDb();
		const accountTweets = db
			.prepare(
				`
        select id, created_at
        from tweets
	        where author_profile_id = 'profile_me'
        order by id
        `,
			)
			.all() as Array<{ id: string; created_at: string }>;
		const authoredEdges = db
			.prepare(
				`
        select edge.tweet_id, edge.source, edge.first_seen_at, edge.last_seen_at
        from tweet_account_edges edge
        join tweets tweet on tweet.id = edge.tweet_id
        where edge.account_id = 'acct_primary'
          and edge.kind = 'authored'
          and tweet.author_profile_id = 'profile_me'
        order by edge.tweet_id
        `,
			)
			.all() as Array<{
			tweet_id: string;
			source: string;
			first_seen_at: string;
			last_seen_at: string;
		}>;

		expect(authoredEdges).toEqual(
			accountTweets.map((tweet) => ({
				tweet_id: tweet.id,
				source: "archive",
				first_seen_at: tweet.created_at,
				last_seen_at: tweet.created_at,
			})),
		);
	});

	it("imports follower and following archive files into the follow graph", async () => {
		const archivePath = makeFollowArchive({
			followers: ["101", "102"],
			following: ["102", "103"],
		});

		const result = await importArchive(archivePath);
		const db = getNativeDb();
		const edges = db
			.prepare(
				`
        select direction || ':' || profile_id || ':' || external_user_id || ':' || source || ':' || current as value
        from follow_edges
        order by direction, external_user_id
        `,
			)
			.all() as Array<{ value: string }>;
		const events = db
			.prepare(
				`
        select direction || ':' || external_user_id || ':' || kind as value
        from follow_events
        order by direction, external_user_id
        `,
			)
			.all() as Array<{ value: string }>;
		const snapshots = db
			.prepare(
				`
        select direction || ':' || source || ':' || status || ':' || result_count as value
        from follow_snapshots
        order by direction
        `,
			)
			.all() as Array<{ value: string }>;

		expect(result.counts.followers).toBe(2);
		expect(result.counts.following).toBe(2);
		expect(edges.map((row) => row.value)).toEqual([
			"followers:profile_user_101:101:archive:1",
			"followers:profile_user_102:102:archive:1",
			"following:profile_user_102:102:archive:1",
			"following:profile_user_103:103:archive:1",
		]);
		expect(events.map((row) => row.value)).toEqual([
			"followers:101:started",
			"followers:102:started",
			"following:102:started",
			"following:103:started",
		]);
		expect(snapshots.map((row) => row.value)).toEqual([
			"followers:archive:partial:2",
			"following:archive:partial:2",
		]);
		expect(
			db
				.prepare(
					"select handle, display_name, bio from profiles where id = 'profile_user_101'",
				)
				.get(),
		).toEqual({ handle: "id101", display_name: "", bio: "" });
	});

	it("uses existing same-handle profiles for selected follow imports", async () => {
		const archivePath = makeFollowArchive({
			followers: ["101"],
			includeFollowing: false,
		});
		const db = getNativeDb({ seedDemoData: false });
		db.exec(`
      insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at)
      values ('acct_primary', 'Primary', '@steipete', '25401953', 'xurl', 1, '2026-01-01T00:00:00.000Z');
      insert into profiles (
        id, handle, display_name, bio, followers_count, following_count,
        public_metrics_json, avatar_hue, avatar_url, location, url, verified_type,
        entities_json, raw_json, created_at
      ) values (
        'profile_local_101', 'id101', 'Existing 101', 'live bio', 10, 2, '{}',
        12, null, null, null, null, '{}', '{}', '2026-01-01T00:00:00.000Z'
      );
    `);

		await importArchive(archivePath, { select: ["followers"] });

		expect(
			db
				.prepare(
					"select profile_id from follow_edges where direction = 'followers'",
				)
				.get(),
		).toEqual({ profile_id: "profile_local_101" });
		expect(
			db
				.prepare(
					"select profile_id from follow_snapshot_members where snapshot_id = 'follow_snapshot_archive_acct_primary_followers'",
				)
				.get(),
		).toEqual({ profile_id: "profile_local_101" });
		expect(
			db.prepare("select id from profiles where id = 'profile_user_101'").get(),
		).toBeUndefined();
	});

	it("handles empty follower and following files", async () => {
		const archivePath = makeFollowArchive({});

		const result = await importArchive(archivePath);
		const db = getNativeDb();

		expect(result.counts.followers).toBe(0);
		expect(result.counts.following).toBe(0);
		expect(
			(
				db.prepare("select count(*) as count from follow_edges").get() as {
					count: number;
				}
			).count,
		).toBe(0);
		expect(
			(
				db.prepare("select count(*) as count from follow_events").get() as {
					count: number;
				}
			).count,
		).toBe(0);
		expect(
			(
				db.prepare("select count(*) as count from follow_snapshots").get() as {
					count: number;
				}
			).count,
		).toBe(2);
	});

	it("re-imports follower data without duplicate follow events or snapshots", async () => {
		const archivePath = makeFollowArchive({
			followers: ["101", "102"],
			following: ["103"],
		});

		await importArchive(archivePath);
		const db = getNativeDb();
		const readArchiveSnapshots = () =>
			db
				.prepare(
					`
          select direction, id, result_count
          from follow_snapshots
          where source = 'archive'
          order by direction
        `,
				)
				.all();
		const readArchiveMembers = () =>
			db
				.prepare(
					`
          select s.direction, count(m.profile_id) as count
          from follow_snapshots s
          left join follow_snapshot_members m on m.snapshot_id = s.id
          where s.source = 'archive'
          group by s.direction
          order by s.direction
        `,
				)
				.all();
		const firstSnapshots = readArchiveSnapshots();
		const firstMembers = readArchiveMembers();

		await importArchive(archivePath);

		expect(
			(
				db.prepare("select count(*) as count from follow_edges").get() as {
					count: number;
				}
			).count,
		).toBe(3);
		expect(
			(
				db.prepare("select count(*) as count from follow_events").get() as {
					count: number;
				}
			).count,
		).toBe(3);
		expect(readArchiveSnapshots()).toEqual(firstSnapshots);
		expect(readArchiveMembers()).toEqual(firstMembers);
		expect(firstSnapshots).toEqual([
			{
				direction: "followers",
				id: "follow_snapshot_archive_acct_primary_followers",
				result_count: 2,
			},
			{
				direction: "following",
				id: "follow_snapshot_archive_acct_primary_following",
				result_count: 1,
			},
		]);
		expect(firstMembers).toEqual([
			{ count: 2, direction: "followers" },
			{ count: 1, direction: "following" },
		]);
	});

	it("preserves hydrated follow profile metadata on archive import", async () => {
		const archivePath = makeFollowArchive({
			followers: ["900"],
			includeFollowing: false,
		});
		const db = getNativeDb();
		db.prepare(
			`
      insert into profiles (
        id, handle, display_name, bio, followers_count, following_count,
        avatar_hue, avatar_url, created_at
      ) values (
        'profile_user_900', 'real900', 'Real User', 'Hydrated bio', 123, 45,
        33, 'https://img.example.com/avatar.jpg', '2026-05-01T00:00:00.000Z'
      )
      `,
		).run();
		db.prepare(
			`
      insert into follow_edges (
        account_id, direction, profile_id, external_user_id, source, current,
        first_seen_at, last_seen_at, ended_at, updated_at
      ) values (
        'acct_primary', 'followers', 'profile_user_900', '900', 'xurl', 1,
        '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', null,
        '2026-05-01T00:00:00.000Z'
      )
      `,
		).run();

		await importArchive(archivePath);

		expect(
			db
				.prepare(
					`
          select handle, display_name, bio, followers_count, following_count,
            avatar_hue, avatar_url
          from profiles
          where id = 'profile_user_900'
        `,
				)
				.get(),
		).toEqual({
			handle: "real900",
			display_name: "Real User",
			bio: "Hydrated bio",
			followers_count: 123,
			following_count: 45,
			avatar_hue: 33,
			avatar_url: "https://img.example.com/avatar.jpg",
		});
	});

	it("preserves hydrated profile columns on archive re-import", async () => {
		const archivePath = makeFollowArchive({
			followers: ["900"],
			includeFollowing: false,
		});

		await importArchive(archivePath);
		const db = getNativeDb();
		db.prepare(
			`
      update profiles
      set handle = 'real900',
        display_name = 'Real User',
        followers_count = 123,
        public_metrics_json = ?,
        location = 'London',
        raw_json = ?
      where id = 'profile_user_900'
      `,
		).run(
			'{"followers_count":123,"following_count":45}',
			'{"id":"900","username":"real900","description":"hydrated"}',
		);

		await importArchive(archivePath);

		expect(
			db
				.prepare(
					`
          select public_metrics_json, location, raw_json
          from profiles
          where id = 'profile_user_900'
        `,
				)
				.get(),
		).toEqual({
			public_metrics_json: '{"followers_count":123,"following_count":45}',
			location: "London",
			raw_json: '{"id":"900","username":"real900","description":"hydrated"}',
		});
	});

	it("preserves hydrated DM-only profile columns on archive re-import", async () => {
		const archivePath = makeRootDataArchive();

		await importArchive(archivePath);
		const db = getNativeDb();
		db.prepare(
			`
      update profiles
      set handle = 'real42',
        display_name = 'Real DM User',
        followers_count = 321,
        public_metrics_json = ?,
        location = 'London',
        raw_json = ?
      where id = 'profile_user_42'
      `,
		).run(
			'{"followers_count":321,"following_count":54}',
			'{"id":"42","username":"real42","description":"hydrated"}',
		);

		await importArchive(archivePath);

		expect(
			db
				.prepare(
					`
          select handle, display_name, followers_count, public_metrics_json,
            location, raw_json
          from profiles
          where id = 'profile_user_42'
        `,
				)
				.get(),
		).toEqual({
			handle: "real42",
			display_name: "Real DM User",
			followers_count: 321,
			public_metrics_json: '{"followers_count":321,"following_count":54}',
			location: "London",
			raw_json: '{"id":"42","username":"real42","description":"hydrated"}',
		});
	});

	it("upgrades DM-only placeholder profiles from archive mention metadata on re-import", async () => {
		const firstArchivePath = makeRootDataArchive();
		const secondArchivePath = makeArchive();

		await importArchive(firstArchivePath);
		const db = getNativeDb();

		await importArchive(secondArchivePath);

		expect(
			db
				.prepare(
					`
          select handle, display_name, bio
          from profiles
          where id = 'profile_user_42'
        `,
				)
				.get(),
		).toEqual({
			handle: "sam",
			display_name: "sam",
			bio: "Imported from archive user 42",
		});
	});

	it("preserves mention-inferred DM profiles when a later archive lacks mention metadata", async () => {
		const firstArchivePath = makeRootDataArchive();
		const secondArchivePath = makeArchive();
		const thirdArchivePath = makeRootDataArchive();

		await importArchive(firstArchivePath);
		await importArchive(secondArchivePath);
		const db = getNativeDb();
		await importArchive(thirdArchivePath);

		expect(
			db
				.prepare(
					`
          select handle, display_name, bio
          from profiles
          where id = 'profile_user_42'
        `,
				)
				.get(),
		).toEqual({
			handle: "sam",
			display_name: "sam",
			bio: "Imported from archive user 42",
		});
	});

	it("preserves mention-inferred DM profiles when follow rows overlap on re-import", async () => {
		const firstArchivePath = makeRootDataArchive();
		const secondArchivePath = makeArchive({ following: ["42"] });

		await importArchive(firstArchivePath);
		await importArchive(secondArchivePath);
		const db = getNativeDb();

		expect(
			db
				.prepare(
					`
	          select handle, display_name, bio
	          from profiles
	          where id = 'profile_user_42'
	        `,
				)
				.get(),
		).toEqual({
			handle: "sam",
			display_name: "sam",
			bio: "Imported from archive user 42",
		});
	}, 20000);

	it("preserves hydrated group-DM sender profiles when follow rows overlap", async () => {
		const archivePath = makeWeirdArchive({ followers: ["42"] });
		const db = getNativeDb();
		db.prepare(
			`
      insert into profiles (
        id, handle, display_name, bio, followers_count, following_count,
        public_metrics_json, avatar_hue, location, raw_json, created_at
      ) values (
        'profile_user_42', 'real42', 'Real Group Sender', 'Hydrated bio',
        321, 54, ?, 33, 'London', ?, '2026-05-01T00:00:00.000Z'
      )
      `,
		).run(
			'{"followers_count":321,"following_count":54}',
			'{"id":"42","username":"real42","description":"hydrated"}',
		);

		await importArchive(archivePath);

		expect(
			db
				.prepare(
					`
          select handle, display_name, bio, followers_count, following_count,
            public_metrics_json, location, raw_json
          from profiles
          where id = 'profile_user_42'
        `,
				)
				.get(),
		).toEqual({
			handle: "real42",
			display_name: "Real Group Sender",
			bio: "Hydrated bio",
			followers_count: 321,
			following_count: 54,
			public_metrics_json: '{"followers_count":321,"following_count":54}',
			location: "London",
			raw_json: '{"id":"42","username":"real42","description":"hydrated"}',
		});
	});

	it("merges hydrated profile metadata when archive DM and follower rows overlap", async () => {
		const archivePath = makeFollowDmArchive("900");
		const db = getNativeDb();
		db.prepare(
			`
      insert into profiles (
        id, handle, display_name, bio, followers_count, following_count,
        avatar_hue, avatar_url, created_at
      ) values (
        'profile_user_900', 'real900', 'Real User', 'Hydrated bio', 123, 45,
        33, 'https://img.example.com/avatar.jpg', '2026-05-01T00:00:00.000Z'
      )
      `,
		).run();
		db.prepare(
			`
      insert into follow_edges (
        account_id, direction, profile_id, external_user_id, source, current,
        first_seen_at, last_seen_at, ended_at, updated_at
      ) values (
        'acct_primary', 'followers', 'profile_user_900', '900', 'xurl', 1,
        '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', null,
        '2026-05-01T00:00:00.000Z'
      )
      `,
		).run();

		await importArchive(archivePath);

		expect(
			db
				.prepare(
					`
          select handle, display_name, bio, followers_count, following_count,
            avatar_hue, avatar_url
          from profiles
          where id = 'profile_user_900'
        `,
				)
				.get(),
		).toEqual({
			handle: "real900",
			display_name: "Real User",
			bio: "Hydrated bio",
			followers_count: 123,
			following_count: 45,
			avatar_hue: 33,
			avatar_url: "https://img.example.com/avatar.jpg",
		});
	});

	it("preserves absent archive follower rows unless restoring", async () => {
		const firstArchivePath = makeFollowArchive({
			followers: ["101", "102"],
			includeFollowing: false,
		});
		const secondArchivePath = makeFollowArchive({
			following: ["201"],
			includeFollowers: false,
		});

		await importArchive(firstArchivePath);
		const db = getNativeDb();
		expect(
			(
				db
					.prepare(
						`
            select count(*) as count
            from follow_events
            where direction = 'followers'
              and snapshot_id = 'follow_snapshot_archive_acct_primary_followers'
          `,
					)
					.get() as { count: number }
			).count,
		).toBe(2);
		db.prepare(
			`
      insert into follow_edges (
        account_id, direction, profile_id, external_user_id, source, current,
        first_seen_at, last_seen_at, ended_at, updated_at
      ) values (
        'acct_primary', 'followers', 'profile_user_900', '900', 'xurl', 1,
        '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', null,
        '2026-05-01T00:00:00.000Z'
      )
      `,
		).run();

		await importArchive(secondArchivePath);

		expect(
			db
				.prepare(
					`
          select external_user_id, source, current
          from follow_edges
          where direction = 'followers'
          order by external_user_id
        `,
				)
				.all(),
		).toEqual([
			{ external_user_id: "101", source: "archive", current: 1 },
			{ external_user_id: "102", source: "archive", current: 1 },
			{ external_user_id: "900", source: "xurl", current: 1 },
		]);
		const partialArchivePath = makeFollowArchive({
			followers: ["102", "103", "103"],
			includeFollowing: false,
		});
		await importArchive(partialArchivePath);
		expect(
			db
				.prepare(
					`
          select external_user_id, source, current
          from follow_edges
          where direction = 'followers'
          order by external_user_id
        `,
				)
				.all(),
		).toEqual([
			{ external_user_id: "101", source: "archive", current: 1 },
			{ external_user_id: "102", source: "archive", current: 1 },
			{ external_user_id: "103", source: "archive", current: 1 },
			{ external_user_id: "900", source: "xurl", current: 1 },
		]);

		await importArchive(secondArchivePath, { restore: true });

		expect(
			db
				.prepare(
					`
          select external_user_id, source, current
          from follow_edges
          where direction = 'followers'
          order by external_user_id
        `,
				)
				.all(),
		).toEqual([{ external_user_id: "900", source: "xurl", current: 1 }]);
		expect(
			(
				db
					.prepare(
						`
            select count(*) as count
            from follow_snapshots
            where direction = 'followers' and source = 'archive'
          `,
					)
					.get() as { count: number }
			).count,
		).toBe(0);
		expect(
			(
				db
					.prepare(
						`
            select count(*) as count
            from follow_snapshot_members
            where snapshot_id like 'follow_snapshot_archive_acct_primary_followers%'
          `,
					)
					.get() as { count: number }
			).count,
		).toBe(0);
		expect(
			(
				db
					.prepare(
						`
            select count(*) as count
            from follow_events
            where direction = 'followers'
              and snapshot_id = 'follow_snapshot_archive_acct_primary_followers'
          `,
					)
					.get() as { count: number }
			).count,
		).toBe(0);
		expect(
			db
				.prepare(
					"select id from profiles where id in ('profile_user_101', 'profile_user_102') order by id",
				)
				.all(),
		).toEqual([]);
	});

	it("preserves live follower source when an overlapping archive is later absent", async () => {
		const firstArchivePath = makeFollowArchive({
			followers: ["900"],
			includeFollowing: false,
		});
		const secondArchivePath = makeFollowArchive({
			following: ["201"],
			includeFollowers: false,
		});
		const db = getNativeDb();
		db.prepare(
			`
      insert into follow_edges (
        account_id, direction, profile_id, external_user_id, source, current,
        first_seen_at, last_seen_at, ended_at, updated_at
      ) values (
        'acct_primary', 'followers', 'profile_user_900', '900', 'xurl', 1,
        '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', null,
        '2026-05-01T00:00:00.000Z'
      )
      `,
		).run();

		await importArchive(firstArchivePath);
		expect(
			db
				.prepare(
					`
          select external_user_id, source, current
          from follow_edges
          where direction = 'followers'
        `,
				)
				.all(),
		).toEqual([{ external_user_id: "900", source: "xurl", current: 1 }]);

		await importArchive(secondArchivePath);

		expect(
			db
				.prepare(
					`
          select external_user_id, source, current
          from follow_edges
          where direction = 'followers'
        `,
				)
				.all(),
		).toEqual([{ external_user_id: "900", source: "xurl", current: 1 }]);
		expect(
			(
				db
					.prepare(
						`
            select count(*) as count
            from follow_edges
            where direction = 'followers' and source = 'archive'
          `,
					)
					.get() as { count: number }
			).count,
		).toBe(0);
	});

	it("does not end live follow edges absent from a merge archive", async () => {
		const archivePath = makeFollowArchive({
			followers: ["101"],
			includeFollowing: false,
		});
		const db = getNativeDb();
		db.prepare(
			`
      insert into follow_edges (
        account_id, direction, profile_id, external_user_id, source, current,
        first_seen_at, last_seen_at, ended_at, updated_at
      ) values
        ('acct_primary', 'followers', 'profile_user_101', '101', 'xurl', 1, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', null, '2026-05-01T00:00:00.000Z'),
        ('acct_primary', 'followers', 'profile_user_900', '900', 'xurl', 1, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', null, '2026-05-01T00:00:00.000Z')
      `,
		).run();

		await importArchive(archivePath);
		const rows = db
			.prepare(
				`
        select profile_id, source, current
        from follow_edges
        where direction = 'followers'
        order by profile_id
        `,
			)
			.all();
		const events = db
			.prepare("select external_user_id, kind from follow_events")
			.all();

		expect(rows).toEqual([
			{ profile_id: "profile_user_101", source: "xurl", current: 1 },
			{ profile_id: "profile_user_900", source: "xurl", current: 1 },
		]);
		expect(events).toEqual([]);
		expect(
			listUnfollowedSince({ date: "2000-01-01" }).items.map(
				(item) => item.profile.handle,
			),
		).toEqual([]);

		await importArchive(archivePath, { restore: true });
		expect(
			db
				.prepare(
					"select profile_id, source, current from follow_edges where direction = 'followers' order by profile_id",
				)
				.all(),
		).toEqual([
			{ profile_id: "profile_user_101", source: "xurl", current: 1 },
			{ profile_id: "profile_user_900", source: "xurl", current: 0 },
		]);
		expect(
			listFollowEvents({
				direction: "followers",
				kind: "ended",
				since: "2000-01-01",
			}).items.map((item) => ({
				kind: item.kind,
				handle: item.profile.handle,
			})),
		).toEqual([{ kind: "ended", handle: "id900" }]);
	});

	it("covers parsing helpers and fallback normalizers", () => {
		expect(__test__.normalizeArchivePath("data\\tweets.js")).toBe(
			"data/tweets.js",
		);
		expect(
			__test__.getFirstEntry(["root/data/account.js"], /data\/account\.js$/),
		).toBe("root/data/account.js");
		expect(
			__test__.getMatchingEntries(
				["root/data/like.js", "root/data/bookmark.js"],
				/data\/(?:like|bookmark)\.js$/,
			),
		).toEqual(["root/data/like.js", "root/data/bookmark.js"]);
		expect(__test__.extractArchiveJson("oops")).toEqual([]);
		expect(__test__.parseArchiveArray("window.YTD.x = {}")).toEqual([]);
		expect(__test__.parseTwitterDate("not-a-date")).toBe(
			"1970-01-01T00:00:00.000Z",
		);
		expect(__test__.parseTwitterDate("")).toBe("1970-01-01T00:00:00.000Z");
		expect(__test__.parseTwitterDate(null)).toBe("1970-01-01T00:00:00.000Z");
		expect(__test__.parseTwitterDate("2026-05-01T12:00:00.000Z")).toBe(
			"2026-05-01T12:00:00.000Z",
		);
		expect(__test__.compareIsoTimestamp("2026-01-01", "2026-01-02")).toBe(-1);
		expect(__test__.compareIsoTimestamp("2026-01-02", "2026-01-01")).toBe(1);
		expect(__test__.compareIsoTimestamp("2026-01-01", "2026-01-01")).toBe(0);
		expect(__test__.asRecord(null)).toBeNull();
		expect(__test__.asRecord([])).toBeNull();
		expect(__test__.asArray("oops")).toEqual([]);
		expect(__test__.toInt("oops")).toBe(0);
		expect(
			__test__.getTweetMediaCount({
				entities: { media: [{ id: 1 }] },
				extended_entities: { media: [{ id: 1 }, { id: 2 }] },
			}),
		).toBe(2);
		expect(
			__test__.buildAccountPayload(
				{ account: { accountId: "1", username: "peter" } },
				null,
			),
		).toMatchObject({
			accountId: "1",
			username: "peter",
			displayName: "peter",
			bio: "",
		});
		expect(__test__.buildAccountPayload(null, null)).toMatchObject({
			accountId: "unknown",
			username: "unknown",
			displayName: "Unknown",
			bio: "",
		});
		expect(
			__test__.buildAccountPayload(
				{
					account: {
						accountId: "2",
						username: "sam",
						name: "Sam",
						createdAt: "not a date",
					},
				},
				{ profile: { description: { bio: "Bio" } } },
			),
		).toMatchObject({
			accountId: "2",
			username: "sam",
			displayName: "Sam",
			createdAt: "1970-01-01T00:00:00.000Z",
			bio: "Bio",
		});
		expect(
			__test__.inferProfileFromDirectory("42", new Map([["42", {}]])),
		).toEqual({
			handle: "id42",
			displayName: "id42",
		});
		expect(
			__test__.inferProfileFromDirectory(
				"42",
				new Map([["42", { handle: "@sam", displayName: "Sam" }]]),
			),
		).toEqual({
			handle: "sam",
			displayName: "Sam",
		});
		expect(__test__.extractCollectionTweet({}, "like")).toBeNull();
		expect(
			__test__.extractCollectionTweet(
				{ like: { fullText: "missing id" } },
				"like",
			),
		).toBeNull();
		expect(
			__test__.extractCollectionTweet(
				{
					tweet: {
						id: "42",
						text: "collection fallback",
						created_at: "2026-05-01T00:00:00.000Z",
						like_count: "4",
					},
				},
				"bookmark",
			),
		).toEqual({
			id: "42",
			text: "collection fallback",
			createdAt: "2026-05-01T00:00:00.000Z",
			likeCount: 4,
		});
		expect(
			__test__.extractCollectionTweet(
				{
					bookmark: {
						id_str: "43",
						expanded_url: "https://example.com/bookmark",
						createdAt: "2026-05-02T00:00:00.000Z",
						favorite_count: "9",
					},
				},
				"bookmark",
			),
		).toEqual({
			id: "43",
			text: "https://example.com/bookmark",
			createdAt: "2026-05-02T00:00:00.000Z",
			likeCount: 9,
		});
		expect(
			__test__.extractCollectionTweet(
				{
					like: {
						tweet_id: "44",
						full_text: "fallback text",
						created_at: "2026-05-03T00:00:00.000Z",
					},
				},
				"like",
			),
		).toMatchObject({
			id: "44",
			text: "fallback text",
			createdAt: "2026-05-03T00:00:00.000Z",
		});
		expect(
			__test__.extractTweetEntities({
				entities: {
					urls: [
						{
							url: "https://t.co/demo",
							expanded_url: "https://example.com/demo",
							display_url: "example.com/demo",
							indices: [12, 29],
							title: "Demo",
							description: "Preview",
						},
					],
					user_mentions: [
						{
							screen_name: "sam",
							id_str: "42",
							indices: [0, 4],
						},
					],
					hashtags: [
						{
							text: "birdclaw",
							indices: [30, 39],
						},
					],
				},
			}),
		).toEqual({
			urls: [
				{
					url: "https://t.co/demo",
					expandedUrl: "https://example.com/demo",
					displayUrl: "example.com/demo",
					start: 12,
					end: 29,
					title: "Demo",
					description: "Preview",
				},
			],
			mentions: [
				{
					username: "sam",
					id: "42",
					start: 0,
					end: 4,
				},
			],
			hashtags: [
				{
					tag: "birdclaw",
					start: 30,
					end: 39,
				},
			],
		});
		expect(
			__test__.extractTweetEntities({
				entities: {
					urls: [
						{
							expandedUrl: "https://example.com/camel",
							displayUrl: "example.com/camel",
						},
						{
							url: "",
						},
					],
					user_mentions: [
						{
							screen_name: "",
							id: 7,
						},
					],
					hashtags: [
						{
							text: "",
						},
					],
				},
			}),
		).toEqual({
			urls: [
				{
					url: "",
					expandedUrl: "https://example.com/camel",
					displayUrl: "example.com/camel",
					start: 0,
					end: 0,
					title: undefined,
					description: null,
				},
			],
		});
		expect(__test__.extractTweetEntities({ entities: null })).toEqual({});
		expect(
			__test__.extractTweetMedia({
				extended_entities: {
					media: [
						{
							media_url_https: "https://example.com/one.jpg",
							url: "https://t.co/one",
							type: "photo",
							ext_alt_text: "One",
						},
						{
							media_url_https: "https://example.com/two.mp4",
							url: "https://t.co/two",
							type: "video",
						},
					],
				},
				entities: {
					media: [
						{
							media_url_https: "https://example.com/one.jpg",
							url: "https://t.co/one",
							type: "photo",
						},
						{
							media_url: "https://example.com/three.gif",
							url: "https://t.co/three",
							type: "animated_gif",
						},
						{
							media_url: "https://example.com/four.bin",
							url: "https://t.co/four",
							type: "mystery",
						},
					],
				},
			}),
		).toEqual([
			{
				url: "https://example.com/one.jpg",
				type: "image",
				altText: "One",
				thumbnailUrl: "https://example.com/one.jpg",
			},
			{
				url: "https://example.com/two.mp4",
				type: "video",
				altText: undefined,
				thumbnailUrl: "https://example.com/two.mp4",
			},
			{
				url: "https://example.com/three.gif",
				type: "gif",
				altText: undefined,
				thumbnailUrl: "https://example.com/three.gif",
			},
			{
				url: "https://example.com/four.bin",
				type: "unknown",
				altText: undefined,
				thumbnailUrl: "https://example.com/four.bin",
			},
		]);
		expect(
			__test__.extractTweetMedia({
				entities: {
					media: [
						{
							url: "https://t.co/thumb",
							type: "photo",
						},
						{
							media_url: "",
							url: "",
							type: "photo",
						},
						{
							media_url_https: "https://example.com/dupe.jpg",
							url: "https://t.co/dupe",
							type: "photo",
						},
						{
							media_url_https: "https://example.com/dupe.jpg",
							url: "https://t.co/dupe2",
							type: "photo",
						},
					],
				},
			}),
		).toEqual([
			{
				url: "https://t.co/thumb",
				type: "image",
				altText: undefined,
				thumbnailUrl: "https://t.co/thumb",
			},
			{
				url: "https://example.com/dupe.jpg",
				type: "image",
				altText: undefined,
				thumbnailUrl: "https://example.com/dupe.jpg",
			},
		]);
	});

	it("throws when account.js is missing", async () => {
		const archivePath = makeArchiveWithoutAccount();

		await expect(importArchive(archivePath)).rejects.toThrow(
			"Archive missing data/account.js",
		);
	});

	it("imports archives whose data directory is at zip root", async () => {
		const archivePath = makeRootDataArchive();

		const result = await importArchive(archivePath);
		const db = getNativeDb();
		const rootMediaPath = path.join(
			getBirdclawPaths().mediaOriginalsDir,
			"archive",
			"tweets",
			"rootmedia",
			"rootmedia-archive.jpg",
		);

		expect(result.counts.tweets).toBe(1);
		expect(result.counts.dmMessages).toBe(1);
		expect(result.counts.mediaFiles.tweets).toBe(1);
		expect(readFileSync(rootMediaPath, "utf8")).toBe("root-media");
		expect(
			(
				db
					.prepare(
						"select count(*) as count from tweets_fts where tweets_fts match 'root'",
					)
					.get() as { count: number }
			).count,
		).toBe(1);
		expect(
			(
				db
					.prepare(
						"select count(*) as count from dm_fts where dm_fts match 'root'",
					)
					.get() as { count: number }
			).count,
		).toBe(1);
		expect(
			(
				db.prepare("select count(*) as count from link_occurrences").get() as {
					count: number;
				}
			).count,
		).toBe(0);
		expect(
			(
				db.prepare("select count(*) as count from url_expansions").get() as {
					count: number;
				}
			).count,
		).toBe(0);
	});

	it("handles missing profile data, split likes files, and group dm edge cases", async () => {
		const archivePath = makeWeirdArchive();

		const result = await importArchive(archivePath);
		const db = getNativeDb();
		const tweets = listTimelineItems({ resource: "home", limit: 10 });
		const dms = listDmConversations({ limit: 10 });
		const group = dms.find((item) => item.id === "group-live");

		expect(result.counts.tweets).toBe(1);
		expect(result.counts.likes).toBe(1);
		expect(tweets[0]?.text).toBe("fallback note");
		expect(tweets[0]?.createdAt).toBe("1970-01-01T00:00:00.000Z");
		expect(
			(
				db.prepare("select count(*) as count from dm_conversations").get() as {
					count: number;
				}
			).count,
		).toBe(1);
		expect(group?.participant.displayName).toBe("Core Team");
		expect(group?.participant.bio).toContain("2 participants");
	});
});
