// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { ingestTweetPayload } from "./tweet-repository";
import {
	editHistoryIdsFromPayload,
	mergeTweetRevisionChain,
	recordTweetRevision,
} from "./tweet-retention";

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
		"update tweets set deleted_at = ?, deletion_source = ?, deletion_reason = ? where id = ?",
	).run(
		"2026-07-02T00:00:00.000Z",
		"archive_first",
		"explicit_delete_first",
		"edit-1",
	);
	db.prepare(
		"update tweets set deleted_at = ?, deletion_source = ?, deletion_reason = ? where id = ?",
	).run(
		"2026-07-03T00:00:00.000Z",
		"archive_second",
		"explicit_delete_second",
		"edit-2",
	);

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
				"select id, deleted_at, deletion_source, deletion_reason from tweets where id in ('edit-1', 'edit-2') order by id",
			)
			.all(),
	).toEqual([
		{
			id: "edit-1",
			deleted_at: "2026-07-02T00:00:00.000Z",
			deletion_source: "archive_first",
			deletion_reason: "explicit_delete_first",
		},
		{
			id: "edit-2",
			deleted_at: "2026-07-02T00:00:00.000Z",
			deletion_source: "archive_first",
			deletion_reason: "explicit_delete_first",
		},
	]);
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

it("merges an enriched edit history into one revision chain", () => {
	tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-test-"));
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
	const db = getNativeDb({ seedDemoData: false });
	const users = [{ id: "42", username: "sam", name: "Sam" }];

	ingestTweetPayload(db, {
		accountId: "acct_primary",
		source: "xurl",
		payload: {
			data: [
				{
					id: "edit-3",
					author_id: "42",
					text: "latest body",
					created_at: "2026-07-01T11:00:00.000Z",
					edit_history_tweet_ids: ["edit-2", "edit-3"],
				},
			],
			includes: { users },
		},
	});
	ingestTweetPayload(db, {
		accountId: "acct_primary",
		source: "xurl",
		payload: {
			data: [
				{
					id: "edit-2",
					author_id: "42",
					text: "middle body",
					created_at: "2026-07-01T10:00:00.000Z",
					edit_history_tweet_ids: ["edit-1", "edit-2", "edit-3"],
				},
			],
			includes: { users },
		},
	});

	expect(
		db
			.prepare(
				"select root_tweet_id, revision_id, revision_index from tweet_revisions order by revision_index",
			)
			.all(),
	).toEqual([
		{ root_tweet_id: "edit-1", revision_id: "edit-1", revision_index: 0 },
		{ root_tweet_id: "edit-1", revision_id: "edit-2", revision_index: 1 },
		{ root_tweet_id: "edit-1", revision_id: "edit-3", revision_index: 2 },
	]);
	for (const [id, history] of [
		["gap-3", ["gap-1", "gap-3"]],
		["gap-2", ["gap-1", "gap-2", "gap-3"]],
	] as const) {
		ingestTweetPayload(db, {
			accountId: "acct_primary",
			source: "xurl",
			payload: {
				data: [
					{
						id,
						author_id: "42",
						text: `${id} body`,
						created_at: "2026-07-01T11:00:00.000Z",
						edit_history_tweet_ids: [...history],
					},
				],
				includes: { users },
			},
		});
	}
	expect(
		db
			.prepare(
				"select revision_id, revision_index from tweet_revisions where root_tweet_id = 'gap-1' order by revision_index",
			)
			.all(),
	).toEqual([
		{ revision_id: "gap-1", revision_index: 0 },
		{ revision_id: "gap-2", revision_index: 1 },
		{ revision_id: "gap-3", revision_index: 2 },
	]);
	for (const [id, history] of [
		["branch-b", ["branch-a", "branch-b"]],
		["branch-c", ["branch-a", "branch-c"]],
		["branch-b", ["branch-a", "branch-c", "branch-b"]],
	] as const) {
		ingestTweetPayload(db, {
			accountId: "acct_primary",
			source: "xurl",
			payload: {
				data: [
					{
						id,
						author_id: "42",
						text: `${id} body`,
						created_at: "2026-07-01T11:00:00.000Z",
						edit_history_tweet_ids: [...history],
					},
				],
				includes: { users },
			},
		});
	}
	expect(
		db
			.prepare(
				"select revision_id, revision_index from tweet_revisions where root_tweet_id = 'branch-a' order by revision_index, revision_id",
			)
			.all(),
	).toEqual([
		{ revision_id: "branch-a", revision_index: 0 },
		{ revision_id: "branch-c", revision_index: 1 },
		{ revision_id: "branch-b", revision_index: 2 },
	]);
	db.prepare(
		"update tweets set deleted_at = ?, deletion_source = ?, deletion_reason = ? where id = ?",
	).run(
		"2026-07-02T00:00:00.000Z",
		"twitter_archive",
		"explicit_deleted_tweet_record",
		"edit-2",
	);
	ingestTweetPayload(db, {
		accountId: "acct_primary",
		source: "xurl",
		payload: {
			data: [
				{
					id: "edit-3",
					author_id: "42",
					text: "latest body",
					created_at: "2026-07-01T11:00:00.000Z",
					edit_history_tweet_ids: ["edit-1", "edit-2", "edit-3"],
				},
			],
			includes: { users },
		},
	});
	expect(
		db
			.prepare(
				"select deleted_at, deletion_source from tweets where id = 'edit-3'",
			)
			.get(),
	).toEqual({
		deleted_at: "2026-07-02T00:00:00.000Z",
		deletion_source: "twitter_archive",
	});
});

