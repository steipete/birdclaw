import { createHash } from "node:crypto";
import { Effect } from "effect";
import { z } from "zod";
import {
	createAnalysisRequestBody,
	type HybridAnalysisResult,
	parseHybridAnalysis,
	resolveAnalysisModelSettings,
	streamHybridAnalysisEffect,
} from "./analysis-runtime";
import { prefetchCachedAvatarsForProfileIdsEffect } from "./avatar-cache";
import { runEffectBackground, runEffectPromise } from "./effect-runtime";
import { getNativeDb } from "./db";
import { listDmConversations } from "./dm-read-model";
import {
	type OpenAIStreamState,
	processOpenAIResponseSseChunk,
} from "./openai-response-runtime";
import { parseJsonField } from "./query-read-model-shared";
import { listTimelineItems } from "./timeline-read-model";
import { readSyncCache, writeSyncCache } from "./sync-cache";
import {
	syncTweetSearchEffect,
	type SyncTweetSearchResult,
	type TweetSearchMode,
} from "./tweet-search-live";
import type { ProfileRecord, TweetEntities, TweetMediaItem } from "./types";

export type SearchDiscussionSource =
	| "all"
	| "home"
	| "mentions"
	| "authored"
	| "search"
	| "likes"
	| "bookmarks";

export interface SearchDiscussionOptions {
	query: string;
	account?: string;
	source?: SearchDiscussionSource;
	since?: string;
	until?: string;
	includeDms?: boolean;
	originalsOnly?: boolean;
	hideLowQuality?: boolean;
	question?: string;
	mode?: TweetSearchMode;
	limit?: number;
	maxPages?: number;
	refresh?: boolean;
	model?: string;
	reasoningEffort?: "minimal" | "low" | "medium" | "high";
	serviceTier?: "default" | "flex" | "priority";
	signal?: AbortSignal;
	prefetchAvatars?: boolean;
}

export interface SearchDiscussionStreamHandlers {
	onDelta?: (delta: string) => void;
	onEvent?: (event: SearchDiscussionStreamEvent) => void;
}

interface CompactSearchTweet {
	id: string;
	url: string;
	source: Exclude<SearchDiscussionSource, "all">;
	author: string;
	name: string;
	authorProfile: ProfileRecord;
	createdAt: string;
	text: string;
	entities?: TweetEntities;
	media: TweetMediaItem[];
	likeCount: number;
	liked: boolean;
	bookmarked: boolean;
	needsReply: boolean;
}

interface CompactSearchDm {
	id: string;
	participant: string;
	name: string;
	lastMessageAt: string;
	text: string;
	needsReply: boolean;
	influenceScore: number;
}

export interface SearchDiscussionContext {
	query: string;
	question?: string;
	account?: string;
	source: SearchDiscussionSource;
	since?: string;
	until?: string;
	includeDms: boolean;
	counts: Record<Exclude<SearchDiscussionSource, "all"> | "dms", number>;
	tweets: CompactSearchTweet[];
	dms: CompactSearchDm[];
	liveSearch?: SyncTweetSearchResult;
	hash: string;
}

const SearchDiscussionSchema = z.object({
	title: z.string().min(1),
	summary: z.string().min(1),
	themes: z.array(
		z.object({
			title: z.string().min(1),
			summary: z.string().min(1),
			tweetIds: z.array(z.string()).default([]),
			dmConversationIds: z.array(z.string()).default([]),
			handles: z.array(z.string()).default([]),
		}),
	),
	tensions: z.array(z.string()).default([]),
	followUps: z.array(z.string()).default([]),
	sourceTweetIds: z.array(z.string()).default([]),
	sourceDmConversationIds: z.array(z.string()).default([]),
});

export type SearchDiscussion = z.infer<typeof SearchDiscussionSchema>;

export interface SearchDiscussionRunResult {
	context: SearchDiscussionContext;
	discussion: SearchDiscussion;
	markdown: string;
	model: string;
	reasoningEffort: string;
	serviceTier: string;
	cached: boolean;
	updatedAt: string;
}

export type SearchDiscussionStreamEvent =
	| { type: "start"; context: SearchDiscussionContext; cached: boolean }
	| { type: "delta"; delta: string }
	| { type: "done"; result: SearchDiscussionRunResult }
	| { type: "error"; error: string };

