import { getNativeDb } from "./db";
import type { Database } from "./sqlite";
import {
	normalizeUrlExpansionForIndex,
	upsertUrlExpansion,
} from "./url-expansion-store";
import {
	expandUrls,
	extractUrls,
	type ExpandUrlsOptions,
} from "./url-expansion";
import type {
	LinkIndexItem,
	LinkOccurrenceItem,
	LinkSearchItem,
	ProfileRecord,
	TimelineItem,
	TweetEntities,
	TweetMediaItem,
} from "./types";

const DEFAULT_EXPAND_CONCURRENCY = 12;

interface TweetUrlEntityLike {
	url?: unknown;
	expandedUrl?: unknown;
	expanded_url?: unknown;
	displayUrl?: unknown;
	display_url?: unknown;
	title?: unknown;
	description?: unknown;
}

interface SourceUrl {
	url: string;
	expandedUrl?: string;
	title?: string;
	description?: string | null;
}

export interface LinkBackfillOptions {
	includeAllUrls?: boolean;
	refresh?: boolean;
	source?: "dm" | "tweet";
	limit?: number;
	concurrency?: number;
	fetchImpl?: ExpandUrlsOptions["fetchImpl"];
	timeoutMs?: number;
}

export interface LinkBackfillResult {
	occurrences: number;
	uniqueUrls: number;
	entityExpansions: number;
	networkExpansions: number;
	cacheExpansions: number;
	misses: number;
	errors: number;
	remainingUnexpanded: number;
}

