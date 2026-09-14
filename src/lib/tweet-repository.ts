import type { Database } from "./sqlite";
import { refreshSearchRows } from "./search-index";
import { buildTweetMedia, indexMediaIncludes } from "./media-includes";
import { tweetEntitiesFromXurl } from "./tweet-render";
import type { XurlMentionData, XurlMentionsResponse } from "./types";
import {
	editHistoryIdsFromPayload,
	reconcileTweetTombstones,
	recordTweetRevision,
} from "./tweet-retention";
import {
	type TweetAccountEdgeKind,
	upsertTweetAccountEdge,
} from "./tweet-account-edges";
import { ensureStubProfileForXUser, upsertProfileFromXUser } from "./x-profile";
import { tweetContentFromXurl } from "./x-tweet-content";
import { profileHandleKey } from "./profile-row";

export interface IngestTweetPayloadOptions {
	accountId: string;
	payload: XurlMentionsResponse;
	source: string;
	edgeKind?: TweetAccountEdgeKind;
	collectionKind?: "likes" | "bookmarks";
	collectionTweetIds?: ReadonlySet<string>;
	markRepliesAsReplied?: boolean;
	provenance?: {
		sourceUrlByTweetId: ReadonlyMap<string, string>;
	};
}

function getReferencedTweetId(tweet: XurlMentionData, type: string) {
	return (
		tweet.referenced_tweets?.find((item) => item.type === type)?.id ?? null
	);
}

function toCanonicalTweets(payload: XurlMentionsResponse) {
	const tweetsById = new Map<string, XurlMentionData>();
	for (const tweet of payload.includes?.tweets ?? []) {
		tweetsById.set(tweet.id, tweet);
	}
	for (const tweet of payload.data) {
		tweetsById.set(tweet.id, tweet);
	}
	return tweetsById.values();
}

function serializeNoteTweet(noteTweet: XurlMentionData["note_tweet"]) {
	if (!noteTweet) return null;
	return JSON.stringify({
		text: noteTweet.text,
		entities: tweetEntitiesFromXurl(noteTweet.entities),
	});
}

