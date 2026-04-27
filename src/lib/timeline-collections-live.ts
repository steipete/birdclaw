import type Database from "better-sqlite3";
import { listBookmarkedTweetsViaBird, listLikedTweetsViaBird } from "./bird";
import { getNativeDb } from "./db";
import { readSyncCache, writeSyncCache } from "./sync-cache";
import type {
	TweetEntities,
	TweetMediaItem,
	XurlMentionData,
	XurlMentionsResponse,
	XurlMentionUser,
} from "./types";
import { ensureStubProfileForXUser, upsertProfileFromXUser } from "./x-profile";
import {
	listBookmarkedTweetsViaXurl,
	listLikedTweetsViaXurl,
	lookupUsersByHandles,
} from "./xurl";

export type TimelineCollectionKind = "likes" | "bookmarks";
export type TimelineCollectionMode = "auto" | "xurl" | "bird";

const DEFAULT_COLLECTION_CACHE_TTL_MS = 2 * 60_000;
const MIN_XURL_LIMIT = 5;
const MAX_XURL_LIMIT = 100;

function parseCacheTtlMs(value?: number) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return DEFAULT_COLLECTION_CACHE_TTL_MS;
	}
	return Math.floor(value);
}

function parseMaxPages(value?: number) {
	if (value === undefined) {
		return null;
	}
	if (!Number.isFinite(value) || value < 1) {
		throw new Error("--max-pages must be at least 1");
	}
	return Math.floor(value);
}

function assertLimit(limit: number) {
	if (!Number.isFinite(limit) || limit < 1) {
		throw new Error("--limit must be at least 1");
	}
}

function assertXurlLimit(limit: number) {
	if (limit < MIN_XURL_LIMIT || limit > MAX_XURL_LIMIT) {
		throw new Error("xurl mode requires --limit between 5 and 100");
	}
}

function resolveAccount(db: Database.Database, accountId?: string) {
	const row = accountId
		? (db
				.prepare(
					"select id, handle, external_user_id from accounts where id = ?",
				)
				.get(accountId) as
				| { id: string; handle: string; external_user_id: string | null }
				| undefined)
		: (db
				.prepare(
					`
          select id, handle, external_user_id
          from accounts
          order by is_default desc, created_at asc
          limit 1
          `,
				)
				.get() as
				| { id: string; handle: string; external_user_id: string | null }
				| undefined);

	if (!row) {
		throw new Error(`Unknown account: ${accountId ?? "default"}`);
	}

	return {
		accountId: row.id,
		username: row.handle.replace(/^@/, ""),
		externalUserId:
			typeof row.external_user_id === "string" &&
			row.external_user_id.length > 0
				? row.external_user_id
				: undefined,
	};
}

function getMediaCount(tweet: XurlMentionData) {
	if (Array.isArray(tweet.media) && tweet.media.length > 0) {
		return tweet.media.length;
	}

	const urls = Array.isArray(tweet.entities?.urls) ? tweet.entities.urls : [];
	return urls.filter(
		(url) =>
			url &&
			typeof url === "object" &&
			typeof (url as Record<string, unknown>).media_key === "string",
	).length;
}

function toLocalEntities(tweet: XurlMentionData): TweetEntities {
	const raw = tweet.entities;
	if (!raw || typeof raw !== "object") {
		return {};
	}

	const entities = raw as Record<string, unknown>;
	const rawMentions = Array.isArray(entities.mentions) ? entities.mentions : [];
	const hasStructuredMedia =
		Array.isArray(tweet.media) && tweet.media.length > 0;
	const rawUrls = Array.isArray(entities.urls)
		? entities.urls.filter((url) => {
				if (!hasStructuredMedia || !url || typeof url !== "object") {
					return true;
				}
				return typeof (url as Record<string, unknown>).media_key !== "string";
			})
		: [];

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
							expandedUrl: String(
								value.expandedUrl ?? value.expanded_url ?? value.url ?? "",
							),
							displayUrl: String(
								value.displayUrl ??
									value.display_url ??
									value.expanded_url ??
									value.url ??
									"",
							),
							start: Number(value.start ?? 0),
							end: Number(value.end ?? 0),
						};
					}),
				}
			: {}),
	};
}

function toLocalMediaItems(tweet: XurlMentionData): TweetMediaItem[] {
	if (!Array.isArray(tweet.media)) {
		return [];
	}

	return tweet.media
		.filter(
			(item) => item && typeof item.url === "string" && item.url.length > 0,
		)
		.map((item) => ({
			url: item.url,
			type:
				item.type === "image" ||
				item.type === "video" ||
				item.type === "gif" ||
				item.type === "unknown"
					? item.type
					: "unknown",
			...(typeof item.altText === "string" ? { altText: item.altText } : {}),
			...(Number.isFinite(item.width) ? { width: Number(item.width) } : {}),
			...(Number.isFinite(item.height) ? { height: Number(item.height) } : {}),
			...(typeof item.thumbnailUrl === "string" && item.thumbnailUrl.length > 0
				? { thumbnailUrl: item.thumbnailUrl }
				: {}),
		}));
}

