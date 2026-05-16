import type { Database } from "./sqlite";
import { Effect } from "effect";
import { getNativeDb } from "./db";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import { readSyncCache, writeSyncCache } from "./sync-cache";
import type {
	TweetEntities,
	TweetMediaItem,
	XurlMedia,
	XurlMentionData,
	XurlMentionUser,
	XurlTweetData,
	XurlTweetIncludes,
	XurlUserTweet,
	XurlUserTweetsResponse,
} from "./types";
import { upsertTweetAccountEdge } from "./tweet-account-edges";
import {
	buildExternalProfileId,
	ensureStubProfileForXUser,
	upsertProfileFromXUser,
} from "./x-profile";
import {
	getTransportStatus,
	listUserTweets,
	lookupAuthenticatedUser,
} from "./xurl";

export type AuthoredSyncMode = "xurl";

export interface SyncAuthoredTweetsOptions {
	account?: string;
	mode?: AuthoredSyncMode;
	limit?: number;
	maxPages?: number;
	sinceId?: string;
	untilId?: string;
}

export class AuthoredSyncError extends Error {
	constructor(
		message: string,
		public readonly exitCode: number,
	) {
		super(message);
		this.name = "AuthoredSyncError";
	}
}

// sync_cache JSON shapes:
// { state: "committed", sinceId }
// { state: "pending-forward", sinceId, token, pendingNewestId }
// { state: "pending-until", sinceId, token, untilId, requestedSinceId }
type AuthoredCursorState =
	| { state: "committed"; sinceId: string | null }
	| {
			state: "pending-forward";
			sinceId: string | null;
			token: string;
			pendingNewestId: string | null;
	  }
	| {
			state: "pending-until";
			sinceId: string | null;
			token: string;
			untilId: string;
			requestedSinceId?: string | null;
	  };

interface AuthoredPayload {
	data: XurlMentionData[];
	includes?: XurlTweetIncludes;
	meta: {
		result_count: number;
		page_count: number;
		next_token: string | null;
		newest_id?: string;
		oldest_id?: string;
	};
}

const MIN_XURL_LIMIT = 5;
const MAX_XURL_LIMIT = 100;
const DEFAULT_LIMIT = 100;
const AUTHORED_CURSOR_PREFIX = "authored:xurl";
const AUTHORED_TWEET_FIELDS = [
	"author_id",
	"created_at",
	"conversation_id",
	"entities",
	"attachments",
	"public_metrics",
	"referenced_tweets",
];
const AUTHORED_EXPANSIONS = [
	"author_id",
	"referenced_tweets.id",
	"referenced_tweets.id.author_id",
	"attachments.media_keys",
];
const AUTHORED_USER_FIELDS = [
	"description",
	"entities",
	"location",
	"public_metrics",
	"profile_image_url",
	"url",
	"created_at",
	"verified",
	"verified_type",
];
const AUTHORED_MEDIA_FIELDS = [
	"media_key",
	"type",
	"url",
	"preview_image_url",
	"width",
	"height",
	"alt_text",
];

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function trySync<T>(try_: () => T) {
	return Effect.try({
		try: try_,
		catch: toError,
	});
}

