import { getReadDb } from "./db";
import { fetchProfileAffiliations } from "./profile-affiliations";
import { toFtsSearchQuery, toProfile } from "./query-read-model-shared";
import type { DmConversationItem, DmMessageItem, DmQuery } from "./types";

export type { DmConversationItem, DmMessageItem, DmQuery } from "./types";

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
	const db = getReadDb();
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

	const db = getReadDb();
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
	const db = getReadDb();
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