it("prefers attributed deletion provenance when revision timestamps tie", () => {
	tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-test-"));
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
	const db = getNativeDb({ seedDemoData: false });
	const users = [{ id: "42", username: "sam", name: "Sam" }];
	for (const [id, history] of [
		["edit-1", ["edit-1"]],
		["edit-2", ["edit-1", "edit-2"]],
	] as const) {
		ingestTweetPayload(db, {
			accountId: "acct_primary",
			source: "xurl",
			payload: {
				data: [
					{
						id,
						author_id: "42",
						text: `${id} body`,
						created_at: "2026-07-01T10:00:00.000Z",
						edit_history_tweet_ids: [...history],
					},
				],
				includes: { users },
			},
		});
	}
	const deletedAt = "2026-07-02T00:00:00.000Z";
	db.prepare("update tweets set deleted_at = ? where id = 'edit-1'").run(
		deletedAt,
	);
	db.prepare(
		"update tweets set deleted_at = ?, deletion_source = ?, deletion_reason = ? where id = 'edit-2'",
	).run(deletedAt, "twitter_archive", "explicit_deleted_tweet_record");
	ingestTweetPayload(db, {
		accountId: "acct_primary",
		source: "xurl",
		payload: {
			data: [
				{
					id: "edit-2",
					author_id: "42",
					text: "edit-2 body",
					created_at: "2026-07-01T10:00:00.000Z",
					edit_history_tweet_ids: ["edit-1", "edit-2"],
				},
			],
			includes: { users },
		},
	});
	expect(
		db
			.prepare(
				"select id, deletion_source, deletion_reason from tweets where id in ('edit-1', 'edit-2') order by id",
			)
			.all(),
	).toEqual([
		{
			id: "edit-1",
			deletion_source: "twitter_archive",
			deletion_reason: "explicit_deleted_tweet_record",
		},
		{
			id: "edit-2",
			deletion_source: "twitter_archive",
			deletion_reason: "explicit_deleted_tweet_record",
		},
	]);
});

it("merges edge-connected roots while preserving order outside a cycle", () => {
	tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-test-"));
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
	const db = getNativeDb({ seedDemoData: false });
	db.exec(`
		insert into tweet_revisions (
			root_tweet_id, revision_id, revision_index, payload_json, source, observed_at
		) values
			('cycle-a', 'cycle-a', 0, null, 'test', '2026-07-01T00:00:00.000Z'),
			('cycle-a', 'cycle-b', 1, null, 'test', '2026-07-01T00:00:00.000Z'),
			('cycle-c', 'cycle-c', 0, null, 'test', '2026-07-01T00:00:00.000Z'),
			('cycle-c', 'cycle-d', 1, null, 'test', '2026-07-01T00:00:00.000Z');
		insert into tweet_revision_edges (
			older_revision_id, newer_revision_id, source, observed_at
		) values
			('cycle-a', 'cycle-b', 'test', '2026-07-01T00:00:00.000Z'),
			('cycle-b', 'cycle-c', 'test', '2026-07-01T00:00:00.000Z'),
			('cycle-c', 'cycle-b', 'test', '2026-07-01T00:00:00.000Z'),
			('cycle-c', 'cycle-d', 'test', '2026-07-01T00:00:00.000Z');
	`);

	mergeTweetRevisionChain(db, ["cycle-a"]);

	expect(
		db
			.prepare(
				"select root_tweet_id, revision_id, revision_index from tweet_revisions order by revision_index, revision_id",
			)
			.all(),
	).toEqual([
		{ root_tweet_id: "cycle-a", revision_id: "cycle-a", revision_index: 0 },
		{ root_tweet_id: "cycle-a", revision_id: "cycle-b", revision_index: 1 },
		{ root_tweet_id: "cycle-a", revision_id: "cycle-c", revision_index: 1 },
		{ root_tweet_id: "cycle-a", revision_id: "cycle-d", revision_index: 2 },
	]);
	for (const source of ["archive_observation", "backup_migration"]) {
		recordTweetRevision(db, {
			tweetId: "provenance-b",
			editHistoryIds: ["provenance-a", "provenance-b"],
			payloadJson: null,
			source,
			observedAt: "2026-07-01T00:00:00.000Z",
		});
	}
	expect(
		db
			.prepare(
				"select source from tweet_revision_edges where older_revision_id = 'provenance-a' and newer_revision_id = 'provenance-b'",
			)
			.get(),
	).toEqual({ source: "archive_observation" });
});

