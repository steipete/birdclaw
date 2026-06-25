import type { Database } from "./sqlite";
import { buildMediaJsonFromIncludes, countTweetMedia } from "./media-includes";
import { tweetEntitiesFromXurl } from "./tweet-render";
import type { XurlMentionData, XurlMentionsResponse } from "./types";
import {
	type TweetAccountEdgeKind,
	upsertTweetAccountEdge,
} from "./tweet-account-edges";
import { ensureStubProfileForXUser, upsertProfileFromXUser } from "./x-profile";

export interface IngestTweetPayloadOptions {
	accountId: string;
	payload: XurlMentionsResponse;
	source: string;
	edgeKind?: TweetAccountEdgeKind;
	collectionKind?: "likes" | "bookmarks";
	markRepliesAsReplied?: boolean;
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

export function replaceTweetFts(db: Database, tweetId: string, text: string) {
	db.prepare("delete from tweets_fts where tweet_id = ?").run(tweetId);
	db.prepare("insert into tweets_fts (tweet_id, text) values (?, ?)").run(
		tweetId,
		text,
	);
}

export function ingestTweetPayload(
	db: Database,
	{
		accountId,
		payload,
		source,
		edgeKind,
		collectionKind,
		markRepliesAsReplied = false,
	}: IngestTweetPayloadOptions,
) {
	const usersById = new Map(
		(payload.includes?.users ?? []).map((user) => [user.id, user]),
	);
	const upsertTweet = db.prepare(`
    insert into tweets (
      id, author_profile_id, text, created_at, is_replied, reply_to_id,
      like_count, media_count, entities_json, media_json, quoted_tweet_id
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set
      author_profile_id = excluded.author_profile_id,
      text = excluded.text,
      created_at = excluded.created_at,
      is_replied = max(tweets.is_replied, excluded.is_replied),
      reply_to_id = coalesce(tweets.reply_to_id, excluded.reply_to_id),
      like_count = excluded.like_count,
      media_count = max(tweets.media_count, excluded.media_count),
      entities_json = excluded.entities_json,
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

	db.transaction(() => {
		const observedAt = new Date().toISOString();
		const primaryTweetIds = new Set(payload.data.map((tweet) => tweet.id));
		for (const tweet of toCanonicalTweets(payload)) {
			const author = usersById.get(tweet.author_id);
			const profile = author
				? upsertProfileFromXUser(db, author)
				: ensureStubProfileForXUser(db, tweet.author_id);
			const replyToId = getReferencedTweetId(tweet, "replied_to");
			const quotedTweetId = getReferencedTweetId(tweet, "quoted");
			upsertTweet.run(
				tweet.id,
				profile.profile.id,
				tweet.text,
				tweet.created_at,
				markRepliesAsReplied && replyToId ? 1 : 0,
				replyToId,
				Number(tweet.public_metrics?.like_count ?? 0),
				countTweetMedia(tweet),
				JSON.stringify(tweetEntitiesFromXurl(tweet.entities)),
				buildMediaJsonFromIncludes(tweet, payload.includes?.media),
				quotedTweetId,
			);
			const isPrimaryTweet = primaryTweetIds.has(tweet.id);
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
			if (isPrimaryTweet) {
				upsertCollection?.run(
					accountId,
					tweet.id,
					collectionKind,
					source,
					JSON.stringify(tweet),
					observedAt,
				);
			}
			replaceTweetFts(db, tweet.id, tweet.text);
			if (isPrimaryTweet) {
				tweetIds.push(tweet.id);
			}
		}
	})();

	return tweetIds;
}
