import { createHash } from "node:crypto";
import { Effect } from "effect";
import { z } from "zod";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import { getLinkInsights } from "./link-insights";
import { listDmConversations, listTimelineItems } from "./queries";
import { readSyncCache, writeSyncCache } from "./sync-cache";

export type PeriodDigestPreset = "today" | "yesterday" | "24h" | "week";
export type PeriodDigestSourceKind =
	| "home"
	| "mentions"
	| "authored"
	| "likes"
	| "bookmarks"
	| "dms";

export interface PeriodDigestOptions {
	period?: string;
	since?: string;
	until?: string;
	account?: string;
	includeDms?: boolean;
	refresh?: boolean;
	model?: string;
	reasoningEffort?: "minimal" | "low" | "medium" | "high";
	serviceTier?: "default" | "flex" | "priority";
	signal?: AbortSignal;
	maxTweets?: number;
	maxLinks?: number;
}

export interface PeriodDigestWindow {
	label: string;
	since: string;
	until: string;
}

export interface PeriodDigestRunResult {
	context: PeriodDigestContext;
	digest: PeriodDigest;
	markdown: string;
	model: string;
	reasoningEffort: string;
	serviceTier: string;
	cached: boolean;
	updatedAt: string;
}

export interface PeriodDigestStreamHandlers {
	onDelta?: (delta: string) => void;
	onEvent?: (event: PeriodDigestStreamEvent) => void;
}

export type PeriodDigestStreamEvent =
	| { type: "start"; context: PeriodDigestContext; cached: boolean }
	| { type: "delta"; delta: string }
	| { type: "done"; result: PeriodDigestRunResult }
	| { type: "error"; error: string };

const PeriodDigestSchema = z.object({
	title: z.string().min(1),
	summary: z.string().min(1),
	keyTopics: z.array(
		z.object({
			title: z.string().min(1),
			summary: z.string().min(1),
			tweetIds: z.array(z.string()).default([]),
			handles: z.array(z.string()).default([]),
		}),
	),
	notableLinks: z.array(
		z.object({
			title: z.string().min(1),
			url: z.string().min(1),
			why: z.string().min(1),
			sourceTweetIds: z.array(z.string()).default([]),
		}),
	),
	people: z.array(
		z.object({
			handle: z.string().min(1),
			name: z.string().optional(),
			why: z.string().min(1),
		}),
	),
	actionItems: z.array(
		z.object({
			kind: z.enum(["reply", "follow_up", "read", "sync"]),
			label: z.string().min(1),
			tweetId: z.string().optional(),
			dmConversationId: z.string().optional(),
		}),
	),
	sourceTweetIds: z.array(z.string()).default([]),
});

export type PeriodDigest = z.infer<typeof PeriodDigestSchema>;

interface CompactTweet {
	id: string;
	url: string;
	source: PeriodDigestSourceKind;
	author: string;
	name: string;
	createdAt: string;
	text: string;
	likeCount: number;
	liked: boolean;
	bookmarked: boolean;
	needsReply: boolean;
}

interface CompactDm {
	id: string;
	participant: string;
	name: string;
	lastMessageAt: string;
	text: string;
	needsReply: boolean;
	influenceScore: number;
}

interface CompactLink {
	title: string;
	url: string;
	displayUrl: string;
	description?: string | null;
	shareCount: number;
	commentCount: number;
	lastSeenAt: string;
	mentions: Array<{
		id: string;
		sourceKind: string;
		sourceId: string;
		createdAt: string;
		author?: string;
		text: string;
		tweetId?: string | null;
	}>;
}

export interface PeriodDigestContext {
	window: PeriodDigestWindow;
	account?: string;
	includeDms: boolean;
	counts: Record<PeriodDigestSourceKind | "links", number>;
	tweets: CompactTweet[];
	dms: CompactDm[];
	links: CompactLink[];
	hash: string;
}

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
const DEFAULT_MAX_TWEETS = 120;
const DEFAULT_MAX_LINKS = 12;
const DELIMITER_PATTERN = /\n---\s*\n/;
const VISIBLE_DELIMITER_HOLD = 8;

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function tryDigestSync<T>(try_: () => T): Effect.Effect<T, Error> {
	return Effect.try({
		try: try_,
		catch: toError,
	});
}

function tryDigestPromise<T>(
	try_: () => PromiseLike<T>,
): Effect.Effect<T, Error> {
	return tryPromise(try_).pipe(Effect.mapError(toError));
}

function localDateStart(date: Date) {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number) {
	const next = new Date(date);
	next.setDate(next.getDate() + days);
	return next;
}

function parseDate(value: string | undefined) {
	if (!value?.trim()) return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizePeriod(value: string | undefined): PeriodDigestPreset {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "yesterday") return "yesterday";
	if (normalized === "24h" || normalized === "day") return "24h";
	if (normalized === "week" || normalized === "7d") return "week";
	return "today";
}