const DEFAULT_LIMIT = 20_000;
const DEFAULT_MAX_PAGES = 200;
const MAX_PROMPT_DATA_CHARS = 1_200_000;
const DELIMITER_PATTERN = /\n---\s*\n/;

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function trySearchSync<T>(try_: () => T): Effect.Effect<T, Error> {
	return Effect.try({
		try: try_,
		catch: toError,
	});
}

function tweetUrl(handle: string, id: string) {
	return `https://x.com/${handle}/status/${id}`;
}

function sourceList(source: SearchDiscussionSource) {
	if (source !== "all") return [source];
	return [
		"search",
		"home",
		"mentions",
		"authored",
		"likes",
		"bookmarks",
	] as const;
}

function compactTweet(
	source: Exclude<SearchDiscussionSource, "all">,
	item: ReturnType<typeof listTimelineItems>[number],
): CompactSearchTweet {
	return {
		id: item.id,
		url: tweetUrl(item.author.handle, item.id),
		source,
		author: item.author.handle,
		name: item.author.displayName,
		authorProfile: item.author,
		createdAt: item.createdAt,
		text: item.text,
		entities: item.entities,
		media: item.media,
		likeCount: item.likeCount,
		liked: item.liked,
		bookmarked: item.bookmarked,
		needsReply: !item.isReplied,
	};
}

function collectTweetsForSource(
	source: Exclude<SearchDiscussionSource, "all">,
	options: SearchDiscussionOptions & { limit: number },
) {
	const timelineResource =
		source === "likes" || source === "bookmarks" ? "home" : source;
	return listTimelineItems({
		resource: timelineResource,
		account: options.account,
		search: options.query,
		since: options.since,
		until: options.until,
		includeReplies: !options.originalsOnly,
		qualityFilter: options.hideLowQuality ? "summary" : "all",
		likedOnly: source === "likes",
		bookmarkedOnly: source === "bookmarks",
		limit: options.limit,
	}).map((item) => compactTweet(source, item));
}

function collectLiveSearchTweets(
	options: SearchDiscussionOptions & {
		limit: number;
		liveSearch?: SyncTweetSearchResult;
	},
) {
	if (options.source !== "search" || options.liveSearch?.ok !== true) {
		return null;
	}
	if (options.liveSearch.tweetIds.length === 0) return [];
	const ids = [...new Set(options.liveSearch.tweetIds)].slice(0, options.limit);
	const positionById = new Map(ids.map((id, index) => [id, index]));
	const placeholders = ids.map(() => "?").join(",");
	const accountId = options.liveSearch.accountId;
	const rows = getNativeDb({ seedDemoData: false })
		.prepare(`
      select
        t.id,
        t.text,
        t.created_at,
        t.is_replied,
        t.like_count,
			t.media_count,
			t.entities_json,
			t.media_json,
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
        end as liked,
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
	  where t.deleted_at is null and t.superseded_at is null
	    and t.id in (${placeholders})
    `)
		.all(accountId, accountId, ...ids) as Array<Record<string, unknown>>;

	return rows
		.sort(
			(left, right) =>
				(positionById.get(String(left.id)) ?? Number.MAX_SAFE_INTEGER) -
				(positionById.get(String(right.id)) ?? Number.MAX_SAFE_INTEGER),
		)
		.filter((row) => liveSearchRowPassesFilters(row, options))
		.map(
			(row): CompactSearchTweet => ({
				id: String(row.id),
				url: tweetUrl(String(row.handle), String(row.id)),
				source: "search",
				author: String(row.handle),
				name: String(row.display_name),
				authorProfile: {
					id: String(row.profile_id),
					handle: String(row.handle),
					displayName: String(row.display_name),
					bio: String(row.bio),
					followersCount: Number(row.followers_count),
					followingCount: Number(row.following_count ?? 0),
					avatarHue: Number(row.avatar_hue),
					avatarUrl:
						typeof row.avatar_url === "string"
							? String(row.avatar_url)
							: undefined,
					createdAt: String(row.profile_created_at),
				},
				createdAt: String(row.created_at),
				text: String(row.text),
				entities: parseJsonField<TweetEntities>(row.entities_json, {}),
				media: parseJsonField<TweetMediaItem[]>(row.media_json, []),
				likeCount: Number(row.like_count),
				liked: Boolean(row.liked),
				bookmarked: Boolean(row.bookmarked),
				needsReply: !row.is_replied,
			}),
		);
}

