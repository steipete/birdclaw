import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { Database } from "./sqlite";
import { findArchivesEffect } from "./archive-finder";
import { getDb, getNativeDb } from "./db";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import { fetchProfileAffiliations } from "./profile-affiliations";
import { displayUrlForLink, enrichFallbackUrlEntities } from "./tweet-render";
import type {
	AccountRecord,
	DmConversationItem,
	DmMessageItem,
	DmQuery,
	EmbeddedTweet,
	ProfileRecord,
	QueryEnvelope,
	QueryResponse,
	ReplyFilter,
	TimelineQualityFilter,
	TimelineItem,
	TimelineQuery,
	TweetEntities,
	TweetConversationResponse,
	TweetMediaItem,
	TweetUrlEntity,
} from "./types";
import {
	dmViaXurlEffect,
	getTransportStatusEffect,
	lookupAuthenticatedUserFresh,
	postViaXurlEffect,
	replyViaXurlEffect,
} from "./xurl";

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function trySync<T>(try_: () => T) {
	return Effect.try({
		try: try_,
		catch: toError,
	});
}

function e2eFakeLiveWritesEnabled() {
	return (
		process.env.BIRDCLAW_E2E === "1" &&
		process.env.BIRDCLAW_E2E_FAKE_LIVE_WRITES === "1"
	);
}

function liveWritesDisabled() {
	return process.env.BIRDCLAW_DISABLE_LIVE_WRITES === "1";
}

function verifySelectedXurlAccountEffect(accountId: string) {
	return Effect.gen(function* () {
		if (liveWritesDisabled()) return;
		if (e2eFakeLiveWritesEnabled()) return;
		const db = yield* trySync(() => getNativeDb());
		const account = yield* trySync(
			() =>
				db
					.prepare("select handle, external_user_id from accounts where id = ?")
					.get(accountId) as
					| { handle: string; external_user_id: string | null }
					| undefined,
		);
		if (!account) {
			return yield* Effect.fail(new Error(`Unknown account: ${accountId}`));
		}
		const authenticated = yield* tryPromise(() =>
			lookupAuthenticatedUserFresh(),
		);
		const authenticatedId =
			typeof authenticated?.id === "string" ? authenticated.id : "";
		const authenticatedHandle =
			typeof authenticated?.username === "string"
				? authenticated.username.replace(/^@/, "")
				: "";
		const expectedHandle = account.handle.replace(/^@/, "");
		if (
			(account.external_user_id &&
				account.external_user_id !== authenticatedId) ||
			(!account.external_user_id &&
				(!authenticatedHandle ||
					authenticatedHandle.toLowerCase() !== expectedHandle.toLowerCase()))
		) {
			return yield* Effect.fail(
				new Error(
					`xurl is authenticated as @${authenticatedHandle || authenticatedId}, not @${expectedHandle}`,
				),
			);
		}
	});
}

function getInfluenceScore(followersCount: number) {
	return Math.round(Math.log10(followersCount + 10) * 24);
}

function getMinFollowersForInfluenceScore(score: number) {
	if (!Number.isFinite(score)) return undefined;
	return Math.max(0, Math.ceil(10 ** ((score - 0.5) / 24) - 10));
}

function getMaxFollowersForInfluenceScore(score: number) {
	if (!Number.isFinite(score)) return undefined;
	if (score < getInfluenceScore(0)) return -1;
	return Math.max(0, Math.ceil(10 ** ((score + 0.5) / 24) - 10) - 1);
}

function getInfluenceLabel(score: number) {
	if (score >= 150) return "very high";
	if (score >= 120) return "high";
	if (score >= 90) return "medium";
	return "emerging";
}

function toProfile(row: Record<string, unknown>): ProfileRecord {
	const followingCount = Number(row.following_count ?? 0);
	const entities = parseJsonField<Record<string, unknown> | undefined>(
		row.entities_json,
		undefined,
	);
	return {
		id: String(row.id),
		handle: String(row.handle),
		displayName: String(row.display_name),
		bio: String(row.bio),
		followersCount: Number(row.followers_count),
		...(Number.isFinite(followingCount) ? { followingCount } : {}),
		avatarHue: Number(row.avatar_hue),
		avatarUrl:
			typeof row.avatar_url === "string" ? String(row.avatar_url) : undefined,
		...(typeof row.location === "string" && row.location.length > 0
			? { location: row.location }
			: {}),
		...(typeof row.url === "string" && row.url.length > 0
			? { url: row.url }
			: {}),
		...(typeof row.verified_type === "string" && row.verified_type.length > 0
			? { verifiedType: row.verified_type }
			: {}),
		...(entities ? { entities } : {}),
		createdAt: String(row.created_at),
	};
}