function replaceTweetFts(db: Database.Database, tweetId: string, text: string) {
	db.prepare("delete from tweets_fts where tweet_id = ?").run(tweetId);
	db.prepare("insert into tweets_fts (tweet_id, text) values (?, ?)").run(
		tweetId,
		text,
	);
}

function mergePayloads(pages: XurlMentionsResponse[]): XurlMentionsResponse {
	const tweets: XurlMentionData[] = [];
	const seenTweetIds = new Set<string>();
	const users: XurlMentionUser[] = [];
	const seenUserIds = new Set<string>();

	for (const page of pages) {
		for (const tweet of page.data) {
			if (seenTweetIds.has(tweet.id)) {
				continue;
			}
			seenTweetIds.add(tweet.id);
			tweets.push(tweet);
		}

		for (const user of page.includes?.users ?? []) {
			if (seenUserIds.has(user.id)) {
				continue;
			}
			seenUserIds.add(user.id);
			users.push(user);
		}
	}

	const lastPage = pages.at(-1);
	return {
		data: tweets,
		includes: users.length > 0 ? { users } : undefined,
		meta: {
			result_count: tweets.length,
			page_count: pages.length,
			next_token: lastPage?.meta?.next_token ?? null,
			...(tweets[0] ? { newest_id: tweets[0].id } : {}),
			...(tweets.at(-1) ? { oldest_id: tweets.at(-1)?.id } : {}),
		},
	};
}

function mergeTimelineCollectionIntoLocalStore(
	db: Database.Database,
	accountId: string,
	kind: TimelineCollectionKind,
	payload: XurlMentionsResponse,
	source: "xurl" | "bird",
) {
	const usersById = new Map(
		(payload.includes?.users ?? []).map((user) => [user.id, user]),
	);
	const tweetKind = kind === "likes" ? "like" : "bookmark";
	const liked = kind === "likes" ? 1 : 0;
	const bookmarked = kind === "bookmarks" ? 1 : 0;
	const upsertTweet = db.prepare(
		`
    insert into tweets (
      id, account_id, author_profile_id, kind, text, created_at,
      is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
      entities_json, media_json, quoted_tweet_id
    ) values (?, ?, ?, ?, ?, ?, 0, null, ?, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set
      account_id = excluded.account_id,
      author_profile_id = excluded.author_profile_id,
      kind = case
        when tweets.kind in ('home', 'mention') then tweets.kind
        else excluded.kind
      end,
      text = excluded.text,
      created_at = excluded.created_at,
      like_count = excluded.like_count,
      media_count = excluded.media_count,
      entities_json = excluded.entities_json,
      media_json = case
        when excluded.media_json not in ('', '[]', 'null') then excluded.media_json
        else tweets.media_json
      end,
      quoted_tweet_id = coalesce(excluded.quoted_tweet_id, tweets.quoted_tweet_id),
      bookmarked = max(tweets.bookmarked, excluded.bookmarked),
      liked = max(tweets.liked, excluded.liked)
    `,
	);
	const upsertCollection = db.prepare(`
    insert into tweet_collections (
      account_id, tweet_id, kind, collected_at, source, raw_json, updated_at
    ) values (?, ?, ?, null, ?, ?, ?)
    on conflict(account_id, tweet_id, kind) do update set
      source = excluded.source,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
  `);

	db.transaction(() => {
		const updatedAt = new Date().toISOString();
		const upsertTweetRecord = (
			tweet: XurlMentionData,
			bookmarkedValue: number,
			likedValue: number,
		) => {
			if (tweet.quotedTweet && tweet.quotedTweet.id !== tweet.id) {
				upsertTweetRecord(tweet.quotedTweet, 0, 0);
			}

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
			const mediaItems = toLocalMediaItems(tweet);
			upsertTweet.run(
				tweet.id,
				accountId,
				profile.profile.id,
				tweetKind,
				tweet.text,
				tweet.created_at,
				Number(tweet.public_metrics?.like_count ?? 0),
				getMediaCount(tweet),
				bookmarkedValue,
				likedValue,
				JSON.stringify(toLocalEntities(tweet)),
				JSON.stringify(mediaItems),
				tweet.quotedTweet?.id ?? null,
			);
			replaceTweetFts(db, tweet.id, tweet.text);
		};

		for (const tweet of payload.data) {
			upsertTweetRecord(tweet, bookmarked, liked);
			upsertCollection.run(
				accountId,
				tweet.id,
				kind,
				source,
				JSON.stringify(tweet),
				updatedAt,
			);
		}
	})();
}

