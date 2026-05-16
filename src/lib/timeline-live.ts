import { Effect } from "effect";
import type { Database } from "./sqlite";
import { listHomeTimelineViaBirdEffect } from "./bird";
import { getNativeDb } from "./db";
import { runEffectPromise } from "./effect-runtime";
import { buildMediaJsonFromIncludes, countTweetMedia } from "./media-includes";
import { readSyncCache, writeSyncCache } from "./sync-cache";
import type { XurlMentionsResponse } from "./types";
import { upsertTweetAccountEdge } from "./tweet-account-edges";
import { ensureStubProfileForXUser, upsertProfileFromXUser } from "./x-profile";

const DEFAULT_TIMELINE_CACHE_TTL_MS = 2 * 60_000;

export interface SyncHomeTimelineOptions {
	account?: string;
	limit?: number;
	following?: boolean;
	refresh?: boolean;
	cacheTtlMs?: number;
}

function parseCacheTtlMs(value?: number) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return DEFAULT_TIMELINE_CACHE_TTL_MS;
	}
	return Math.floor(value);
}

function assertLimit(limit: number) {
	if (!Number.isFinite(limit) || limit < 1) {
		throw new Error("--limit must be at least 1");
	}
}

function resolveAccount(db: Database, accountId?: string) {
	const row = accountId
		? (db.prepare("select id from accounts where id = ?").get(accountId) as
				| { id: string }
				| undefined)
		: (db
				.prepare(
					`
          select id
          from accounts
          order by is_default desc, created_at asc
          limit 1
          `,
				)
				.get() as { id: string } | undefined);

	if (!row) {
		throw new Error(`Unknown account: ${accountId ?? "default"}`);
	}

	return row.id;
}

function replaceTweetFts(db: Database, tweetId: string, text: string) {
	db.prepare("delete from tweets_fts where tweet_id = ?").run(tweetId);
	db.prepare("insert into tweets_fts (tweet_id, text) values (?, ?)").run(
		tweetId,
		text,
	);
}

function mergeHomeTimelineIntoLocalStore(
	db: Database,
	accountId: string,
	payload: XurlMentionsResponse,
) {
	const usersById = new Map(
		(payload.includes?.users ?? []).map((user) => [user.id, user]),
	);
	const upsertTweet = db.prepare(
		`
    insert into tweets (
      id, account_id, author_profile_id, kind, text, created_at,
      is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
      entities_json, media_json, quoted_tweet_id
    ) values (?, ?, ?, 'home', ?, ?, 0, null, ?, ?, 0, 0, ?, ?, null)
    on conflict(id) do update set
      account_id = tweets.account_id,
      author_profile_id = excluded.author_profile_id,
      kind = tweets.kind,
      text = excluded.text,
      created_at = excluded.created_at,
      like_count = excluded.like_count,
      media_count = max(tweets.media_count, excluded.media_count),
      entities_json = excluded.entities_json,
      media_json = case
        when excluded.media_json not in ('', '[]', 'null') then excluded.media_json
        else tweets.media_json
      end,
      bookmarked = tweets.bookmarked,
      liked = tweets.liked
    `,
	);

	db.transaction(() => {
		const seenAt = new Date().toISOString();
		for (const tweet of payload.data) {
			const author =
				usersById.get(tweet.author_id) ??
				({
					id: tweet.author_id,
					username: `user_${tweet.author_id}`,
					name: `user_${tweet.author_id}`,
				} as const);
			const profile = usersById.has(tweet.author_id)
				? upsertProfileFromXUser(db, author)
				: ensureStubProfileForXUser(db, tweet.author_id);
			upsertTweet.run(
				tweet.id,
				accountId,
				profile.profile.id,
				tweet.text,
				tweet.created_at,
				Number(tweet.public_metrics?.like_count ?? 0),
				countTweetMedia(tweet),
				JSON.stringify(tweet.entities ?? {}),
				buildMediaJsonFromIncludes(tweet, payload.includes?.media),
			);
			upsertTweetAccountEdge(db, {
				accountId,
				tweetId: tweet.id,
				kind: "home",
				source: "bird",
				seenAt,
				rawJson: JSON.stringify(tweet),
			});
			replaceTweetFts(db, tweet.id, tweet.text);
		}
	})();
}

export function syncHomeTimelineEffect({
	account,
	limit = 100,
	following = true,
	refresh = false,
	cacheTtlMs,
}: SyncHomeTimelineOptions = {}): Effect.Effect<
	{
		ok: true;
		source: "bird" | "cache";
		kind: "timeline";
		accountId: string;
		feed: "following" | "for-you";
		count: number;
		payload: XurlMentionsResponse;
	},
	unknown
> {
	return Effect.gen(function* () {
		assertLimit(limit);
		const db = getNativeDb();
		const accountId = resolveAccount(db, account);
		const cacheKey = `timeline:bird:${accountId}:${following ? "following" : "for-you"}:${String(limit)}`;
		const ttlMs = parseCacheTtlMs(cacheTtlMs);
		const cached = readSyncCache<XurlMentionsResponse>(cacheKey, db);
		const cacheAgeMs = cached
			? Date.now() - new Date(cached.updatedAt).getTime()
			: Number.POSITIVE_INFINITY;

		if (!refresh && cached && cacheAgeMs <= ttlMs) {
			return {
				ok: true,
				source: "cache",
				kind: "timeline",
				accountId,
				feed: following ? "following" : "for-you",
				count: cached.value.data.length,
				payload: cached.value,
			} as const;
		}

		const payload = yield* listHomeTimelineViaBirdEffect({
			maxResults: limit,
			following,
		});
		mergeHomeTimelineIntoLocalStore(db, accountId, payload);
		writeSyncCache(cacheKey, payload, db);

		return {
			ok: true,
			source: "bird",
			kind: "timeline",
			accountId,
			feed: following ? "following" : "for-you",
			count: payload.data.length,
			payload,
		} as const;
	});
}

export function syncHomeTimeline(options: SyncHomeTimelineOptions = {}) {
	return runEffectPromise(syncHomeTimelineEffect(options));
}