function parseJsonField<T>(value: unknown, fallback: T): T {
	if (typeof value !== "string" || value.length === 0) {
		return fallback;
	}

	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function normalizeProfileHandle(handle: string) {
	return handle.replace(/^@/, "").toLowerCase();
}

function avatarHueForHandle(handle: string) {
	let hash = 0;
	for (const character of handle) {
		hash = (hash * 31 + character.charCodeAt(0)) % 360;
	}
	return hash;
}

function fallbackProfileForHandle(handle: string): ProfileRecord {
	const normalized = normalizeProfileHandle(handle);
	return {
		id: `profile_handle_${normalized}`,
		handle: normalized,
		displayName: `@${normalized}`,
		bio: "",
		followersCount: 0,
		avatarHue: avatarHueForHandle(normalized),
		createdAt: new Date(0).toISOString(),
	};
}

type ProfileByHandleCache = Map<string, ProfileRecord | null>;

function getProfileByHandle(
	db: Database,
	cache: ProfileByHandleCache,
	handle: string,
	profiles: Record<string, ProfileRecord> = {},
) {
	const normalized = normalizeProfileHandle(handle);
	const inlineProfile = Object.values(profiles).find(
		(profile) => normalizeProfileHandle(profile.handle) === normalized,
	);
	if (inlineProfile) {
		return inlineProfile;
	}

	if (cache.has(normalized)) {
		return cache.get(normalized) ?? fallbackProfileForHandle(normalized);
	}

	const row = db
		.prepare(
			`
      select *
      from profiles
      where lower(handle) = lower(?)
      limit 1
      `,
		)
		.get(normalized) as Record<string, unknown> | undefined;
	const profile = row ? toProfile(row) : null;
	cache.set(normalized, profile);
	return profile ?? fallbackProfileForHandle(normalized);
}

function spansOverlap(
	leftStart: number,
	leftEnd: number,
	rightStart: number,
	rightEnd: number,
) {
	return leftStart < rightEnd && rightStart < leftEnd;
}

function enrichFallbackMentionEntities(
	text: string,
	entities: TweetEntities,
	resolveProfileByHandle: (handle: string) => ProfileRecord,
): TweetEntities {
	const existingMentions = entities.mentions ?? [];
	const occupied = [
		...existingMentions,
		...(entities.urls ?? []),
		...(entities.hashtags ?? []),
	].map((entry) => ({ start: entry.start, end: entry.end }));
	const fallbackMentions = [];
	const mentionPattern = /(^|[^\w@])@([A-Za-z0-9_]{1,15})/g;

	for (const match of text.matchAll(mentionPattern)) {
		const prefix = match[1] ?? "";
		const username = match[2];
		if (!username) continue;
		const start = (match.index ?? 0) + prefix.length;
		const end = start + username.length + 1;
		if (
			occupied.some((entry) => spansOverlap(start, end, entry.start, entry.end))
		) {
			continue;
		}

		const profile = resolveProfileByHandle(username);
		fallbackMentions.push({
			username,
			id: profile.id,
			start,
			end,
			profile,
		});
		occupied.push({ start, end });
	}

	if (fallbackMentions.length === 0) {
		return entities;
	}

	return {
		...entities,
		mentions: [...existingMentions, ...fallbackMentions].sort(
			(left, right) => left.start - right.start,
		),
	};
}

function toFtsSearchQuery(value: string) {
	const terms = value.match(/[\p{L}\p{N}_]+/gu) ?? [];
	return terms
		.map((term) => term.trim())
		.filter((term) => term.length > 0)
		.map((term) => `"${term.replaceAll('"', '""')}"`)
		.join(" ");
}

function enrichEntities(
	entities: TweetEntities,
	profiles: Record<string, ProfileRecord>,
	resolveProfileByHandle?: (handle: string) => ProfileRecord,
): TweetEntities {
	const mentions = entities.mentions?.map((mention) => {
		const profile =
			(mention.id ? profiles[mention.id] : undefined) ??
			Object.values(profiles).find(
				(candidate) =>
					normalizeProfileHandle(candidate.handle) ===
					normalizeProfileHandle(mention.username),
			) ??
			resolveProfileByHandle?.(mention.username);
		return profile ? { ...mention, profile } : mention;
	});

	return {
		...entities,
		...(mentions ? { mentions } : {}),
	};
}

type UrlExpansionCache = Map<
	string,
	| (Pick<TweetUrlEntity, "expandedUrl" | "displayUrl"> &
			Partial<
				Pick<TweetUrlEntity, "title" | "description" | "imageUrl" | "siteName">
			>)
	| null
>;

function getUrlExpansion(
	db: Database,
	cache: UrlExpansionCache,
	rawUrl: string,
) {
	if (cache.has(rawUrl)) {
		return cache.get(rawUrl);
	}

	const row = db
		.prepare(
			`
      select expanded_url, final_url, title, description, image_url, site_name
      from url_expansions
      where short_url = ?
        and status = 'hit'
      `,
		)
		.get(rawUrl) as
		| {
				expanded_url: string;
				final_url: string;
				title: string | null;
				description: string | null;
				image_url: string | null;
				site_name: string | null;
		  }
		| undefined;
	if (!row) {
		cache.set(rawUrl, null);
		return null;
	}

	const expandedUrl = row.final_url || row.expanded_url || rawUrl;
	const expansion = {
		expandedUrl,
		displayUrl: displayUrlForLink(expandedUrl),
		...(row.title ? { title: row.title } : {}),
		...(row.description ? { description: row.description } : {}),
		...(row.image_url ? { imageUrl: row.image_url } : {}),
		...(row.site_name ? { siteName: row.site_name } : {}),
	};
	cache.set(rawUrl, expansion);
	return expansion;
}

function enrichTimelineEntities(
	db: Database,
	urlExpansionCache: UrlExpansionCache,
	text: string,
	entities: TweetEntities,
	profiles: Record<string, ProfileRecord>,
	resolveProfileByHandle?: (handle: string) => ProfileRecord,
): TweetEntities {
	const withUrls = enrichFallbackUrlEntities(
		text,
		enrichEntities(entities, profiles, resolveProfileByHandle),
		(rawUrl) => getUrlExpansion(db, urlExpansionCache, rawUrl),
	);
	return resolveProfileByHandle
		? enrichFallbackMentionEntities(text, withUrls, resolveProfileByHandle)
		: withUrls;
}

function buildEmbeddedTweet(
	db: Database,
	urlExpansionCache: UrlExpansionCache,
	row: Record<string, unknown>,
	prefix: string,
	resolveProfileByHandle?: (handle: string) => ProfileRecord,
): EmbeddedTweet | null {
	if (!row[`${prefix}id`]) {
		return null;
	}

	const author = toProfile({
		id: row[`${prefix}profile_id`],
		handle: row[`${prefix}handle`],
		display_name: row[`${prefix}display_name`],
		bio: row[`${prefix}bio`],
		followers_count: row[`${prefix}followers_count`],
		following_count: row[`${prefix}following_count`],
		avatar_hue: row[`${prefix}avatar_hue`],
		avatar_url: row[`${prefix}avatar_url`],
		created_at: row[`${prefix}profile_created_at`],
	});

	const text = String(row[`${prefix}text`] ?? "");
	return {
		id: String(row[`${prefix}id`]),
		text,
		createdAt: String(row[`${prefix}created_at`] ?? new Date(0).toISOString()),
		replyToId:
			typeof row[`${prefix}reply_to_id`] === "string"
				? String(row[`${prefix}reply_to_id`])
				: null,
		...(row[`${prefix}is_replied`] === undefined
			? {}
			: { isReplied: Boolean(row[`${prefix}is_replied`]) }),
		...(row[`${prefix}like_count`] === undefined
			? {}
			: { likeCount: Number(row[`${prefix}like_count`]) }),
		...(row[`${prefix}media_count`] === undefined
			? {}
			: { mediaCount: Number(row[`${prefix}media_count`]) }),
		...(row[`${prefix}bookmarked`] === undefined
			? {}
			: { bookmarked: Boolean(row[`${prefix}bookmarked`]) }),
		...(row[`${prefix}liked`] === undefined
			? {}
			: { liked: Boolean(row[`${prefix}liked`]) }),
		author,
		entities: enrichTimelineEntities(
			db,
			urlExpansionCache,
			text,
			parseJsonField<TweetEntities>(row[`${prefix}entities_json`], {}),
			{
				[author.id]: author,
			},
			resolveProfileByHandle,
		),
		media: parseJsonField<TweetMediaItem[]>(row[`${prefix}media_json`], []),
	};
}

function getRetweetedTweetIdFromRaw(rawJson: unknown) {
	const raw = parseJsonField<Record<string, unknown>>(rawJson, {});
	const directCandidates = [
		raw.retweeted_tweet_id,
		raw.retweetedTweetId,
		raw.retweetedStatusId,
		raw.retweeted_status_id_str,
	];
	for (const candidate of directCandidates) {
		if (typeof candidate === "string" && candidate.length > 0) {
			return candidate;
		}
	}

	const nestedCandidates = [raw.retweetedTweet, raw.retweeted_status];
	for (const nested of nestedCandidates) {
		if (nested && typeof nested === "object") {
			const record = nested as Record<string, unknown>;
			for (const key of ["id", "id_str"]) {
				if (typeof record[key] === "string" && record[key].length > 0) {
					return record[key];
				}
			}
		}
	}

	const references = [raw.referenced_tweets, raw.referencedTweets].find(
		(value): value is unknown[] => Array.isArray(value),
	);
	for (const reference of references ?? []) {
		if (!reference || typeof reference !== "object") continue;
		const record = reference as Record<string, unknown>;
		if (record.type === "retweeted" && typeof record.id === "string") {
			return record.id;
		}
	}

	return null;
}

function parseManualRetweet(text: string) {
	const match = text.match(/^RT\s+@([A-Za-z0-9_]{1,15}):\s*([\s\S]+)$/);
	if (!match?.[1] || !match[2]) {
		return null;
	}
	return {
		handle: match[1],
		text: match[2].trim(),
	};
}

function buildRetweetedTweet(
	db: Database,
	urlExpansionCache: UrlExpansionCache,
	row: Record<string, unknown>,
	resolveProfileByHandle: (handle: string) => ProfileRecord,
) {
	const retweetedId = getRetweetedTweetIdFromRaw(row.edge_raw_json);
	const accountId = String(row.account_id);
	if (retweetedId) {
		const tweet = getTweetById(
			db,
			urlExpansionCache,
			retweetedId,
			resolveProfileByHandle,
			accountId,
		);
		if (tweet) {
			return tweet;
		}
	}

	const manualRetweet = parseManualRetweet(String(row.text ?? ""));
	if (!manualRetweet) {
		return null;
	}

	const author = resolveProfileByHandle(manualRetweet.handle);
	return {
		id: `${String(row.id)}:retweeted`,
		text: manualRetweet.text,
		createdAt: String(row.created_at ?? new Date(0).toISOString()),
		replyToId: null,
		isReplied: Boolean(row.is_replied),
		likeCount: Number(row.like_count ?? 0),
		mediaCount: 0,
		bookmarked: Boolean(row.bookmarked),
		liked: Boolean(row.liked),
		author,
		entities: enrichTimelineEntities(
			db,
			urlExpansionCache,
			manualRetweet.text,
			{},
			{ [author.id]: author },
			resolveProfileByHandle,
		),
		media: [],
	};
}

function buildReplyClause(replyFilter: ReplyFilter) {
	if (replyFilter === "replied") {
		return " and is_replied = 1";
	}
	if (replyFilter === "unreplied") {
		return " and is_replied = 0";
	}
	return "";
}

function normalizeLowQualityThreshold(threshold: number | undefined) {
	const value = threshold ?? 50;
	if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
		throw new Error("lowQualityThreshold must be a non-negative integer");
	}
	return value;
}