export function resolvePeriodDigestWindow(
	options: Pick<PeriodDigestOptions, "period" | "since" | "until"> & {
		now?: Date;
	} = {},
): PeriodDigestWindow {
	const now = options.now ?? new Date();
	const explicitSince = parseDate(options.since);
	const explicitUntil = parseDate(options.until);
	if (explicitSince || explicitUntil) {
		const since = explicitSince ?? addDays(explicitUntil ?? now, -1);
		const until = explicitUntil ?? now;
		return {
			label: `${since.toLocaleString()} - ${until.toLocaleString()}`,
			since: since.toISOString(),
			until: until.toISOString(),
		};
	}

	const period = normalizePeriod(options.period);
	if (period === "24h") {
		const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
		return {
			label: "Last 24 hours",
			since: since.toISOString(),
			until: now.toISOString(),
		};
	}
	if (period === "week") {
		const since = addDays(now, -7);
		return {
			label: "Last 7 days",
			since: since.toISOString(),
			until: now.toISOString(),
		};
	}
	if (period === "yesterday") {
		const today = localDateStart(now);
		const yesterday = addDays(today, -1);
		return {
			label: "Yesterday",
			since: yesterday.toISOString(),
			until: today.toISOString(),
		};
	}

	const start = localDateStart(now);
	return {
		label: "Today",
		since: start.toISOString(),
		until: now.toISOString(),
	};
}

function tweetUrl(handle: string, id: string) {
	return `https://x.com/${handle}/status/${id}`;
}

function compactTweet(
	source: PeriodDigestSourceKind,
	item: ReturnType<typeof listTimelineItems>[number],
): CompactTweet {
	return {
		id: item.id,
		url: tweetUrl(item.author.handle, item.id),
		source,
		author: item.author.handle,
		name: item.author.displayName,
		createdAt: item.createdAt,
		text: item.text,
		likeCount: item.likeCount,
		liked: item.liked,
		bookmarked: item.bookmarked,
		needsReply: !item.isReplied,
	};
}

function dedupeTweets(tweets: CompactTweet[]) {
	const seen = new Set<string>();
	const items: CompactTweet[] = [];
	for (const tweet of tweets) {
		if (seen.has(tweet.id)) continue;
		seen.add(tweet.id);
		items.push(tweet);
	}
	return items.sort((left, right) =>
		right.createdAt.localeCompare(left.createdAt),
	);
}

function collectTweetsForSource(
	source: Exclude<PeriodDigestSourceKind, "dms">,
	options: {
		account?: string;
		window: PeriodDigestWindow;
		limit: number;
	},
) {
	if (source === "likes" || source === "bookmarks") {
		return listTimelineItems({
			resource: "home",
			account: options.account,
			since: options.window.since,
			until: options.window.until,
			likedOnly: source === "likes",
			bookmarkedOnly: source === "bookmarks",
			limit: Math.ceil(options.limit / 3),
		}).map((item) => compactTweet(source, item));
	}
	return listTimelineItems({
		resource: source,
		account: options.account,
		since: options.window.since,
		until: options.window.until,
		limit: source === "home" ? options.limit : Math.ceil(options.limit / 2),
	}).map((item) => compactTweet(source, item));
}

function collectDms(options: {
	account?: string;
	includeDms: boolean;
	window: PeriodDigestWindow;
	limit: number;
}) {
	if (!options.includeDms) return [];
	return listDmConversations({
		account: options.account,
		since: options.window.since,
		until: options.window.until,
		sort: "recent",
		limit: options.limit,
	}).map(
		(item): CompactDm => ({
			id: item.id,
			participant: item.participant.handle,
			name: item.participant.displayName,
			lastMessageAt: item.lastMessageAt,
			text: item.lastMessagePreview,
			needsReply: item.needsReply,
			influenceScore: item.influenceScore,
		}),
	);
}

function compactLinks(options: {
	account?: string;
	window: PeriodDigestWindow;
	limit: number;
}) {
	return getLinkInsights({
		account: options.account,
		range: "today",
		sort: "rank",
		source: "tweet",
		since: options.window.since,
		until: options.window.until,
		limit: options.limit,
		commentsLimit: 5,
	}).items.map(
		(item): CompactLink => ({
			title: item.title ?? item.displayUrl,
			url: item.url,
			displayUrl: item.displayUrl,
			description: item.description,
			shareCount: item.shareCount,
			commentCount: item.commentCount,
			lastSeenAt: item.lastSeenAt,
			mentions: item.mentions.slice(0, 5).map((mention) => ({
				id: mention.id,
				sourceKind: mention.sourceKind,
				sourceId: mention.sourceId,
				createdAt: mention.createdAt,
				author: mention.sharedBy?.handle,
				text:
					mention.commentText || mention.sharedContentText || mention.rawText,
				tweetId: mention.timelineTweetId ?? mention.contentTweetId,
			})),
		}),
	);
}

