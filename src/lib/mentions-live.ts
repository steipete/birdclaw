import type { Database } from "./sqlite";
import { listMentionsViaBird } from "./bird";
import type { MentionsDataSource } from "./config";
import { getNativeDb } from "./db";
import { serializeMentionItemsAsXurlCompatible } from "./mentions-export";
import { listTimelineItems } from "./queries";
import { readSyncCache, writeSyncCache } from "./sync-cache";
import type {
	ReplyFilter,
	TweetEntities,
	XurlMentionData,
	XurlMentionsResponse,
	XurlMentionUser,
} from "./types";
import { upsertTweetAccountEdge } from "./tweet-account-edges";
import { ensureStubProfileForXUser, upsertProfileFromXUser } from "./x-profile";
import { listMentionsViaXurl, lookupUsersByHandles } from "./xurl";

export const DEFAULT_MENTIONS_CACHE_TTL_MS = 2 * 60_000;
const MIN_XURL_MENTIONS_LIMIT = 5;
const MAX_XURL_MENTIONS_LIMIT = 100;
type MentionSyncMode = Exclude<MentionsDataSource, "birdclaw">;

function getMentionsFetchModeKey({
	mode,
	accountId,
	pageSize,
	all,
	maxPages,
	sinceId,
}: {
	mode: MentionsDataSource;
	accountId: string;
	pageSize: number;
	all: boolean;
	maxPages: number | null;
	sinceId: string | null;
}) {
	return `mentions:${mode}:${accountId}:${String(pageSize)}:${all ? "all" : "single"}:${maxPages === null ? "all-pages" : String(maxPages)}:${sinceId ?? "no-since"}`;
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

function assertBirdLimit(limit: number) {
	if (!Number.isFinite(limit) || limit < 1) {
		throw new Error("bird mode requires --limit of at least 1");
	}
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

function parseSyncMode(value?: string): MentionSyncMode {
	const mode = value ?? "xurl";
	if (mode !== "bird" && mode !== "xurl") {
		throw new Error("--mode must be bird or xurl");
	}
	return mode;
}

function resolveAccount(db: Database, accountId?: string) {
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

function findNewestLocalMentionId(db: Database, accountId: string) {
	const row = db
		.prepare(
			`
      select t.id
      from tweets t
      join tweet_account_edges e
        on e.account_id = t.account_id and e.tweet_id = t.id
      where e.account_id = ?
        and e.kind = 'mention'
      order by length(t.id) desc, t.id desc
      limit 1
      `,
		)
		.get(accountId) as { id: string } | undefined;
	return row?.id;
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

function replaceTweetFts(db: Database, tweetId: string, text: string) {
	db.prepare("delete from tweets_fts where tweet_id = ?").run(tweetId);
	db.prepare("insert into tweets_fts (tweet_id, text) values (?, ?)").run(
		tweetId,
		text,
	);
}

function mergeMentionsIntoLocalStore(
	db: Database,
	accountId: string,
	payload: XurlMentionsResponse,
	source: MentionsDataSource,
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
      account_id = tweets.account_id,
      author_profile_id = excluded.author_profile_id,
      kind = case
        when tweets.kind in ('authored', 'home', 'mention') then tweets.kind
        when excluded.kind in ('authored', 'home', 'mention') then excluded.kind
        else excluded.kind
      end,
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
				getMediaCount(tweet),
				JSON.stringify(toLocalEntities(tweet)),
			);
			upsertTweetAccountEdge(db, {
				accountId,
				tweetId: tweet.id,
				kind: "mention",
				source,
				seenAt,
				rawJson: JSON.stringify(tweet),
			});
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

function mergeMentionPayloads(
	pages: XurlMentionsResponse[],
): XurlMentionsResponse {
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

	const lastMeta = pages.at(-1)?.meta;
	return {
		data: tweets,
		includes: users.length > 0 ? { users } : undefined,
		meta: {
			...lastMeta,
			result_count: tweets.length,
			page_count: pages.length,
			next_token:
				typeof lastMeta?.next_token === "string" ? lastMeta.next_token : null,
		},
	};
}

async function fetchMentionsViaXurl({
	resolvedAccount,
	limit,
	all,
	parsedMaxPages,
	sinceId,
}: {
	resolvedAccount: ReturnType<typeof resolveAccount>;
	limit: number;
	all: boolean;
	parsedMaxPages: number | null;
	sinceId?: string;
}) {
	const [accountUser] = await lookupUsersByHandles([resolvedAccount.username]);
	if (!accountUser?.id) {
		throw new Error(
			`Could not resolve Twitter user id for @${resolvedAccount.username}`,
		);
	}

	const pages: XurlMentionsResponse[] = [];
	let nextToken: string | undefined;
	let pageCount = 0;
	do {
		const payload = await listMentionsViaXurl({
			maxResults: limit,
			username: resolvedAccount.username,
			userId: String(accountUser.id),
			paginationToken: nextToken,
			...(sinceId ? { sinceId } : {}),
		});
		pages.push(payload);
		const metaNextToken =
			typeof payload.meta?.next_token === "string"
				? payload.meta.next_token
				: undefined;
		nextToken = metaNextToken;
		pageCount += 1;
	} while (
		all &&
		nextToken &&
		(parsedMaxPages === null || pageCount < parsedMaxPages)
	);

	return mergeMentionPayloads(pages);
}

async function fetchMentionsViaBird({ limit }: { limit: number }) {
	return listMentionsViaBird({ maxResults: limit });
}

function isMaxPagesPartial({
	payload,
	maxPages,
}: {
	payload: XurlMentionsResponse;
	maxPages: number | null;
}) {
	return (
		maxPages !== null &&
		typeof payload.meta?.next_token === "string" &&
		payload.meta.next_token.length > 0
	);
}

export async function syncMentions({
	account,
	mode,
	limit = 20,
	maxPages,
	refresh = false,
	cacheTtlMs,
	sinceId,
}: {
	account?: string;
	mode?: string;
	limit?: number;
	maxPages?: number;
	refresh?: boolean;
	cacheTtlMs?: number;
	sinceId?: string;
}) {
	const parsedMode = parseSyncMode(mode);
	const explicitSinceId = sinceId?.trim() || undefined;
	if (parsedMode === "xurl") {
		assertXurlLimit(limit);
	} else {
		assertBirdLimit(limit);
	}
	const parsedMaxPages = parseMaxPages(maxPages);
	const fetchAll = parsedMode === "xurl" && parsedMaxPages !== null;
	const db = getNativeDb();
	const resolvedAccount = resolveAccount(db, account);
	const cacheKey = getMentionsFetchModeKey({
		mode: parsedMode,
		accountId: resolvedAccount.accountId,
		pageSize: limit,
		all: fetchAll,
		maxPages: parsedMaxPages,
		sinceId: explicitSinceId ?? null,
	});
	const ttlMs = parseCacheTtlMs(cacheTtlMs);
	const cached = readSyncCache<XurlMentionsResponse>(cacheKey, db);
	const cacheAgeMs = cached
		? Date.now() - new Date(cached.updatedAt).getTime()
		: Number.POSITIVE_INFINITY;

	if (!refresh && cached && cacheAgeMs <= ttlMs) {
		mergeMentionsIntoLocalStore(
			db,
			resolvedAccount.accountId,
			cached.value,
			parsedMode,
		);
		return {
			ok: true,
			source: "cache",
			kind: "mentions",
			accountId: resolvedAccount.accountId,
			count: cached.value.data.length,
			partial: isMaxPagesPartial({
				payload: cached.value,
				maxPages: parsedMaxPages,
			}),
			payload: cached.value,
		};
	}

	const cachedPaginationToken =
		typeof cached?.value.meta?.next_token === "string" &&
		cached.value.meta.next_token.length > 0
			? cached.value.meta.next_token
			: undefined;
	const seededSinceId =
		parsedMode === "xurl" && !explicitSinceId && !cachedPaginationToken
			? findNewestLocalMentionId(db, resolvedAccount.accountId)
			: undefined;
	if (
		parsedMode === "xurl" &&
		!explicitSinceId &&
		!cachedPaginationToken &&
		!seededSinceId
	) {
		console.error(
			"No local mention baseline found; syncing mentions from the newest page backwards.",
		);
	}

	const payload =
		parsedMode === "bird"
			? await fetchMentionsViaBird({ limit })
			: await fetchMentionsViaXurl({
					resolvedAccount,
					limit,
					all: fetchAll,
					parsedMaxPages,
					sinceId: explicitSinceId ?? seededSinceId,
				});
	mergeMentionsIntoLocalStore(
		db,
		resolvedAccount.accountId,
		payload,
		parsedMode,
	);
	writeSyncCache(cacheKey, payload, db);

	return {
		ok: true,
		source: parsedMode,
		kind: "mentions",
		accountId: resolvedAccount.accountId,
		count: payload.data.length,
		partial: isMaxPagesPartial({ payload, maxPages: parsedMaxPages }),
		payload,
	};
}

async function exportMentionsViaCachedLiveSource({
	mode,
	account,
	search,
	replyFilter = "all",
	limit = 20,
	all = false,
	maxPages,
	refresh = false,
	cacheTtlMs,
}: {
	mode: MentionsDataSource;
	account?: string;
	search?: string;
	replyFilter?: ReplyFilter;
	limit?: number;
	all?: boolean;
	maxPages?: number;
	refresh?: boolean;
	cacheTtlMs?: number;
}) {
	if (mode === "xurl") {
		assertXurlLimit(limit);
	} else {
		assertBirdLimit(limit);
	}
	const parsedMaxPages = parseMaxPages(maxPages);
	const fetchAll = mode === "xurl" && (all || parsedMaxPages !== null);

	const db = getNativeDb();
	const resolvedAccount = resolveAccount(db, account);
	const cacheKey = getMentionsFetchModeKey({
		mode,
		accountId: resolvedAccount.accountId,
		pageSize: limit,
		all: fetchAll,
		maxPages: parsedMaxPages,
		sinceId: null,
	});
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
				limit: fetchAll ? cached.value.data.length : limit,
			});
		}
		return cached.value;
	}

	try {
		const payload =
			mode === "bird"
				? await listMentionsViaBird({ maxResults: limit })
				: await fetchMentionsViaXurl({
						resolvedAccount,
						limit,
						all: fetchAll,
						parsedMaxPages,
					});
		mergeMentionsIntoLocalStore(db, resolvedAccount.accountId, payload, mode);
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
				limit: fetchAll ? payload.data.length : limit,
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
					limit: fetchAll ? cached.value.data.length : limit,
				});
			}
			return cached.value;
		}
		throw error;
	}
}

export async function exportMentionsViaCachedXurl(
	options: Omit<
		Parameters<typeof exportMentionsViaCachedLiveSource>[0],
		"mode"
	>,
) {
	return exportMentionsViaCachedLiveSource({
		...options,
		mode: "xurl",
	});
}

export async function exportMentionsViaCachedBird(
	options: Omit<
		Parameters<typeof exportMentionsViaCachedLiveSource>[0],
		"mode"
	>,
) {
	return exportMentionsViaCachedLiveSource({
		...options,
		mode: "bird",
	});
}