export function ingestTweetPayload(
	db: Database,
	{
		accountId,
		payload,
		source,
		edgeKind,
		collectionKind,
		collectionTweetIds,
		markRepliesAsReplied = false,
		provenance,
	}: IngestTweetPayloadOptions,
) {
	const usersById = new Map(
		(payload.includes?.users ?? []).map((user) => [user.id, user]),
	);
	const handleOwners = new Map<string, string>();
	const conflictingAuthors = new Set<string>();
	for (const user of usersById.values()) {
		const handle = profileHandleKey(user.username);
		const previous = handleOwners.get(handle);
		if (previous && previous !== user.id) {
			conflictingAuthors.add(previous);
			conflictingAuthors.add(user.id);
		}
		handleOwners.set(handle, user.id);
	}
	const mediaByKey = indexMediaIncludes(payload.includes?.media);
	const upsertTweet = db.prepare(`
    insert into tweets (
      id, author_profile_id, text, created_at, is_replied, reply_to_id,
      like_count, media_count, entities_json, note_tweet_json, media_json,
      quoted_tweet_id
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set
      author_profile_id = excluded.author_profile_id,
      text = case
        when excluded.note_tweet_json is null and tweets.note_tweet_json is not null then tweets.text
        else excluded.text
      end,
      created_at = excluded.created_at,
      is_replied = max(tweets.is_replied, excluded.is_replied),
      reply_to_id = coalesce(tweets.reply_to_id, excluded.reply_to_id),
      like_count = case when ? then tweets.like_count else excluded.like_count end,
      media_count = max(tweets.media_count, excluded.media_count),
      entities_json = case
        when excluded.note_tweet_json is null and tweets.note_tweet_json is not null then tweets.entities_json
        else excluded.entities_json
      end,
      note_tweet_json = coalesce(excluded.note_tweet_json, tweets.note_tweet_json),
      media_json = case
        when excluded.media_json not in ('', '[]', 'null') then excluded.media_json
        else tweets.media_json
      end,
      quoted_tweet_id = coalesce(tweets.quoted_tweet_id, excluded.quoted_tweet_id)
  `);
	const upsertCollection = collectionKind
		? db.prepare(`
        insert into tweet_collections (
          account_id, tweet_id, kind, collected_at, source, raw_json, updated_at
        ) values (?, ?, ?, null, ?, ?, ?)
        on conflict(account_id, tweet_id, kind) do update set
          source = excluded.source,
          raw_json = excluded.raw_json,
          updated_at = excluded.updated_at
      `)
		: undefined;
	const tweetIds: string[] = [];
	const touchedTweetIds: string[] = [];
	const upsertSource = provenance
		? db.prepare(`
        insert into tweet_sources (tweet_id, source, source_url, observed_at)
        values (?, ?, ?, ?)
        on conflict(tweet_id, source) do update set
          source_url = excluded.source_url,
          observed_at = excluded.observed_at
      `)
		: undefined;

	db.transaction(() => {
		const observedAt = new Date().toISOString();
		const primaryTweetIds = new Set(payload.data.map((tweet) => tweet.id));
		const profileIdsByAuthor = new Map<string, string>();
		for (const tweet of toCanonicalTweets(payload)) {
			touchedTweetIds.push(tweet.id);
			const isPrimaryTweet = primaryTweetIds.has(tweet.id);
			let profileId = profileIdsByAuthor.get(tweet.author_id);
			if (!profileId) {
				const author = usersById.get(tweet.author_id);
				const profile = author
					? upsertProfileFromXUser(db, author)
					: ensureStubProfileForXUser(db, tweet.author_id);
				profileId = profile.profile.id;
				// Keep order-dependent handle-collision reconciliation for ambiguous payloads.
				if (!conflictingAuthors.has(tweet.author_id)) {
					profileIdsByAuthor.set(tweet.author_id, profileId);
				}
			}
			const replyToId = getReferencedTweetId(tweet, "replied_to");
			const quotedTweetId = getReferencedTweetId(tweet, "quoted");
			const media = buildTweetMedia(tweet, mediaByKey);
			const content = tweetContentFromXurl(tweet);
			// Included tweets are reference data, not members of the caller's result set.
			const shouldMarkReplied =
				isPrimaryTweet && markRepliesAsReplied && Boolean(replyToId);
			upsertTweet.run(
				tweet.id,
				profileId,
				content.text,
				tweet.created_at,
				shouldMarkReplied ? 1 : 0,
				replyToId,
				Number(tweet.public_metrics?.like_count ?? 0),
				media.count,
				JSON.stringify(content.entities),
				serializeNoteTweet(tweet.note_tweet),
				media.json,
				quotedTweetId,
				!isPrimaryTweet && tweet.public_metrics?.like_count === undefined
					? 1
					: 0,
			);
			recordTweetRevision(db, {
				tweetId: tweet.id,
				editHistoryIds: editHistoryIdsFromPayload(tweet.id, tweet),
				payloadJson: JSON.stringify(tweet),
				source,
				observedAt,
			});
			const sourceUrl = provenance?.sourceUrlByTweetId.get(tweet.id);
			if (sourceUrl) {
				upsertSource?.run(tweet.id, source, sourceUrl, observedAt);
			}
			if (edgeKind && isPrimaryTweet) {
				upsertTweetAccountEdge(db, {
					accountId,
					tweetId: tweet.id,
					kind: edgeKind,
					source,
					seenAt: observedAt,
					rawJson: JSON.stringify(tweet),
				});
			}
			if (
				isPrimaryTweet &&
				(!collectionTweetIds || collectionTweetIds.has(tweet.id))
			) {
				upsertCollection?.run(
					accountId,
					tweet.id,
					collectionKind,
					source,
					JSON.stringify(tweet),
					observedAt,
				);
			}
			if (isPrimaryTweet) {
				tweetIds.push(tweet.id);
			}
		}
		reconcileTweetTombstones(db, touchedTweetIds);
		refreshSearchRows(db, "tweet", touchedTweetIds);
	})();

	return tweetIds;
}
