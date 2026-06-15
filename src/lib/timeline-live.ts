import { Effect } from "effect";
import type { Database } from "./sqlite";
import { listHomeTimelineViaBirdEffect } from "./bird";
import { getNativeDb } from "./db";
import { runEffectPromise } from "./effect-runtime";
import { buildMediaJsonFromIncludes, countTweetMedia } from "./media-includes";
import { readSyncCache, writeSyncCache } from "./sync-cache";
import { tweetEntitiesFromXurl } from "./tweet-render";
import type {
	XurlMediaItem,
	XurlMentionUser,
	XurlMentionsResponse,
} from "./types";
import { upsertTweetAccountEdge } from "./tweet-account-edges";
import { ensureStubProfileForXUser, upsertProfileFromXUser } from "./x-profile";
import { listHomeTimelineViaXurlEffect } from "./xurl";

const DEFAULT_TIMELINE_CACHE_TTL_MS = 2 * 60_000;
const MAX_XURL_TIMELINE_PAGE_SIZE = 100;

export type HomeTimelineMode = "bird" | "xurl" | "auto";
export interface HomeTimelineProgress {
	source: "bird" | "xurl" | "cache";
	fetched: number;
	total?: number;
	page?: number;
	maxPages?: number;
	pageSize?: number;
	done: boolean;
}
export interface SyncHomeTimelineOptions {
	account?: string;
	mode?: HomeTimelineMode;
	limit?: number;
	maxPages?: number;
	startTime?: string;
	following?: boolean;
	refresh?: boolean;
	cacheTtlMs?: number;
	timeoutMs?: number;
	onProgress?: (progress: HomeTimelineProgress) => void;
}

function parseCacheTtlMs(value?: number) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return DEFAULT_TIMELINE_CACHE_TTL_MS;
	}
	return Math.floor(value);
}

function assertLimit(limit: number) {
	if ((!Number.isFinite(limit) && limit !== Infinity) || limit < 1) {
		throw new Error("--limit must be at least 1");
	}
}

function parseMode(mode: HomeTimelineMode | undefined) {
	const parsed = mode ?? "bird";
	if (parsed !== "bird" && parsed !== "xurl" && parsed !== "auto") {
		throw new Error("--mode must be bird, xurl, or auto");
	}
	return parsed;
}

function parseMaxPages(maxPages: number | undefined) {
	if (maxPages === undefined) return 1;
	if (!Number.isFinite(maxPages) || maxPages < 1) {
		throw new Error("--max-pages must be at least 1");
	}
	return Math.floor(maxPages);
}

function parseStartTime(value: string | undefined) {
	if (!value?.trim()) return undefined;
	const time = new Date(value).getTime();
	if (!Number.isFinite(time)) {
		throw new Error("--start-time must be a valid date");
	}
	return { iso: new Date(time).toISOString(), time };
}

function reachedStartTimeBoundary(
	payload: XurlMentionsResponse,
	startTimeMs: number | undefined,
) {
	if (startTimeMs === undefined) return false;
	return payload.data.some((tweet) => {
		const createdAt = new Date(tweet.created_at).getTime();
		return Number.isFinite(createdAt) && createdAt <= startTimeMs;
	});
}

function getReferencedTweetId(
	tweet: XurlMentionsResponse["data"][number],
	type: "replied_to" | "quoted",
) {
	return tweet.referenced_tweets?.find((reference) => reference.type === type)
		?.id;
}

function mergeTimelinePayloads(
	payloads: XurlMentionsResponse[],
	limit: number,
) {
	const data: XurlMentionsResponse["data"] = [];
	const usersById = new Map<string, XurlMentionUser>();
	const mediaByKey = new Map<string, XurlMediaItem>();
	let meta: XurlMentionsResponse["meta"] | undefined;

	for (const payload of payloads) {
		meta = payload.meta;
		for (const tweet of payload.data) {
			if (data.some((existing) => existing.id === tweet.id)) continue;
			data.push(tweet);
			if (data.length >= limit) break;
		}
		for (const user of payload.includes?.users ?? []) {
			usersById.set(user.id, user);
		}
		for (const media of payload.includes?.media ?? []) {
			mediaByKey.set(media.media_key, media);
		}
		if (data.length >= limit) break;
	}

	return {
		data,
		includes: {
			users: [...usersById.values()],
			media: [...mediaByKey.values()],
		},
		meta,
	} satisfies XurlMentionsResponse;
}