async function fetchXurlCollection({
	kind,
	username,
	userId,
	limit,
	all,
	maxPages,
}: {
	kind: TimelineCollectionKind;
	username: string;
	userId?: string;
	limit: number;
	all: boolean;
	maxPages: number | null;
}) {
	let resolvedUserId = userId;
	if (!resolvedUserId) {
		const [accountUser] = await lookupUsersByHandles([username]);
		if (!accountUser?.id) {
			throw new Error(`Could not resolve Twitter user id for @${username}`);
		}
		resolvedUserId = String(accountUser.id);
	}

	const pages: XurlMentionsResponse[] = [];
	let nextToken: string | undefined;
	let pageCount = 0;
	do {
		const payload =
			kind === "likes"
				? await listLikedTweetsViaXurl({
						maxResults: limit,
						username,
						userId: resolvedUserId,
						paginationToken: nextToken,
					})
				: await listBookmarkedTweetsViaXurl({
						maxResults: limit,
						username,
						userId: resolvedUserId,
						paginationToken: nextToken,
					});
		pages.push(payload);
		nextToken =
			typeof payload.meta?.next_token === "string"
				? payload.meta.next_token
				: undefined;
		pageCount += 1;
	} while (all && nextToken && (maxPages === null || pageCount < maxPages));

	return mergePayloads(pages);
}

async function fetchBirdCollection({
	kind,
	limit,
	all,
	maxPages,
}: {
	kind: TimelineCollectionKind;
	limit: number;
	all: boolean;
	maxPages: number | null;
}) {
	return kind === "likes"
		? listLikedTweetsViaBird({
				maxResults: limit,
				all,
				maxPages: maxPages ?? undefined,
			})
		: listBookmarkedTweetsViaBird({
				maxResults: limit,
				all,
				maxPages: maxPages ?? undefined,
			});
}

export async function syncTimelineCollection({
	kind,
	account,
	mode = "auto",
	limit = 20,
	all = false,
	maxPages,
	refresh = false,
	cacheTtlMs,
}: {
	kind: TimelineCollectionKind;
	account?: string;
	mode?: TimelineCollectionMode;
	limit?: number;
	all?: boolean;
	maxPages?: number;
	refresh?: boolean;
	cacheTtlMs?: number;
}) {
	assertLimit(limit);
	const parsedMaxPages = parseMaxPages(maxPages);
	if (mode === "xurl" || mode === "auto") {
		assertXurlLimit(limit);
	}

	const db = getNativeDb();
	const resolvedAccount = resolveAccount(db, account);
	const cacheKey = `${kind}:${mode}:${resolvedAccount.accountId}:${String(limit)}:${all ? "all" : "single"}:${parsedMaxPages === null ? "all-pages" : String(parsedMaxPages)}`;
	const ttlMs = parseCacheTtlMs(cacheTtlMs);
	const cached = readSyncCache<XurlMentionsResponse>(cacheKey, db);
	const cacheAgeMs = cached
		? Date.now() - new Date(cached.updatedAt).getTime()
		: Number.POSITIVE_INFINITY;

	if (!refresh && cached && cacheAgeMs <= ttlMs) {
		return {
			ok: true,
			source: "cache",
			kind,
			accountId: resolvedAccount.accountId,
			count: cached.value.data.length,
			payload: cached.value,
		};
	}

	let source: "xurl" | "bird";
	let payload: XurlMentionsResponse;
	if (mode === "bird") {
		payload = await fetchBirdCollection({
			kind,
			limit,
			all,
			maxPages: parsedMaxPages,
		});
		source = "bird";
	} else {
		try {
			payload = await fetchXurlCollection({
				kind,
				username: resolvedAccount.username,
				userId: resolvedAccount.externalUserId,
				limit,
				all,
				maxPages: parsedMaxPages,
			});
			source = "xurl";
		} catch (error) {
			if (mode === "xurl") {
				throw error;
			}
			payload = await fetchBirdCollection({
				kind,
				limit,
				all,
				maxPages: parsedMaxPages,
			});
			source = "bird";
		}
	}

	mergeTimelineCollectionIntoLocalStore(
		db,
		resolvedAccount.accountId,
		kind,
		payload,
		source,
	);
	writeSyncCache(cacheKey, payload, db);

	return {
		ok: true,
		source,
		kind,
		accountId: resolvedAccount.accountId,
		count: payload.data.length,
		payload,
	};
}