export interface LinkSearchOptions {
	since?: string;
	until?: string;
	account?: string;
	source?: "dm" | "tweet";
	direction?: "inbound" | "outbound";
	participant?: string;
	mediaType?: "image" | "video" | "gif";
	limit?: number;
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

function getString(value: unknown) {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isIndexedUrl(url: string, includeAllUrls: boolean) {
	if (includeAllUrls) {
		return true;
	}

	try {
		const host = new URL(url).hostname.toLowerCase();
		return host === "t.co" || host.endsWith(".t.co");
	} catch {
		return false;
	}
}

function toTweetEntityUrls(entitiesJson: string): SourceUrl[] {
	const entities = parseJsonField<TweetEntities>(entitiesJson, {});
	const urls = Array.isArray(entities.urls) ? entities.urls : [];
	return urls
		.map((entry: TweetUrlEntityLike) => {
			const url = getString(entry.url);
			const expandedUrl =
				getString(entry.expandedUrl) ?? getString(entry.expanded_url);
			if (!url) {
				return undefined;
			}
			return {
				url,
				...(expandedUrl ? { expandedUrl } : {}),
				...(getString(entry.title) ? { title: getString(entry.title) } : {}),
				...(entry.description !== undefined
					? { description: getString(entry.description) ?? null }
					: {}),
			};
		})
		.filter((entry): entry is SourceUrl => Boolean(entry));
}

function uniqueSourceUrls(
	text: string,
	entityUrls: SourceUrl[],
	includeAllUrls: boolean,
) {
	const byUrl = new Map<string, SourceUrl>();
	for (const url of extractUrls(text)) {
		if (isIndexedUrl(url, includeAllUrls)) {
			byUrl.set(url, { url });
		}
	}
	for (const entityUrl of entityUrls) {
		if (!isIndexedUrl(entityUrl.url, includeAllUrls)) {
			continue;
		}
		byUrl.set(entityUrl.url, { ...byUrl.get(entityUrl.url), ...entityUrl });
	}
	return Array.from(byUrl.values());
}

function rebuildOccurrences(
	db: Database,
	includeAllUrls: boolean,
	source: LinkBackfillOptions["source"],
) {
	const insert = db.prepare(`
    insert or replace into link_occurrences (
      source_kind, source_id, source_position, short_url, account_id,
      conversation_id, direction, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
  `);
	let occurrences = 0;
	let entityExpansions = 0;
	const now = new Date().toISOString();

	db.transaction(() => {
		if (source) {
			db.prepare("delete from link_occurrences where source_kind = ?").run(
				source,
			);
		} else {
			db.exec("delete from link_occurrences");
		}

		const dmRows =
			source === "tweet"
				? []
				: (db
						.prepare(`
      select m.id, m.conversation_id, c.account_id, m.direction, m.created_at, m.text
      from dm_messages m
      join dm_conversations c on c.id = m.conversation_id
      where m.text like '%://%'
    `)
						.all() as Array<Record<string, unknown>>);
		for (const row of dmRows) {
			const urls = uniqueSourceUrls(String(row.text), [], includeAllUrls);
			urls.forEach((entry, index) => {
				insert.run(
					"dm",
					String(row.id),
					index,
					entry.url,
					String(row.account_id),
					String(row.conversation_id),
					String(row.direction),
					String(row.created_at),
				);
				occurrences++;
			});
		}

		const tweetRows =
			source === "dm"
				? []
				: (db
						.prepare(`
      select id, account_id, created_at, text, entities_json
      from tweets
      where text like '%://%' or entities_json like '%://%'
    `)
						.all() as Array<Record<string, unknown>>);
		for (const row of tweetRows) {
			const entityUrls = toTweetEntityUrls(String(row.entities_json));
			const urls = uniqueSourceUrls(
				String(row.text),
				entityUrls,
				includeAllUrls,
			);
			urls.forEach((entry, index) => {
				insert.run(
					"tweet",
					String(row.id),
					index,
					entry.url,
					String(row.account_id),
					null,
					null,
					String(row.created_at),
				);
				occurrences++;
				if (entry.expandedUrl) {
					upsertUrlExpansion(
						db,
						normalizeUrlExpansionForIndex({
							url: entry.url,
							expandedUrl: entry.expandedUrl,
							finalUrl: entry.expandedUrl,
							status: "hit",
							title: entry.title,
							description: entry.description,
							source: "entity",
							updatedAt: now,
						}),
					);
					entityExpansions++;
				}
			});
		}
	})();

	return { occurrences, entityExpansions };
}

async function expandWithConcurrency(
	db: Database,
	urls: string[],
	options: LinkBackfillOptions,
) {
	const concurrency = Math.max(
		1,
		Math.min(options.concurrency ?? DEFAULT_EXPAND_CONCURRENCY, 64),
	);
	const counts = {
		networkExpansions: 0,
		cacheExpansions: 0,
		misses: 0,
		errors: 0,
	};
	let nextIndex = 0;

	async function worker() {
		for (;;) {
			const index = nextIndex++;
			const url = urls[index];
			if (!url) {
				return;
			}
			const result = (
				await expandUrls([url], {
					refresh: options.refresh,
					fetchImpl: options.fetchImpl,
					timeoutMs: options.timeoutMs,
				})
			)[0]!;
			if (result.source === "network") {
				counts.networkExpansions++;
			} else {
				counts.cacheExpansions++;
			}
			if (result.status === "miss") {
				counts.misses++;
			}
			if (result.status === "error") {
				counts.errors++;
			}
			upsertUrlExpansion(db, normalizeUrlExpansionForIndex(result));
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()),
	);
	return counts;
}

export async function backfillLinkIndex(
	options: LinkBackfillOptions = {},
): Promise<LinkBackfillResult> {
	const db = getNativeDb({ seedDemoData: false });
	const { occurrences, entityExpansions } = rebuildOccurrences(
		db,
		Boolean(options.includeAllUrls),
		options.source,
	);
	const limit =
		typeof options.limit === "number" && Number.isFinite(options.limit)
			? Math.max(0, Math.trunc(options.limit))
			: undefined;
	const needsExpansionClause = options.refresh
		? "1 = 1"
		: "(e.short_url is null or e.status in ('error', 'miss'))";

	const urlsToExpand = db
		.prepare(`
    select distinct o.short_url
    from link_occurrences o
    left join url_expansions e on e.short_url = o.short_url
    where ${needsExpansionClause}
      ${options.source ? "and o.source_kind = ?" : ""}
    order by o.short_url
    ${limit === undefined ? "" : "limit ?"}
  `)
		.all(
			...(options.source ? [options.source] : []),
			...(limit === undefined ? [] : [limit]),
		) as Array<{
		short_url: string;
	}>;

	const expansionCounts = await expandWithConcurrency(
		db,
		urlsToExpand.map((row) => row.short_url),
		options,
	);

	const uniqueUrls = db
		.prepare(`
    select count(distinct short_url) as count
    from link_occurrences
    ${options.source ? "where source_kind = ?" : ""}
  `)
		.get(...(options.source ? [options.source] : [])) as { count: number };
	const remaining = db
		.prepare(`
    select count(distinct o.short_url) as count
    from link_occurrences o
    left join url_expansions e on e.short_url = o.short_url
    where (e.short_url is null or e.status in ('error', 'miss'))
      ${options.source ? "and o.source_kind = ?" : ""}
  `)
		.get(...(options.source ? [options.source] : [])) as { count: number };

	return {
		occurrences,
		uniqueUrls: Number(uniqueUrls.count),
		entityExpansions,
		...expansionCounts,
		remainingUnexpanded: Number(remaining.count),
	};
}

function likePattern(value: string) {
	return `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_").toLowerCase()}%`;
}

function toProfile(
	row: Record<string, unknown>,
	prefix: string,
): ProfileRecord | null {
	if (!row[`${prefix}id`]) {
		return null;
	}
	return {
		id: String(row[`${prefix}id`]),
		handle: String(row[`${prefix}handle`]),
		displayName: String(row[`${prefix}display_name`]),
		bio: String(row[`${prefix}bio`]),
		followersCount: Number(row[`${prefix}followers_count`]),
		followingCount: Number(row[`${prefix}following_count`]),
		avatarHue: Number(row[`${prefix}avatar_hue`]),
		avatarUrl: getString(row[`${prefix}avatar_url`]),
		location: getString(row[`${prefix}location`]),
		url: getString(row[`${prefix}url`]),
		verifiedType: getString(row[`${prefix}verified_type`]),
		entities: parseJsonField<Record<string, unknown>>(
			row[`${prefix}entities_json`],
			{},
		),
		createdAt: String(row[`${prefix}created_at`]),
	};
}

function toLinkedTweet(row: Record<string, unknown>): TimelineItem | null {
	const author = toProfile(row, "linked_author_");
	if (!row.linked_id || !author) {
		return null;
	}

	return {
		id: String(row.linked_id),
		accountId: String(row.linked_account_id),
		accountHandle: String(row.linked_account_handle ?? ""),
		kind: String(row.linked_kind) as TimelineItem["kind"],
		text: String(row.linked_text),
		createdAt: String(row.linked_created_at),
		isReplied: Boolean(row.linked_is_replied),
		likeCount: Number(row.linked_like_count),
		mediaCount: Number(row.linked_media_count),
		bookmarked: Boolean(row.linked_bookmarked),
		liked: Boolean(row.linked_liked),
		author,
		entities: parseJsonField<TweetEntities>(row.linked_entities_json, {}),
		media: parseJsonField<TweetMediaItem[]>(row.linked_media_json, []),
	};
}

function toLinkSearchItem(row: Record<string, unknown>): LinkSearchItem {
	const occurrence: LinkOccurrenceItem = {
		sourceKind: String(row.source_kind) as LinkOccurrenceItem["sourceKind"],
		sourceId: String(row.source_id),
		sourcePosition: Number(row.source_position),
		shortUrl: String(row.short_url),
		accountId: getString(row.account_id) ?? null,
		conversationId: getString(row.conversation_id) ?? null,
		direction: getString(row.direction) ?? null,
		createdAt: String(row.created_at),
	};
	return {
		occurrence,
		expansion: {
			shortUrl: String(row.short_url),
			expandedUrl: String(row.expanded_url),
			finalUrl: String(row.final_url),
			status: String(row.status) as LinkIndexItem["status"],
			expandedTweetId: getString(row.expanded_tweet_id) ?? null,
			expandedHandle: getString(row.expanded_handle) ?? null,
			title: getString(row.title) ?? null,
			description: getString(row.description) ?? null,
			imageUrl: getString(row.image_url) ?? null,
			siteName: getString(row.site_name) ?? null,
			error: getString(row.error) ?? null,
			source: String(row.expansion_source),
			updatedAt: String(row.updated_at),
		},
		sourceText: String(row.source_text),
		sourceAuthor: toProfile(row, "source_author_"),
		participant: toProfile(row, "participant_"),
		linkedTweet: toLinkedTweet(row),
	};
}

export function searchLinks(query: string, options: LinkSearchOptions = {}) {
	const db = getNativeDb({ seedDemoData: false });
	const conditions: string[] = [];
	const params: unknown[] = [];
	const searchFields = `
    lower(
      coalesce(e.short_url, '') || ' ' ||
      coalesce(e.expanded_url, '') || ' ' ||
      coalesce(e.final_url, '') || ' ' ||
      coalesce(e.expanded_handle, '') || ' ' ||
      coalesce(e.title, '') || ' ' ||
      coalesce(e.description, '') || ' ' ||
      coalesce(dm.text, '') || ' ' ||
      coalesce(source_tweet.text, '') || ' ' ||
      coalesce(linked.text, '') || ' ' ||
      coalesce(linked_author.handle, '') || ' ' ||
      coalesce(linked_author.display_name, '')
    )
  `;

	for (const term of query.match(/[\p{L}\p{N}_:.@/-]+/gu) ?? []) {
		conditions.push(`${searchFields} like ? escape '\\'`);
		params.push(likePattern(term));
	}
	if (options.since) {
		conditions.push("o.created_at >= ?");
		params.push(options.since);
	}
	if (options.until) {
		conditions.push("o.created_at < ?");
		params.push(options.until);
	}
	if (options.account) {
		conditions.push("(o.account_id = ? or account.handle = ?)");
		params.push(options.account, options.account.replace(/^@/, ""));
	}
	if (options.source) {
		conditions.push("o.source_kind = ?");
		params.push(options.source);
	}
	if (options.direction) {
		conditions.push("o.direction = ?");
		params.push(options.direction);
	}
	if (options.participant) {
		conditions.push(
			"(participant.handle = ? or participant.display_name like ?)",
		);
		params.push(
			options.participant.replace(/^@/, ""),
			`%${options.participant}%`,
		);
	}
	if (options.mediaType) {
		conditions.push(
			"(linked.media_json like ? or source_tweet.media_json like ?)",
		);
		params.push(
			`%"type":"${options.mediaType}"%`,
			`%"type":"${options.mediaType}"%`,
		);
	}

	const limit =
		options.limit && Number.isFinite(options.limit)
			? Math.max(1, Math.trunc(options.limit))
			: 20;
	params.push(limit);

	const rows = db
		.prepare(`
    select
      o.source_kind,
      o.source_id,
      o.source_position,
      o.short_url,
      o.account_id,
      o.conversation_id,
      o.direction,
      o.created_at,
      e.expanded_url,
      e.final_url,
      e.status,
      e.expanded_tweet_id,
      e.expanded_handle,
      e.title,
      e.description,
      e.image_url,
      e.site_name,
      e.error,
      e.source as expansion_source,
      e.updated_at,
      coalesce(dm.text, source_tweet.text, '') as source_text,
      account.handle as account_handle,
      source_author.id as source_author_id,
      source_author.handle as source_author_handle,
      source_author.display_name as source_author_display_name,
      source_author.bio as source_author_bio,
      source_author.followers_count as source_author_followers_count,
      source_author.following_count as source_author_following_count,
      source_author.avatar_hue as source_author_avatar_hue,
      source_author.avatar_url as source_author_avatar_url,
      source_author.location as source_author_location,
      source_author.url as source_author_url,
      source_author.verified_type as source_author_verified_type,
      source_author.entities_json as source_author_entities_json,
      source_author.created_at as source_author_created_at,
      participant.id as participant_id,
      participant.handle as participant_handle,
      participant.display_name as participant_display_name,
      participant.bio as participant_bio,
      participant.followers_count as participant_followers_count,
      participant.following_count as participant_following_count,
      participant.avatar_hue as participant_avatar_hue,
      participant.avatar_url as participant_avatar_url,
      participant.location as participant_location,
      participant.url as participant_url,
      participant.verified_type as participant_verified_type,
      participant.entities_json as participant_entities_json,
      participant.created_at as participant_created_at,
      linked.id as linked_id,
      linked.account_id as linked_account_id,
      linked_account.handle as linked_account_handle,
      linked.kind as linked_kind,
      linked.text as linked_text,
      linked.created_at as linked_created_at,
      linked.is_replied as linked_is_replied,
      linked.like_count as linked_like_count,
      linked.media_count as linked_media_count,
      linked.bookmarked as linked_bookmarked,
      linked.liked as linked_liked,
      linked.entities_json as linked_entities_json,
      linked.media_json as linked_media_json,
      linked_author.id as linked_author_id,
      linked_author.handle as linked_author_handle,
      linked_author.display_name as linked_author_display_name,
      linked_author.bio as linked_author_bio,
      linked_author.followers_count as linked_author_followers_count,
      linked_author.following_count as linked_author_following_count,
      linked_author.avatar_hue as linked_author_avatar_hue,
      linked_author.avatar_url as linked_author_avatar_url,
      linked_author.location as linked_author_location,
      linked_author.url as linked_author_url,
      linked_author.verified_type as linked_author_verified_type,
      linked_author.entities_json as linked_author_entities_json,
      linked_author.created_at as linked_author_created_at
    from link_occurrences o
    join url_expansions e on e.short_url = o.short_url
    left join accounts account on account.id = o.account_id
    left join dm_messages dm
      on o.source_kind = 'dm' and dm.id = o.source_id
    left join dm_conversations conversation
      on conversation.id = o.conversation_id
    left join profiles participant
      on participant.id = conversation.participant_profile_id
    left join tweets source_tweet
      on o.source_kind = 'tweet' and source_tweet.id = o.source_id
    left join profiles source_author
      on source_author.id = source_tweet.author_profile_id
    left join tweets linked
      on linked.id = e.expanded_tweet_id
    left join accounts linked_account
      on linked_account.id = linked.account_id
    left join profiles linked_author
      on linked_author.id = linked.author_profile_id
    ${conditions.length > 0 ? `where ${conditions.join(" and ")}` : ""}
    order by o.created_at desc
    limit ?
  `)
		.all(...params) as Array<Record<string, unknown>>;

	return rows.map(toLinkSearchItem);
}
