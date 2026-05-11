import { randomUUID } from "node:crypto";
import type { Database } from "./sqlite";
import { findArchives } from "./archive-finder";
import { getDb, getNativeDb } from "./db";
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
	TweetMediaItem,
	TweetUrlEntity,
} from "./types";
import {
	dmViaXurl,
	getTransportStatus,
	postViaXurl,
	replyViaXurl,
} from "./xurl";

function getInfluenceScore(followersCount: number) {
	return Math.round(Math.log10(followersCount + 10) * 24);
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
): TweetEntities {
	const mentions = entities.mentions?.map((mention) => {
		const profile =
			(mention.id ? profiles[mention.id] : undefined) ??
			Object.values(profiles).find(
				(candidate) => candidate.handle === mention.username,
			);
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
): TweetEntities {
	return enrichFallbackUrlEntities(
		text,
		enrichEntities(entities, profiles),
		(rawUrl) => getUrlExpansion(db, urlExpansionCache, rawUrl),
	);
}

function buildEmbeddedTweet(
	db: Database,
	urlExpansionCache: UrlExpansionCache,
	row: Record<string, unknown>,
	prefix: string,
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
		author,
		entities: enrichTimelineEntities(
			db,
			urlExpansionCache,
			text,
			parseJsonField<TweetEntities>(row[`${prefix}entities_json`], {}),
			{
				[author.id]: author,
			},
		),
		media: parseJsonField<TweetMediaItem[]>(row[`${prefix}media_json`], []),
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
      with timeline_edges as (
        select account_id, tweet_id, kind
        from tweet_account_edges
        where kind = ?
        union all
        select legacy.account_id, legacy.id as tweet_id, legacy.kind
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
      select count(*) as count
      from timeline_edges e
      join tweets t on t.id = e.tweet_id
      where e.kind = ?
      `,
		)
		.get(kind, kind, kind) as { count: number | bigint } | undefined;
	return Number(row?.count ?? 0);
}

export async function getQueryEnvelope(): Promise<QueryEnvelope> {
	const db = getDb();
	const nativeDb = getNativeDb();
	const homeCount = countTimelineEdges(nativeDb, "home");
	const mentionCount = countTimelineEdges(nativeDb, "mention");
	const counts = await Promise.all([
		db
			.selectFrom("dm_conversations")
			.select((eb) => eb.fn.countAll().as("count"))
			.executeTakeFirstOrThrow(),
		db
			.selectFrom("dm_conversations")
			.select((eb) => eb.fn.countAll().as("count"))
			.where("needs_reply", "=", 1)
			.executeTakeFirstOrThrow(),
		db
			.selectFrom("accounts")
			.selectAll()
			.orderBy("is_default", "desc")
			.orderBy("name", "asc")
			.execute(),
		findArchives(),
		getTransportStatus(),
	]);

	return {
		stats: {
			home: homeCount,
			mentions: mentionCount,
			dms: Number(counts[0].count),
			needsReply: Number(counts[1].count),
			inbox: mentionCount + Number(counts[1].count),
		},
		accounts: counts[2].map((row) => ({
			id: row.id,
			name: row.name,
			handle: row.handle,
			externalUserId: row.external_user_id,
			transport: row.transport,
			isDefault: row.is_default,
			createdAt: row.created_at,
		})) satisfies AccountRecord[],
		archives: counts[3],
		transport: counts[4],
	};
}

export function listTimelineItems({
	resource,
	account,
	search,
	replyFilter = "all",
	since,
	until,
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
	let timelineEdgesCte = `
      with timeline_edges as (
        select account_id, tweet_id, kind
        from tweet_account_edges
        where kind = ?
        union all
        select legacy.account_id, legacy.id as tweet_id, legacy.kind
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
	let join = "";
	let where = "where t.kind = ?";
	let searchSnippetSelect = "";

	if (likedOnly || bookmarkedOnly) {
		if (likedOnly && bookmarkedOnly) {
			timelineEdgesCte = `
        with timeline_edges as (
          select likes.account_id, likes.tweet_id, 'home' as kind
          from tweet_collections likes
          join tweet_collections bookmarks
            on bookmarks.account_id = likes.account_id
            and bookmarks.tweet_id = likes.tweet_id
            and bookmarks.kind = 'bookmarks'
          where likes.kind = 'likes'
          union all
          select legacy.account_id, legacy.id as tweet_id, 'home' as kind
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
          select account_id, tweet_id, 'home' as kind
          from tweet_collections
          where kind = ?
          union all
          select legacy.account_id, legacy.id as tweet_id, 'home' as kind
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
	} else {
		params.push(kind, kind);
		where = "where e.kind = ?";
		params.push(kind);
	}

	if (account && account !== "all") {
		where += " and e.account_id = ?";
		params.push(account);
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
		where += " and t.created_at < ?";
		params.push(until.trim());
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

	const rows = db
		.prepare(
			`
      ${timelineEdgesCte}
      select
        t.id,
        e.account_id,
        a.handle as account_handle,
        e.kind,
        t.text,
        t.created_at,
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
      order by t.created_at desc
      limit ?
      `,
		)
		.all(...params) as Array<Record<string, unknown>>;

	const urlExpansionCache: UrlExpansionCache = new Map();
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
		const text = String(row.text);
		const entities = enrichTimelineEntities(
			db,
			urlExpansionCache,
			text,
			parseJsonField<TweetEntities>(row.entities_json, {}),
			{
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
			},
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
			isReplied: Boolean(row.is_replied),
			likeCount: Number(row.like_count),
			mediaCount: Number(row.media_count),
			bookmarked: Boolean(row.bookmarked),
			liked: Boolean(row.liked),
			author,
			entities,
			media: parseJsonField<TweetMediaItem[]>(row.media_json, []),
			replyToTweet: buildEmbeddedTweet(db, urlExpansionCache, row, "reply_"),
			quotedTweet: buildEmbeddedTweet(db, urlExpansionCache, row, "quoted_"),
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

export function listDmConversations({
	account,
	conversationIds,
	participant,
	search,
	replyFilter = "all",
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

	if (account && account !== "all") {
		where += " and a.id = ?";
		params.push(account);
	}

	if (conversationIds && conversationIds.length > 0) {
		where += ` and c.id in (${conversationIds.map(() => "?").join(",")})`;
		params.push(...conversationIds);
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

	if (typeof minFollowers === "number") {
		where += " and p.followers_count >= ?";
		params.push(minFollowers);
	}

	if (typeof maxFollowers === "number") {
		where += " and p.followers_count <= ?";
		params.push(maxFollowers);
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
      order by c.last_message_at desc
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

	if (sort === "influence") {
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
): { conversation: DmConversationItem; messages: DmMessageItem[] } | null {
	const conversation = listDmConversations({ limit: 100 }).find(
		(item) => item.id === conversationId,
	);

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
	resource: "home" | "mentions" | "dms",
	filters: (TimelineQuery | DmQuery) & { conversationId?: string },
): QueryResponse {
	if (resource === "dms") {
		const dmFilters = filters as DmQuery & { conversationId?: string };
		const items = listDmConversations(dmFilters);
		const selectedConversationId = dmFilters.conversationId ?? items[0]?.id;
		return {
			resource,
			items,
			selectedConversation: selectedConversationId
				? getConversationThread(selectedConversationId)
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
) {
	db.prepare(
		`
    update dm_conversations
    set last_message_at = ?,
        unread_count = 0,
        needs_reply = 0
    where id = ?
    `,
	).run(lastMessageAt, conversationId);
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

export async function createPost(accountId: string, text: string) {
	const db = getNativeDb();
	const authorProfileId = getLocalAuthorProfileId(accountId);
	if (!authorProfileId) {
		throw new Error("No local author profile for account");
	}

	const now = new Date().toISOString();
	const tweetId = `tweet_${randomUUID()}`;

	db.prepare(
		`
    insert into tweets (
      id, account_id, author_profile_id, kind, text, created_at,
      is_replied, reply_to_id, like_count, media_count, bookmarked, liked
    ) values (?, ?, ?, 'home', ?, ?, 0, null, 0, 0, 0, 0)
    `,
	).run(tweetId, accountId, authorProfileId, text, now);

	db.prepare("insert into tweets_fts (tweet_id, text) values (?, ?)").run(
		tweetId,
		text,
	);
	db.prepare(
		"insert into tweet_actions (id, account_id, tweet_id, kind, body, created_at) values (?, ?, ?, ?, ?, ?)",
	).run(randomUUID(), accountId, tweetId, "post", text, now);

	const transport = await postViaXurl(text);
	return { ok: true, transport, tweetId };
}

export async function createTweetReply(
	accountId: string,
	tweetId: string,
	text: string,
) {
	const db = getNativeDb();
	const authorProfileId = getLocalAuthorProfileId(accountId);
	if (!authorProfileId) {
		throw new Error("No local author profile for account");
	}

	const now = new Date().toISOString();
	db.prepare("update tweets set is_replied = 1 where id = ?").run(tweetId);

	const replyId = `tweet_${randomUUID()}`;
	db.prepare(
		`
    insert into tweets (
      id, account_id, author_profile_id, kind, text, created_at,
      is_replied, reply_to_id, like_count, media_count, bookmarked, liked
    ) values (?, ?, ?, 'home', ?, ?, 1, ?, 0, 0, 0, 0)
    `,
	).run(replyId, accountId, authorProfileId, text, now, tweetId);
	db.prepare("insert into tweets_fts (tweet_id, text) values (?, ?)").run(
		replyId,
		text,
	);

	db.prepare(
		"insert into tweet_actions (id, account_id, tweet_id, kind, body, created_at) values (?, ?, ?, ?, ?, ?)",
	).run(randomUUID(), accountId, tweetId, "reply", text, now);

	const transport = await replyViaXurl(tweetId, text);
	return { ok: true, transport, replyId };
}

export async function createDmReply(conversationId: string, text: string) {
	const db = getNativeDb();
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

	const now = new Date().toISOString();
	const outboundId = `msg_${randomUUID()}`;

	db.prepare(
		`
    insert into dm_messages (
      id, conversation_id, sender_profile_id, text, created_at, direction, is_replied, media_count
    ) values (?, ?, ?, ?, ?, 'outbound', 1, 0)
    `,
	).run(outboundId, conversationId, authorProfileId, text, now);
	db.prepare("insert into dm_fts (message_id, text) values (?, ?)").run(
		outboundId,
		text,
	);

	refreshDmConversationState(db, conversationId, now);
	const transport = await dmViaXurl(
		conversation.conversation.participant.handle,
		text,
	);
	return { ok: true, transport, messageId: outboundId };
}