function buildTimelineQualityClause(
	qualityFilter: TimelineQualityFilter,
	lowQualityThreshold: number,
) {
	if (qualityFilter === "all") {
		return { sql: "", params: [] };
	}

	return {
		sql: `
    and not (
      t.text like 'RT @%'
      or (
        t.like_count < ?
        and (
          (
            length(trim(replace(t.text, 'https://t.co/', ''))) < 16
            and t.media_count = 0
          )
          or (
            t.text like '@%'
            and length(trim(t.text)) < 60
          )
          or (
            t.text glob '*https://t.co/*'
            and t.media_count = 0
            and length(trim(replace(t.text, 'https://t.co/', ''))) < 45
          )
        )
      )
    )
  `,
		params: [lowQualityThreshold],
	};
}

function getTimelineQualityReason(
	row: Record<string, unknown>,
	lowQualityThreshold: number,
) {
	const text = String(row.text);
	const trimmed = text.trim();
	const strippedShortUrlText = text.replaceAll("https://t.co/", "").trim();
	const likeCount = Number(row.like_count);
	const mediaCount = Number(row.media_count);

	if (text.startsWith("RT @")) {
		return "drop:rt";
	}

	if (likeCount < lowQualityThreshold) {
		if (text.startsWith("@") && trimmed.length < 60) {
			return "drop:short-reply";
		}
		if (
			text.includes("https://t.co/") &&
			mediaCount === 0 &&
			strippedShortUrlText.length < 45
		) {
			return "drop:short-link-only";
		}
		if (strippedShortUrlText.length < 16 && mediaCount === 0) {
			return "drop:short-text";
		}
	}

	if (mediaCount > 0) {
		return "keep:has-media";
	}
	if (likeCount >= lowQualityThreshold) {
		return "keep:high-likes";
	}
	return "keep:long-text";
}

function countTimelineEdges(db: Database, kind: "home" | "mention") {
	const row = db
		.prepare(
			`
      select count(distinct tweet_id) as count
      from (
        select edge.tweet_id
        from tweet_account_edges edge
        where edge.kind = ?
          and exists (
            select 1
            from tweets t
            where t.id = edge.tweet_id
          )
        union all
        select legacy.id as tweet_id
        from tweets legacy
        where legacy.kind = ?
          and not exists (
            select 1
            from tweet_account_edges edge
            where edge.account_id = legacy.account_id
              and edge.tweet_id = legacy.id
              and edge.kind = legacy.kind
          )
      )
      `,
		)
		.get(kind, kind) as { count: number | bigint } | undefined;
	return Number(row?.count ?? 0);
}

const RECENT_TIMELINE_EDGE_CANDIDATES = 5000;

function getAccountProfileMeta(
	db: Database,
	account: { handle: string; external_user_id: string | null },
) {
	const handle = account.handle.replace(/^@/, "");
	const externalProfileId = account.external_user_id
		? `profile_user_${account.external_user_id}`
		: "";
	return db
		.prepare(
			`
      select id, avatar_hue, avatar_url
      from profiles
      where id = ?
         or lower(handle) = lower(?)
      order by case
        when id = 'profile_me' then 0
        when id = ? then 1
        else 2
      end
      limit 1
    `,
		)
		.get(externalProfileId, handle, externalProfileId) as
		| { id: string; avatar_hue: number; avatar_url: string | null }
		| undefined;
}

export function getQueryEnvelopeEffect(): Effect.Effect<
	QueryEnvelope,
	unknown
> {
	return Effect.gen(function* () {
		const db = yield* trySync(() => getDb());
		const nativeDb = yield* trySync(() => getNativeDb());
		const homeCount = yield* trySync(() =>
			countTimelineEdges(nativeDb, "home"),
		);
		const mentionCount = yield* trySync(() =>
			countTimelineEdges(nativeDb, "mention"),
		);
		const counts = yield* Effect.all({
			dms: tryPromise(() =>
				db
					.selectFrom("dm_conversations")
					.select((eb) => eb.fn.countAll().as("count"))
					.executeTakeFirstOrThrow(),
			),
			needsReply: tryPromise(() =>
				db
					.selectFrom("dm_conversations")
					.select((eb) => eb.fn.countAll().as("count"))
					.where("needs_reply", "=", 1)
					.executeTakeFirstOrThrow(),
			),
			accounts: tryPromise(() =>
				db
					.selectFrom("accounts")
					.selectAll()
					.orderBy("is_default", "desc")
					.orderBy("name", "asc")
					.execute(),
			),
			archives: findArchivesEffect(),
			transport: getTransportStatusEffect(),
		});

		return {
			stats: {
				home: homeCount,
				mentions: mentionCount,
				dms: Number(counts.dms.count),
				needsReply: Number(counts.needsReply.count),
				inbox: mentionCount + Number(counts.needsReply.count),
			},
			accounts: counts.accounts.map((row) => {
				const profile = getAccountProfileMeta(nativeDb, row);
				return {
					id: row.id,
					name: row.name,
					handle: row.handle,
					externalUserId: row.external_user_id,
					...(profile
						? {
								profileId: profile.id,
								avatarHue: Number(profile.avatar_hue),
								...(profile.avatar_url
									? { avatarUrl: profile.avatar_url }
									: {}),
							}
						: {}),
					transport: row.transport,
					isDefault: row.is_default,
					createdAt: row.created_at,
				};
			}) satisfies AccountRecord[],
			archives: counts.archives,
			transport: counts.transport,
		};
	});
}

export function getQueryEnvelope(): Promise<QueryEnvelope> {
	return runEffectPromise(getQueryEnvelopeEffect());
}