function contextHash(context: Omit<PeriodDigestContext, "hash">) {
	return createHash("sha1")
		.update(
			JSON.stringify({
				window: {
					label: context.window.label,
					bucket: context.window.until.slice(0, 10),
				},
				account: context.account,
				includeDms: context.includeDms,
				tweets: context.tweets.map((tweet) => [
					tweet.id,
					tweet.source,
					tweet.createdAt,
					tweet.text,
					tweet.liked,
					tweet.bookmarked,
					tweet.needsReply,
				]),
				dms: context.dms.map((dm) => [
					dm.id,
					dm.lastMessageAt,
					dm.text,
					dm.needsReply,
				]),
				links: context.links.map((link) => [
					link.url,
					link.shareCount,
					link.commentCount,
					link.lastSeenAt,
				]),
			}),
		)
		.digest("hex");
}

export function collectPeriodDigestContext(
	options: PeriodDigestOptions = {},
): PeriodDigestContext {
	const window = resolvePeriodDigestWindow(options);
	const maxTweets = Math.max(
		20,
		Math.trunc(options.maxTweets ?? DEFAULT_MAX_TWEETS),
	);
	const maxLinks = Math.max(
		3,
		Math.trunc(options.maxLinks ?? DEFAULT_MAX_LINKS),
	);
	const home = collectTweetsForSource("home", {
		account: options.account,
		window,
		limit: maxTweets,
	});
	const mentions = collectTweetsForSource("mentions", {
		account: options.account,
		window,
		limit: maxTweets,
	});
	const authored = collectTweetsForSource("authored", {
		account: options.account,
		window,
		limit: maxTweets,
	});
	const likes = collectTweetsForSource("likes", {
		account: options.account,
		window,
		limit: maxTweets,
	});
	const bookmarks = collectTweetsForSource("bookmarks", {
		account: options.account,
		window,
		limit: maxTweets,
	});
	const dms = collectDms({
		account: options.account,
		includeDms: Boolean(options.includeDms),
		window,
		limit: Math.ceil(maxTweets / 3),
	});
	const links = compactLinks({
		account: options.account,
		window,
		limit: maxLinks,
	});
	const tweets = dedupeTweets([
		...home,
		...mentions,
		...authored,
		...likes,
		...bookmarks,
	]).slice(0, maxTweets);
	const withoutHash = {
		window,
		...(options.account ? { account: options.account } : {}),
		includeDms: Boolean(options.includeDms),
		counts: {
			home: home.length,
			mentions: mentions.length,
			authored: authored.length,
			likes: likes.length,
			bookmarks: bookmarks.length,
			dms: dms.length,
			links: links.length,
		},
		tweets,
		dms,
		links,
	} satisfies Omit<PeriodDigestContext, "hash">;
	return {
		...withoutHash,
		hash: contextHash(withoutHash),
	};
}

function modelFromOptions(options: PeriodDigestOptions) {
	return options.model ?? process.env.BIRDCLAW_AI_MODEL ?? DEFAULT_MODEL;
}

function reasoningEffortFromOptions(options: PeriodDigestOptions) {
	return (
		options.reasoningEffort ??
		(process.env.BIRDCLAW_OPENAI_REASONING_EFFORT as
			| PeriodDigestOptions["reasoningEffort"]
			| undefined) ??
		DEFAULT_REASONING_EFFORT
	);
}

function serviceTierFromOptions(options: PeriodDigestOptions) {
	return (
		options.serviceTier ??
		(process.env.BIRDCLAW_OPENAI_SERVICE_TIER as
			| PeriodDigestOptions["serviceTier"]
			| undefined) ??
		DEFAULT_SERVICE_TIER
	);
}

function digestCacheKey(
	context: PeriodDigestContext,
	options: PeriodDigestOptions,
) {
	return [
		"period-digest:v1",
		modelFromOptions(options),
		reasoningEffortFromOptions(options),
		serviceTierFromOptions(options),
		context.hash,
	].join(":");
}