function assertXurlLimit(limit: number) {
	if (
		!Number.isFinite(limit) ||
		limit < MIN_XURL_LIMIT ||
		limit > MAX_XURL_LIMIT
	) {
		throw new Error("xurl mode requires --limit between 5 and 100");
	}
	return Math.floor(limit);
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

function cursorKey(accountId: string) {
	return `${AUTHORED_CURSOR_PREFIX}:${accountId}:cursor`;
}

function normalizeCursor(value: unknown): AuthoredCursorState {
	if (!value || typeof value !== "object") {
		return { state: "committed", sinceId: null };
	}
	const record = value as Record<string, unknown>;
	const sinceId = typeof record.sinceId === "string" ? record.sinceId : null;
	if (record.state === "pending-forward" && typeof record.token === "string") {
		return {
			state: "pending-forward",
			sinceId,
			token: record.token,
			pendingNewestId:
				typeof record.pendingNewestId === "string"
					? record.pendingNewestId
					: null,
		};
	}
	if (
		record.state === "pending-until" &&
		typeof record.token === "string" &&
		typeof record.untilId === "string"
	) {
		const requestedSinceId =
			"requestedSinceId" in record
				? typeof record.requestedSinceId === "string"
					? record.requestedSinceId
					: null
				: undefined;
		return {
			state: "pending-until",
			sinceId,
			token: record.token,
			untilId: record.untilId,
			...(requestedSinceId !== undefined ? { requestedSinceId } : {}),
		};
	}
	const legacyToken =
		typeof record.paginationToken === "string" ? record.paginationToken : null;
	if (legacyToken) {
		return {
			state: "pending-forward",
			sinceId,
			token: legacyToken,
			pendingNewestId:
				typeof record.pendingNewestId === "string"
					? record.pendingNewestId
					: null,
		};
	}
	return { state: "committed", sinceId };
}

function readAuthoredCursor(db: Database, accountId: string) {
	return normalizeCursor(readSyncCache(cursorKey(accountId), db)?.value);
}

function writeAuthoredCursor(
	db: Database,
	accountId: string,
	state: AuthoredCursorState,
) {
	writeSyncCache(cursorKey(accountId), state, db);
}

function writeCommittedCursor(
	db: Database,
	accountId: string,
	sinceId: string | null,
) {
	writeAuthoredCursor(db, accountId, { state: "committed", sinceId });
}

function writePendingForwardCursor(
	db: Database,
	accountId: string,
	{
		sinceId,
		token,
		pendingNewestId,
	}: {
		sinceId: string | null;
		token: string;
		pendingNewestId: string | null;
	},
) {
	writeAuthoredCursor(db, accountId, {
		state: "pending-forward",
		sinceId,
		token,
		pendingNewestId,
	});
}

function writePendingUntilCursor(
	db: Database,
	accountId: string,
	{
		sinceId,
		token,
		untilId,
		requestedSinceId,
	}: {
		sinceId: string | null;
		token: string;
		untilId: string;
		requestedSinceId: string | null;
	},
) {
	writeAuthoredCursor(db, accountId, {
		state: "pending-until",
		sinceId,
		token,
		untilId,
		requestedSinceId,
	});
}

// Archive seeds stay archive-only because backups can contain live edges without sync_cache.
function findArchiveAuthoredSinceSeed(db: Database, accountId: string) {
	const row = db
		.prepare(
			`
    select t.id
    from tweets t
    join accounts a on a.id = ?
    where t.id glob '[0-9]*'
      and t.id not glob '*[^0-9]*'
      and (
      exists (
        select 1
        from tweet_account_edges e
	        where e.account_id = ?
	          and e.tweet_id = t.id
	          and e.kind = 'authored'
	          and e.source = 'archive'
	      )
      or (
        t.kind = 'home'
        and exists (
          select 1
          from tweet_account_edges e2
          where e2.account_id = ?
            and e2.tweet_id = t.id
            and e2.source = 'archive'
            and e2.kind = 'home'
        )
        and t.author_profile_id in ('profile_me', 'profile_user_' || a.external_user_id)
      )
    )
    order by length(t.id) desc, t.id desc
    limit 1
    `,
		)
		.get(accountId, accountId, accountId) as { id: string } | undefined;
	return row?.id ?? null;
}

function compareTweetIds(
	left: string | null | undefined,
	right: string | null | undefined,
) {
	if (!left && !right) {
		return 0;
	}
	if (!left) {
		return -1;
	}
	if (!right) {
		return 1;
	}
	try {
		const leftBigInt = BigInt(left);
		const rightBigInt = BigInt(right);
		return leftBigInt === rightBigInt ? 0 : leftBigInt > rightBigInt ? 1 : -1;
	} catch {
		if (left.length !== right.length) {
			return left.length > right.length ? 1 : -1;
		}
		return left.localeCompare(right);
	}
}

function maxTweetId(...ids: Array<string | null | undefined>) {
	return ids.reduce<string | null>((current, next) => {
		if (!next) {
			return current;
		}
		return compareTweetIds(next, current) > 0 ? next : current;
	}, null);
}

function getNewestTweetId(tweets: XurlMentionData[]) {
	return maxTweetId(...tweets.map((tweet) => tweet.id));
}

function getOldestTweetId(tweets: XurlMentionData[]) {
	return tweets.reduce<string | null>((current, tweet) => {
		if (!current) {
			return tweet.id;
		}
		return compareTweetIds(tweet.id, current) < 0 ? tweet.id : current;
	}, null);
}

function resolveAccount(db: Database, accountId?: string) {
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

function normalizeUsername(value: string) {
	return value.replace(/^@/, "").trim().toLowerCase();
}

function persistAccountExternalUserId(
	db: Database,
	accountId: string,
	externalUserId: string,
) {
	db.prepare(
		`
    update accounts
    set external_user_id = ?
    where id = ?
      and (external_user_id is null or external_user_id = '')
    `,
	).run(externalUserId, accountId);
}

function userFromAuthenticatedPayload(
	payload: Record<string, unknown> | null,
): XurlMentionUser | undefined {
	if (!payload || typeof payload.id !== "string") {
		return undefined;
	}
	const username =
		typeof payload.username === "string"
			? payload.username.replace(/^@/, "")
			: "";
	if (!username) {
		return undefined;
	}
	return {
		id: payload.id,
		username,
		name: typeof payload.name === "string" ? payload.name : username,
	};
}

function resolveAuthoredIdentityEffect({
	account,
	db,
}: {
	account?: string;
	db: Database;
}) {
	return Effect.gen(function* () {
		const status = yield* tryPromise(() => getTransportStatus());
		if (status.availableTransport !== "xurl") {
			return yield* Effect.fail(new AuthoredSyncError(status.statusText, 4));
		}

		const resolvedAccount = yield* trySync(() => resolveAccount(db, account));
		if (resolvedAccount.externalUserId) {
			return {
				...resolvedAccount,
				userId: resolvedAccount.externalUserId,
				authenticatedUser: undefined,
			};
		}

		const authenticated = yield* tryPromise(() => lookupAuthenticatedUser());
		const authenticatedUser = userFromAuthenticatedPayload(authenticated);
		if (!authenticatedUser?.id) {
			return yield* Effect.fail(
				new AuthoredSyncError(
					"Could not resolve authenticated Twitter user id",
					4,
				),
			);
		}

		if (
			normalizeUsername(authenticatedUser.username) !==
			normalizeUsername(resolvedAccount.username)
		) {
			return yield* Effect.fail(
				new AuthoredSyncError(
					`xurl is authenticated as @${authenticatedUser.username}, but selected account ${resolvedAccount.accountId} is @${resolvedAccount.username}. Link the account external_user_id or switch xurl login before syncing authored tweets.`,
					4,
				),
			);
		}

		yield* trySync(() =>
			persistAccountExternalUserId(
				db,
				resolvedAccount.accountId,
				authenticatedUser.id,
			),
		);

		return {
			...resolvedAccount,
			userId: authenticatedUser.id,
			authenticatedUser,
		};
	});
}

function toFallbackUser({
	userId,
	username,
	authenticatedUser,
}: {
	userId: string;
	username: string;
	authenticatedUser?: XurlMentionUser;
}): XurlMentionUser {
	if (authenticatedUser?.id === userId) {
		return authenticatedUser;
	}
	return {
		id: userId,
		username: username || `user_${userId}`,
		name: username || `user_${userId}`,
	};
}

function toMentionData(tweet: XurlUserTweet, fallbackAuthorId: string) {
	return {
		...tweet,
		author_id: tweet.author_id ?? fallbackAuthorId,
	} satisfies XurlMentionData;
}

function toLocalEntities(tweet: XurlMentionData): TweetEntities {
	const raw = tweet.entities;
	if (!raw || typeof raw !== "object") {
		return {};
	}

	const entities = raw as Record<string, unknown>;
	const rawMentions = Array.isArray(entities.mentions) ? entities.mentions : [];
	const rawUrls = Array.isArray(entities.urls) ? entities.urls : [];
	const rawHashtags = Array.isArray(entities.hashtags) ? entities.hashtags : [];

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
		...(rawHashtags.length
			? {
					hashtags: rawHashtags.map((hashtag) => {
						const value =
							hashtag && typeof hashtag === "object"
								? (hashtag as Record<string, unknown>)
								: {};
						return {
							tag: String(value.tag ?? ""),
							start: Number(value.start ?? 0),
							end: Number(value.end ?? 0),
						};
					}),
				}
			: {}),
	};
}

function toMediaType(type: string): TweetMediaItem["type"] {
	if (type === "photo" || type === "image") {
		return "image";
	}
	if (type === "animated_gif" || type === "gif") {
		return "gif";
	}
	return type === "video" ? "video" : "unknown";
}

function toLocalMedia(
	tweet: XurlMentionData,
	mediaByKey: Map<string, XurlMedia>,
) {
	const mediaKeys = tweet.attachments?.media_keys ?? [];
	const seen = new Set<string>();
	return mediaKeys
		.map((mediaKey) => mediaByKey.get(mediaKey))
		.filter((media): media is XurlMedia => Boolean(media))
		.map((media) => {
			const url = media.url ?? media.preview_image_url ?? "";
			const thumbnailUrl = media.preview_image_url ?? media.url ?? "";
			return {
				url,
				type: toMediaType(media.type),
				...(typeof media.alt_text === "string"
					? { altText: media.alt_text }
					: {}),
				...(typeof media.width === "number" ? { width: media.width } : {}),
				...(typeof media.height === "number" ? { height: media.height } : {}),
				...(thumbnailUrl ? { thumbnailUrl } : {}),
			};
		})
		.filter((media) => {
			const key = media.url || media.thumbnailUrl;
			if (!key || seen.has(key)) {
				return false;
			}
			seen.add(key);
			return true;
		});
}

function getMediaCount(tweet: XurlMentionData, media: TweetMediaItem[]) {
	if (media.length > 0) {
		return media.length;
	}
	if (tweet.attachments?.media_keys?.length) {
		return tweet.attachments.media_keys.length;
	}
	const urls = Array.isArray(tweet.entities?.urls) ? tweet.entities.urls : [];
	return urls.filter(
		(url) =>
			url &&
			typeof url === "object" &&
			typeof (url as Record<string, unknown>).media_key === "string",
	).length;
}

function getReferencedTweetId(tweet: XurlMentionData, type: string) {
	return (
		tweet.referenced_tweets?.find((item) => item.type === type)?.id ?? null
	);
}

function replaceTweetFts(db: Database, tweetId: string, text: string) {
	db.prepare("delete from tweets_fts where tweet_id = ?").run(tweetId);
	db.prepare("insert into tweets_fts (tweet_id, text) values (?, ?)").run(
		tweetId,
		text,
	);
}

function findExistingProfileIdForUser(db: Database, user: XurlMentionUser) {
	const username = String(user.username ?? "").replace(/^@/, "");
	const row = db
		.prepare(
			`
      select id
      from profiles
      where id = ? or handle = ?
      limit 1
      `,
		)
		.get(buildExternalProfileId(user.id), username) as
		| { id: string }
		| undefined;
	return row?.id ?? null;
}

function mergeAuthoredPayloadIntoLocalStore({
	db,
	accountId,
	payload,
	sourceUser,
}: {
	db: Database;
	accountId: string;
	payload: AuthoredPayload;
	sourceUser: XurlMentionUser;
}) {
	const usersById = new Map(
		(payload.includes?.users ?? []).map((user) => [user.id, user]),
	);
	const fallbackUserIds = new Set<string>();
	if (!usersById.has(sourceUser.id)) {
		usersById.set(sourceUser.id, sourceUser);
		fallbackUserIds.add(sourceUser.id);
	}
	const mediaByKey = new Map(
		(payload.includes?.media ?? []).map((media) => [media.media_key, media]),
	);
	const upsertTweet = db.prepare(
		`
    insert into tweets (
      id, account_id, author_profile_id, kind, text, created_at,
      is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
      entities_json, media_json, quoted_tweet_id
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set
      account_id = tweets.account_id,
      author_profile_id = excluded.author_profile_id,
      kind = case
        when tweets.kind in ('home', 'mention', 'authored') then tweets.kind
        when excluded.kind in ('home', 'mention', 'authored') then excluded.kind
        else coalesce(nullif(tweets.kind, ''), excluded.kind)
      end,
      text = excluded.text,
      created_at = excluded.created_at,
      like_count = excluded.like_count,
      media_count = excluded.media_count,
      entities_json = excluded.entities_json,
      media_json = excluded.media_json,
      is_replied = max(tweets.is_replied, excluded.is_replied),
      reply_to_id = coalesce(excluded.reply_to_id, tweets.reply_to_id),
      quoted_tweet_id = coalesce(excluded.quoted_tweet_id, tweets.quoted_tweet_id),
      bookmarked = tweets.bookmarked,
      liked = tweets.liked
    `,
	);

	const writeTweet = (tweet: XurlMentionData, kind: "authored" | "thread") => {
		const author =
			usersById.get(tweet.author_id) ??
			({
				id: tweet.author_id,
				username: `user_${tweet.author_id}`,
				name: `user_${tweet.author_id}`,
			} as const);
		const profileId =
			usersById.has(tweet.author_id) && !fallbackUserIds.has(tweet.author_id)
				? upsertProfileFromXUser(db, author).profile.id
				: ((fallbackUserIds.has(tweet.author_id)
						? findExistingProfileIdForUser(db, author)
						: null) ??
					ensureStubProfileForXUser(db, tweet.author_id).profile.id);
		const replyToId = getReferencedTweetId(tweet, "replied_to");
		const quotedTweetId = getReferencedTweetId(tweet, "quoted");
		const media = toLocalMedia(tweet, mediaByKey);
		upsertTweet.run(
			tweet.id,
			accountId,
			profileId,
			kind,
			tweet.text,
			tweet.created_at,
			replyToId ? 1 : 0,
			replyToId,
			Number(tweet.public_metrics?.like_count ?? 0),
			getMediaCount(tweet, media),
			0,
			0,
			JSON.stringify(toLocalEntities(tweet)),
			JSON.stringify(media),
			quotedTweetId,
		);
		replaceTweetFts(db, tweet.id, tweet.text);
	};

	db.transaction(() => {
		const seenAt = new Date().toISOString();
		for (const includedTweet of payload.includes?.tweets ?? []) {
			writeTweet(includedTweet, "thread");
		}
		for (const tweet of payload.data) {
			writeTweet(tweet, "authored");
			upsertTweetAccountEdge(db, {
				accountId,
				tweetId: tweet.id,
				kind: "authored",
				source: "xurl",
				seenAt,
				rawJson: JSON.stringify(tweet),
			});
		}
	})();
}

function appendUniqueById<T extends { id: string }>(
	target: T[],
	seenIds: Set<string>,
	items: T[] | undefined,
) {
	for (const item of items ?? []) {
		if (seenIds.has(item.id)) {
			continue;
		}
		seenIds.add(item.id);
		target.push(item);
	}
}

function appendUniqueMedia(
	target: XurlMedia[],
	seenIds: Set<string>,
	items: XurlMedia[] | undefined,
) {
	for (const item of items ?? []) {
		if (seenIds.has(item.media_key)) {
			continue;
		}
		seenIds.add(item.media_key);
		target.push(item);
	}
}

function mergePages({
	pages,
	userId,
	nextToken,
}: {
	pages: XurlUserTweetsResponse[];
	userId: string;
	nextToken: string | null;
}): AuthoredPayload {
	const tweets: XurlMentionData[] = [];
	const users: XurlMentionUser[] = [];
	const includedTweets: XurlTweetData[] = [];
	const media: XurlMedia[] = [];
	const seenTweetIds = new Set<string>();
	const seenUserIds = new Set<string>();
	const seenIncludedTweetIds = new Set<string>();
	const seenMediaKeys = new Set<string>();

	for (const page of pages) {
		for (const tweet of page.items) {
			const normalized = toMentionData(tweet, userId);
			if (seenTweetIds.has(normalized.id)) {
				continue;
			}
			seenTweetIds.add(normalized.id);
			tweets.push(normalized);
		}
		appendUniqueById(users, seenUserIds, page.includes?.users);
		appendUniqueById(
			includedTweets,
			seenIncludedTweetIds,
			page.includes?.tweets,
		);
		appendUniqueMedia(media, seenMediaKeys, page.includes?.media);
	}

	const newestId = getNewestTweetId(tweets);
	const oldestId = getOldestTweetId(tweets);
	const includes = {
		...(users.length > 0 ? { users } : {}),
		...(includedTweets.length > 0 ? { tweets: includedTweets } : {}),
		...(media.length > 0 ? { media } : {}),
	};

	return {
		data: tweets,
		...(Object.keys(includes).length > 0 ? { includes } : {}),
		meta: {
			result_count: tweets.length,
			page_count: pages.length,
			next_token: nextToken,
			...(newestId ? { newest_id: newestId } : {}),
			...(oldestId ? { oldest_id: oldestId } : {}),
		},
	};
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function buildResult({
	accountId,
	userId,
	effectiveSinceId,
	nextSinceId,
	nextToken,
	pageCount,
	payload,
	partial,
	error,
}: {
	accountId: string;
	userId: string;
	effectiveSinceId: string | null;
	nextSinceId: string | null;
	nextToken: string | null;
	pageCount: number;
	payload: AuthoredPayload;
	partial: boolean;
	error?: string;
}) {
	return {
		ok: !partial,
		kind: "authored" as const,
		source: "xurl" as const,
		accountId,
		userId,
		count: payload.data.length,
		pages: pageCount,
		sinceId: effectiveSinceId,
		nextSinceId,
		nextToken,
		partial,
		...(error ? { error } : {}),
		cursor: {
			sinceId: nextSinceId,
			paginationToken: nextToken,
			pending: Boolean(nextToken),
		},
		payload,
	};
}

export function syncAuthoredTweetsEffect({
	account,
	mode = "xurl",
	limit = DEFAULT_LIMIT,
	maxPages,
	sinceId,
	untilId,
}: SyncAuthoredTweetsOptions) {
	return Effect.gen(function* () {
		if (mode !== "xurl") {
			return yield* Effect.fail(
				new Error("authored sync only supports --mode xurl"),
			);
		}

		const pageLimit = yield* trySync(() => assertXurlLimit(limit));
		const parsedMaxPages = yield* trySync(() => parseMaxPages(maxPages));
		const db = yield* trySync(() => getNativeDb());
		const identity = yield* resolveAuthoredIdentityEffect({ account, db });
		const cursor = yield* trySync(() =>
			readAuthoredCursor(db, identity.accountId),
		);
		const usePersistedForward =
			sinceId === undefined && !untilId && cursor.state === "pending-forward";
		const usePersistedUntil =
			sinceId === undefined &&
			Boolean(untilId) &&
			cursor.state === "pending-until" &&
			cursor.untilId === untilId;
		const shouldSeedFromArchive =
			!usePersistedForward &&
			!cursor.sinceId &&
			sinceId === undefined &&
			!untilId;
		const archiveSinceSeed = shouldSeedFromArchive
			? yield* trySync(() =>
					findArchiveAuthoredSinceSeed(db, identity.accountId),
				)
			: null;
		if (shouldSeedFromArchive && !archiveSinceSeed) {
			console.error(
				"birdclaw sync authored: no archive baseline found; starting a full backwards scan",
			);
		}
		const persistedUntilSinceId: string | null = usePersistedUntil
			? (("requestedSinceId" in cursor
					? cursor.requestedSinceId
					: cursor.sinceId) ?? null)
			: null;
		const effectiveSinceId: string | null =
			sinceId ??
			archiveSinceSeed ??
			(untilId ? persistedUntilSinceId : cursor.sinceId) ??
			null;
		let nextToken = usePersistedForward
			? cursor.token
			: usePersistedUntil
				? cursor.token
				: undefined;
		let newestSeenId = usePersistedForward
			? maxTweetId(cursor.sinceId, cursor.pendingNewestId)
			: cursor.sinceId;
		const pages: XurlUserTweetsResponse[] = [];
		const sourceUser = toFallbackUser({
			userId: identity.userId,
			username: identity.username,
			authenticatedUser: identity.authenticatedUser,
		});
		let pageCount = 0;

		while (parsedMaxPages === null || pageCount < parsedMaxPages) {
			const fetched = yield* tryPromise(() =>
				listUserTweets(identity.userId, {
					maxResults: pageLimit,
					paginationToken: nextToken,
					excludeRetweets: false,
					sinceId: effectiveSinceId ?? undefined,
					untilId,
					tweetFields: AUTHORED_TWEET_FIELDS,
					expansions: AUTHORED_EXPANSIONS,
					userFields: AUTHORED_USER_FIELDS,
					mediaFields: AUTHORED_MEDIA_FIELDS,
					auth: "oauth2",
				}),
			).pipe(
				Effect.map((page) => ({ ok: true as const, page })),
				Effect.catchAll((error) =>
					Effect.succeed({ ok: false as const, error }),
				),
			);

			if (!fetched.ok) {
				if (pages.length === 0) {
					return yield* Effect.fail(fetched.error);
				}
				const payload = mergePages({
					pages,
					userId: identity.userId,
					nextToken: nextToken ?? null,
				});
				return buildResult({
					accountId: identity.accountId,
					userId: identity.userId,
					effectiveSinceId,
					nextSinceId: untilId ? cursor.sinceId : effectiveSinceId,
					nextToken: nextToken ?? null,
					pageCount,
					payload,
					partial: true,
					error: formatError(fetched.error),
				});
			}

			const page = fetched.page;
			const pagePayload = mergePages({
				pages: [page],
				userId: identity.userId,
				nextToken: page.nextToken,
			});
			yield* trySync(() =>
				mergeAuthoredPayloadIntoLocalStore({
					db,
					accountId: identity.accountId,
					payload: pagePayload,
					sourceUser,
				}),
			);
			pages.push(page);
			pageCount += 1;
			newestSeenId = maxTweetId(newestSeenId, pagePayload.meta.newest_id);
			nextToken = page.nextToken ?? undefined;

			const pendingToken = nextToken;
			if (pendingToken && untilId) {
				yield* trySync(() =>
					writePendingUntilCursor(db, identity.accountId, {
						sinceId: cursor.sinceId,
						token: pendingToken,
						untilId,
						requestedSinceId: effectiveSinceId,
					}),
				);
			} else if (pendingToken) {
				yield* trySync(() =>
					writePendingForwardCursor(db, identity.accountId, {
						sinceId: effectiveSinceId,
						token: pendingToken,
						pendingNewestId: newestSeenId,
					}),
				);
			}

			if (!nextToken) {
				break;
			}
		}

		const capped = Boolean(nextToken);
		const nextSinceId = untilId
			? cursor.sinceId
			: capped
				? effectiveSinceId
				: maxTweetId(newestSeenId, effectiveSinceId, cursor.sinceId);
		if (untilId && capped && nextToken) {
			yield* trySync(() =>
				writePendingUntilCursor(db, identity.accountId, {
					sinceId: cursor.sinceId,
					token: nextToken,
					untilId,
					requestedSinceId: effectiveSinceId,
				}),
			);
		} else if (untilId) {
			yield* trySync(() =>
				writeCommittedCursor(db, identity.accountId, cursor.sinceId),
			);
		} else if (capped && nextToken) {
			yield* trySync(() =>
				writePendingForwardCursor(db, identity.accountId, {
					sinceId: nextSinceId,
					token: nextToken,
					pendingNewestId: newestSeenId,
				}),
			);
		} else {
			yield* trySync(() =>
				writeCommittedCursor(db, identity.accountId, nextSinceId),
			);
		}

		const payload = mergePages({
			pages,
			userId: identity.userId,
			nextToken: nextToken ?? null,
		});
		return buildResult({
			accountId: identity.accountId,
			userId: identity.userId,
			effectiveSinceId,
			nextSinceId,
			nextToken: nextToken ?? null,
			pageCount,
			payload,
			partial: capped,
			...(capped ? { error: "max pages reached before sync completed" } : {}),
		});
	});
}

export function syncAuthoredTweets(options: SyncAuthoredTweetsOptions) {
	return runEffectPromise(syncAuthoredTweetsEffect(options));
}