function resolveAccount(db: Database, accountId?: string) {
	const row = accountId
		? (db
				.prepare(
					"select id, handle, external_user_id, is_default as isDefault from accounts where id = ?",
				)
				.get(accountId) as
				| ({ id: string; handle: string; external_user_id: string | null } & {
						isDefault: number;
				  })
				| undefined)
		: (db
				.prepare(
					`
          select id, handle, external_user_id, is_default as isDefault
          from accounts
          order by is_default desc, created_at asc
          limit 1
          `,
				)
				.get() as
				| ({ id: string; handle: string; external_user_id: string | null } & {
						isDefault: number;
				  })
				| undefined);

	if (!row) {
		throw new Error(`Unknown account: ${accountId ?? "default"}`);
	}

	return {
		accountId: row.id,
		isDefault: row.isDefault === 1,
		username: row.handle.replace(/^@/, ""),
		externalUserId:
			typeof row.external_user_id === "string" &&
			row.external_user_id.trim().length > 0
				? row.external_user_id.trim()
				: undefined,
	};
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
	source: "bird" | "xurl",
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
    ) values (?, ?, ?, 'home', ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
    on conflict(id) do update set
      account_id = tweets.account_id,
      author_profile_id = excluded.author_profile_id,
      kind = tweets.kind,
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
      bookmarked = tweets.bookmarked,
      liked = tweets.liked,
      quoted_tweet_id = coalesce(tweets.quoted_tweet_id, excluded.quoted_tweet_id)
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
			const replyToId = getReferencedTweetId(tweet, "replied_to") ?? null;
			const quotedTweetId = getReferencedTweetId(tweet, "quoted") ?? null;
			upsertTweet.run(
				tweet.id,
				accountId,
				profile.profile.id,
				tweet.text,
				tweet.created_at,
				0,
				replyToId,
				Number(tweet.public_metrics?.like_count ?? 0),
				countTweetMedia(tweet),
				JSON.stringify(tweetEntitiesFromXurl(tweet.entities)),
				buildMediaJsonFromIncludes(tweet, payload.includes?.media),
				quotedTweetId,
			);
			upsertTweetAccountEdge(db, {
				accountId,
				tweetId: tweet.id,
				kind: "home",
				source,
				seenAt,
				rawJson: JSON.stringify(tweet),
			});
			replaceTweetFts(db, tweet.id, tweet.text);
		}
	})();
}

export function syncHomeTimelineEffect({
	account,
	mode,
	limit,
	maxPages,
	startTime,
	following = true,
	refresh = false,
	cacheTtlMs,
	timeoutMs,
	onProgress,
}: SyncHomeTimelineOptions = {}): Effect.Effect<
	{
		ok: true;
		source: "bird" | "xurl" | "cache";
		kind: "timeline";
		accountId: string;
		feed: "following" | "for-you";
		count: number;
		payload: XurlMentionsResponse;
	},
	unknown