function liveSearchRowPassesFilters(
	row: Record<string, unknown>,
	options: SearchDiscussionOptions,
) {
	const text = String(row.text);
	const createdAt = String(row.created_at);
	if (options.originalsOnly && text.startsWith("@")) return false;
	if (options.since?.trim() && createdAt < options.since.trim()) return false;
	if (options.until?.trim() && createdAt >= options.until.trim()) return false;
	if (!options.hideLowQuality) return true;

	const trimmed = text.trim();
	const strippedShortUrlText = text.replaceAll("https://t.co/", "").trim();
	const likeCount = Number(row.like_count);
	const mediaCount = Number(row.media_count);
	return !(
		text.startsWith("RT @") ||
		(likeCount < 50 &&
			((strippedShortUrlText.length < 16 && mediaCount === 0) ||
				(text.startsWith("@") && trimmed.length < 60) ||
				(text.includes("https://t.co/") &&
					mediaCount === 0 &&
					strippedShortUrlText.length < 45)))
	);
}

function collectDms(options: SearchDiscussionOptions & { limit: number }) {
	if (!options.includeDms) return [];
	return listDmConversations({
		account: options.account,
		search: options.query,
		since: options.since,
		until: options.until,
		sort: "recent",
		context: 2,
		limit: Math.max(1, Math.ceil(options.limit / 2)),
	}).map((item): CompactSearchDm => {
		const matchText = item.matches
			?.flatMap((match) => [
				...match.before.map((message) => message.text),
				match.message.text,
				...match.after.map((message) => message.text),
			])
			.join("\n");
		return {
			id: item.id,
			participant: item.participant.handle,
			name: item.participant.displayName,
			lastMessageAt: item.lastMessageAt,
			text: matchText || item.lastMessagePreview,
			needsReply: item.needsReply,
			influenceScore: item.influenceScore,
		};
	});
}

function dedupeTweets(tweets: CompactSearchTweet[]) {
	const seen = new Set<string>();
	const items: CompactSearchTweet[] = [];
	for (const tweet of tweets) {
		if (seen.has(tweet.id)) continue;
		seen.add(tweet.id);
		items.push(tweet);
	}
	return items.sort((left, right) =>
		right.createdAt.localeCompare(left.createdAt),
	);
}

function contextHash(context: Omit<SearchDiscussionContext, "hash">) {
	const liveSearch =
		context.liveSearch?.ok === true
			? {
					ok: true,
					accountId: context.liveSearch.accountId,
					query: context.liveSearch.query,
					count: context.liveSearch.count,
					pageCount: context.liveSearch.pageCount,
					tweetIds: context.liveSearch.tweetIds,
				}
			: context.liveSearch;
	return createHash("sha1")
		.update(
			JSON.stringify({
				query: context.query,
				question: context.question,
				account: context.account,
				source: context.source,
				since: context.since,
				until: context.until,
				includeDms: context.includeDms,
				tweets: context.tweets.map((tweet) => [
					tweet.id,
					tweet.source,
					tweet.author,
					tweet.name,
					tweet.authorProfile.bio,
					tweet.authorProfile.followersCount,
					tweet.createdAt,
					tweet.text,
					tweet.likeCount,
					tweet.liked,
					tweet.bookmarked,
					tweet.needsReply,
				]),
				dms: context.dms.map((dm) => [
					dm.id,
					dm.lastMessageAt,
					dm.text,
					dm.needsReply,
					dm.influenceScore,
				]),
				liveSearch,
			}),
		)
		.digest("hex");
}

