import type { Database } from "./sqlite";

export type TweetAccountEdgeKind =
	| "home"
	| "mention"
	| "authored"
	| "search"
	| "profile"
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
      last_seen_at = case
        when excluded.source = 'cache' then tweet_account_edges.last_seen_at
        else max(tweet_account_edges.last_seen_at, excluded.last_seen_at)
      end,
      seen_count = case
        when excluded.source = 'cache' then tweet_account_edges.seen_count
        else tweet_account_edges.seen_count + 1
      end,
	      source = case
	        when tweet_account_edges.source = 'archive' then 'archive'
	        when excluded.source = 'cache' then tweet_account_edges.source
	        else coalesce(nullif(excluded.source, ''), tweet_account_edges.source)
	      end,
      raw_json = case
        when excluded.source = 'cache' and tweet_account_edges.raw_json not in ('', '{}', 'null') then tweet_account_edges.raw_json
        when excluded.raw_json not in ('', '{}', 'null') then excluded.raw_json
        else tweet_account_edges.raw_json
      end,
      updated_at = case
        when excluded.source = 'cache' then tweet_account_edges.updated_at
        else max(tweet_account_edges.updated_at, excluded.updated_at)
      end
  `).run(accountId, tweetId, kind, seenAt, seenAt, source, rawJson, seenAt);
}