function buildPrompt(context: PeriodDigestContext) {
	return `Window: ${context.window.label}
Since: ${context.window.since}
Until: ${context.window.until}
Sources: ${JSON.stringify(context.counts)}

Write a concise, high-signal "what happened" report from this local Twitter/X dataset.

Requirements:
- Stream readable Markdown first.
- Be specific about what happened, not generic about "engagement".
- Cite tweets inline with their id in parentheses, e.g. (tweet_123), and use authors/links when useful.
- Separate signal from noise.
- Include action items only when there is something Peter should reply to, read, or follow up.
- DMs are private context and only present when explicitly included.
- After the Markdown, output a blank line, then a line containing only three hyphens, then one compact JSON object.
- JSON shape: { "title": string, "summary": string, "keyTopics": [{ "title": string, "summary": string, "tweetIds": string[], "handles": string[] }], "notableLinks": [{ "title": string, "url": string, "why": string, "sourceTweetIds": string[] }], "people": [{ "handle": string, "name"?: string, "why": string }], "actionItems": [{ "kind": "reply"|"follow_up"|"read"|"sync", "label": string, "tweetId"?: string, "dmConversationId"?: string }], "sourceTweetIds": string[] }

Dataset:
${JSON.stringify(
	{
		tweets: context.tweets,
		dms: context.dms,
		links: context.links,
	},
	null,
	2,
)}`;
}

function fallbackDigest(
	context: PeriodDigestContext,
	markdown: string,
): PeriodDigest {
	const title = `${context.window.label} digest`;
	return {
		title,
		summary:
			markdown.replaceAll(/\s+/g, " ").trim().slice(0, 280) ||
			"No model summary was returned.",
		keyTopics: [],
		notableLinks: [],
		people: [],
		actionItems: [],
		sourceTweetIds: context.tweets.slice(0, 20).map((tweet) => tweet.id),
	};
}

function parseDigestFromHybridText(
	context: PeriodDigestContext,
	rawText: string,
): { digest: PeriodDigest; markdown: string } {
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
				digest: PeriodDigestSchema.parse(JSON.parse(candidate)),
			};
		} catch {
			return { markdown, digest: fallbackDigest(context, markdown) };
		}
	}
	return { markdown, digest: fallbackDigest(context, markdown) };
}

function emitVisibleDelta(
	state: OpenAIStreamState,
	delta: string,
	handlers: PeriodDigestStreamHandlers,
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
	handlers: PeriodDigestStreamHandlers,
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
	handlers: PeriodDigestStreamHandlers,
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
	handlers: PeriodDigestStreamHandlers,
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
				// Ignore malformed event frames; the final JSON parse will decide result quality.
			}
		}
		boundary = state.eventBuffer.indexOf("\n\n");
	}
}

function createOpenAIRequestBody(
	context: PeriodDigestContext,
	options: PeriodDigestOptions,
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
	context: PeriodDigestContext,
	options: PeriodDigestOptions,
	handlers: PeriodDigestStreamHandlers,
): Effect.Effect<PeriodDigestRunResult, Error> {
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
			const { done, value } = yield* tryDigestPromise(() => reader.read());
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

			const parsed = yield* tryDigestSync(() =>
				parseDigestFromHybridText(context, state.rawText),
			);
			const cacheKey = digestCacheKey(context, options);
			const updatedAt = yield* tryDigestSync(() =>
				writeSyncCache(cacheKey, {
					digest: parsed.digest,
					markdown: parsed.markdown,
					model: modelFromOptions(options),
					reasoningEffort: reasoningEffortFromOptions(options),
					serviceTier: serviceTierFromOptions(options),
					usage: state.usage,
					responseId: state.responseId,
				}),
			);
			const result: PeriodDigestRunResult = {
				context,
				digest: parsed.digest,
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

export function streamPeriodDigestEffect(
	options: PeriodDigestOptions = {},
	handlers: PeriodDigestStreamHandlers = {},
): Effect.Effect<PeriodDigestRunResult, Error> {
	return Effect.gen(function* () {
		const context = yield* tryDigestSync(() =>
			collectPeriodDigestContext(options),
		);
		const cacheKey = digestCacheKey(context, options);
		const cached = options.refresh
			? null
			: yield* tryDigestSync(() =>
					readSyncCache<{
						digest: PeriodDigest;
						markdown: string;
						model: string;
						reasoningEffort: string;
						serviceTier: string;
					}>(cacheKey),
				);

		if (cached) {
			const result: PeriodDigestRunResult = yield* tryDigestSync(() => ({
				context,
				digest: PeriodDigestSchema.parse(cached.value.digest),
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
		const response = yield* tryDigestPromise(() =>
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
			const text = yield* tryDigestPromise(() => response.text());
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

export function streamPeriodDigest(
	options: PeriodDigestOptions = {},
	handlers: PeriodDigestStreamHandlers = {},
): Promise<PeriodDigestRunResult> {
	return runEffectPromise(streamPeriodDigestEffect(options, handlers));
}

export const __test__ = {
	PeriodDigestSchema,
	buildPrompt,
	readOpenAIStreamEffect,
	parseDigestFromHybridText,
	processSseChunk,
	resolvePeriodDigestWindow,
};