> {
	return Effect.gen(function* () {
		const parsedStartTime = yield* Effect.try({
			try: () => parseStartTime(startTime),
			catch: (error) => error,
		});
		const parsedMode = parseMode(mode);
		const finiteFallbackLimit = limit ?? (parsedStartTime ? 300 : 100);
		const effectiveLimit =
			limit ??
			(parsedStartTime && (parsedMode === "xurl" || parsedMode === "auto")
				? Infinity
				: finiteFallbackLimit);
		assertLimit(effectiveLimit);
		const parsedMaxPages =
			maxPages === undefined && parsedStartTime
				? Infinity
				: parseMaxPages(maxPages);
		const db = getNativeDb();
		const resolvedAccount = resolveAccount(db, account);
		const accountId = resolvedAccount.accountId;
		const effectiveMode =
			parsedMode === "auto" &&
			account !== undefined &&
			!resolvedAccount.isDefault
				? "xurl"
				: parsedMode;
		const cacheKey = `timeline:${effectiveMode}:${accountId}:${following ? "following" : "for-you"}:${Number.isFinite(effectiveLimit) ? String(effectiveLimit) : "all"}:${Number.isFinite(parsedMaxPages) ? String(parsedMaxPages) : "all-pages"}:${parsedStartTime?.iso ?? "no-start"}`;
		const ttlMs = parseCacheTtlMs(cacheTtlMs);
		const cached = readSyncCache<XurlMentionsResponse>(cacheKey, db);
		const cacheAgeMs = cached
			? Date.now() - new Date(cached.updatedAt).getTime()
			: Number.POSITIVE_INFINITY;

		if (!refresh && cached && cacheAgeMs <= ttlMs) {
			yield* Effect.sync(() =>
				onProgress?.({
					source: "cache",
					fetched: cached.value.data.length,
					total: Number.isFinite(effectiveLimit) ? effectiveLimit : undefined,
					done: true,
				}),
			);
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

		const fetchViaXurl = Effect.gen(function* () {
			if (!following) {
				return yield* Effect.fail(
					new Error("xurl home timeline mode does not support --for-you"),
				);
			}
			const pages: XurlMentionsResponse[] = [];
			let nextToken: string | undefined;
			for (let page = 0; page < parsedMaxPages; page += 1) {
				const fetchedCount = pages.reduce(
					(sum, item) => sum + item.data.length,
					0,
				);
				const remaining = Number.isFinite(effectiveLimit)
					? Math.max(1, effectiveLimit - fetchedCount)
					: Infinity;
				const pageSize = Math.min(
					MAX_XURL_TIMELINE_PAGE_SIZE,
					Math.max(5, remaining),
				);
				const pagePayload = yield* listHomeTimelineViaXurlEffect({
					maxResults: pageSize,
					userId: resolvedAccount.externalUserId,
					username: resolvedAccount.username,
					paginationToken: nextToken,
					timeoutMs,
				});
				pages.push(pagePayload);
				nextToken =
					typeof pagePayload.meta?.next_token === "string"
						? pagePayload.meta.next_token
						: undefined;
				const totalFetched = fetchedCount + pagePayload.data.length;
				const done =
					!nextToken ||
					(Number.isFinite(parsedMaxPages) && page + 1 >= parsedMaxPages) ||
					(Number.isFinite(effectiveLimit) && totalFetched >= effectiveLimit) ||
					reachedStartTimeBoundary(pagePayload, parsedStartTime?.time);
				yield* Effect.sync(() =>
					onProgress?.({
						source: "xurl",
						fetched: totalFetched,
						total: Number.isFinite(effectiveLimit) ? effectiveLimit : undefined,
						page: page + 1,
						maxPages: Number.isFinite(parsedMaxPages)
							? parsedMaxPages
							: undefined,
						pageSize,
						done,
					}),
				);
				if (done) {
					break;
				}
			}
			return mergeTimelinePayloads(pages, effectiveLimit);
		});
		const fetchViaBird = listHomeTimelineViaBirdEffect({
			maxResults: finiteFallbackLimit,
			following,
		});
		let source: "bird" | "xurl";
		let payload: XurlMentionsResponse;
		if (effectiveMode === "xurl") {
			payload = yield* fetchViaXurl;
			source = "xurl";
		} else if (effectiveMode === "auto") {
			const fetched = yield* fetchViaXurl.pipe(
				Effect.map((value) => ({ source: "xurl" as const, value })),
				Effect.catchAll(() =>
					fetchViaBird.pipe(
						Effect.map((value) => ({ source: "bird" as const, value })),
					),
				),
			);
			payload = fetched.value;
			source = fetched.source;
		} else {
			payload = yield* listHomeTimelineViaBirdEffect({
				maxResults: finiteFallbackLimit,
				following,
			});
			source = "bird";
		}
		if (source === "bird") {
			yield* Effect.sync(() =>
				onProgress?.({
					source: "bird",
					fetched: payload.data.length,
					total: finiteFallbackLimit,
					done: true,
				}),
			);
		}
		mergeHomeTimelineIntoLocalStore(db, accountId, payload, source);
		writeSyncCache(cacheKey, payload, db);

		return {
			ok: true,
			source,
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