export function collectSearchDiscussionContext(
	options: SearchDiscussionOptions & { liveSearch?: SyncTweetSearchResult },
): SearchDiscussionContext {
	const query = options.query.trim();
	if (!query) {
		throw new Error("Search query is required");
	}
	const limit = Math.max(1, Math.trunc(options.limit ?? DEFAULT_LIMIT));
	const source = options.source ?? "all";
	const counts = {
		home: 0,
		mentions: 0,
		authored: 0,
		search: 0,
		likes: 0,
		bookmarks: 0,
		dms: 0,
	};
	const liveSearchTweets = collectLiveSearchTweets({
		...options,
		query,
		source,
		limit,
	});
	const tweets =
		liveSearchTweets ??
		sourceList(source).flatMap((item) => {
			const sourceTweets = collectTweetsForSource(item, {
				...options,
				query,
				source,
				limit,
			});
			counts[item] = sourceTweets.length;
			return sourceTweets;
		});
	if (liveSearchTweets) {
		counts.search = liveSearchTweets.length;
	}
	const dms = collectDms({ ...options, query, source, limit });
	counts.dms = dms.length;
	const limitedTweets = dedupeTweets(tweets).slice(0, limit);
	const withoutHash = {
		query,
		...(options.question?.trim() ? { question: options.question.trim() } : {}),
		...(options.account ? { account: options.account } : {}),
		source,
		...(options.since ? { since: options.since } : {}),
		...(options.until ? { until: options.until } : {}),
		includeDms: Boolean(options.includeDms),
		counts,
		tweets: limitedTweets,
		dms,
		...(options.liveSearch ? { liveSearch: options.liveSearch } : {}),
	} satisfies Omit<SearchDiscussionContext, "hash">;
	return {
		...withoutHash,
		hash: contextHash(withoutHash),
	};
}

function prefetchDiscussionAvatars(context: SearchDiscussionContext) {
	const profileIds = context.tweets
		.filter((tweet) => tweet.authorProfile.avatarUrl)
		.map((tweet) => tweet.authorProfile.id);
	if (profileIds.length === 0) {
		return;
	}
	runEffectBackground(
		prefetchCachedAvatarsForProfileIdsEffect(profileIds).pipe(
			Effect.catchAll(() =>
				Effect.succeed({
					requested: 0,
					available: 0,
					missing: 0,
					failed: 0,
				}),
			),
		),
		{
			onSuccess: () => {},
			onFailure: () => {},
		},
	);
}

function modelFromOptions(options: SearchDiscussionOptions) {
	return resolveAnalysisModelSettings(options).model;
}

function reasoningEffortFromOptions(options: SearchDiscussionOptions) {
	return resolveAnalysisModelSettings(options).reasoningEffort;
}

function serviceTierFromOptions(options: SearchDiscussionOptions) {
	return resolveAnalysisModelSettings(options).serviceTier;
}

function cacheKey(
	context: SearchDiscussionContext,
	options: SearchDiscussionOptions,
) {
	return [
		"search-discussion:v1",
		modelFromOptions(options),
		reasoningEffortFromOptions(options),
		serviceTierFromOptions(options),
		context.hash,
	].join(":");
}