export function listTimelineItems({
	resource,
	account,
	search,
	replyFilter = "all",
	since,
	until,
	untilId,
	includeReplies = true,
	qualityFilter = "all",
	lowQualityThreshold,
	includeQualityReason = false,
	likedOnly = false,
	bookmarkedOnly = false,
	limit = 18,
}: TimelineQuery): TimelineItem[] {
	const db = getNativeDb();
	const kind = resource === "mentions" ? "mention" : resource;
	const params: Array<string | number> = [];
	const normalizedLowQualityThreshold =
		normalizeLowQualityThreshold(lowQualityThreshold);
	const shouldDedupeAcrossAccounts = !account || account === "all";
	let timelineEdgesCte = `
      with timeline_edges as (
        select account_id, tweet_id, kind, raw_json
        from tweet_account_edges
        where kind = ?
        union all
        select legacy.account_id, legacy.id as tweet_id, legacy.kind, '{}' as raw_json
        from tweets legacy
        where legacy.kind = ?
          and not exists (
            select 1
            from tweet_account_edges edge
            where edge.account_id = legacy.account_id
              and edge.tweet_id = legacy.id
              and edge.kind = legacy.kind
          )
      )
    `;
	const unwindowedTimelineEdgesCte = timelineEdgesCte;
	let usedRecentEdgeWindow = false;
	let join = "";
	let where = "where t.kind = ?";
	let searchSnippetSelect = "";

	const canUseRecentEdgeWindow =
		!likedOnly &&
		!bookmarkedOnly &&
		!account &&
		!search?.trim() &&
		replyFilter === "all" &&
		!since?.trim() &&
		!until?.trim() &&
		includeReplies &&
		qualityFilter === "all";

	if (likedOnly || bookmarkedOnly) {
		if (likedOnly && bookmarkedOnly) {
			timelineEdgesCte = `
        with timeline_edges as (
          select likes.account_id, likes.tweet_id, 'home' as kind, likes.raw_json
          from tweet_collections likes
          join tweet_collections bookmarks
            on bookmarks.account_id = likes.account_id
            and bookmarks.tweet_id = likes.tweet_id
            and bookmarks.kind = 'bookmarks'
          where likes.kind = 'likes'
          union all
          select legacy.account_id, legacy.id as tweet_id, 'home' as kind, '{}' as raw_json
          from tweets legacy
          where legacy.liked = 1
            and legacy.bookmarked = 1
            and not exists (
              select 1
              from tweet_collections collection
              where collection.account_id = legacy.account_id
                and collection.tweet_id = legacy.id
                and collection.kind in ('likes', 'bookmarks')
            )
        )
      `;
		} else {
			const collectionKind = likedOnly ? "likes" : "bookmarks";
			const legacyColumn = likedOnly ? "liked" : "bookmarked";
			timelineEdgesCte = `
        with timeline_edges as (
          select account_id, tweet_id, 'home' as kind, raw_json
          from tweet_collections
          where kind = ?
          union all
          select legacy.account_id, legacy.id as tweet_id, 'home' as kind, '{}' as raw_json
          from tweets legacy
          where legacy.${legacyColumn} = 1
            and not exists (
              select 1
              from tweet_collections collection
              where collection.account_id = legacy.account_id
                and collection.tweet_id = legacy.id
                and collection.kind = ?
            )
        )
			`;
			params.push(collectionKind, collectionKind);
		}
		where = "where 1 = 1";
	} else if (canUseRecentEdgeWindow) {
		usedRecentEdgeWindow = true;
		timelineEdgesCte = `
      with timeline_edges as (
        select account_id, tweet_id, kind, raw_json
        from tweet_account_edges
        where kind = ?
          and tweet_id in (
            select id
            from tweets
            order by created_at desc
            limit ?
          )
        union all
        select legacy.account_id, legacy.id as tweet_id, legacy.kind, '{}' as raw_json
        from tweets legacy
        where legacy.kind = ?
          and legacy.id in (
            select id
            from tweets
            order by created_at desc
            limit ?
          )
          and not exists (
            select 1
            from tweet_account_edges edge
            where edge.account_id = legacy.account_id
              and edge.tweet_id = legacy.id
              and edge.kind = legacy.kind
          )
      )
    `;
		const candidateLimit = Math.max(
			RECENT_TIMELINE_EDGE_CANDIDATES,
			limit * 50,
		);
		params.push(kind, candidateLimit, kind, candidateLimit);
		where = "where e.kind = ?";
		params.push(kind);
	} else {
		params.push(kind, kind);
		where = "where e.kind = ?";
		params.push(kind);
	}

	if (account && account !== "all") {
		where += " and e.account_id = ?";
		params.push(account);
	}

	if (shouldDedupeAcrossAccounts) {
		where += `
      and e.account_id = (
        select e2.account_id
        from timeline_edges e2
        join accounts a2 on a2.id = e2.account_id
        where e2.tweet_id = e.tweet_id
          and e2.kind = e.kind
        order by a2.is_default desc, e2.account_id asc
        limit 1
      )
    `;
	}

	where += buildReplyClause(replyFilter).replaceAll(
		"is_replied",
		"t.is_replied",
	);
	const qualityClause = buildTimelineQualityClause(
		qualityFilter,
		normalizedLowQualityThreshold,
	);
	where += qualityClause.sql;
	params.push(...qualityClause.params);

	if (!includeReplies) {
		where += " and t.text not like '@%'";
	}

	if (since?.trim()) {
		where += " and t.created_at >= ?";
		params.push(since.trim());
	}

	if (until?.trim()) {
		// Deterministic keyset cursor: page on (created_at, id) so rows that share
		// the boundary timestamp are not skipped. Uses the same text comparison as
		// the `order by t.created_at desc, t.id desc` below, which is a total order
		// because t.id is unique.
		if (untilId?.trim()) {
			where += " and (t.created_at < ? or (t.created_at = ? and t.id < ?))";
			params.push(until.trim(), until.trim(), untilId.trim());
		} else {
			where += " and t.created_at < ?";
			params.push(until.trim());
		}
	}

	const ftsSearch = search?.trim() ? toFtsSearchQuery(search) : "";
	if (ftsSearch) {
		join += " join tweets_fts on tweets_fts.tweet_id = t.id ";
		where += " and tweets_fts.text match ?";
		searchSnippetSelect =
			", snippet(tweets_fts, 1, '<mark>', '</mark>', '...', 16) as search_snippet";
		params.push(ftsSearch);
	}

	params.push(limit);

	const buildTimelineSelectSql = (timelineEdgesSql: string) => `
      ${timelineEdgesSql}
      select
        t.id,
        e.account_id,
        a.handle as account_handle,
        e.kind,
        e.raw_json as edge_raw_json,
        t.text,
        t.created_at,
        t.reply_to_id,
        t.is_replied,
        t.like_count,
        t.media_count,
        case
          when exists (
            select 1 from tweet_collections collection
            where collection.account_id = e.account_id
              and collection.tweet_id = t.id
              and collection.kind = 'bookmarks'
          ) then 1
          when t.account_id = e.account_id and t.bookmarked = 1 then 1
          else 0
        end as bookmarked,
        case
          when exists (
            select 1 from tweet_collections collection
            where collection.account_id = e.account_id
              and collection.tweet_id = t.id
              and collection.kind = 'likes'
          ) then 1
          when t.account_id = e.account_id and t.liked = 1 then 1
          else 0
        end as liked,
        t.entities_json,
        t.media_json,
        t.quoted_tweet_id,
        p.id as profile_id,
        p.handle,
        p.display_name,
        p.bio,
        p.followers_count,
        p.following_count,
        p.avatar_hue,
        p.avatar_url,
        p.location as profile_location,
        p.url as profile_url,
        p.verified_type as profile_verified_type,
        p.entities_json as profile_entities_json,
        p.created_at as profile_created_at,
        rt.id as reply_id,
        rt.text as reply_text,
        rt.created_at as reply_created_at,
        rt.reply_to_id as reply_reply_to_id,
        rt.entities_json as reply_entities_json,
        rt.media_json as reply_media_json,
        rp.id as reply_profile_id,
        rp.handle as reply_handle,
        rp.display_name as reply_display_name,
        rp.bio as reply_bio,
        rp.followers_count as reply_followers_count,
        rp.following_count as reply_following_count,
        rp.avatar_hue as reply_avatar_hue,
        rp.avatar_url as reply_avatar_url,
        rp.created_at as reply_profile_created_at,
        qt.id as quoted_id,
        qt.text as quoted_text,
        qt.created_at as quoted_created_at,
        qt.reply_to_id as quoted_reply_to_id,
        qt.entities_json as quoted_entities_json,
        qt.media_json as quoted_media_json,
        qp.id as quoted_profile_id,
        qp.handle as quoted_handle,
        qp.display_name as quoted_display_name,
        qp.bio as quoted_bio,
        qp.followers_count as quoted_followers_count,
        qp.following_count as quoted_following_count,
        qp.avatar_hue as quoted_avatar_hue,
        qp.avatar_url as quoted_avatar_url,
        qp.created_at as quoted_profile_created_at
        ${searchSnippetSelect}
      from timeline_edges e
      join tweets t on t.id = e.tweet_id
      join accounts a on a.id = e.account_id
      join profiles p on p.id = t.author_profile_id
      left join tweets rt on rt.id = t.reply_to_id
      left join profiles rp on rp.id = rt.author_profile_id
      left join tweets qt on qt.id = t.quoted_tweet_id
      left join profiles qp on qp.id = qt.author_profile_id
      ${join}
      ${where}
      order by t.created_at desc, t.id desc
      limit ?
      `;

	let rows = db
		.prepare(buildTimelineSelectSql(timelineEdgesCte))
		.all(...params) as Array<Record<string, unknown>>;

	if (usedRecentEdgeWindow && rows.length < limit) {
		rows = db
			.prepare(buildTimelineSelectSql(unwindowedTimelineEdgesCte))
			.all(kind, kind, kind, limit) as Array<Record<string, unknown>>;
	}

	const urlExpansionCache: UrlExpansionCache = new Map();
	const profileByHandleCache: ProfileByHandleCache = new Map();
	return rows.map((row) => {
		const author = {
			id: String(row.profile_id),
			handle: String(row.handle),
			displayName: String(row.display_name),
			bio: String(row.bio),
			followersCount: Number(row.followers_count),
			followingCount: Number(row.following_count ?? 0),
			avatarHue: Number(row.avatar_hue),
			avatarUrl:
				typeof row.avatar_url === "string" ? String(row.avatar_url) : undefined,
			createdAt: String(row.profile_created_at),
		};
		const rowProfiles: Record<string, ProfileRecord> = {
			[author.id]: author,
			...(row.reply_profile_id
				? {
						[String(row.reply_profile_id)]: toProfile({
							id: row.reply_profile_id,
							handle: row.reply_handle,
							display_name: row.reply_display_name,
							bio: row.reply_bio,
							followers_count: row.reply_followers_count,
							following_count: row.reply_following_count,
							avatar_hue: row.reply_avatar_hue,
							avatar_url: row.reply_avatar_url,
							created_at: row.reply_profile_created_at,
						}),
					}
				: {}),
			...(row.quoted_profile_id
				? {
						[String(row.quoted_profile_id)]: toProfile({
							id: row.quoted_profile_id,
							handle: row.quoted_handle,
							display_name: row.quoted_display_name,
							bio: row.quoted_bio,
							followers_count: row.quoted_followers_count,
							following_count: row.quoted_following_count,
							avatar_hue: row.quoted_avatar_hue,
							avatar_url: row.quoted_avatar_url,
							created_at: row.quoted_profile_created_at,
						}),
					}
				: {}),
		};
		const resolveProfileByHandle = (handle: string) =>
			getProfileByHandle(db, profileByHandleCache, handle, rowProfiles);
		const text = String(row.text);
		const entities = enrichTimelineEntities(
			db,
			urlExpansionCache,
			text,
			parseJsonField<TweetEntities>(row.entities_json, {}),
			rowProfiles,
			resolveProfileByHandle,
		);
		const item = {
			id: String(row.id),
			accountId: String(row.account_id),
			accountHandle: String(row.account_handle),
			kind: row.kind as TimelineItem["kind"],
			text,
			...(typeof row.search_snippet === "string"
				? { searchSnippet: row.search_snippet }
				: {}),
			createdAt: String(row.created_at),
			replyToId:
				typeof row.reply_to_id === "string" ? String(row.reply_to_id) : null,
			isReplied: Boolean(row.is_replied),
			likeCount: Number(row.like_count),
			mediaCount: Number(row.media_count),
			bookmarked: Boolean(row.bookmarked),
			liked: Boolean(row.liked),
			author,
			entities,
			media: parseJsonField<TweetMediaItem[]>(row.media_json, []),
			replyToTweet: buildEmbeddedTweet(
				db,
				urlExpansionCache,
				row,
				"reply_",
				resolveProfileByHandle,
			),
			quotedTweet: buildEmbeddedTweet(
				db,
				urlExpansionCache,
				row,
				"quoted_",
				resolveProfileByHandle,
			),
			retweetedTweet: buildRetweetedTweet(
				db,
				urlExpansionCache,
				row,
				resolveProfileByHandle,
			),
		};
		return includeQualityReason
			? {
					...item,
					qualityReason: getTimelineQualityReason(
						row,
						normalizedLowQualityThreshold,
					),
				}
			: item;
	});
}

