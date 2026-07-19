// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { ingestTweetPayload } from "./tweet-repository";
import { editHistoryIdsFromPayload } from "./tweet-retention";

let tempRoot: string | undefined;

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	if (tempRoot) {
		rmSync(tempRoot, { recursive: true, force: true });
		tempRoot = undefined;
	}
});

it("marks only primary replies as replied", () => {
	tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-test-"));
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
	const db = getNativeDb();

	ingestTweetPayload(db, {
		accountId: "acct_primary",
		markRepliesAsReplied: true,
		source: "xurl",
		payload: {
			data: [
				{
					id: "liked_reply",
					author_id: "42",
					text: "primary reply quoting context",
					created_at: "2026-07-01T10:00:00.000Z",
					referenced_tweets: [
						{ type: "replied_to", id: "primary_parent" },
						{ type: "quoted", id: "quoted_reply" },
					],
				},
			],
			includes: {
				users: [
					{ id: "42", username: "sam", name: "Sam" },
					{ id: "43", username: "alex", name: "Alex" },
				],
				tweets: [
					{
						id: "quoted_reply",
						author_id: "43",
						text: "included reply used only as quote context",
						created_at: "2026-07-01T09:00:00.000Z",
						referenced_tweets: [{ type: "replied_to", id: "quoted_parent" }],
					},
				],
			},
		},
	});

	expect(
		db
			.prepare(
				"select id, is_replied, reply_to_id from tweets where id in (?, ?) order by id",
			)
			.all("liked_reply", "quoted_reply"),
	).toEqual([
		{ id: "liked_reply", is_replied: 1, reply_to_id: "primary_parent" },
		{ id: "quoted_reply", is_replied: 0, reply_to_id: "quoted_parent" },
	]);
});

it("records observable edit chains without re-indexing a tombstoned tweet", () => {
	tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-test-"));
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
	const db = getNativeDb({ seedDemoData: false });

	ingestTweetPayload(db, {
		accountId: "acct_primary",
		edgeKind: "home",
		source: "xurl",
		payload: {
			data: [
				{
					id: "edit-1",
					author_id: "42",
					text: "original body",
					created_at: "2026-07-01T09:00:00.000Z",
				},
			],
			includes: {
				users: [{ id: "42", username: "sam", name: "Sam" }],
			},
		},
	});
	ingestTweetPayload(db, {
		accountId: "acct_primary",
		edgeKind: "home",
		source: "xurl",
		payload: {
			data: [
				{
					id: "edit-2",
					author_id: "42",
					text: "edited body",
					created_at: "2026-07-01T10:00:00.000Z",
					edit_history_tweet_ids: ["edit-1", "edit-2"],
					attachments: { media_keys: ["media-1"] },
					referenced_tweets: [{ type: "quoted", id: "quote-1" }],
				},
			],
			includes: {
				users: [{ id: "42", username: "sam", name: "Sam" }],
				media: [
					{
						media_key: "media-1",
						type: "photo",
						url: "https://pbs.twimg.com/media/edit.jpg",
					},
				],
			},
		},
	});
	db.prepare(
		"update tweets set deleted_at = ?, deletion_reason = ? where id = ?",
	).run("2026-07-02T00:00:00.000Z", "explicit_delete", "edit-2");

	ingestTweetPayload(db, {
		accountId: "acct_primary",
		source: "xurl",
		payload: {
			data: [
				{
					id: "edit-2",
					author_id: "42",
					text: "edited body",
					created_at: "2026-07-01T10:00:00.000Z",
					edit_history_tweet_ids: ["edit-1", "edit-2"],
					attachments: { media_keys: ["media-1"] },
					referenced_tweets: [{ type: "quoted", id: "quote-1" }],
				},
			],
			includes: {
				users: [{ id: "42", username: "sam", name: "Sam" }],
				media: [
					{
						media_key: "media-1",
						type: "photo",
						url: "https://pbs.twimg.com/media/edit.jpg",
					},
				],
			},
		},
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
	expect(
		db
			.prepare(
				"select count(*) as count from tweets_fts where tweet_id = 'edit-2'",
			)
			.get(),
	).toEqual({ count: 0 });
	expect(
		db
			.prepare(
				"select kind, subordinate_id from tweet_subordinate_tombstones where tweet_id = 'edit-2' order by kind",
			)
			.all(),
	).toEqual([
		{
			kind: "media",
			subordinate_id: "https://pbs.twimg.com/media/edit.jpg",
		},
		{ kind: "quote", subordinate_id: "quote-1" },
	]);
});

it("reads both X archive edit-info variants", () => {
	expect(
		editHistoryIdsFromPayload("edit-2", {
			edit_info: {
				initial: { editTweetIds: ["edit-1", "edit-2"] },
			},
		}),
	).toEqual(["edit-1", "edit-2"]);
	expect(
		editHistoryIdsFromPayload("edit-3", {
			edit_info: {
				edit: {
					initialTweetId: "edit-1",
					editControlInitial: {
						editTweetIds: ["edit-1", "edit-2", "edit-3"],
					},
				},
			},
		}),
	).toEqual(["edit-1", "edit-2", "edit-3"]);
});
