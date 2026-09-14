import { profileSelect, type ProfileSqlRow } from "./profile-row";
import { parseJsonField } from "./json-codec";
import { getNativeDb } from "./db";
import { isReadOnlyDeployment } from "./config";
import { ReadOnlyQueryCache } from "./read-only-query-cache";
import type { Database } from "./sqlite";
import type { LinkInsightResponse } from "./api-contracts";
import {
	normalizeProfileHandle,
	nullableProfileFromDbRow,
} from "./profile-row";
import type {
	LinkInsightItem,
	LinkInsightKind,
	LinkInsightMention,
	LinkInsightQuery,
	LinkInsightRange,
	LinkInsightSort,
	ProfileRecord,
	TweetMediaItem,
} from "./types";

const DEFAULT_LIMIT = 30;
const DEFAULT_COMMENTS_LIMIT = 8;
const TRACKING_PARAMS = new Set([
	"fbclid",
	"gclid",
	"igshid",
	"mc_cid",
	"mc_eid",
	"ref",
	"ref_src",
]);
const VIDEO_HOST_SUFFIXES = [
	"youtube.com",
	"youtube-nocookie.com",
	"youtubeeducation.com",
	"youtubekids.com",
	"vimeo.com",
	"twitch.tv",
	"tiktok.com",
	"loom.com",
];
const VIDEO_EXACT_HOSTS = new Set([
	"youtu.be",
	"clips.twitch.tv",
	"vm.tiktok.com",
]);
const EXCLUDED_HOST_SUFFIXES = ["x.com", "twitter.com"];
const EXCLUDED_EXACT_HOSTS = new Set(["t.co"]);
const URL_WHITESPACE = /\s+/g;
const RAW_URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;
const SQL_URL_EXPRESSION =
	"lower(coalesce(nullif(e.final_url, ''), nullif(e.expanded_url, ''), e.short_url))";

interface LinkInsightRow
	extends
		ProfileSqlRow<"source_author_">,
		ProfileSqlRow<"dm_sender_">,
		ProfileSqlRow<"participant_">,
		ProfileSqlRow<"linked_author_"> {
	[key: string]: string | number | null;
	source_kind: "dm" | "tweet";
	source_id: string;
	source_position: number;
	short_url: string;
	account_id: string | null;
	conversation_id: string | null;
	direction: string | null;
	created_at: string;
	expanded_url: string;
	final_url: string;
	expanded_tweet_id: string | null;
	expanded_handle: string | null;
	title: string | null;
	description: string | null;
	source_text: string;
	source_media_json: string | null;
	account_handle: string | null;
	linked_text: string | null;
	linked_media_json: string | null;
}

interface LinkInsightRankRow {
	occurrence_rowid: number;
	source_kind: "dm" | "tweet";
	short_url: string;
	created_at: string;
	expanded_url: string;
	final_url: string;
	source_text: string;
}

interface NormalizedUrl {
	canonicalKey: string;
	displayUrl: string;
	host: string;
	url: string;
}

interface InsightGroup {
	canonicalKey: string;
	description: string | null;
	displayUrl: string;
	firstSeenAt: string;
	host: string;
	kind: LinkInsightKind;
	lastSeenAt: string;
	mentions: LinkInsightMention[];
	seenMentions: Set<string>;
	sharers: Set<string>;
	sharerProfiles: Map<string, ProfileRecord>;
	shareCount: number;
	title: string | null;
	topSharer: ProfileRecord | null;
	totalInfluence: number;
	url: string;
}

interface InsightRanking {
	commentCount: number;
	lastSeenAt: string;
	shareCount: number;
	totalInfluence: number;
}

interface RankedInsightGroup extends InsightRanking {
	canonicalKey: string;
	rowIds: number[];
}

const TITLE_SEGMENT_STOPWORDS = new Set([
	"a",
	"about",
	"blog",
	"events",
	"forum",
	"news",
	"post",
	"posts",
	"public",
	"story",
	"watch",
]);