function buildPrompt(context: SearchDiscussionContext) {
	const promptTweets = context.tweets.map((tweet) => ({
		id: tweet.id,
		url: tweet.url,
		source: tweet.source,
		author: tweet.author,
		name: tweet.name,
		bio: tweet.authorProfile.bio,
		followersCount: tweet.authorProfile.followersCount,
		createdAt: tweet.createdAt,
		text: tweet.text,
		likeCount: tweet.likeCount,
		liked: tweet.liked,
		bookmarked: tweet.bookmarked,
		needsReply: tweet.needsReply,
	}));
	const fitDataset = () => {
		let tweetCount = promptTweets.length;
		let dmCount = context.dms.length;
		const datasetFor = (tweets: number, dms: number) => ({
			tweets: promptTweets.slice(0, tweets),
			dms: context.dms.slice(0, dms),
		});
		const lengthFor = (tweets: number, dms: number) =>
			JSON.stringify(datasetFor(tweets, dms)).length;
		const fitCount = (max: number, fits: (count: number) => boolean) => {
			let low = 0;
			let high = max;
			let best = 0;
			while (low <= high) {
				const mid = Math.floor((low + high) / 2);
				if (fits(mid)) {
					best = mid;
					low = mid + 1;
				} else {
					high = mid - 1;
				}
			}
			return best;
		};
		if (lengthFor(tweetCount, dmCount) <= MAX_PROMPT_DATA_CHARS) {
			return { dataset: datasetFor(tweetCount, dmCount), tweetCount };
		}
		dmCount = fitCount(
			dmCount,
			(count) => lengthFor(tweetCount, count) <= MAX_PROMPT_DATA_CHARS,
		);
		if (lengthFor(tweetCount, dmCount) > MAX_PROMPT_DATA_CHARS) {
			tweetCount = fitCount(
				tweetCount,
				(count) => lengthFor(count, dmCount) <= MAX_PROMPT_DATA_CHARS,
			);
		}
		return { dataset: datasetFor(tweetCount, dmCount), tweetCount };
	};
	const { dataset, tweetCount } = fitDataset();

	return `Search query: ${context.query}
${context.question ? `Discussion question: ${context.question}\n` : ""}Account: ${context.account ?? "all"}
Source: ${context.source}
Live search: ${context.liveSearch ? JSON.stringify(context.liveSearch) : "not run"}
Since: ${context.since ?? "(none)"}
Until: ${context.until ?? "(none)"}
Counts: ${JSON.stringify(context.counts)}
Prompt tweets: ${String(tweetCount)} of ${String(context.tweets.length)} selected context tweets

Write a high-signal Markdown discussion from this local Twitter/X search result set.

Requirements:
- Start with a concise summary of what the matching posts are really about.
- Then write sections named "Themes", "Discussion", and "Follow-ups".
- Use bullets when grouping multiple points.
- Compare agreement, disagreement, shifts over time, and recurring people or links when visible.
- Cite claims with tweet ids or DM conversation ids at the end of the sentence, e.g. (tweet_123) or (dm_456).
- DMs are private context and only present when explicitly included; do not quote private text at length.
- If there is no data, say that plainly in one short paragraph.
- After the Markdown, output a blank line, then a line containing only three hyphens, then one compact JSON object.
- Put every cited tweet id in sourceTweetIds and every cited DM conversation id in sourceDmConversationIds.
- JSON shape: { "title": string, "summary": string, "themes": [{ "title": string, "summary": string, "tweetIds": string[], "dmConversationIds": string[], "handles": string[] }], "tensions": string[], "followUps": string[], "sourceTweetIds": string[], "sourceDmConversationIds": string[] }

Dataset:
${JSON.stringify(dataset)}`;
}

function fallbackDiscussion(
	context: SearchDiscussionContext,
	markdown: string,
): SearchDiscussion {
	return {
		title: `Search discussion: ${context.query}`,
		summary:
			markdown.replaceAll(/\s+/g, " ").trim().slice(0, 280) ||
			"No model summary was returned.",
		themes: [],
		tensions: [],
		followUps: [],
		sourceTweetIds: context.tweets.slice(0, 20).map((tweet) => tweet.id),
		sourceDmConversationIds: context.dms.slice(0, 20).map((dm) => dm.id),
	};
}

function parseDiscussionFromHybridText(
	context: SearchDiscussionContext,
	rawText: string,
): { discussion: SearchDiscussion; markdown: string } {
	const parsed = parseHybridAnalysis({
		rawText,
		parse: (value) => SearchDiscussionSchema.parse(value),
		fallback: (markdown) => fallbackDiscussion(context, markdown),
		delimiterPattern: DELIMITER_PATTERN,
	});
	return { markdown: parsed.markdown, discussion: parsed.value };
}

function processSseChunk(
	state: OpenAIStreamState,
	chunk: string,
	handlers: SearchDiscussionStreamHandlers,
) {
	processOpenAIResponseSseChunk(state, chunk, {
		delimiterPattern: DELIMITER_PATTERN,
		onDelta: (delta) => {
			handlers.onDelta?.(delta);
			handlers.onEvent?.({ type: "delta", delta });
		},
	});
}

function createOpenAIRequestBody(
	context: SearchDiscussionContext,
	options: SearchDiscussionOptions,
) {
	return createAnalysisRequestBody({
		settings: resolveAnalysisModelSettings(options),
		system:
			"You are a precise local Twitter archive analyst. Stream Markdown first, then emit the requested JSON object after the delimiter. Do not invent events not present in the dataset.",
		prompt: buildPrompt(context),
		stream: true,
	});
}

