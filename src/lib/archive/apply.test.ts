// @vitest-environment node
import { Effect } from "effect";
import { expect, it } from "vitest";
import { useTestHome } from "../../test/test-home";
import {
	ArchiveImportPlan,
	type ArchiveProfileRow,
} from "../archive-import-plan";
import { ImportRepository } from "../import-repository";
import { NativeSqliteDatabase } from "../sqlite";
import { refreshSearchRows } from "../search-index";
import { applyArchiveImportPlanEffect } from "./apply";

const testHome = useTestHome({ seedDemoData: true });
it("indexes merged canonical records once and keeps unrelated entries", async () => {
	const home = testHome();
	void home.db;
	const statements: string[] = [];
	const db = new NativeSqliteDatabase(home.paths.dbPath, {
		onStatement: (sql) => statements.push(sql),
	});
	const localProfile: ArchiveProfileRow = {
		id: "profile_me",
		handle: "steipete",
		displayName: "Synthetic Owner",
		bio: "",
		followersCount: 0,
		followingCount: 0,
		publicMetricsJson: "{}",
		avatarHue: 0,
		avatarUrl: null,
		location: null,
		url: null,
		verifiedType: null,
		entitiesJson: "{}",
		rawJson: "{}",
		createdAt: "2026-01-01T00:00:00Z",
	};
	const plan = new ArchiveImportPlan();
	for (let i = 0; i < 40; i++) {
		plan.tweets.push({
			id: `archive_batch_${i}`,
			kind: "home",
			authorProfileId: "profile_me",
			text: `batchterm full archived body ${i}`,
			createdAt: "2026-01-01T00:00:00Z",
			isReplied: 0,
			replyToId: null,
			likeCount: 0,
			mediaCount: 0,
			bookmarked: 0,
			liked: 0,
			entitiesJson: "{}",
			mediaJson: "[]",
			quotedTweetId: null,
			...(i === 1
				? { deletedAt: "2026-02-01T00:00:00Z", deletionSource: "archive" }
				: {}),
		});
		plan.dmMessages.push({
			id: `archive_dm_${i}`,
			conversationId: "dm_001",
			senderProfileId: "profile_me",
			text: `dmindex ${i}`,
			createdAt: "2026-01-01T00:00:00Z",
			direction: "outbound",
			mediaCount: 0,
		});
	}
	plan.tweets.push({ ...plan.tweets[0]!, kind: "like", text: "short stub" });
	plan.dmMessages.push({
		...plan.dmMessages[0]!,
		text: "dmindex final merged body",
	});
	try {
		db.exec(`
			insert into tweets(id,author_profile_id,text,created_at) values
			('archive_batch_0','profile_me','obsolete',''),('unrelated_sentinel','profile_me','keep tweet','');
			insert into dm_messages(id,conversation_id,sender_profile_id,text,created_at,direction) values
			('archive_dm_0','dm_001','profile_me','obsolete','','inbound'),('unrelated_dm_sentinel','dm_001','profile_me','keep DM','','inbound');
		`);
		refreshSearchRows(db, "tweet", ["archive_batch_0", "unrelated_sentinel"]);
		refreshSearchRows(db, "dm", ["archive_dm_0", "unrelated_dm_sentinel"]);
		statements.length = 0;
		await Effect.runPromise(
			applyArchiveImportPlanEffect({
				archivePath: "synthetic.zip",
				db,
				repository: new ImportRepository(db),
				selection: null,
				includeTweets: true,
				includeLikes: true,
				includeBookmarks: false,
				includeDirectMessages: true,
				includeProfiles: false,
				includeFollowers: false,
				includeFollowing: false,
				accountPayload: {
					accountId: "25401953",
					username: "steipete",
					displayName: "Synthetic Owner",
					createdAt: localProfile.createdAt,
					bio: "",
				},
				localProfile,
				plan,
				resolveProfileId: (id) => id,
				followerEntryCount: 0,
				followingEntryCount: 0,
				onProgress: () => {},
				restore: false,
			}),
		);
		expect(
			statements.filter((sql) => /^\s*delete from tweets_fts/i.test(sql)),
		).toHaveLength(1);
		expect(
			statements.filter((sql) => /^\s*delete from dm_fts/i.test(sql)),
		).toHaveLength(1);
		expect(
			db
				.prepare("select text from tweets_fts where tweet_id='archive_batch_0'")
				.all(),
		).toEqual([{ text: "batchterm full archived body 0" }]);
		expect(
			db
				.prepare(
					"select count(*) count from tweets_fts where tweets_fts match 'batchterm'",
				)
				.get(),
		).toEqual({ count: 39 });
		expect(
			db
				.prepare("select text from dm_fts where message_id='archive_dm_0'")
				.all(),
		).toEqual([{ text: "dmindex final merged body" }]);
		expect(
			db
				.prepare(
					"select count(*) count from dm_fts where dm_fts match 'dmindex'",
				)
				.get(),
		).toEqual({ count: 40 });
		expect(
			db
				.prepare(
					"select text from tweets_fts where tweet_id='unrelated_sentinel'",
				)
				.get(),
		).toEqual({ text: "keep tweet" });
		expect(
			db
				.prepare(
					"select text from dm_fts where message_id='unrelated_dm_sentinel'",
				)
				.get(),
		).toEqual({ text: "keep DM" });
	} finally {
		db.close();
	}
});