it("merges revision components beyond SQLite's traditional variable limit", () => {
	tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-test-"));
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
	const db = getNativeDb({ seedDemoData: false });
	const insertRevision = db.prepare(`
		insert into tweet_revisions (
			root_tweet_id, revision_id, revision_index, payload_json, source, observed_at
		) values (?, ?, 0, null, 'test', '2026-07-01T00:00:00.000Z')
	`);
	const insertEdge = db.prepare(`
		insert into tweet_revision_edges (
			older_revision_id, newer_revision_id, source, observed_at
		) values (?, ?, 'test', '2026-07-01T00:00:00.000Z')
	`);
	for (let index = 0; index < 5_000; index += 1) {
		const revisionId = `scale-${String(index).padStart(4, "0")}`;
		insertRevision.run(revisionId, revisionId);
		if (index > 0) {
			insertEdge.run(`scale-${String(index - 1).padStart(4, "0")}`, revisionId);
		}
	}

	const component = mergeTweetRevisionChain(db, ["scale-0000"]);

	expect(component).toHaveLength(5_000);
	expect(
		db
			.prepare(
				"select count(*) as count, max(revision_index) as max_rank from tweet_revisions where root_tweet_id = 'scale-0000'",
			)
			.get(),
	).toEqual({ count: 5_000, max_rank: 4_999 });
}, 20_000);

it("scopes live tombstone reconciliation to the ingested edit chains", () => {
	tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-test-"));
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
	const db = getNativeDb({ seedDemoData: false });
	const user = [{ id: "42", username: "sam", name: "Sam" }];

	ingestTweetPayload(db, {
		accountId: "acct_primary",
		source: "xurl",
		payload: {
			data: [
				{
					id: "unrelated-edit-1",
					author_id: "42",
					text: "old unrelated revision",
					created_at: "2026-07-01T09:00:00.000Z",
				},
			],
			includes: { users: user },
		},
	});
	ingestTweetPayload(db, {
		accountId: "acct_primary",
		source: "xurl",
		payload: {
			data: [
				{
					id: "unrelated-edit-2",
					author_id: "42",
					text: "new unrelated revision",
					created_at: "2026-07-01T10:00:00.000Z",
					edit_history_tweet_ids: ["unrelated-edit-1", "unrelated-edit-2"],
				},
			],
			includes: { users: user },
		},
	});
	db.prepare(
		"update tweets set superseded_at = null, superseded_by_id = null where id = 'unrelated-edit-1'",
	).run();
	db.prepare(
		"insert into tweets_fts (tweet_id, text) values ('unrelated-edit-1', 'scope sentinel')",
	).run();

	ingestTweetPayload(db, {
		accountId: "acct_primary",
		source: "xurl",
		payload: {
			data: [
				{
					id: "isolated-tweet",
					author_id: "42",
					text: "isolated payload",
					created_at: "2026-07-01T11:00:00.000Z",
				},
			],
			includes: { users: user },
		},
	});

	expect(
		db
			.prepare(
				"select superseded_at, superseded_by_id from tweets where id = 'unrelated-edit-1'",
			)
			.get(),
	).toEqual({ superseded_at: null, superseded_by_id: null });
	expect(
		db
			.prepare(
				"select count(*) as count from tweets_fts where tweet_id = 'unrelated-edit-1'",
			)
			.get(),
	).toEqual({ count: 1 });
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
