import type { Database } from "./sqlite";

export const ARCHIVE_DELETION_SOURCE = "twitter_archive";
export const ARCHIVE_DELETION_REASON = "explicit_deleted_tweet_record";
export const PARENT_DELETION_REASON = "parent_tweet_deleted";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: null;
}

function stringArray(value: unknown) {
	return Array.isArray(value)
		? value
				.map((item) => String(item ?? "").trim())
				.filter((item) => item.length > 0)
		: [];
}

export function editHistoryIdsFromPayload(tweetId: string, payload: unknown) {
	const record = asRecord(payload);
	const legacyHistory = asRecord(record?.edit_history);
	const archiveEditInfo = asRecord(record?.edit_info);
	const archiveInitial = asRecord(archiveEditInfo?.initial);
	const archiveEdit = asRecord(archiveEditInfo?.edit);
	const archiveEditControl = asRecord(archiveEdit?.editControlInitial);
	const ids = [
		...stringArray(archiveInitial?.editTweetIds),
		...stringArray(archiveEditControl?.editTweetIds),
		...stringArray(record?.edit_history_tweet_ids),
		...stringArray(legacyHistory?.edit_tweet_ids),
	];
	const initialTweetId = String(archiveEdit?.initialTweetId ?? "").trim();
	if (initialTweetId && !ids.includes(initialTweetId))
		ids.unshift(initialTweetId);
	const unique = Array.from(new Set(ids));
	if (!unique.includes(tweetId)) unique.push(tweetId);
	return unique.length > 0 ? unique : [tweetId];
}

export function recordTweetRevision(
	db: Database,
	{
		tweetId,
		editHistoryIds,
		payloadJson,
		source,
		observedAt,
	}: {
		tweetId: string;
		editHistoryIds: readonly string[];
		payloadJson: string | null;
		source: string;
		observedAt: string;
	},
) {
	const ids = Array.from(
		new Set(
			[...editHistoryIds, tweetId]
				.map((id) => id.trim())
				.filter((id) => id.length > 0),
		),
	);
	const rootTweetId = ids[0] ?? tweetId;
	const insert = db.prepare(`
		insert into tweet_revisions (
			root_tweet_id, revision_id, revision_index, payload_json, source, observed_at
		) values (?, ?, ?, ?, ?, ?)
		on conflict(revision_id) do update set
			root_tweet_id = case
				when tweet_revisions.root_tweet_id = tweet_revisions.revision_id
					and excluded.root_tweet_id <> excluded.revision_id
					then excluded.root_tweet_id
				else tweet_revisions.root_tweet_id
			end,
			revision_index = case
				when tweet_revisions.root_tweet_id = tweet_revisions.revision_id
					and excluded.root_tweet_id <> excluded.revision_id
					then excluded.revision_index
				else tweet_revisions.revision_index
			end,
			payload_json = coalesce(tweet_revisions.payload_json, excluded.payload_json),
			source = case
				when tweet_revisions.payload_json is null and excluded.payload_json is not null
					then excluded.source
				else tweet_revisions.source
			end,
			observed_at = max(tweet_revisions.observed_at, excluded.observed_at)
	`);
	ids.forEach((revisionId, revisionIndex) => {
		insert.run(
			rootTweetId,
			revisionId,
			revisionIndex,
			revisionId === tweetId ? payloadJson : null,
			source,
			observedAt,
		);
	});
	const terminalRevisionId = ids.at(-1) ?? tweetId;
	const markSuperseded = db.prepare(`
		update tweets
		set superseded_at = case
				when superseded_at is null or superseded_at > ? then ?
				else superseded_at
			end,
			superseded_by_id = ?
		where id = ?
	`);
	for (const revisionId of ids.slice(0, -1)) {
		markSuperseded.run(observedAt, observedAt, terminalRevisionId, revisionId);
	}
}