function completeOpenAIStreamEffect(
	stream: HybridAnalysisResult<SearchDiscussion>,
	context: SearchDiscussionContext,
	options: SearchDiscussionOptions,
	handlers: SearchDiscussionStreamHandlers,
): Effect.Effect<SearchDiscussionRunResult, Error> {
	return Effect.gen(function* () {
		const updatedAt = yield* trySearchSync(() =>
			writeSyncCache(cacheKey(context, options), {
				discussion: stream.value,
				markdown: stream.markdown,
				model: modelFromOptions(options),
				reasoningEffort: reasoningEffortFromOptions(options),
				serviceTier: serviceTierFromOptions(options),
				usage: stream.usage,
				responseId: stream.responseId,
			}),
		);
		const result = {
			context,
			discussion: stream.value,
			markdown: stream.markdown,
			model: modelFromOptions(options),
			reasoningEffort: reasoningEffortFromOptions(options),
			serviceTier: serviceTierFromOptions(options),
			cached: false,
			updatedAt,
		};
		handlers.onEvent?.({ type: "done", result });
		return result;
	});
}

export function streamSearchDiscussionEffect(
	options: SearchDiscussionOptions,
	handlers: SearchDiscussionStreamHandlers = {},
): Effect.Effect<SearchDiscussionRunResult, Error> {
	return Effect.gen(function* () {
		const mode = options.mode ?? "auto";
		const liveSearch =
			mode === "local"
				? undefined
				: yield* syncTweetSearchEffect({
						query: options.query,
						account: options.account,
						mode,
						limit: options.limit ?? DEFAULT_LIMIT,
						maxPages: options.maxPages ?? DEFAULT_MAX_PAGES,
						since: options.since,
						until: options.until,
						refresh: options.refresh,
						timeoutMs: 30_000,
					});
		if (liveSearch && !liveSearch.ok) {
			return yield* Effect.fail(
				new Error(
					`Live tweet search failed via ${liveSearch.source}: ${liveSearch.error}`,
				),
			);
		}
		const context = yield* trySearchSync(() =>
			collectSearchDiscussionContext({
				...options,
				source: options.source ?? "search",
				liveSearch,
			}),
		);
		if (options.prefetchAvatars) {
			prefetchDiscussionAvatars(context);
		}
		const cached = options.refresh
			? null
			: yield* trySearchSync(() =>
					readSyncCache<{
						discussion: SearchDiscussion;
						markdown: string;
						model: string;
						reasoningEffort: string;
						serviceTier: string;
					}>(cacheKey(context, options)),
				);
		if (cached) {
			const result: SearchDiscussionRunResult = yield* trySearchSync(() => ({
				context,
				discussion: SearchDiscussionSchema.parse(cached.value.discussion),
				markdown: cached.value.markdown,
				model: cached.value.model,
				reasoningEffort: cached.value.reasoningEffort,
				serviceTier: cached.value.serviceTier,
				cached: true,
				updatedAt: cached.updatedAt,
			}));
			handlers.onEvent?.({ type: "start", context, cached: true });
			handlers.onDelta?.(result.markdown);
			handlers.onEvent?.({ type: "delta", delta: result.markdown });
			handlers.onEvent?.({ type: "done", result });
			return result;
		}

		handlers.onEvent?.({ type: "start", context, cached: false });
		const stream = yield* streamHybridAnalysisEffect({
			body: createOpenAIRequestBody(context, options),
			signal: options.signal,
			parse: (value) => SearchDiscussionSchema.parse(value),
			fallback: (markdown) => fallbackDiscussion(context, markdown),
			delimiterPattern: DELIMITER_PATTERN,
			onDelta: (delta) => {
				handlers.onDelta?.(delta);
				handlers.onEvent?.({ type: "delta", delta });
			},
		});
		return yield* completeOpenAIStreamEffect(
			stream,
			context,
			options,
			handlers,
		);
	});
}

export function streamSearchDiscussion(
	options: SearchDiscussionOptions,
	handlers: SearchDiscussionStreamHandlers = {},
): Promise<SearchDiscussionRunResult> {
	return runEffectPromise(streamSearchDiscussionEffect(options, handlers));
}

export const __test__ = {
	SearchDiscussionSchema,
	buildPrompt,
	parseDiscussionFromHybridText,
	processSseChunk,
};