function conversationTweetSelect(accountId?: string) {
	const collectionStateSelect = accountId
		? `
    case
      when exists (
        select 1 from tweet_collections collection
        where collection.account_id = ?
          and collection.tweet_id = t.id
          and collection.kind = 'bookmarks'
      ) then 1
      when t.account_id = ? and t.bookmarked = 1 then 1
      else 0
    end as bookmarked,
    case
      when exists (
        select 1 from tweet_collections collection
        where collection.account_id = ?
          and collection.tweet_id = t.id
          and collection.kind = 'likes'
      ) then 1
      when t.account_id = ? and t.liked = 1 then 1
      else 0
    end as liked,`
		: `
    t.bookmarked,
    t.liked,`;
	return `
  select
    t.id,
    t.text,
    t.created_at,
    t.reply_to_id,
    t.is_replied,
    t.like_count,
    t.media_count,
    ${collectionStateSelect}
    t.entities_json,
    t.media_json,
    p.id as profile_id,
    p.handle,
    p.display_name,
    p.bio,
    p.followers_count,
    p.following_count,
    p.avatar_hue,
    p.avatar_url,
    p.created_at as profile_created_at
  from tweets t
  join profiles p on p.id = t.author_profile_id
`;
}

function getTweetById(
	db: Database,
	urlExpansionCache: UrlExpansionCache,
	tweetId: string,
	resolveProfileByHandle?: (handle: string) => ProfileRecord,
	accountId?: string,
): EmbeddedTweet | null {
	const stateParams = accountId
		? [accountId, accountId, accountId, accountId]
		: [];
	const row = db
		.prepare(`${conversationTweetSelect(accountId)} where t.id = ?`)
		.get(...stateParams, tweetId) as Record<string, unknown> | undefined;
	if (!row) return null;
	return buildEmbeddedTweet(
		db,
		urlExpansionCache,
		row,
		"",
		resolveProfileByHandle,
	);
}

function listTweetDescendants(
	db: Database,
	urlExpansionCache: UrlExpansionCache,
	rootId: string,
	limit: number,
	resolveProfileByHandle?: (handle: string) => ProfileRecord,
) {
	if (limit <= 0) return [];
	const rows = db
		.prepare(
			`
      with recursive branch(id, depth) as (
        select t.id, 0
        from tweets t
        where t.id = ?
        union all
        select child.id, branch.depth + 1
        from tweets child
        join branch on child.reply_to_id = branch.id
        where branch.depth < 8
      )
      ${conversationTweetSelect()}
      join branch on branch.id = t.id
      where t.id != ?
      order by t.created_at asc
      limit ?
      `,
		)
		.all(rootId, rootId, limit) as Array<Record<string, unknown>>;

	return rows
		.map((row) =>
			buildEmbeddedTweet(
				db,
				urlExpansionCache,
				row,
				"",
				resolveProfileByHandle,
			),
		)
		.filter((tweet): tweet is EmbeddedTweet => Boolean(tweet));
}

function appendConversationTweets(
	target: EmbeddedTweet[],
	seen: Set<string>,
	items: EmbeddedTweet[],
	remaining: number,
) {
	for (const tweet of items) {
		if (target.length >= remaining || seen.has(tweet.id)) continue;
		seen.add(tweet.id);
		target.push(tweet);
	}
}

export function getTweetConversation(
	tweetId: string,
	limit = 80,
): TweetConversationResponse | null {
	const db = getNativeDb();
	const urlExpansionCache: UrlExpansionCache = new Map();
	const profileByHandleCache: ProfileByHandleCache = new Map();
	const resolveProfileByHandle = (handle: string) =>
		getProfileByHandle(db, profileByHandleCache, handle);
	const anchor = getTweetById(
		db,
		urlExpansionCache,
		tweetId,
		resolveProfileByHandle,
	);
	if (!anchor) return null;

	const ancestors: EmbeddedTweet[] = [];
	let current = anchor;
	for (let depth = 0; depth < 12 && current.replyToId; depth += 1) {
		const parent = getTweetById(
			db,
			urlExpansionCache,
			current.replyToId,
			resolveProfileByHandle,
		);
		if (!parent || ancestors.some((tweet) => tweet.id === parent.id)) break;
		ancestors.push(parent);
		current = parent;
	}

	const required = [...ancestors].reverse();
	required.push(anchor);
	const root = required[0] ?? anchor;
	const seen = new Set<string>();
	const items = required.filter((tweet) => {
		if (seen.has(tweet.id)) return false;
		seen.add(tweet.id);
		return true;
	});
	const remainingAfterRequired = Math.max(0, limit - items.length);
	const focusedDescendants = listTweetDescendants(
		db,
		urlExpansionCache,
		anchor.id,
		remainingAfterRequired,
		resolveProfileByHandle,
	);
	appendConversationTweets(items, seen, focusedDescendants, limit);

	if (items.length < limit && root.id !== anchor.id) {
		const ambientDescendants = listTweetDescendants(
			db,
			urlExpansionCache,
			root.id,
			limit,
			resolveProfileByHandle,
		);
		appendConversationTweets(items, seen, ambientDescendants, limit);
	}

	items.sort((left, right) => left.createdAt.localeCompare(right.createdAt));

	return {
		anchorId: anchor.id,
		items,
	};
}