function mediaIdentifiers(mediaJson: string) {
	let parsed: unknown;
	try {
		parsed = JSON.parse(mediaJson);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const identifiers = parsed.flatMap((item, index) => {
		const media = asRecord(item);
		if (!media) return [];
		for (const key of ["media_key", "mediaKey", "id_str", "id", "url"]) {
			const value = media[key];
			if (typeof value === "string" && value.length > 0) return [value];
		}
		return [`media:${String(index)}`];
	});
	return Array.from(new Set(identifiers));
}

export function tombstoneTweetSubordinates(
	db: Database,
	{
		tweetId,
		deletedAt,
		deletionSource,
		deletionReason = PARENT_DELETION_REASON,
	}: {
		tweetId: string;
		deletedAt: string;
		deletionSource: string;
		deletionReason?: string;
	},
) {
	const tweet = db
		.prepare("select media_json, quoted_tweet_id from tweets where id = ?")
		.get(tweetId) as
		| { media_json: string; quoted_tweet_id: string | null }
		| undefined;
	if (!tweet) return;
	const rows = [
		...mediaIdentifiers(tweet.media_json).map((subordinateId) => ({
			kind: "media",
			subordinateId,
		})),
		...(tweet.quoted_tweet_id
			? [{ kind: "quote", subordinateId: tweet.quoted_tweet_id }]
			: []),
	];
	const insert = db.prepare(`
		insert into tweet_subordinate_tombstones (
			tweet_id, kind, subordinate_id, deleted_at, deletion_source, deletion_reason
		) values (?, ?, ?, ?, ?, ?)
		on conflict(tweet_id, kind, subordinate_id) do update set
			deleted_at = min(tweet_subordinate_tombstones.deleted_at, excluded.deleted_at),
			deletion_source = coalesce(tweet_subordinate_tombstones.deletion_source, excluded.deletion_source),
			deletion_reason = coalesce(tweet_subordinate_tombstones.deletion_reason, excluded.deletion_reason)
	`);
	for (const row of rows) {
		insert.run(
			tweetId,
			row.kind,
			row.subordinateId,
			deletedAt,
			deletionSource,
			deletionReason,
		);
	}
}

export function reconcileTweetTombstones(db: Database) {
	db.exec(`
		update tweets
		set superseded_at = coalesce(
				superseded_at,
				(
					select min(newer.observed_at)
					from tweet_revisions current_revision
					join tweet_revisions newer
						on newer.root_tweet_id = current_revision.root_tweet_id
						and newer.revision_index > current_revision.revision_index
					where current_revision.revision_id = tweets.id
				)
			),
			superseded_by_id = (
					select latest.revision_id
					from tweet_revisions current_revision
					join tweet_revisions latest
						on latest.root_tweet_id = current_revision.root_tweet_id
					where current_revision.revision_id = tweets.id
					order by latest.revision_index desc
					limit 1
			)
		where exists (
			select 1
			from tweet_revisions current_revision
			join tweet_revisions newer
				on newer.root_tweet_id = current_revision.root_tweet_id
				and newer.revision_index > current_revision.revision_index
			where current_revision.revision_id = tweets.id
		);
	`);
	const deletedTweets = db
		.prepare(`
			select id, deleted_at, deletion_source
			from tweets
			where deleted_at is not null
		`)
		.all() as Array<{
		id: string;
		deleted_at: string;
		deletion_source: string | null;
	}>;
	for (const tweet of deletedTweets) {
		tombstoneTweetSubordinates(db, {
			tweetId: tweet.id,
			deletedAt: tweet.deleted_at,
			deletionSource: tweet.deletion_source ?? "import",
		});
	}
	const revisionsOfDeletedTweets = db
		.prepare(`
			select earlier.id, terminal.deleted_at, terminal.deletion_source
			from tweets earlier
			join tweet_revisions earlier_revision
				on earlier_revision.revision_id = earlier.id
			join tweet_revisions terminal_revision
				on terminal_revision.root_tweet_id = earlier_revision.root_tweet_id
			join tweets terminal on terminal.id = terminal_revision.revision_id
			where terminal_revision.revision_index = (
				select max(candidate.revision_index)
				from tweet_revisions candidate
				where candidate.root_tweet_id = earlier_revision.root_tweet_id
			)
			and terminal.deleted_at is not null
			and earlier.id <> terminal.id
		`)
		.all() as Array<{
		id: string;
		deleted_at: string;
		deletion_source: string | null;
	}>;
	for (const tweet of revisionsOfDeletedTweets) {
		tombstoneTweetSubordinates(db, {
			tweetId: tweet.id,
			deletedAt: tweet.deleted_at,
			deletionSource: tweet.deletion_source ?? "revision_parent",
		});
	}
	db.exec(`
		delete from tweets_fts
		where tweet_id in (
			select id from tweets
			where deleted_at is not null or superseded_at is not null
		);
		delete from link_occurrences
		where source_kind = 'tweet'
			and source_id in (
				select id from tweets
				where deleted_at is not null or superseded_at is not null
			);
	`);
}
