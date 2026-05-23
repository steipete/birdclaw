import { createHash } from "node:crypto";
import { Effect } from "effect";
import { z } from "zod";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import { listDmConversations, listTimelineItems } from "./queries";
import { readSyncCache, writeSyncCache } from "./sync-cache";
import {
	syncTweetSearchEffect,
	type SyncTweetSearchResult,
	type TweetSearchMode,
} from "./tweet-search-live";
import type { ProfileRecord } from "./types";

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

interface OpenAIStreamState {
	eventBuffer: string;
	rawText: string;
	pendingVisible: string;
	jsonMode: boolean;
	responseId?: string;
	usage?: unknown;
	error?: string;
}

const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_REASONING_EFFORT = "medium";
const DEFAULT_SERVICE_TIER = "priority";
const DEFAULT_LIMIT = 500;
const DEFAULT_MAX_PAGES = 5;
const DELIMITER_PATTERN = /\n---\s*\n/;
const VISIBLE_DELIMITER_HOLD = 8;

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function trySearchSync<T>(try_: () => T): Effect.Effect<T, Error> {
	return Effect.try({
		try: try_,
		catch: toError,
	});
}

function trySearchPromise<T>(
	try_: () => PromiseLike<T>,
): Effect.Effect<T, Error> {
	return tryPromise(try_).pipe(Effect.mapError(toError));
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
	const tweets = sourceList(source).flatMap((item) => {
		const sourceTweets = collectTweetsForSource(item, {
			...options,
			query,
			source,
			limit,
		});
		counts[item] = sourceTweets.length;
		return sourceTweets;
	});
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

function modelFromOptions(options: SearchDiscussionOptions) {
	return options.model ?? process.env.BIRDCLAW_AI_MODEL ?? DEFAULT_MODEL;
}

function reasoningEffortFromOptions(options: SearchDiscussionOptions) {
	return (
		options.reasoningEffort ??
		(process.env.BIRDCLAW_OPENAI_REASONING_EFFORT as
			| SearchDiscussionOptions["reasoningEffort"]
			| undefined) ??
		DEFAULT_REASONING_EFFORT
	);
}

function serviceTierFromOptions(options: SearchDiscussionOptions) {
	return (
		options.serviceTier ??
		(process.env.BIRDCLAW_OPENAI_SERVICE_TIER as
			| SearchDiscussionOptions["serviceTier"]
			| undefined) ??
		DEFAULT_SERVICE_TIER
	);
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

	return `Search query: ${context.query}
${context.question ? `Discussion question: ${context.question}\n` : ""}Account: ${context.account ?? "all"}
Source: ${context.source}
Live search: ${context.liveSearch ? JSON.stringify(context.liveSearch) : "not run"}
Since: ${context.since ?? "(none)"}
Until: ${context.until ?? "(none)"}
Counts: ${JSON.stringify(context.counts)}

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
${JSON.stringify({ tweets: promptTweets, dms: context.dms }, null, 2)}`;
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
	const [markdownPart, jsonPart] = rawText.split(DELIMITER_PATTERN);
	const markdown = (markdownPart ?? rawText).trim();
	const candidate = jsonPart?.slice(
		jsonPart.indexOf("{"),
		jsonPart.lastIndexOf("}") + 1,
	);
	if (candidate?.startsWith("{")) {
		try {
			return {
				markdown,
				discussion: SearchDiscussionSchema.parse(JSON.parse(candidate)),
			};
		} catch {
			return { markdown, discussion: fallbackDiscussion(context, markdown) };
		}
	}
	return { markdown, discussion: fallbackDiscussion(context, markdown) };
}

function emitVisibleDelta(
	state: OpenAIStreamState,
	delta: string,
	handlers: SearchDiscussionStreamHandlers,
) {
	state.rawText += delta;
	if (state.jsonMode) return;

	const combined = state.pendingVisible + delta;
	const delimiterIndex = combined.search(DELIMITER_PATTERN);
	if (delimiterIndex >= 0) {
		const visible = combined.slice(0, delimiterIndex);
		if (visible) {
			handlers.onDelta?.(visible);
			handlers.onEvent?.({ type: "delta", delta: visible });
		}
		state.pendingVisible = "";
		state.jsonMode = true;
		return;
	}

	if (combined.length <= VISIBLE_DELIMITER_HOLD) {
		state.pendingVisible = combined;
		return;
	}

	const visible = combined.slice(0, -VISIBLE_DELIMITER_HOLD);
	state.pendingVisible = combined.slice(-VISIBLE_DELIMITER_HOLD);
	if (visible) {
		handlers.onDelta?.(visible);
		handlers.onEvent?.({ type: "delta", delta: visible });
	}
}

function flushPendingVisible(
	state: OpenAIStreamState,
	handlers: SearchDiscussionStreamHandlers,
) {
	if (state.jsonMode || !state.pendingVisible) return;
	const delta = state.pendingVisible;
	state.pendingVisible = "";
	handlers.onDelta?.(delta);
	handlers.onEvent?.({ type: "delta", delta });
}

function handleOpenAIEvent(
	state: OpenAIStreamState,
	event: Record<string, unknown>,
	handlers: SearchDiscussionStreamHandlers,
) {
	const type = typeof event.type === "string" ? event.type : "";
	if (
		type === "response.output_text.delta" &&
		typeof event.delta === "string"
	) {
		emitVisibleDelta(state, event.delta, handlers);
		return;
	}
	if (type === "response.completed") {
		const response = event.response;
		if (response && typeof response === "object") {
			const record = response as Record<string, unknown>;
			state.responseId = typeof record.id === "string" ? record.id : undefined;
			state.usage = record.usage;
		}
		return;
	}
	if (type === "response.error" || type === "error") {
		const error = event.error;
		state.error =
			error && typeof error === "object" && "message" in error
				? String((error as { message?: unknown }).message)
				: "OpenAI stream failed";
		return;
	}
	if (type === "response.failed" || type === "response.incomplete") {
		const response = event.response;
		const record =
			response && typeof response === "object"
				? (response as Record<string, unknown>)
				: {};
		const error = record.error;
		const incomplete = record.incomplete_details;
		state.error =
			error && typeof error === "object" && "message" in error
				? String((error as { message?: unknown }).message)
				: incomplete && typeof incomplete === "object" && "reason" in incomplete
					? `OpenAI response incomplete: ${String((incomplete as { reason?: unknown }).reason)}`
					: "OpenAI stream failed";
	}
}

function processSseChunk(
	state: OpenAIStreamState,
	chunk: string,
	handlers: SearchDiscussionStreamHandlers,
) {
	state.eventBuffer += chunk;
	let boundary = state.eventBuffer.indexOf("\n\n");
	while (boundary >= 0) {
		const block = state.eventBuffer.slice(0, boundary);
		state.eventBuffer = state.eventBuffer.slice(boundary + 2);
		const data = block
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		if (data && data !== "[DONE]") {
			try {
				handleOpenAIEvent(
					state,
					JSON.parse(data) as Record<string, unknown>,
					handlers,
				);
			} catch {
				// Final hybrid parse decides whether malformed output can be used.
			}
		}
		boundary = state.eventBuffer.indexOf("\n\n");
	}
}

function createOpenAIRequestBody(
	context: SearchDiscussionContext,
	options: SearchDiscussionOptions,
) {
	return {
		model: modelFromOptions(options),
		reasoning: { effort: reasoningEffortFromOptions(options) },
		service_tier: serviceTierFromOptions(options),
		store: false,
		stream: true,
		max_output_tokens: 7000,
		input: [
			{
				role: "system",
				content:
					"You are a precise local Twitter archive analyst. Stream Markdown first, then emit the requested JSON object after the delimiter. Do not invent events not present in the dataset.",
			},
			{
				role: "user",
				content: buildPrompt(context),
			},
		],
	};
}

function readOpenAIStreamEffect(
	response: Response,
	context: SearchDiscussionContext,
	options: SearchDiscussionOptions,
	handlers: SearchDiscussionStreamHandlers,
): Effect.Effect<SearchDiscussionRunResult, Error> {
	const reader = response.body?.getReader();
	if (!reader) {
		return Effect.fail(new Error("OpenAI response did not include a stream"));
	}

	const decoder = new TextDecoder();
	const state: OpenAIStreamState = {
		eventBuffer: "",
		rawText: "",
		pendingVisible: "",
		jsonMode: false,
	};

	return Effect.gen(function* () {
		for (;;) {
			const { done, value } = yield* trySearchPromise(() => reader.read());
			if (!done) {
				processSseChunk(
					state,
					decoder.decode(value, { stream: true }),
					handlers,
				);
				continue;
			}

			flushPendingVisible(state, handlers);
			if (state.error) {
				return yield* Effect.fail(new Error(state.error));
			}

			const parsed = yield* trySearchSync(() =>
				parseDiscussionFromHybridText(context, state.rawText),
			);
			const updatedAt = yield* trySearchSync(() =>
				writeSyncCache(cacheKey(context, options), {
					discussion: parsed.discussion,
					markdown: parsed.markdown,
					model: modelFromOptions(options),
					reasoningEffort: reasoningEffortFromOptions(options),
					serviceTier: serviceTierFromOptions(options),
					usage: state.usage,
					responseId: state.responseId,
				}),
			);
			const result = {
				context,
				discussion: parsed.discussion,
				markdown: parsed.markdown,
				model: modelFromOptions(options),
				reasoningEffort: reasoningEffortFromOptions(options),
				serviceTier: serviceTierFromOptions(options),
				cached: false,
				updatedAt,
			};
			handlers.onEvent?.({ type: "done", result });
			return result;
		}
	}).pipe(
		Effect.ensuring(
			Effect.sync(() => {
				reader.releaseLock();
			}),
		),
	);
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

		const apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) {
			return yield* Effect.fail(new Error("OPENAI_API_KEY is not set"));
		}

		handlers.onEvent?.({ type: "start", context, cached: false });
		const response = yield* trySearchPromise(() =>
			fetch("https://api.openai.com/v1/responses", {
				method: "POST",
				signal: options.signal,
				headers: {
					authorization: `Bearer ${apiKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(createOpenAIRequestBody(context, options)),
			}),
		);
		if (!response.ok) {
			const text = yield* trySearchPromise(() => response.text());
			return yield* Effect.fail(
				new Error(
					`OpenAI request failed: ${String(response.status)} ${text.slice(
						0,
						400,
					)}`,
				),
			);
		}
		return yield* readOpenAIStreamEffect(response, context, options, handlers);
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
