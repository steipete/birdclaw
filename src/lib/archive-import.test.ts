// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __test__, importArchive } from "./archive-import";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { listFollowEvents, listUnfollowedSince } from "./follow-graph";
import {
	getQueryEnvelope,
	listDmConversations,
	listTimelineItems,
} from "./queries";

const createdDirs: string[] = [];

function makeArchive() {
	const root = mkdtempSync(path.join(os.tmpdir(), "birdclaw-archive-"));
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
  { "like": { "tweetId": "5", "fullText": "liked archive item", "likedAt": "2025-06-03T20:00:00.000Z" } }
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

	const archivePath = path.join(root, "archive.zip");
	execFileSync("zip", ["-qr", archivePath, "sample"], { cwd: root });
	createdDirs.push(root);
	return archivePath;
}

function makeArchiveWithoutAccount() {
	const root = mkdtempSync(path.join(os.tmpdir(), "birdclaw-archive-empty-"));
	const archiveDir = path.join(root, "sample", "data");
	mkdirSync(archiveDir, { recursive: true });
	writeFileSync(
		path.join(archiveDir, "tweets.js"),
		'window.YTD.tweets.part0 = [{ "tweet": { "id_str": "1", "created_at": "Tue Jun 03 19:32:20 +0000 2025", "full_text": "hello" } }]',
	);
	const archivePath = path.join(root, "archive.zip");
	execFileSync("zip", ["-qr", archivePath, "sample"], { cwd: root });
	createdDirs.push(root);
	return archivePath;
}

function makeRootDataArchive() {
	const root = mkdtempSync(path.join(os.tmpdir(), "birdclaw-archive-root-"));
	const archiveDir = path.join(root, "data");
	mkdirSync(archiveDir, { recursive: true });

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
	const archivePath = path.join(root, "archive.zip");
	execFileSync("zip", ["-qr", archivePath, "data"], { cwd: root });
	createdDirs.push(root);
	return archivePath;
}

function makeWeirdArchive() {
	const root = mkdtempSync(path.join(os.tmpdir(), "birdclaw-archive-weird-"));
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

	const archivePath = path.join(root, "archive.zip");
	execFileSync("zip", ["-qr", archivePath, "sample"], { cwd: root });
	createdDirs.push(root);
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
	const root = mkdtempSync(path.join(os.tmpdir(), "birdclaw-archive-follow-"));
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
	createdDirs.push(root);
	return archivePath;
}

describe("archive import", () => {
	afterEach(() => {
		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		for (const directory of createdDirs.splice(0)) {
			rmSync(directory, { recursive: true, force: true });
		}
		delete process.env.BIRDCLAW_HOME;
	});

	it("imports tweets, dms, profiles, and envelope stats from a zip archive", async () => {
		const archivePath = makeArchive();
		const homeDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-home-"));
		createdDirs.push(homeDir);
		process.env.BIRDCLAW_HOME = homeDir;
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

		const result = await importArchive(archivePath);
		const db = getNativeDb();
		const envelope = await getQueryEnvelope();
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

	it("imports follower and following archive files into the follow graph", async () => {
		const archivePath = makeFollowArchive({
			followers: ["101", "102"],
			following: ["102", "103"],
		});
		const homeDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-home-"));
		createdDirs.push(homeDir);
		process.env.BIRDCLAW_HOME = homeDir;

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
			"followers:archive:complete:2",
			"following:archive:complete:2",
		]);
		expect(
			db
				.prepare(
					"select handle, display_name, bio from profiles where id = 'profile_user_101'",
				)
				.get(),
		).toEqual({ handle: "id101", display_name: "", bio: "" });
	});

	it("handles empty follower and following files", async () => {
		const archivePath = makeFollowArchive({});
		const homeDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-home-"));
		createdDirs.push(homeDir);
		process.env.BIRDCLAW_HOME = homeDir;

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
		const homeDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-home-"));
		createdDirs.push(homeDir);
		process.env.BIRDCLAW_HOME = homeDir;

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

	it("clears archive follower rows when follower file is absent", async () => {
		const firstArchivePath = makeFollowArchive({
			followers: ["101", "102"],
			includeFollowing: false,
		});
		const secondArchivePath = makeFollowArchive({
			following: ["201"],
			includeFollowers: false,
		});
		const homeDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-home-"));
		createdDirs.push(homeDir);
		process.env.BIRDCLAW_HOME = homeDir;

		await importArchive(firstArchivePath);
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
	});

	it("keeps live follow source on xurl edges absent from the archive", async () => {
		const archivePath = makeFollowArchive({
			followers: ["101"],
			includeFollowing: false,
		});
		const homeDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-home-"));
		createdDirs.push(homeDir);
		process.env.BIRDCLAW_HOME = homeDir;
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
			{ profile_id: "profile_user_101", source: "archive", current: 1 },
			{ profile_id: "profile_user_900", source: "xurl", current: 0 },
		]);
		expect(events).toEqual([{ external_user_id: "900", kind: "ended" }]);
		expect(
			listUnfollowedSince({ date: "2000-01-01" }).items.map(
				(item) => item.profile.handle,
			),
		).toEqual(["id900"]);
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
		const homeDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-home-"));
		createdDirs.push(homeDir);
		process.env.BIRDCLAW_HOME = homeDir;

		await expect(importArchive(archivePath)).rejects.toThrow(
			"Archive missing data/account.js",
		);
	});

	it("imports archives whose data directory is at zip root", async () => {
		const archivePath = makeRootDataArchive();
		const homeDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-home-"));
		createdDirs.push(homeDir);
		process.env.BIRDCLAW_HOME = homeDir;

		const result = await importArchive(archivePath);
		const db = getNativeDb();

		expect(result.counts.tweets).toBe(1);
		expect(result.counts.dmMessages).toBe(1);
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
		const homeDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-home-"));
		createdDirs.push(homeDir);
		process.env.BIRDCLAW_HOME = homeDir;

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
