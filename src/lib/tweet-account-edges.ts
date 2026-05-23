import type { Database } from "./sqlite";

export type TweetAccountEdgeKind =
	| "home"
	| "mention"
	| "authored"
	| "search"
	| "thread_context";

export function upsertTweetAccountEdge(
	db: Database,
	{
		accountId,
		tweetId,
		kind,
		source,
		seenAt,
		rawJson = "{}",
	}: {
		accountId: string;
		tweetId: string;
		kind: TweetAccountEdgeKind;
		source: string;
		seenAt: string;
		rawJson?: string;
	},
) {
	db.prepare(`
    insert into tweet_account_edges (
      account_id, tweet_id, kind, first_seen_at, last_seen_at, seen_count,
      source, raw_json, updated_at
    ) values (?, ?, ?, ?, ?, 1, ?, ?, ?)
    on conflict(account_id, tweet_id, kind) do update set
      first_seen_at = min(tweet_account_edges.first_seen_at, excluded.first_seen_at),
      last_seen_at = max(tweet_account_edges.last_seen_at, excluded.last_seen_at),
      seen_count = tweet_account_edges.seen_count + 1,
	      source = case
	        when tweet_account_edges.source = 'archive' then 'archive'
	        else coalesce(nullif(excluded.source, ''), tweet_account_edges.source)
	      end,
      raw_json = case
        when excluded.raw_json not in ('', '{}', 'null') then excluded.raw_json
        else tweet_account_edges.raw_json
      end,
      updated_at = max(tweet_account_edges.updated_at, excluded.updated_at)
  `).run(accountId, tweetId, kind, seenAt, seenAt, source, rawJson, seenAt);
}
