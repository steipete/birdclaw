import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { findArchives } from "./archive-finder";
import { getDb, getNativeDb } from "./db";
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
	return {
		id: String(row.id),
		handle: String(row.handle),
		displayName: String(row.display_name),
		bio: String(row.bio),
		followersCount: Number(row.followers_count),
		avatarHue: Number(row.avatar_hue),
		avatarUrl:
			typeof row.avatar_url === "string" ? String(row.avatar_url) : undefined,
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

function buildEmbeddedTweet(
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
		avatar_hue: row[`${prefix}avatar_hue`],
		avatar_url: row[`${prefix}avatar_url`],
		created_at: row[`${prefix}profile_created_at`],
	});

	return {
		id: String(row[`${prefix}id`]),
		text: String(row[`${prefix}text`] ?? ""),
		createdAt: String(row[`${prefix}created_at`] ?? new Date(0).toISOString()),
		author,
		entities: enrichEntities(
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

export async function getQueryEnvelope(): Promise<QueryEnvelope> {
	const db = getDb();
	const counts = await Promise.all([
		db
			.selectFrom("tweets")
			.select((eb) => eb.fn.countAll().as("count"))
			.where("kind", "=", "home")
			.executeTakeFirstOrThrow(),
		db
			.selectFrom("tweets")
			.select((eb) => eb.fn.countAll().as("count"))
			.where("kind", "=", "mention")
			.executeTakeFirstOrThrow(),
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
			home: Number(counts[0].count),
			mentions: Number(counts[1].count),
			dms: Number(counts[2].count),
			needsReply: Number(counts[3].count),
			inbox: Number(counts[1].count) + Number(counts[3].count),
		},
		accounts: counts[4].map((row) => ({
			id: row.id,
			name: row.name,
			handle: row.handle,
			externalUserId: row.external_user_id,
			transport: row.transport,
			isDefault: row.is_default,
			createdAt: row.created_at,
		})) satisfies AccountRecord[],
		archives: counts[5],
		transport: counts[6],
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
	const params: Array<string | number> = [kind];
	const normalizedLowQualityThreshold =
		normalizeLowQualityThreshold(lowQualityThreshold);
	let join = "";
	let where = "where t.kind = ?";

	if (likedOnly || bookmarkedOnly) {
		params.length = 0;
		where = "where 1 = 1";
	}

	if (account && account !== "all") {
		where += " and a.id = ?";
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

	if (search?.trim()) {
		join += " join tweets_fts fts on fts.tweet_id = t.id ";
		where += " and fts.text match ?";
		params.push(search.trim());
	}

	if (likedOnly) {
		where += " and t.liked = 1";
	}

	if (bookmarkedOnly) {
		where += " and t.bookmarked = 1";
	}

	params.push(limit);

	const rows = db
		.prepare(
			`
      select
        t.id,
        t.account_id,
        a.handle as account_handle,
        t.kind,
        t.text,
        t.created_at,
        t.is_replied,
        t.like_count,
        t.media_count,
        t.bookmarked,
        t.liked,
        t.entities_json,
        t.media_json,
        t.quoted_tweet_id,
        p.id as profile_id,
        p.handle,
        p.display_name,
        p.bio,
        p.followers_count,
        p.avatar_hue,
        p.avatar_url,
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
        qp.avatar_hue as quoted_avatar_hue,
        qp.avatar_url as quoted_avatar_url,
        qp.created_at as quoted_profile_created_at
      from tweets t
      join accounts a on a.id = t.account_id
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

	return rows.map((row) => {
		const author = {
			id: String(row.profile_id),
			handle: String(row.handle),
			displayName: String(row.display_name),
			bio: String(row.bio),
			followersCount: Number(row.followers_count),
			avatarHue: Number(row.avatar_hue),
			avatarUrl:
				typeof row.avatar_url === "string" ? String(row.avatar_url) : undefined,
			createdAt: String(row.profile_created_at),
		};
		const entities = enrichEntities(
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
			text: String(row.text),
			createdAt: String(row.created_at),
			isReplied: Boolean(row.is_replied),
			likeCount: Number(row.like_count),
			mediaCount: Number(row.media_count),
			bookmarked: Boolean(row.bookmarked),
			liked: Boolean(row.liked),
			author,
			entities,
			media: parseJsonField<TweetMediaItem[]>(row.media_json, []),
			replyToTweet: buildEmbeddedTweet(row, "reply_"),
			quotedTweet: buildEmbeddedTweet(row, "quoted_"),
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
	participant,
	search,
	replyFilter = "all",
	minFollowers,
	maxFollowers,
	minInfluenceScore,
	maxInfluenceScore,
	sort = "recent",
	limit = 20,
}: DmQuery): DmConversationItem[] {
	const db = getNativeDb();
	const params: Array<string | number> = [];
	let join = "";
	let where = "where 1 = 1";

	if (account && account !== "all") {
		where += " and a.id = ?";
		params.push(account);
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

	if (search?.trim()) {
		join +=
			" join dm_messages latest_search on latest_search.conversation_id = c.id ";
		join += " join dm_fts dmfts on dmfts.message_id = latest_search.id ";
		where += " and dmfts.text match ?";
		params.push(search.trim());
	}

	params.push(limit);

	const rows = db
		.prepare(
			`
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
        p.avatar_hue,
        p.avatar_url,
        p.created_at as profile_created_at,
        (
          select text
          from dm_messages latest_message
          where latest_message.conversation_id = c.id
          order by latest_message.created_at desc
          limit 1
        ) as last_message_preview
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
		.all(...params) as Array<Record<string, unknown>>;

	const items = rows.map((row) => {
		const followersCount = Number(row.followers_count);
		const influenceScore = getInfluenceScore(followersCount);
		return {
			id: String(row.id),
			accountId: String(row.account_id),
			accountHandle: String(row.account_handle),
			title: String(row.title),
			lastMessageAt: String(row.last_message_at),
			lastMessagePreview: String(row.last_message_preview ?? ""),
			unreadCount: Number(row.unread_count),
			needsReply: Boolean(row.needs_reply),
			influenceScore,
			influenceLabel: getInfluenceLabel(influenceScore),
			participant: {
				id: String(row.profile_id),
				handle: String(row.handle),
				displayName: String(row.display_name),
				bio: String(row.bio),
				followersCount,
				avatarHue: Number(row.avatar_hue),
				avatarUrl:
					typeof row.avatar_url === "string"
						? String(row.avatar_url)
						: undefined,
				createdAt: String(row.profile_created_at),
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

	return filtered.slice(0, limit);
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
				avatar_hue: row.avatar_hue,
				avatar_url: row.avatar_url,
				created_at: row.profile_created_at,
			}),
		})),
	};
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
	db: Database.Database,
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
