import type Database from "better-sqlite3";
import { getNativeDb } from "./db";
import { serializeMentionItemsAsXurlCompatible } from "./mentions-export";
import { listTimelineItems } from "./queries";
import { readSyncCache, writeSyncCache } from "./sync-cache";
import type {
	ReplyFilter,
	TweetEntities,
	XurlMentionData,
	XurlMentionsResponse,
} from "./types";
import { ensureStubProfileForXUser, upsertProfileFromXUser } from "./x-profile";
import { listMentionsViaXurl } from "./xurl";

export const DEFAULT_MENTIONS_CACHE_TTL_MS = 2 * 60_000;
const MIN_XURL_MENTIONS_LIMIT = 5;
const MAX_XURL_MENTIONS_LIMIT = 100;

function getMentionsCacheKey(accountId: string, limit: number) {
	return `mentions:xurl:${accountId}:${String(limit)}`;
}

function parseCacheTtlMs(value?: number) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return DEFAULT_MENTIONS_CACHE_TTL_MS;
	}
	return Math.floor(value);
}

function assertXurlLimit(limit: number) {
	if (limit < MIN_XURL_MENTIONS_LIMIT || limit > MAX_XURL_MENTIONS_LIMIT) {
		throw new Error("xurl mode requires --limit between 5 and 100");
	}
}

function resolveAccount(db: Database.Database, accountId?: string) {
	const row = accountId
		? (db
				.prepare("select id, handle from accounts where id = ?")
				.get(accountId) as { id: string; handle: string } | undefined)
		: (db
				.prepare(
					`
          select id, handle
          from accounts
          order by is_default desc, created_at asc
          limit 1
          `,
				)
				.get() as { id: string; handle: string } | undefined);

	if (!row) {
		throw new Error(`Unknown account: ${accountId ?? "default"}`);
	}

	return {
		accountId: row.id,
		username: row.handle.replace(/^@/, ""),
	};
}

function toLocalEntities(tweet: XurlMentionData): TweetEntities {
	const raw = tweet.entities;
	if (!raw || typeof raw !== "object") {
		return {};
	}

	const entities = raw as Record<string, unknown>;
	const rawMentions = Array.isArray(entities.mentions) ? entities.mentions : [];
	const rawUrls = Array.isArray(entities.urls) ? entities.urls : [];

	return {
		...(rawMentions.length
			? {
					mentions: rawMentions.map((mention) => {
						const value =
							mention && typeof mention === "object"
								? (mention as Record<string, unknown>)
								: {};
						return {
							username: String(value.username ?? ""),
							id: typeof value.id === "string" ? String(value.id) : undefined,
							start: Number(value.start ?? 0),
							end: Number(value.end ?? 0),
						};
					}),
				}
			: {}),
		...(rawUrls.length
			? {
					urls: rawUrls.map((url) => {
						const value =
							url && typeof url === "object"
								? (url as Record<string, unknown>)
								: {};
						return {
							url: String(value.url ?? ""),
							expandedUrl: String(value.expanded_url ?? value.url ?? ""),
							displayUrl: String(
								value.display_url ?? value.expanded_url ?? value.url ?? "",
							),
							start: Number(value.start ?? 0),
							end: Number(value.end ?? 0),
						};
					}),
				}
			: {}),
	};
}

function getMediaCount(tweet: XurlMentionData) {
	const urls = Array.isArray(tweet.entities?.urls) ? tweet.entities.urls : [];
	return urls.filter(
		(url) =>
			url &&
			typeof url === "object" &&
			typeof (url as Record<string, unknown>).media_key === "string",
	).length;
}

function replaceTweetFts(db: Database.Database, tweetId: string, text: string) {
	db.prepare("delete from tweets_fts where tweet_id = ?").run(tweetId);
	db.prepare("insert into tweets_fts (tweet_id, text) values (?, ?)").run(
		tweetId,
		text,
	);
}