export function listDmConversations({
	account,
	conversationIds,
	inbox = "all",
	participant,
	search,
	replyFilter = "all",
	since,
	until,
	minFollowers,
	maxFollowers,
	minInfluenceScore,
	maxInfluenceScore,
	sort = "recent",
	context = 0,
	limit = 20,
}: DmQuery): DmConversationItem[] {
	const db = getNativeDb();
	const params: Array<string | number> = [];
	const joinParams: Array<string | number> = [];
	let searchSnippetCte = "";
	let join = "";
	let where = "where 1 = 1";
	let searchSnippetSelect = "";
	const ftsSearch = search?.trim() ? toFtsSearchQuery(search) : "";
	const influenceMinFollowers =
		typeof minInfluenceScore === "number"
			? getMinFollowersForInfluenceScore(minInfluenceScore)
			: undefined;
	const influenceMaxFollowers =
		typeof maxInfluenceScore === "number"
			? getMaxFollowersForInfluenceScore(maxInfluenceScore)
			: undefined;
	const effectiveMinFollowers =
		typeof minFollowers === "number" ||
		typeof influenceMinFollowers === "number"
			? Math.max(minFollowers ?? 0, influenceMinFollowers ?? 0)
			: undefined;
	const effectiveMaxFollowers =
		typeof maxFollowers === "number" ||
		typeof influenceMaxFollowers === "number"
			? Math.min(
					maxFollowers ?? Number.MAX_SAFE_INTEGER,
					influenceMaxFollowers ?? Number.MAX_SAFE_INTEGER,
				)
			: undefined;
	const orderBy =
		sort === "followers" || sort === "influence"
			? "p.followers_count desc, c.last_message_at desc"
			: "c.last_message_at desc";

	if (account && account !== "all") {
		where += " and a.id = ?";
		params.push(account);
	}

	if (conversationIds && conversationIds.length > 0) {
		where += ` and c.id in (${conversationIds.map(() => "?").join(",")})`;
		params.push(...conversationIds);
	}

	if (inbox === "accepted") {
		where += " and c.inbox_kind = 'accepted'";
	} else if (inbox === "requests") {
		where += " and c.inbox_kind = 'request'";
	}

	if (participant?.trim()) {
		where += " and (p.handle like ? or p.display_name like ?)";
		params.push(`%${participant.trim()}%`, `%${participant.trim()}%`);
	}

	if (replyFilter === "replied") {
		where += " and c.needs_reply = 0";
	} else if (replyFilter === "unreplied") {
		where += " and c.needs_reply = 1";
	}

	if (since?.trim()) {
		where += " and c.last_message_at >= ?";
		params.push(since);
	}
	if (until?.trim()) {
		where += " and c.last_message_at < ?";
		params.push(until);
	}

	if (typeof effectiveMinFollowers === "number") {
		where += " and p.followers_count >= ?";
		params.push(effectiveMinFollowers);
	}

	if (typeof effectiveMaxFollowers === "number") {
		where += " and p.followers_count <= ?";
		params.push(effectiveMaxFollowers);
	}

	if (ftsSearch) {
		searchSnippetCte = `
	      with ranked_dm_search as materialized (
        select
          latest_search.id,
          latest_search.conversation_id,
          row_number() over (
            partition by latest_search.conversation_id
            order by latest_search.created_at desc, latest_search.id desc
          ) as match_rank
        from dm_messages latest_search
        join dm_fts on dm_fts.message_id = latest_search.id
        where dm_fts.text match ?
      ),
      dm_search as materialized (
        select
          ranked_dm_search.conversation_id,
          snippet(dm_fts, 1, '<mark>', '</mark>', '...', 16) as search_snippet
        from ranked_dm_search
        join dm_fts on dm_fts.message_id = ranked_dm_search.id
        where ranked_dm_search.match_rank = 1
          and dm_fts.text match ?
      )
	`;
		join += " join dm_search on dm_search.conversation_id = c.id ";
		searchSnippetSelect = ", dm_search.search_snippet as search_snippet";
		joinParams.push(ftsSearch, ftsSearch);
	}

	params.push(limit);

	const rows = db
		.prepare(
			`
      ${searchSnippetCte}
      select
        c.id,
        c.account_id,
        a.handle as account_handle,
        c.title,
        c.inbox_kind,
        c.last_message_at,
        c.unread_count,
        c.needs_reply,
        p.id as profile_id,
        p.handle,
        p.display_name,
        p.bio,
        p.followers_count,
        p.following_count,
        p.avatar_hue,
        p.avatar_url,
        p.location as profile_location,
        p.url as profile_url,
        p.verified_type as profile_verified_type,
        p.entities_json as profile_entities_json,
        p.created_at as profile_created_at,
        (
          select text
          from dm_messages latest_message
          where latest_message.conversation_id = c.id
          order by latest_message.created_at desc
          limit 1
        ) as last_message_preview
        ${searchSnippetSelect}
      from dm_conversations c
      join accounts a on a.id = c.account_id
      join profiles p on p.id = c.participant_profile_id
      ${join}
      ${where}
      group by c.id
      order by ${orderBy}
      limit ?
      `,
		)
		.all(...joinParams, ...params) as Array<Record<string, unknown>>;

	const affiliationsByProfile = fetchProfileAffiliations(
		db,
		rows.map((row) => String(row.profile_id)),
	);
	const items: DmConversationItem[] = rows.map((row) => {
		const followersCount = Number(row.followers_count);
		const influenceScore = getInfluenceScore(followersCount);
		const participant = toProfile({
			id: row.profile_id,
			handle: row.handle,
			display_name: row.display_name,
			bio: row.bio,
			followers_count: row.followers_count,
			following_count: row.following_count,
			avatar_hue: row.avatar_hue,
			avatar_url: row.avatar_url,
			location: row.profile_location,
			url: row.profile_url,
			verified_type: row.profile_verified_type,
			entities_json: row.profile_entities_json,
			created_at: row.profile_created_at,
		});
		const affiliations = affiliationsByProfile.get(participant.id) ?? [];
		return {
			id: String(row.id),
			accountId: String(row.account_id),
			accountHandle: String(row.account_handle),
			title: String(row.title),
			...(typeof row.search_snippet === "string"
				? { searchSnippet: row.search_snippet }
				: {}),
			inboxKind: row.inbox_kind === "request" ? "request" : "accepted",
			isMessageRequest: row.inbox_kind === "request",
			lastMessageAt: String(row.last_message_at),
			lastMessagePreview: String(row.last_message_preview ?? ""),
			unreadCount: Number(row.unread_count),
			needsReply: Boolean(row.needs_reply),
			influenceScore,
			influenceLabel: getInfluenceLabel(influenceScore),
			participant: {
				...participant,
				...(affiliations.length > 0
					? {
							affiliations,
							primaryAffiliation: affiliations[0],
						}
					: {}),
			},
		};
	});

	const filtered = items.filter((item) => {
		if (
			typeof minInfluenceScore === "number" &&
			item.influenceScore < minInfluenceScore
		) {
			return false;
		}

		if (
			typeof maxInfluenceScore === "number" &&
			item.influenceScore > maxInfluenceScore
		) {
			return false;
		}

		return true;
	});

	if (sort === "followers" || sort === "influence") {
		filtered.sort((left, right) => {
			if (
				right.participant.followersCount !== left.participant.followersCount
			) {
				return (
					right.participant.followersCount - left.participant.followersCount
				);
			}
			return (
				new Date(right.lastMessageAt).getTime() -
				new Date(left.lastMessageAt).getTime()
			);
		});
	}

	const limited = filtered.slice(0, limit);
	const normalizedContext = normalizeDmContext(context);
	if (ftsSearch && normalizedContext > 0 && limited.length > 0) {
		const matches = getDmSearchMatches({
			search: ftsSearch,
			conversationIds: limited.map((item) => item.id),
			context: normalizedContext,
		});
		for (const item of limited) {
			const itemMatches = matches.get(item.id);
			if (itemMatches && itemMatches.length > 0) {
				item.matches = itemMatches;
			}
		}
	}

	return limited;
}

