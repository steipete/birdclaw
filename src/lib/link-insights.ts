import { getNativeDb } from "./db";
import type {
	LinkInsightItem,
	LinkInsightKind,
	LinkInsightMention,
	LinkInsightQuery,
	LinkInsightRange,
	LinkInsightResponse,
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

interface LinkInsightRow {
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
	source_author_id: string | null;
	source_author_handle: string | null;
	source_author_display_name: string | null;
	source_author_bio: string | null;
	source_author_followers_count: number | null;
	source_author_following_count: number | null;
	source_author_avatar_hue: number | null;
	source_author_avatar_url: string | null;
	source_author_location: string | null;
	source_author_url: string | null;
	source_author_verified_type: string | null;
	source_author_entities_json: string | null;
	source_author_created_at: string | null;
	dm_sender_id: string | null;
	dm_sender_handle: string | null;
	dm_sender_display_name: string | null;
	dm_sender_bio: string | null;
	dm_sender_followers_count: number | null;
	dm_sender_following_count: number | null;
	dm_sender_avatar_hue: number | null;
	dm_sender_avatar_url: string | null;
	dm_sender_location: string | null;
	dm_sender_url: string | null;
	dm_sender_verified_type: string | null;
	dm_sender_entities_json: string | null;
	dm_sender_created_at: string | null;
	participant_id: string | null;
	participant_handle: string | null;
	participant_display_name: string | null;
	participant_bio: string | null;
	participant_followers_count: number | null;
	participant_following_count: number | null;
	participant_avatar_hue: number | null;
	participant_avatar_url: string | null;
	participant_location: string | null;
	participant_url: string | null;
	participant_verified_type: string | null;
	participant_entities_json: string | null;
	participant_created_at: string | null;
	linked_text: string | null;
	linked_media_json: string | null;
	linked_author_id: string | null;
	linked_author_handle: string | null;
	linked_author_display_name: string | null;
	linked_author_bio: string | null;
	linked_author_followers_count: number | null;
	linked_author_following_count: number | null;
	linked_author_avatar_hue: number | null;
	linked_author_avatar_url: string | null;
	linked_author_location: string | null;
	linked_author_url: string | null;
	linked_author_verified_type: string | null;
	linked_author_entities_json: string | null;
	linked_author_created_at: string | null;
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

function toProfile(
	row: LinkInsightRow,
	prefix: "dm_sender_" | "linked_author_" | "participant_" | "source_author_",
): ProfileRecord | null {
	const id = row[`${prefix}id`];
	if (!id) {
		return null;
	}
	return {
		id: String(id),
		handle: String(row[`${prefix}handle`] ?? ""),
		displayName: String(row[`${prefix}display_name`] ?? ""),
		bio: String(row[`${prefix}bio`] ?? ""),
		followersCount: Number(row[`${prefix}followers_count`] ?? 0),
		followingCount: Number(row[`${prefix}following_count`] ?? 0),
		avatarHue: Number(row[`${prefix}avatar_hue`] ?? 0),
		avatarUrl: getString(row[`${prefix}avatar_url`]),
		location: getString(row[`${prefix}location`]),
		url: getString(row[`${prefix}url`]),
		verifiedType: getString(row[`${prefix}verified_type`]),
		entities: parseJsonField<Record<string, unknown>>(
			row[`${prefix}entities_json`],
			{},
		),
		createdAt: String(row[`${prefix}created_at`] ?? ""),
	};
}

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
	conditions.push(`(${predicates.join(" or ")})`);
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
	const cleanHandle = handle?.replace(/^@/, "").trim();
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
			? toProfile(row, "source_author_")
			: toProfile(row, "dm_sender_");
	const participant =
		row.source_kind === "dm" ? toProfile(row, "participant_") : null;
	const contentAuthor = toProfile(row, "linked_author_");
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

function compareRank(left: LinkInsightItem, right: LinkInsightItem) {
	if (right.shareCount !== left.shareCount) {
		return right.shareCount - left.shareCount;
	}
	if (right.totalInfluence !== left.totalInfluence) {
		return right.totalInfluence - left.totalInfluence;
	}
	return right.lastSeenAt.localeCompare(left.lastSeenAt);
}

function compareInsights(sort: LinkInsightSort) {
	return (left: LinkInsightItem, right: LinkInsightItem) => {
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

export function getLinkInsights(
	query: LinkInsightQuery = {},
): LinkInsightResponse {
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

	const db = getNativeDb({ seedDemoData: false });
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
        dm_sender.id as dm_sender_id,
        dm_sender.handle as dm_sender_handle,
        dm_sender.display_name as dm_sender_display_name,
        dm_sender.bio as dm_sender_bio,
        dm_sender.followers_count as dm_sender_followers_count,
        dm_sender.following_count as dm_sender_following_count,
        dm_sender.avatar_hue as dm_sender_avatar_hue,
        dm_sender.avatar_url as dm_sender_avatar_url,
        dm_sender.location as dm_sender_location,
        dm_sender.url as dm_sender_url,
        dm_sender.verified_type as dm_sender_verified_type,
        dm_sender.entities_json as dm_sender_entities_json,
        dm_sender.created_at as dm_sender_created_at,
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
        linked.text as linked_text,
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
      where ${conditions.join(" and ")}
      order by o.created_at desc
    `)
		.all(...params) as LinkInsightRow[];

	const groups = new Map<string, InsightGroup>();
	let occurrences = 0;
	for (const row of rows) {
		const rawUrl = row.final_url || row.expanded_url || row.short_url;
		const normalized = normalizeUrl(rawUrl);
		if (!normalized) {
			continue;
		}
		const rowKind: LinkInsightKind = isVideoHost(normalized.host)
			? "videos"
			: "links";
		if (rowKind !== kind) {
			continue;
		}
		occurrences++;

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

	const items = [...groups.values()]
		.map((group) => toInsight(group, commentsLimit))
		.sort(compareInsights(sort))
		.slice(0, limit);

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
			groups: groups.size,
		},
	};
}