function mergeMentionsIntoLocalStore(
	db: Database.Database,
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
    ) values (?, ?, ?, 'mention', ?, ?, 0, null, ?, ?, 0, 0, ?, '[]', null)
    on conflict(id) do update set
      account_id = excluded.account_id,
      author_profile_id = excluded.author_profile_id,
      kind = excluded.kind,
      text = excluded.text,
      created_at = excluded.created_at,
      like_count = excluded.like_count,
      media_count = excluded.media_count,
      entities_json = excluded.entities_json,
      media_json = excluded.media_json,
      is_replied = max(tweets.is_replied, excluded.is_replied),
      bookmarked = max(tweets.bookmarked, excluded.bookmarked),
      liked = max(tweets.liked, excluded.liked)
    `,
	);

	const writePayload = db.transaction(() => {
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
				getMediaCount(tweet),
				JSON.stringify(toLocalEntities(tweet)),
			);
			replaceTweetFts(db, tweet.id, tweet.text);
		}
	});

	writePayload();
}

function shouldReturnFilteredLocalPayload({
	search,
	replyFilter,
}: {
	search?: string;
	replyFilter?: ReplyFilter;
}) {
	return (
		Boolean(search?.trim()) ||
		replyFilter === "replied" ||
		replyFilter === "unreplied"
	);
}

function readLocalXurlCompatiblePayload({
	accountId,
	search,
	replyFilter,
	limit,
}: {
	accountId?: string;
	search?: string;
	replyFilter?: ReplyFilter;
	limit: number;
}) {
	return serializeMentionItemsAsXurlCompatible(
		listTimelineItems({
			resource: "mentions",
			account: accountId,
			search,
			replyFilter,
			limit,
		}),
	);
}

export async function exportMentionsViaCachedXurl({
	account,
	search,
	replyFilter = "all",
	limit = 20,
	refresh = false,
	cacheTtlMs,
}: {
	account?: string;
	search?: string;
	replyFilter?: ReplyFilter;
	limit?: number;
	refresh?: boolean;
	cacheTtlMs?: number;
}) {
	assertXurlLimit(limit);

	const db = getNativeDb();
	const resolvedAccount = resolveAccount(db, account);
	const cacheKey = getMentionsCacheKey(resolvedAccount.accountId, limit);
	const ttlMs = parseCacheTtlMs(cacheTtlMs);
	const cached = readSyncCache<XurlMentionsResponse>(cacheKey, db);
	const cacheAgeMs = cached
		? Date.now() - new Date(cached.updatedAt).getTime()
		: Number.POSITIVE_INFINITY;

	if (!refresh && cached && cacheAgeMs <= ttlMs) {
		if (
			shouldReturnFilteredLocalPayload({
				search,
				replyFilter,
			})
		) {
			return readLocalXurlCompatiblePayload({
				accountId: resolvedAccount.accountId,
				search,
				replyFilter,
				limit,
			});
		}
		return cached.value;
	}

	try {
		const payload = await listMentionsViaXurl({
			maxResults: limit,
			username: resolvedAccount.username,
		});
		mergeMentionsIntoLocalStore(db, resolvedAccount.accountId, payload);
		writeSyncCache(cacheKey, payload, db);

		if (
			shouldReturnFilteredLocalPayload({
				search,
				replyFilter,
			})
		) {
			return readLocalXurlCompatiblePayload({
				accountId: resolvedAccount.accountId,
				search,
				replyFilter,
				limit,
			});
		}

		return payload;
	} catch (error) {
		if (!refresh && cached) {
			if (
				shouldReturnFilteredLocalPayload({
					search,
					replyFilter,
				})
			) {
				return readLocalXurlCompatiblePayload({
					accountId: resolvedAccount.accountId,
					search,
					replyFilter,
					limit,
				});
			}
			return cached.value;
		}
		throw error;
	}
}