export function getConversationThread(
	conversationId: string,
	filters: Pick<DmQuery, "account"> = {},
): { conversation: DmConversationItem; messages: DmMessageItem[] } | null {
	const conversation = listDmConversations({
		...filters,
		conversationIds: [conversationId],
		limit: 1,
	}).find((item) => item.id === conversationId);

	if (!conversation) {
		return null;
	}

	const db = getNativeDb();
	const rows = db
		.prepare(
			`
      select
        m.id,
        m.conversation_id,
        m.text,
        m.created_at,
        m.direction,
        m.is_replied,
        m.media_count,
        p.id as profile_id,
        p.handle,
        p.display_name,
        p.bio,
        p.followers_count,
        p.following_count,
        p.avatar_hue,
        p.avatar_url,
        p.created_at as profile_created_at
      from dm_messages m
      join profiles p on p.id = m.sender_profile_id
      where m.conversation_id = ?
      order by m.created_at asc
      `,
		)
		.all(conversationId) as Array<Record<string, unknown>>;

	return {
		conversation,
		messages: rows.map((row) => ({
			id: String(row.id),
			conversationId: String(row.conversation_id),
			text: String(row.text),
			createdAt: String(row.created_at),
			direction: row.direction as DmMessageItem["direction"],
			isReplied: Boolean(row.is_replied),
			mediaCount: Number(row.media_count),
			sender: toProfile({
				id: row.profile_id,
				handle: row.handle,
				display_name: row.display_name,
				bio: row.bio,
				followers_count: row.followers_count,
				following_count: row.following_count,
				avatar_hue: row.avatar_hue,
				avatar_url: row.avatar_url,
				created_at: row.profile_created_at,
			}),
		})),
	};
}

export type DmRequestMutationAction = "accept" | "reject" | "block";

export function applyDmRequestMutationToLocalStore(
	conversationId: string,
	action: DmRequestMutationAction,
) {
	return persistWrite((db) => {
		db.prepare(
			"delete from sync_cache where cache_key like 'dms:bird:%'",
		).run();
		if (action === "accept") {
			return db
				.prepare(
					`
    update dm_conversations
    set inbox_kind = 'accepted'
    where id = ?
    `,
				)
				.run(conversationId).changes;
		}

		db.prepare(
			`
    delete from link_occurrences
    where source_kind = 'dm'
      and source_id in (
        select id from dm_messages where conversation_id = ?
      )
    `,
		).run(conversationId);
		db.prepare(
			`
    delete from dm_fts
    where message_id in (
      select id from dm_messages where conversation_id = ?
    )
    `,
		).run(conversationId);
		db.prepare("delete from dm_messages where conversation_id = ?").run(
			conversationId,
		);
		return db
			.prepare("delete from dm_conversations where id = ?")
			.run(conversationId).changes;
	});
}

function normalizeDmContext(value: number | undefined) {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return 0;
	}
	return Math.max(0, Math.min(20, Math.trunc(value)));
}

function mapDmMessageRow(row: Record<string, unknown>): DmMessageItem {
	return {
		id: String(row.id),
		conversationId: String(row.conversation_id),
		text: String(row.text),
		createdAt: String(row.created_at),
		direction: row.direction as DmMessageItem["direction"],
		isReplied: Boolean(row.is_replied),
		mediaCount: Number(row.media_count),
		sender: toProfile({
			id: row.profile_id,
			handle: row.handle,
			display_name: row.display_name,
			bio: row.bio,
			followers_count: row.followers_count,
			following_count: row.following_count,
			avatar_hue: row.avatar_hue,
			avatar_url: row.avatar_url,
			created_at: row.profile_created_at,
		}),
	};
}

function selectDmMessageSql(where: string, orderBy: string) {
	return `
    select
      m.id,
      m.conversation_id,
      m.text,
      m.created_at,
      m.direction,
      m.is_replied,
      m.media_count,
      p.id as profile_id,
      p.handle,
      p.display_name,
      p.bio,
      p.followers_count,
      p.following_count,
      p.avatar_hue,
      p.avatar_url,
      p.created_at as profile_created_at
    from dm_messages m
    join profiles p on p.id = m.sender_profile_id
    ${where}
    ${orderBy}
  `;
}

function getDmSearchMatches({
	search,
	conversationIds,
	context,
}: {
	search: string;
	conversationIds: string[];
	context: number;
}) {
	const db = getNativeDb();
	if (search.length === 0) {
		return new Map<string, DmConversationItem["matches"]>();
	}
	const conversationPlaceholders = conversationIds.map(() => "?").join(", ");
	const matchRows = db
		.prepare(
			`
      with ranked_matches as (
        select
          m.id,
          m.conversation_id,
          m.text,
          m.created_at,
          m.direction,
          m.is_replied,
          m.media_count,
          p.id as profile_id,
          p.handle,
          p.display_name,
          p.bio,
          p.followers_count,
          p.following_count,
          p.avatar_hue,
          p.avatar_url,
          p.created_at as profile_created_at,
          row_number() over (
            partition by m.conversation_id
            order by m.created_at desc, m.id desc
          ) as match_rank
        from dm_messages m
        join dm_fts on dm_fts.message_id = m.id
        join profiles p on p.id = m.sender_profile_id
        where dm_fts.text match ?
          and m.conversation_id in (${conversationPlaceholders})
      )
      select *
      from ranked_matches
      where match_rank <= 3
      order by created_at desc, id desc
      `,
		)
		.all(search, ...conversationIds) as Array<Record<string, unknown>>;

	const beforeStatement = db.prepare(
		selectDmMessageSql(
			`
      where m.conversation_id = ?
        and (m.created_at < ? or (m.created_at = ? and m.id < ?))
    `,
			"order by m.created_at desc, m.id desc limit ?",
		),
	);
	const afterStatement = db.prepare(
		selectDmMessageSql(
			`
      where m.conversation_id = ?
        and (m.created_at > ? or (m.created_at = ? and m.id > ?))
    `,
			"order by m.created_at asc, m.id asc limit ?",
		),
	);
	const grouped = new Map<string, DmConversationItem["matches"]>();

	for (const row of matchRows) {
		const message = mapDmMessageRow(row);
		const before = (
			beforeStatement.all(
				message.conversationId,
				message.createdAt,
				message.createdAt,
				message.id,
				context,
			) as Array<Record<string, unknown>>
		)
			.map(mapDmMessageRow)
			.reverse();
		const after = (
			afterStatement.all(
				message.conversationId,
				message.createdAt,
				message.createdAt,
				message.id,
				context,
			) as Array<Record<string, unknown>>
		).map(mapDmMessageRow);
		const matches = grouped.get(message.conversationId) ?? [];
		matches.push({ message, before, after });
		grouped.set(message.conversationId, matches);
	}

	return grouped;
}

export function queryResource(
	resource: "home" | "mentions" | "authored" | "search" | "dms",
	filters: (TimelineQuery | DmQuery) & { conversationId?: string },
): QueryResponse {
	if (resource === "dms") {
		const dmFilters = filters as DmQuery & { conversationId?: string };
		const items = listDmConversations(dmFilters);
		const requestedConversationId = dmFilters.conversationId;
		const selectedConversationId =
			requestedConversationId &&
			items.some((item) => item.id === requestedConversationId)
				? requestedConversationId
				: items[0]?.id;
		return {
			resource,
			items,
			selectedConversation: selectedConversationId
				? getConversationThread(selectedConversationId, {
						account: dmFilters.account,
					})
				: null,
		};
	}

	const { resource: _filterResource, ...timelineFilters } =
		filters as TimelineQuery;

	return {
		resource,
		items: listTimelineItems({
			resource,
			...timelineFilters,
		}),
	};
}

function refreshDmConversationState(
	db: Database,
	conversationId: string,
	lastMessageAt: string,
	observedLastMessageAt = lastMessageAt,
) {
	db.prepare(
		`
    update dm_conversations
    set last_message_at = case
          when last_message_at < ? then ?
          else last_message_at
        end,
        unread_count = case
          when last_message_at = ? then 0
          when last_message_at <= ? then 0
          else unread_count
        end,
        needs_reply = case
          when last_message_at = ? then 0
          when last_message_at <= ? then 0
          else needs_reply
        end
    where id = ?
    `,
	).run(
		lastMessageAt,
		lastMessageAt,
		observedLastMessageAt,
		lastMessageAt,
		observedLastMessageAt,
		lastMessageAt,
		conversationId,
	);
}

