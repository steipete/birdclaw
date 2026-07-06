import type { Database } from "./sqlite";
import { getReadDb } from "./db";
import { profileFromDbRow, profileHandleKey } from "./profile-row";
import { displayUrlForLink, enrichFallbackUrlEntities } from "./tweet-render";
import { parseJsonField, toFtsSearchQuery } from "./query-read-model-shared";
import type {
	EmbeddedTweet,
	ProfileRecord,
	ReplyFilter,
	TimelineItem,
	TimelineQualityFilter,
	TimelineQuery,
	TweetConversation,
	TweetEntities,
	TweetMediaItem,
	TweetUrlEntity,
} from "./types";

export type { TimelineItem, TimelineQuery } from "./types";
export type { TweetConversation } from "./types";

function avatarHueForHandle(handle: string) {
	let hash = 0;
	for (const character of handle) {
		hash = (hash * 31 + character.charCodeAt(0)) % 360;
	}
	return hash;
}

function fallbackProfileForHandle(handle: string): ProfileRecord {
	const normalized = profileHandleKey(handle);
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
	const normalized = profileHandleKey(handle);
	const inlineProfile = Object.values(profiles).find(
		(profile) => profileHandleKey(profile.handle) === normalized,
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
	const profile = row ? profileFromDbRow(row) : null;
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
					profileHandleKey(candidate.handle) ===
					profileHandleKey(mention.username),
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

	const author = profileFromDbRow({
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

const RECENT_TIMELINE_EDGE_CANDIDATES = 5000;

export interface TimelineItemsQueryPlan {
	sql: string;
	params: Array<string | number>;
	fallbackSql: string;
	fallbackParams: Array<string | number>;
	usedRecentEdgeWindow: boolean;
	ftsSearch: string;
}

// Above this many FTS matches, iterating the match set (with the per-row
// dedupe subquery) costs more than walking the created_at index newest-first
// and probing the match set until the limit fills.
const FTS_DRIVE_FROM_MATCHES_MAX = 10_000;

// Exported so tests can EXPLAIN the generated SQL with bound parameters and
// guard the query plan (see the fts_matches comment below).
export function buildTimelineItemsQuery(
	{
		resource,
		account,
		listAccountId,
		listId,
		search,
		replyFilter = "all",
		since,
		until,
		untilId,
		includeReplies = true,
		qualityFilter = "all",
		lowQualityThreshold,
		likedOnly = false,
		bookmarkedOnly = false,
		limit = 18,
	}: TimelineQuery,
	ftsMatchCountHint = 0,
): TimelineItemsQueryPlan {
	const kind = resource === "mentions" ? "mention" : resource;
	const cteParams: Array<string | number> = [];
	const params: Array<string | number> = [];
	const normalizedLowQualityThreshold =
		normalizeLowQualityThreshold(lowQualityThreshold);
	const shouldDedupeAcrossAccounts = !account || account === "all";
	let timelineEdgesCte = `
	      with timeline_edges as (
	        select account_id, tweet_id, kind, raw_json
	        from tweet_account_edges
	        where kind = ?
	      )
	    `;
	const unwindowedTimelineEdgesCte = timelineEdgesCte;
	let usedRecentEdgeWindow = false;
	let where = "where e.kind = ?";
	const ftsSearch = search?.trim() ? toFtsSearchQuery(search) : "";

	const canUseRecentEdgeWindow =
		!likedOnly &&
		!bookmarkedOnly &&
		!listId &&
		!account &&
		!search?.trim() &&
		replyFilter === "all" &&
		!since?.trim() &&
		!until?.trim() &&
		includeReplies &&
		qualityFilter === "all";

	if (likedOnly || bookmarkedOnly) {
		// This CTE is also reused by the all-account dedupe subquery below. Keep
		// both passes on tweet lookups so SQLite cannot choose a quadratic kind scan.
		if (likedOnly && bookmarkedOnly) {
			timelineEdgesCte = `
        with timeline_edges as (
          select likes.account_id, likes.tweet_id, 'home' as kind, likes.raw_json
	          from tweet_collections likes indexed by idx_tweet_collections_tweet
	          join tweet_collections bookmarks indexed by idx_tweet_collections_tweet
            on bookmarks.account_id = likes.account_id
            and bookmarks.tweet_id = likes.tweet_id
	            and bookmarks.kind = 'bookmarks'
	          where likes.kind = 'likes'
	        )
	      `;
		} else {
			const collectionKind = likedOnly ? "likes" : "bookmarks";
			timelineEdgesCte = `
	        with timeline_edges as (
	          select account_id, tweet_id, 'home' as kind, raw_json
	          from tweet_collections indexed by idx_tweet_collections_tweet
	          where kind = ?
	        )
				`;
			cteParams.push(collectionKind);
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
	      )
	    `;
		const candidateLimit = Math.max(
			RECENT_TIMELINE_EDGE_CANDIDATES,
			limit * 50,
		);
		cteParams.push(kind, candidateLimit);
		where = "where e.kind = ?";
		params.push(kind);
	} else {
		cteParams.push(kind);
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

	if (Boolean(listId) !== Boolean(listAccountId)) {
		throw new Error("List filtering requires both listId and listAccountId");
	}
	if (listId && listAccountId) {
		where += `
      and exists (
        select 1
        from x_list_members list_member
        where list_member.account_id = ?
          and list_member.list_id = ?
          and list_member.profile_id = t.author_profile_id
          and list_member.current = 1
      )
    `;
		params.push(listAccountId, listId);
	}

	// Materialize the FTS match set once. Joining tweets_fts directly looks
	// equivalent, but with bound parameters SQLite picks a plan that re-runs
	// the whole MATCH scan for every timeline edge row (minutes on large
	// archives). The cross joins pin the join order: selective terms iterate
	// the match set, ultra-common terms walk the created_at index newest-first
	// and probe the match set so the limit fills after a few rows. Snippets
	// are computed in a separate pass for only the returned rows.
	const ftsMatchesCte = ftsSearch
		? `, fts_matches as materialized (
        select tweet_id
        from tweets_fts
        where tweets_fts.text match ?
      )`
		: "";
	if (ftsSearch) {
		cteParams.push(ftsSearch);
	}
	const searchDrivenFrom =
		ftsMatchCountHint > FTS_DRIVE_FROM_MATCHES_MAX
			? `tweets t
        cross join fts_matches on fts_matches.tweet_id = t.id
        cross join timeline_edges e on e.tweet_id = t.id`
			: `fts_matches
        cross join tweets t on t.id = fts_matches.tweet_id
        cross join timeline_edges e on e.tweet_id = t.id`;

	params.push(limit);
	if (ftsSearch) {
		// Outer limit; the inner search CTE consumes the first one.
		params.push(limit);
	}

	// For searches, resolve the limited id set first so the wide column list
	// (embedded tweets, bookmark/like probes) is only evaluated for returned
	// rows instead of every match.
	const searchSelectionCte = ftsSearch
		? `, search_selection as materialized (
        select t.id as tweet_id, e.account_id, e.kind, e.raw_json
        from ${searchDrivenFrom}
        ${where}
        order by t.created_at desc, t.id desc
        limit ?
      )`
		: "";

	const buildTimelineSelectSql = (timelineEdgesSql: string) => `
      ${timelineEdgesSql}${ftsMatchesCte}${searchSelectionCte}
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
          else 0
        end as bookmarked,
        case
          when exists (
            select 1 from tweet_collections collection
            where collection.account_id = e.account_id
              and collection.tweet_id = t.id
              and collection.kind = 'likes'
          ) then 1
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
      from ${ftsSearch ? "search_selection e" : "timeline_edges e"}
      join tweets t on t.id = e.tweet_id
      join accounts a on a.id = e.account_id
      join profiles p on p.id = t.author_profile_id
      left join tweets rt on rt.id = t.reply_to_id
      left join profiles rp on rp.id = rt.author_profile_id
      left join tweets qt on qt.id = t.quoted_tweet_id
      left join profiles qp on qp.id = qt.author_profile_id
      ${ftsSearch ? "" : where}
      order by t.created_at desc, t.id desc
      limit ?
      `;

	return {
		sql: buildTimelineSelectSql(timelineEdgesCte),
		params: [...cteParams, ...params],
		fallbackSql: buildTimelineSelectSql(unwindowedTimelineEdgesCte),
		fallbackParams: [kind, kind, limit],
		usedRecentEdgeWindow,
		ftsSearch,
	};
}

const SEARCH_SNIPPET_SQL =
	"snippet(tweets_fts, 1, '<mark>', '</mark>', '...', 16)";

export function listTimelineItems(query: TimelineQuery): TimelineItem[] {
	const db = getReadDb();
	const {
		includeQualityReason = false,
		lowQualityThreshold,
		limit = 18,
	} = query;
	const normalizedLowQualityThreshold =
		normalizeLowQualityThreshold(lowQualityThreshold);
	const ftsSearch = query.search?.trim() ? toFtsSearchQuery(query.search) : "";
	const ftsMatchCount = ftsSearch
		? Number(
				(
					db
						.prepare(
							"select count(*) as match_count from tweets_fts where tweets_fts.text match ?",
						)
						.get(ftsSearch) as { match_count: number }
				).match_count,
			)
		: 0;
	const plan = buildTimelineItemsQuery(query, ftsMatchCount);

	let rows = db.prepare(plan.sql).all(...plan.params) as Array<
		Record<string, unknown>
	>;

	if (plan.usedRecentEdgeWindow && rows.length < limit) {
		rows = db.prepare(plan.fallbackSql).all(...plan.fallbackParams) as Array<
			Record<string, unknown>
		>;
	}

	if (plan.ftsSearch && rows.length > 0) {
		const snippetRows = db
			.prepare(
				`select tweet_id, ${SEARCH_SNIPPET_SQL} as search_snippet
         from tweets_fts
         where tweets_fts.text match ?
           and tweet_id in (${rows.map(() => "?").join(",")})`,
			)
			.all(plan.ftsSearch, ...rows.map((row) => String(row.id))) as Array<
			Record<string, unknown>
		>;
		const snippetByTweetId = new Map(
			snippetRows.map((row) => [String(row.tweet_id), row.search_snippet]),
		);
		for (const row of rows) {
			row.search_snippet = snippetByTweetId.get(String(row.id));
		}
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
						[String(row.reply_profile_id)]: profileFromDbRow({
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
						[String(row.quoted_profile_id)]: profileFromDbRow({
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
      else 0
    end as bookmarked,
    case
      when exists (
        select 1 from tweet_collections collection
        where collection.account_id = ?
          and collection.tweet_id = t.id
          and collection.kind = 'likes'
      ) then 1
      else 0
    end as liked,`
		: `
    exists (
      select 1 from tweet_collections collection
      where collection.tweet_id = t.id and collection.kind = 'bookmarks'
    ) as bookmarked,
    exists (
      select 1 from tweet_collections collection
      where collection.tweet_id = t.id and collection.kind = 'likes'
    ) as liked,`;
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
	const stateParams = accountId ? [accountId, accountId] : [];
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

export function getTweetsByIds(
	tweetIds: string[],
	accountId?: string,
): EmbeddedTweet[] {
	const db = getReadDb();
	const scopedAccountId =
		accountId && accountId !== "all" ? accountId : undefined;
	const urlExpansionCache: UrlExpansionCache = new Map();
	const profileByHandleCache: ProfileByHandleCache = new Map();
	const resolveProfileByHandle = (handle: string) =>
		getProfileByHandle(db, profileByHandleCache, handle);
	const seen = new Set<string>();
	const tweets: EmbeddedTweet[] = [];

	for (const tweetId of tweetIds) {
		const normalized = tweetId.trim().replace(/^tweet_/, "");
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		if (
			scopedAccountId &&
			!db
				.prepare(
					`
					select 1
					from tweets tweet
					where tweet.id = ?
						and (
							exists (
								select 1
								from tweet_account_edges edge
								where edge.account_id = ?
									and edge.tweet_id = tweet.id
							)
							or exists (
								select 1
								from tweet_collections collection
								where collection.account_id = ?
									and collection.tweet_id = tweet.id
							)
						)
					limit 1
					`,
				)
				.get(normalized, scopedAccountId, scopedAccountId)
		) {
			continue;
		}
		const tweet = getTweetById(
			db,
			urlExpansionCache,
			normalized,
			resolveProfileByHandle,
			scopedAccountId,
		);
		if (tweet) tweets.push(tweet);
	}

	return tweets;
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
): TweetConversation | null {
	const db = getReadDb();
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