const TITLE_WORD_OVERRIDES = new Map([
	["ai", "AI"],
	["api", "API"],
	["codex", "Codex"],
	["gpt", "GPT"],
	["ios", "iOS"],
	["macos", "macOS"],
	["openai", "OpenAI"],
	["url", "URL"],
	["wwdc", "WWDC"],
]);

const TITLE_SMALL_WORDS = new Set([
	"a",
	"an",
	"and",
	"as",
	"at",
	"but",
	"by",
	"for",
	"from",
	"in",
	"into",
	"nor",
	"of",
	"on",
	"or",
	"per",
	"the",
	"to",
	"via",
	"vs",
]);

function isHostMatch(host: string, suffixes: string[], exact: Set<string>) {
	const normalized = host.toLowerCase();
	if (exact.has(normalized)) {
		return true;
	}
	return suffixes.some(
		(suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
	);
}

function isVideoHost(host: string) {
	return isHostMatch(host, VIDEO_HOST_SUFFIXES, VIDEO_EXACT_HOSTS);
}

function isExcludedHost(host: string) {
	return isHostMatch(host, EXCLUDED_HOST_SUFFIXES, EXCLUDED_EXACT_HOSTS);
}

function addVideoUrlPrefilter(conditions: string[]) {
	const predicates: string[] = [];
	for (const host of VIDEO_HOST_SUFFIXES) {
		predicates.push(`${SQL_URL_EXPRESSION} like 'http://${host}/%'`);
		predicates.push(`${SQL_URL_EXPRESSION} like 'https://${host}/%'`);
		predicates.push(`${SQL_URL_EXPRESSION} like 'http://%.${host}/%'`);
		predicates.push(`${SQL_URL_EXPRESSION} like 'https://%.${host}/%'`);
	}
	for (const host of VIDEO_EXACT_HOSTS) {
		predicates.push(`${SQL_URL_EXPRESSION} like 'http://${host}/%'`);
		predicates.push(`${SQL_URL_EXPRESSION} like 'https://${host}/%'`);
	}
	// Most URLs are not videos. Reject them before testing every scheme/subdomain form.
	const hints = new Set(
		[...VIDEO_HOST_SUFFIXES, ...VIDEO_EXACT_HOSTS].map((host) =>
			host.split(".").slice(-2).join(".").slice(0, 4),
		),
	);
	const quick = [...hints].map(
		(hint) => `${SQL_URL_EXPRESSION} like '%${hint}%'`,
	);
	conditions.push(
		`case when (${quick.join(" or ")}) then (${predicates.join(" or ")}) else 0 end`,
	);
}

function normalizeUrl(rawUrl: string): NormalizedUrl | null {
	try {
		const parsed = new URL(rawUrl);
		const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
		const host = parsed.port ? `${hostname}:${parsed.port}` : hostname;
		if (!hostname || isExcludedHost(hostname)) {
			return null;
		}

		parsed.hash = "";
		const searchParamKeys = new Set(parsed.searchParams.keys());
		for (const key of searchParamKeys) {
			if (key.startsWith("utm_") || TRACKING_PARAMS.has(key.toLowerCase())) {
				parsed.searchParams.delete(key);
			}
		}
		parsed.searchParams.sort();

		let pathname = parsed.pathname || "/";
		if (pathname.length > 1) {
			pathname = pathname.replace(/\/+$/g, "");
		}
		const search = parsed.search;
		const canonicalKey = `${host}${pathname}${search}`;
		const url = `${parsed.protocol}//${host}${pathname}${search}`;
		const displayUrl =
			pathname === "/" && !search ? host : `${host}${pathname}${search}`;
		return { canonicalKey, displayUrl, host, url };
	} catch {
		return null;
	}
}

function isOpaqueSlugToken(value: string) {
	return /^(?=.*\d)[a-z0-9]{6,}$/i.test(value) || /^[a-f0-9]{8,}$/i.test(value);
}

function titleCaseSlugWord(word: string, index: number) {
	const lower = word.toLowerCase();
	const override = TITLE_WORD_OVERRIDES.get(lower);
	if (override) {
		return override;
	}
	if (index > 0 && TITLE_SMALL_WORDS.has(lower)) {
		return lower;
	}
	return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
}

function humanizeUrlSegment(segment: string) {
	let decoded = segment;
	try {
		decoded = decodeURIComponent(segment);
	} catch {
		// Use the raw segment when the URL contains malformed escapes.
	}
	const withoutExtension = decoded
		.replace(/\.(?:html?|php|aspx?)$/i, "")
		.trim();
	const words = withoutExtension
		.split(/[-_+.\s]+/g)
		.map((word) => word.trim())
		.filter(Boolean);
	while (words.length > 3 && isOpaqueSlugToken(words[words.length - 1] ?? "")) {
		words.pop();
	}
	if (words.length < 2) {
		return null;
	}
	if (!words.some((word) => /[a-z]/i.test(word))) {
		return null;
	}
	return words.map(titleCaseSlugWord).join(" ");
}

function deriveTitleFromUrl(url: string) {
	try {
		const parsed = new URL(url);
		const candidates = parsed.pathname
			.split("/")
			.filter(Boolean)
			.filter((segment) => !TITLE_SEGMENT_STOPWORDS.has(segment.toLowerCase()))
			.map(humanizeUrlSegment)
			.filter((title): title is string => Boolean(title));
		if (candidates.length === 0) {
			return null;
		}
		return candidates.sort((left, right) => right.length - left.length)[0];
	} catch {
		return null;
	}
}

function resolveRange(
	range: LinkInsightRange,
	now: Date,
	since?: string,
	until?: string,
) {
	if (since || until) {
		return {
			since: since ?? null,
			until: until ?? null,
		};
	}
	if (range === "all") {
		return { since: null, until: null };
	}

	const start = new Date(now);
	if (range === "today") {
		// "Today" follows the user's local calendar day; toISOString below
		// converts that local midnight into the correct UTC storage boundary.
		start.setHours(0, 0, 0, 0);
	} else {
		const days = range === "week" ? 7 : range === "month" ? 30 : 365;
		start.setDate(start.getDate() - days);
	}
	return {
		since: start.toISOString(),
		until: now.toISOString(),
	};
}

function getInfluenceScore(profile: ProfileRecord | null) {
	if (!profile) {
		return 0;
	}
	return Math.round(Math.log10(profile.followersCount + 10) * 24);
}

type LinkInfluenceRow = Pick<
	LinkInsightRow,
	| "source_kind"
	| "source_author_id"
	| "source_author_followers_count"
	| "dm_sender_id"
	| "dm_sender_followers_count"
>;

function getDetailRowInfluenceScore(row: LinkInfluenceRow) {
	const profileId =
		row.source_kind === "tweet" ? row.source_author_id : row.dm_sender_id;
	if (!profileId) return 0;
	const value =
		row.source_kind === "tweet"
			? row.source_author_followers_count
			: row.dm_sender_followers_count;
	const followersCount = Number(value ?? 0);
	return Math.round(
		Math.log10((Number.isFinite(followersCount) ? followersCount : 0) + 10) *
			24,
	);
}

function chooseMetadata(existing: string | null, candidate: string | null) {
	if (!candidate) {
		return existing;
	}
	if (!existing) {
		return candidate;
	}
	return candidate.length > existing.length ? candidate : existing;
}

function stripUrls(text: string, urls: string[]) {
	let output = text;
	for (const url of urls) {
		if (!url) {
			continue;
		}
		const variants = new Set<string>([url]);
		try {
			const parsed = new URL(url);
			variants.add(parsed.href);
			variants.add(`${parsed.host}${parsed.pathname}${parsed.search}`);
			variants.add(
				`${parsed.hostname.replace(/^www\./, "")}${parsed.pathname}${parsed.search}`,
			);
		} catch {
			// keep raw variant only
		}
		for (const variant of variants) {
			output = output.split(variant).join(" ");
		}
	}
	return output.replaceAll(URL_WHITESPACE, " ").trim();
}

function parseMedia(value: unknown) {
	return parseJsonField<TweetMediaItem[]>(value, []);
}

function buildTweetUrl(
	handle: string | null | undefined,
	tweetId: string | null,
) {
	const cleanHandle = normalizeProfileHandle(handle);
	if (!cleanHandle || !tweetId) {
		return null;
	}
	return `https://x.com/${cleanHandle}/status/${tweetId}`;
}

function sourceLabel(row: LinkInsightRow) {
	if (row.source_kind === "dm") {
		return row.direction ? `DM ${row.direction}` : "DM";
	}
	return "tweet";
}

function buildMention(row: LinkInsightRow, normalized: NormalizedUrl) {
	const sharedBy =
		row.source_kind === "tweet"
			? nullableProfileFromDbRow(row, "source_author_")
			: nullableProfileFromDbRow(row, "dm_sender_");
	const participant =
		row.source_kind === "dm"
			? nullableProfileFromDbRow(row, "participant_")
			: null;
	const contentAuthor = nullableProfileFromDbRow(row, "linked_author_");
	const rawText = String(row.source_text ?? "");
	const text = stripUrls(rawText, [
		row.short_url,
		row.expanded_url,
		row.final_url,
		normalized.url,
		normalized.displayUrl,
		...(rawText.match(RAW_URL_PATTERN) ?? []),
	]);
	const sharedContentText =
		row.linked_text && row.linked_text !== rawText ? row.linked_text : null;
	const timelineTweetId = row.source_kind === "tweet" ? row.source_id : null;
	const contentTweetId = row.expanded_tweet_id;
	const sourceUrl =
		row.source_kind === "tweet"
			? buildTweetUrl(sharedBy?.handle, timelineTweetId)
			: null;
	const contentTweetUrl = buildTweetUrl(
		contentAuthor?.handle ?? row.expanded_handle,
		contentTweetId,
	);
	const media = [
		...parseMedia(row.source_media_json),
		...parseMedia(row.linked_media_json),
	];
	const mention: LinkInsightMention = {
		id: `${row.source_kind}:${row.source_id}:${String(row.source_position)}:${row.short_url}`,
		sourceKind: row.source_kind,
		sourceId: row.source_id,
		sourceUrl,
		sourceLabel: sourceLabel(row),
		shortUrl: row.short_url,
		conversationId: row.conversation_id,
		createdAt: row.created_at,
		rawText,
		text,
		commentText: text,
		sharedContentText,
		hasComment: text.length > 0,
		isPureShare: text.length === 0,
		timelineTweetId,
		contentTweetId,
		contentTweetUrl,
		contentAuthor,
		media,
		direction: row.direction,
		accountHandle: row.account_handle,
		sharedBy,
		participant,
	};
	return mention;
}

function rankRowHasComment(row: LinkInsightRankRow, normalized: NormalizedUrl) {
	const rawText = String(row.source_text ?? "");
	return (
		stripUrls(rawText, [
			row.short_url,
			row.expanded_url,
			row.final_url,
			normalized.url,
			normalized.displayUrl,
			...(rawText.match(RAW_URL_PATTERN) ?? []),
		]).length > 0
	);
}

function toInsight(
	group: InsightGroup,
	commentsLimit: number,
): LinkInsightItem {
	const sortedMentions = [...group.mentions].sort((a, b) => {
		const commentWeight = Number(b.hasComment) - Number(a.hasComment);
		if (commentWeight !== 0) {
			return commentWeight;
		}
		const influence =
			getInfluenceScore(b.sharedBy ?? null) -
			getInfluenceScore(a.sharedBy ?? null);
		if (influence !== 0) {
			return influence;
		}
		return b.createdAt.localeCompare(a.createdAt);
	});
	const mentions = sortedMentions.slice(0, commentsLimit);
	const mentionCount = sortedMentions.length;
	const commentCount = sortedMentions.filter(
		(mention) => mention.hasComment,
	).length;
	const pureShareCount = mentionCount - commentCount;
	const sharers = [...group.sharerProfiles.values()].sort((a, b) => {
		const influence = getInfluenceScore(b) - getInfluenceScore(a);
		if (influence !== 0) {
			return influence;
		}
		return a.handle.localeCompare(b.handle);
	});
	return {
		id: group.canonicalKey,
		kind: group.kind,
		url: group.url,
		canonicalKey: group.canonicalKey,
		displayUrl: group.displayUrl,
		host: group.host,
		title: group.title ?? deriveTitleFromUrl(group.url),
		description: group.description,
		shareCount: group.shareCount,
		uniqueSharers: group.sharers.size,
		totalInfluence: group.totalInfluence,
		mentionCount,
		commentCount,
		pureShareCount,
		hiddenMentionCount: Math.max(0, mentionCount - mentions.length),
		firstSeenAt: group.firstSeenAt,
		lastSeenAt: group.lastSeenAt,
		topSharer: group.topSharer,
		sharers,
		mentions,
	};
}

function compareRank(left: InsightRanking, right: InsightRanking) {
	if (right.shareCount !== left.shareCount) {
		return right.shareCount - left.shareCount;
	}
	if (right.totalInfluence !== left.totalInfluence) {
		return right.totalInfluence - left.totalInfluence;
	}
	return right.lastSeenAt.localeCompare(left.lastSeenAt);
}

function compareInsights(sort: LinkInsightSort) {
	return (left: InsightRanking, right: InsightRanking) => {
		if (sort === "recent") {
			return (
				right.lastSeenAt.localeCompare(left.lastSeenAt) ||
				compareRank(left, right)
			);
		}
		if (sort === "comments") {
			return (
				right.commentCount - left.commentCount ||
				right.shareCount - left.shareCount ||
				right.lastSeenAt.localeCompare(left.lastSeenAt)
			);
		}
		return compareRank(left, right);
	};
}

function selectHydrationCandidates(
	groups: RankedInsightGroup[],
	sort: LinkInsightSort,
	limit: number,
) {
	if (sort === "comments") {
		return [...groups].sort(compareInsights(sort)).slice(0, limit);
	}

	// Share count and recency are the primary rank keys. Only groups tied at or
	// above the limit boundary need their full profile/media rows hydrated.
	const sorted = [...groups].sort((left, right) =>
		sort === "recent"
			? right.lastSeenAt.localeCompare(left.lastSeenAt)
			: right.shareCount - left.shareCount,
	);
	const boundary = sorted[Math.min(limit - 1, sorted.length - 1)];
	if (!boundary) return [];
	return sorted.filter((group) =>
		sort === "recent"
			? group.lastSeenAt >= boundary.lastSeenAt
			: group.shareCount >= boundary.shareCount,
	);
}

const readCaches = new WeakMap<Database, ReadOnlyQueryCache>();

export function getLinkInsights(
	query: LinkInsightQuery = {},
): LinkInsightResponse {
	const db = getNativeDb({ seedDemoData: false });
	if (!isReadOnlyDeployment()) return buildLinkInsights(query, db);
	let cache = readCaches.get(db);
	if (!cache) {
		cache = new ReadOnlyQueryCache();
		readCaches.set(db, cache);
	}
	const bounds = resolveRange(
		query.range ?? "week",
		query.now ?? new Date(),
		query.since,
		query.until,
	);
	// Pin the boundary probes and result to one snapshot on this cache's owner.
	return db.readTransaction(() => {
		const boundary = (value: string | null) =>
			value === null
				? "unbounded"
				: ((
						db
							.prepare(
								"select created_at from link_occurrences where created_at < ? order by created_at desc limit 1",
							)
							.get(value) as { created_at: string } | undefined
					)?.created_at ?? null);
		const { now: _now, since: _since, until: _until, ...filters } = query;
		const key = JSON.stringify([
			filters,
			boundary(bounds.since),
			boundary(bounds.until),
		]);
		const body = cache.read(db, key, () =>
			JSON.stringify(
				buildLinkInsights(
					{
						...query,
						since: bounds.since ?? undefined,
						until: bounds.until ?? undefined,
					},
					db,
				),
			),
		);
		return { ...JSON.parse(body), ...bounds } as LinkInsightResponse;
	})();
}

function buildLinkInsights(
	query: LinkInsightQuery = {},
	db: Database,
): LinkInsightResponse {
	const normalizedUrls = new Map<string, NormalizedUrl | null>();
	const normalize = (url: string) => {
		const cached = normalizedUrls.get(url);
		if (cached !== undefined) return cached;
		const normalized = normalizeUrl(url);
		normalizedUrls.set(url, normalized);
		return normalized;
	};
	const kind = query.kind ?? "links";
	const range = query.range ?? "week";
	const sort = query.sort ?? "rank";
	const source = query.source ?? "all";
	const limit =
		typeof query.limit === "number" && Number.isFinite(query.limit)
			? Math.max(1, Math.trunc(query.limit))
			: DEFAULT_LIMIT;
	const commentsLimit =
		typeof query.commentsLimit === "number" &&
		Number.isFinite(query.commentsLimit)
			? Math.max(1, Math.trunc(query.commentsLimit))
			: DEFAULT_COMMENTS_LIMIT;
	const bounds = resolveRange(
		range,
		query.now ?? new Date(),
		query.since,
		query.until,
	);

	const params: Array<string | number> = [];
	const conditions = ["e.status = 'hit'"];
	if (bounds.since) {
		conditions.push("o.created_at >= ?");
		params.push(bounds.since);
	}
	if (bounds.until) {
		conditions.push("o.created_at < ?");
		params.push(bounds.until);
	}
	if (source === "tweet" || source === "dm") {
		conditions.push("o.source_kind = ?");
		params.push(source);
	}
	if (query.account && query.account !== "all") {
		conditions.push(`(
	    (o.source_kind = 'dm' and o.account_id = ?)
	    or (
	      o.source_kind = 'tweet'
	      and (
	        o.account_id = ?
	        or exists (
	          select 1
	          from tweet_account_edges edge
	          where edge.account_id = ?
	            and edge.tweet_id = o.source_id
	        )
	        or exists (
	          select 1
	          from tweet_collections collection
	          where collection.account_id = ?
	            and collection.tweet_id = o.source_id
	        )
	      )
	    )
	  )`);
		params.push(query.account, query.account, query.account, query.account);
	}
	if (kind === "videos") {
		addVideoUrlPrefilter(conditions);
	}

	const rankSourceText =
		sort === "comments" ? "coalesce(dm.text, source_tweet.text, '')" : "''";
	const rankSourceJoins =
		sort === "comments"
			? `left join dm_messages dm
        on o.source_kind = 'dm' and dm.id = o.source_id
      left join tweets source_tweet
        on o.source_kind = 'tweet' and source_tweet.id = o.source_id`
			: "";
	const rankRows = db
		.prepare(`
      select
        o.rowid as occurrence_rowid,
        o.source_kind,
        o.short_url,
        o.created_at,
        e.expanded_url,
        e.final_url,
        ${rankSourceText} as source_text
      from link_occurrences o
      join url_expansions e on e.short_url = o.short_url
      ${rankSourceJoins}
      where ${conditions.join(" and ")}
      order by o.created_at desc
    `)
		.all(...params) as LinkInsightRankRow[];

	const rankedGroups = new Map<string, RankedInsightGroup>();
	let occurrences = 0;
	for (const row of rankRows) {
		const normalized = normalize(
			row.final_url || row.expanded_url || row.short_url,
		);
		if (!normalized) continue;
		const rowKind: LinkInsightKind = isVideoHost(normalized.host)
			? "videos"
			: "links";
		if (rowKind !== kind) continue;
		occurrences++;

		const existing = rankedGroups.get(normalized.canonicalKey);
		if (existing) {
			existing.rowIds.push(row.occurrence_rowid);
			existing.shareCount++;
			if (sort === "comments" && rankRowHasComment(row, normalized)) {
				existing.commentCount++;
			}
			if (row.created_at > existing.lastSeenAt) {
				existing.lastSeenAt = row.created_at;
			}
			continue;
		}

		rankedGroups.set(normalized.canonicalKey, {
			canonicalKey: normalized.canonicalKey,
			commentCount:
				sort === "comments" && rankRowHasComment(row, normalized) ? 1 : 0,
			lastSeenAt: row.created_at,
			rowIds: [row.occurrence_rowid],
			shareCount: 1,
			totalInfluence: 0,
		});
	}

	const preliminaryGroups = selectHydrationCandidates(
		[...rankedGroups.values()],
		sort,
		limit,
	);
	const candidateRowIds = preliminaryGroups.flatMap((group) => group.rowIds);
	if (candidateRowIds.length === 0) {
		return {
			kind,
			range,
			sort,
			source,
			since: bounds.since,
			until: bounds.until,
			items: [],
			stats: { occurrences, groups: rankedGroups.size },
		};
	}

	let selectedGroups = preliminaryGroups;
	// A separate query only pays off when the tie set substantially exceeds a page.
	const needsRankingPass = preliminaryGroups.length > Math.max(limit * 2, 32);
	if (needsRankingPass) {
		const groupByRowId = new Map(
			preliminaryGroups.flatMap((group) =>
				group.rowIds.map((id) => [id, group] as const),
			),
		);
		const influenceRows = db
			.prepare(`
      select o.rowid as occurrence_rowid, o.source_kind,
        author.id as source_author_id, author.followers_count as source_author_followers_count,
        sender.id as dm_sender_id, sender.followers_count as dm_sender_followers_count
      from link_occurrences o
      left join tweets tweet on o.source_kind = 'tweet' and tweet.id = o.source_id
      left join profiles author on author.id = tweet.author_profile_id
      left join dm_messages dm on o.source_kind = 'dm' and dm.id = o.source_id
      left join profiles sender on sender.id = dm.sender_profile_id
      where o.rowid in (select cast(value as integer) from json_each(?))
    `)
			.all(JSON.stringify(candidateRowIds)) as Array<
			LinkInfluenceRow & { occurrence_rowid: number }
		>;
		for (const row of influenceRows) {
			const group = groupByRowId.get(row.occurrence_rowid);
			if (group) group.totalInfluence += getDetailRowInfluenceScore(row);
		}
		selectedGroups = preliminaryGroups
			.sort(compareInsights(sort))
			.slice(0, limit);
	}

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
        e.expanded_tweet_id,
        e.expanded_handle,
        e.title,
        e.description,
        coalesce(dm.text, source_tweet.text, '') as source_text,
        source_tweet.media_json as source_media_json,
        account.handle as account_handle,
        ${profileSelect("source_author", "source_author_")},
        ${profileSelect("dm_sender", "dm_sender_")},
        ${profileSelect("participant", "participant_")},
        linked.text as linked_text,
        linked.media_json as linked_media_json,
        ${profileSelect("linked_author", "linked_author_")}
      from link_occurrences o
      join url_expansions e on e.short_url = o.short_url
      left join accounts account on account.id = o.account_id
      left join dm_messages dm
        on o.source_kind = 'dm' and dm.id = o.source_id
      left join profiles dm_sender
        on dm_sender.id = dm.sender_profile_id
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
      left join profiles linked_author
        on linked_author.id = linked.author_profile_id
	      where o.rowid in (
	        select cast(value as integer)
	        from json_each(?)
	      )
	      order by o.created_at desc
	    `)
		.all(
			JSON.stringify(selectedGroups.flatMap((group) => group.rowIds)),
		) as LinkInsightRow[];

	for (const row of needsRankingPass ? [] : rows) {
		const normalized = normalize(
			row.final_url || row.expanded_url || row.short_url,
		);
		if (!normalized) continue;
		const rankedGroup = rankedGroups.get(normalized.canonicalKey);
		if (rankedGroup) {
			rankedGroup.totalInfluence += getDetailRowInfluenceScore(row);
		}
	}
	selectedGroups = selectedGroups.sort(compareInsights(sort)).slice(0, limit);
	const selectedKeys = new Set(
		selectedGroups.map((group) => group.canonicalKey),
	);

	const groups = new Map<string, InsightGroup>();
	for (const row of rows) {
		const rawUrl = row.final_url || row.expanded_url || row.short_url;
		const normalized = normalize(rawUrl);
		if (!normalized) {
			continue;
		}
		const rowKind: LinkInsightKind = isVideoHost(normalized.host)
			? "videos"
			: "links";
		if (rowKind !== kind) {
			continue;
		}
		if (!selectedKeys.has(normalized.canonicalKey)) continue;
		const mention = buildMention(row, normalized);
		const sharerKey = mention.sharedBy
			? mention.sharedBy.id
			: `${row.source_kind}:${row.source_id}`;
		const influence = getInfluenceScore(mention.sharedBy ?? null);
		const existing = groups.get(normalized.canonicalKey);
		if (existing) {
			if (!existing.seenMentions.has(mention.id)) {
				existing.seenMentions.add(mention.id);
				existing.mentions.push(mention);
				existing.shareCount++;
				existing.totalInfluence += influence;
				existing.sharers.add(sharerKey);
				if (mention.sharedBy) {
					existing.sharerProfiles.set(mention.sharedBy.id, mention.sharedBy);
				}
				if (
					!existing.topSharer ||
					influence > getInfluenceScore(existing.topSharer)
				) {
					existing.topSharer = mention.sharedBy ?? null;
				}
			}
			existing.title = chooseMetadata(existing.title, row.title);
			existing.description = chooseMetadata(
				existing.description,
				row.description,
			);
			if (row.created_at < existing.firstSeenAt) {
				existing.firstSeenAt = row.created_at;
			}
			if (row.created_at > existing.lastSeenAt) {
				existing.lastSeenAt = row.created_at;
			}
			continue;
		}

		groups.set(normalized.canonicalKey, {
			canonicalKey: normalized.canonicalKey,
			description: row.description,
			displayUrl: normalized.displayUrl,
			firstSeenAt: row.created_at,
			host: normalized.host,
			kind: rowKind,
			lastSeenAt: row.created_at,
			mentions: [mention],
			seenMentions: new Set([mention.id]),
			sharers: new Set([sharerKey]),
			sharerProfiles: mention.sharedBy
				? new Map([[mention.sharedBy.id, mention.sharedBy]])
				: new Map(),
			shareCount: 1,
			title: row.title,
			topSharer: mention.sharedBy ?? null,
			totalInfluence: influence,
			url: normalized.url,
		});
	}

	const itemsByKey = new Map(
		[...groups.entries()].map(([key, group]) => [
			key,
			toInsight(group, commentsLimit),
		]),
	);
	const items = selectedGroups
		.map((group) => itemsByKey.get(group.canonicalKey))
		.filter((item): item is LinkInsightItem => item !== undefined);

	return {
		kind,
		range,
		sort,
		source,
		since: bounds.since,
		until: bounds.until,
		items,
		stats: {
			occurrences,
			groups: rankedGroups.size,
		},
	};
}