function getLocalAuthorProfileId(accountId: string) {
	const db = getNativeDb();
	const row = db
		.prepare(
			`
      select p.id
      from accounts a
      join profiles p on p.handle = replace(a.handle, '@', '')
      where a.id = ?
      `,
		)
		.get(accountId) as { id: string } | undefined;

	return row?.id;
}

let savepointCounter = 0;

function preflightWrite<T>(write: (db: Database) => T) {
	const db = getNativeDb();
	const savepoint = `__birdclaw_preflight_${++savepointCounter}`;
	db.exec(`savepoint ${savepoint}`);
	try {
		const result = write(db);
		db.exec(`rollback to ${savepoint}`);
		db.exec(`release ${savepoint}`);
		return result;
	} catch (error) {
		try {
			db.exec(`rollback to ${savepoint}`);
			db.exec(`release ${savepoint}`);
		} catch {
			// Preserve the original staging error; cleanup is best effort here.
		}
		throw error;
	}
}

function persistWrite<T>(write: (db: Database) => T) {
	const db = getNativeDb();
	return db.transaction(() => write(db))();
}

type PostDraft = {
	actionId: string;
	authorProfileId: string;
	createdAt: string;
	tweetId: string;
};

function preparePostDraft(accountId: string): PostDraft {
	const authorProfileId = getLocalAuthorProfileId(accountId);
	if (!authorProfileId) {
		throw new Error("No local author profile for account");
	}

	return {
		actionId: randomUUID(),
		authorProfileId,
		createdAt: new Date().toISOString(),
		tweetId: `tweet_${randomUUID()}`,
	};
}

function writePostDraft(
	db: Database,
	accountId: string,
	text: string,
	draft: PostDraft,
) {
	db.prepare(
		`
    insert into tweets (
      id, account_id, author_profile_id, kind, text, created_at,
      is_replied, reply_to_id, like_count, media_count, bookmarked, liked
    ) values (?, ?, ?, 'home', ?, ?, 0, null, 0, 0, 0, 0)
    `,
	).run(draft.tweetId, accountId, draft.authorProfileId, text, draft.createdAt);

	db.prepare("insert into tweets_fts (tweet_id, text) values (?, ?)").run(
		draft.tweetId,
		text,
	);
	db.prepare(
		"insert into tweet_actions (id, account_id, tweet_id, kind, body, created_at) values (?, ?, ?, ?, ?, ?)",
	).run(
		draft.actionId,
		accountId,
		draft.tweetId,
		"post",
		text,
		draft.createdAt,
	);
}

export function createPostEffect(accountId: string, text: string) {
	return Effect.gen(function* () {
		const draft = yield* trySync(() => {
			const postDraft = preparePostDraft(accountId);
			preflightWrite((db) => writePostDraft(db, accountId, text, postDraft));
			return postDraft;
		});

		yield* verifySelectedXurlAccountEffect(accountId);
		const transport = yield* postViaXurlEffect(text);
		if (!transport.ok) {
			return yield* Effect.fail(new Error(transport.output || "post failed"));
		}
		yield* trySync(() =>
			persistWrite((db) => writePostDraft(db, accountId, text, draft)),
		);

		return { ok: true, transport, tweetId: draft.tweetId };
	});
}

export function createPost(accountId: string, text: string) {
	return runEffectPromise(createPostEffect(accountId, text));
}

export function createTweetReplyEffect(
	accountId: string,
	tweetId: string,
	text: string,
) {
	type ReplyDraft = PostDraft & { replyId: string };

	function prepareReplyDraft(): ReplyDraft {
		const postDraft = preparePostDraft(accountId);
		return {
			...postDraft,
			replyId: postDraft.tweetId,
		};
	}

	function writeReplyDraft(db: Database, draft: ReplyDraft) {
		db.prepare("update tweets set is_replied = 1 where id = ?").run(tweetId);

		db.prepare(
			`
    insert into tweets (
      id, account_id, author_profile_id, kind, text, created_at,
      is_replied, reply_to_id, like_count, media_count, bookmarked, liked
    ) values (?, ?, ?, 'home', ?, ?, 1, ?, 0, 0, 0, 0)
    `,
		).run(
			draft.replyId,
			accountId,
			draft.authorProfileId,
			text,
			draft.createdAt,
			tweetId,
		);
		db.prepare("insert into tweets_fts (tweet_id, text) values (?, ?)").run(
			draft.replyId,
			text,
		);

		db.prepare(
			"insert into tweet_actions (id, account_id, tweet_id, kind, body, created_at) values (?, ?, ?, ?, ?, ?)",
		).run(draft.actionId, accountId, tweetId, "reply", text, draft.createdAt);
	}

	return Effect.gen(function* () {
		const draft = yield* trySync(() => {
			const replyDraft = prepareReplyDraft();
			preflightWrite((db) => writeReplyDraft(db, replyDraft));
			return replyDraft;
		});

		yield* verifySelectedXurlAccountEffect(accountId);
		const transport = yield* replyViaXurlEffect(tweetId, text);
		if (!transport.ok) {
			return yield* Effect.fail(new Error(transport.output || "reply failed"));
		}
		yield* trySync(() => persistWrite((db) => writeReplyDraft(db, draft)));

		return { ok: true, transport, replyId: draft.replyId };
	});
}

export function createTweetReply(
	accountId: string,
	tweetId: string,
	text: string,
) {
	return runEffectPromise(createTweetReplyEffect(accountId, tweetId, text));
}

export function createDmReplyEffect(conversationId: string, text: string) {
	return Effect.gen(function* () {
		const draft = yield* trySync(() => {
			const conversation = getConversationThread(conversationId);
			if (!conversation) {
				throw new Error("Conversation not found");
			}
			const authorProfileId = getLocalAuthorProfileId(
				conversation.conversation.accountId,
			);
			if (!authorProfileId) {
				throw new Error("No local author profile for account");
			}

			const dmDraft = {
				accountId: conversation.conversation.accountId,
				authorProfileId,
				createdAt: new Date().toISOString(),
				handle: conversation.conversation.participant.handle,
				observedLastMessageAt: conversation.conversation.lastMessageAt,
				outboundId: `msg_${randomUUID()}`,
			};
			preflightWrite((db) => {
				db.prepare(
					`
    insert into dm_messages (
      id, conversation_id, sender_profile_id, text, created_at, direction, is_replied, media_count
    ) values (?, ?, ?, ?, ?, 'outbound', 1, 0)
    `,
				).run(
					dmDraft.outboundId,
					conversationId,
					dmDraft.authorProfileId,
					text,
					dmDraft.createdAt,
				);
				db.prepare("insert into dm_fts (message_id, text) values (?, ?)").run(
					dmDraft.outboundId,
					text,
				);

				refreshDmConversationState(
					db,
					conversationId,
					dmDraft.createdAt,
					dmDraft.observedLastMessageAt,
				);
			});
			return dmDraft;
		});

		yield* verifySelectedXurlAccountEffect(draft.accountId);
		const transport = yield* dmViaXurlEffect(draft.handle, text);
		if (!transport.ok) {
			return yield* Effect.fail(new Error(transport.output || "dm failed"));
		}
		yield* trySync(() =>
			persistWrite((db) => {
				db.prepare(
					`
    insert into dm_messages (
      id, conversation_id, sender_profile_id, text, created_at, direction, is_replied, media_count
    ) values (?, ?, ?, ?, ?, 'outbound', 1, 0)
    `,
				).run(
					draft.outboundId,
					conversationId,
					draft.authorProfileId,
					text,
					draft.createdAt,
				);
				db.prepare("insert into dm_fts (message_id, text) values (?, ?)").run(
					draft.outboundId,
					text,
				);

				refreshDmConversationState(
					db,
					conversationId,
					draft.createdAt,
					draft.observedLastMessageAt,
				);
			}),
		);

		return { ok: true, transport, messageId: draft.outboundId };
	});
}

export function createDmReply(conversationId: string, text: string) {
	return runEffectPromise(createDmReplyEffect(conversationId, text));
}
