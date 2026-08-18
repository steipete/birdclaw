import { createHash } from "node:crypto";
import { Effect } from "effect";
import { z } from "zod";
import {
	createAnalysisRequestBody,
	type HybridAnalysisResult,
	parseHybridAnalysis,
	readHybridAnalysisStreamEffect,
	resolveAnalysisModelSettings,
	streamHybridAnalysisEffect,
} from "./analysis-runtime";
import { maybeAutoSyncBackupEffect } from "./backup";
import { runEffectPromise } from "./effect-runtime";
import { getLinkInsights } from "./link-insights";
import { syncMentionThreadsEffect } from "./mention-threads-live";
import { syncMentionsEffect } from "./mentions-live";
import { listDmConversations } from "./dm-read-model";
import { getTweetsByIds, listTimelineItems } from "./timeline-read-model";
import {
	type OpenAIStreamState,
	processOpenAIResponseSseChunk,
} from "./openai-response-runtime";
import { readSyncCache, writeSyncCache } from "./sync-cache";
import { syncHomeTimelineEffect, type HomeTimelineMode } from "./timeline-live";
import type {
	EmbeddedTweet,
	ProfileRecord,
	TweetEntities,
	TweetMediaItem,
} from "./types";

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
	language?: string;
	reasoningEffort?: "minimal" | "low" | "medium" | "high";
	serviceTier?: "default" | "flex" | "priority";
	signal?: AbortSignal;
	maxTweets?: number;
	maxLinks?: number;
	liveSync?: boolean;
	liveSyncMode?: HomeTimelineMode;
	liveTimelineLimit?: number;
	liveTimelineMaxPages?: number;
	liveMentionsLimit?: number;
	liveMentionsMaxPages?: number;
	liveThreadLimit?: number;
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
	| { type: "status"; label: string; detail?: string }
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

const MAX_DIGEST_LANGUAGE_LENGTH = 64;

export function normalizeDigestLanguage(
	value: string | undefined,
): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	if (
		trimmed.length > MAX_DIGEST_LANGUAGE_LENGTH ||
		!/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(trimmed)
	) {
		throw new Error(
			"Digest language must be a valid Unicode locale identifier such as en, zh-CN, or pt-BR",
		);
	}
	try {
		const [canonical] = Intl.getCanonicalLocales(trimmed);
		if (!canonical) throw new Error("missing canonical locale");
		return canonical;
	} catch {
		throw new Error(
			"Digest language must be a valid Unicode locale identifier such as en, zh-CN, or pt-BR",
		);
	}
}

export type PeriodDigest = z.infer<typeof PeriodDigestSchema>;

interface CompactTweet {
	id: string;
	url: string;
	source: PeriodDigestSourceKind;
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
	replyToId?: string | null;
	replyToTweet?: {
		id: string;
		url: string;
		author: string;
		name: string;
		createdAt: string;
		text: string;
	} | null;
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

const DEFAULT_MAX_TWEETS = 2_500;
const DEFAULT_MAX_LINKS = 12;
const DEFAULT_LIVE_TIMELINE_MAX_PAGES = undefined;
const DEFAULT_LIVE_MENTIONS_LIMIT = 100;
const DEFAULT_LIVE_MENTIONS_MAX_PAGES = undefined;
const DEFAULT_LIVE_THREAD_LIMIT = 12;
const DEFAULT_LIVE_THREAD_TIMEOUT_MS = 5_000;
const DEFAULT_DIGEST_FRESHNESS_MS = 5 * 60_000;
const MAX_PROMPT_DATA_CHARS = 1_200_000;
const DELIMITER_PATTERN = /\n---\s*\n/;

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function tryDigestSync<T>(try_: () => T): Effect.Effect<T, Error> {
	return Effect.try({
		try: try_,
		catch: toError,
	});
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

function floorIsoToHour(value: string) {
	const date = new Date(value);
	date.setUTCMinutes(0, 0, 0);
	return date.toISOString();
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
	const replyToTweet = item.replyToTweet
		? {
				id: item.replyToTweet.id,
				url: tweetUrl(item.replyToTweet.author.handle, item.replyToTweet.id),
				author: item.replyToTweet.author.handle,
				name: item.replyToTweet.author.displayName,
				createdAt: item.replyToTweet.createdAt,
				text: item.replyToTweet.text,
			}
		: null;
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
		replyToId: item.replyToId ?? null,
		replyToTweet,
	};
}

function compactEmbeddedTweet(item: EmbeddedTweet): CompactTweet {
	return {
		id: item.id,
		url: tweetUrl(item.author.handle, item.id),
		source: "home",
		author: item.author.handle,
		name: item.author.displayName,
		authorProfile: item.author,
		createdAt: item.createdAt,
		text: item.text,
		entities: item.entities,
		media: item.media,
		likeCount: item.likeCount ?? 0,
		liked: Boolean(item.liked),
		bookmarked: Boolean(item.bookmarked),
		needsReply: !item.isReplied,
		replyToId: item.replyToId ?? null,
		replyToTweet: null,
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
					tweet.url,
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
					tweet.replyToId,
					tweet.replyToTweet?.id,
					tweet.replyToTweet?.text,
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

function languageFromOptions(options: PeriodDigestOptions) {
	return normalizeDigestLanguage(
		options.language ?? process.env.BIRDCLAW_DIGEST_LANGUAGE,
	);
}

function modelFromOptions(options: PeriodDigestOptions) {
	return resolveAnalysisModelSettings(options).model;
}

function reasoningEffortFromOptions(options: PeriodDigestOptions) {
	return resolveAnalysisModelSettings(options).reasoningEffort;
}

function serviceTierFromOptions(options: PeriodDigestOptions) {
	return resolveAnalysisModelSettings(options).serviceTier;
}

function boundedPositiveInteger(
	value: number | undefined,
	fallback: number,
	max: number,
) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
		return fallback;
	}
	return Math.min(max, Math.floor(value));
}

function emitDigestStatus(
	handlers: PeriodDigestStreamHandlers,
	label: string,
	detail?: string,
) {
	handlers.onEvent?.({
		type: "status",
		label,
		...(detail ? { detail } : {}),
	});
}

function formatFetchedStatus({
	fetched,
	total,
	noun,
}: {
	fetched: number;
	total: number;
	noun: string;
}) {
	const count = `${String(Math.min(fetched, total))}/${String(total)}`;
	return `Fetched ${count} ${noun}`;
}

function formatPageDetail({
	source,
	page,
	maxPages,
	done,
}: {
	source: string;
	page?: number;
	maxPages?: number;
	done: boolean;
}) {
	const pageText =
		page === undefined
			? undefined
			: `page ${String(page)}${maxPages === undefined ? "" : `/${String(maxPages)}`}`;
	return [source, pageText, done ? "done" : undefined]
		.filter(Boolean)
		.join(" · ");
}

function refreshPeriodDigestInputsEffect(
	options: PeriodDigestOptions,
	phase: {
		timeline?: boolean;
		mentions?: boolean;
		threads?: boolean;
		threadTweetIds?: string[];
	} = {},
	handlers: PeriodDigestStreamHandlers = {},
): Effect.Effect<void, unknown> {
	if (!options.liveSync) {
		return Effect.void;
	}
	const includeTimeline = phase.timeline ?? true;
	const includeMentions = phase.mentions ?? true;
	const includeThreads = phase.threads ?? true;
	const window = resolvePeriodDigestWindow(options);
	const liveStartTime = floorIsoToHour(window.since);
	const mode = options.liveSyncMode ?? "xurl";
	const contextTweetBudget = Math.max(
		20,
		Math.trunc(options.maxTweets ?? DEFAULT_MAX_TWEETS),
	);
	const timelineLimit =
		options.liveTimelineLimit === undefined
			? undefined
			: boundedPositiveInteger(options.liveTimelineLimit, 300, 100_000);
	const mentionsLimit = boundedPositiveInteger(
		options.liveMentionsLimit,
		DEFAULT_LIVE_MENTIONS_LIMIT,
		100,
	);
	const threadLimit = boundedPositiveInteger(
		options.liveThreadLimit,
		DEFAULT_LIVE_THREAD_LIMIT,
		100,
	);
	const timelineMaxPages =
		options.liveTimelineMaxPages === undefined
			? DEFAULT_LIVE_TIMELINE_MAX_PAGES
			: boundedPositiveInteger(options.liveTimelineMaxPages, 3, 1_000);
	const mentionsMaxPages =
		options.liveMentionsMaxPages === undefined
			? DEFAULT_LIVE_MENTIONS_MAX_PAGES
			: boundedPositiveInteger(options.liveMentionsMaxPages, 3, 1_000);

	return Effect.gen(function* () {
		if (includeTimeline) {
			yield* Effect.sync(() =>
				emitDigestStatus(
					handlers,
					"Fetching home timeline from X",
					"Walking the selected time window with xurl.",
				),
			);
			const result = yield* syncHomeTimelineEffect({
				account: options.account,
				mode,
				limit: timelineLimit,
				maxPages: timelineMaxPages,
				startTime: liveStartTime,
				following: true,
				refresh: Boolean(options.refresh),
				cacheTtlMs: 2 * 60_000,
				timeoutMs: 30_000,
				onProgress: (progress) =>
					emitDigestStatus(
						handlers,
						formatFetchedStatus({
							fetched: progress.fetched,
							total: progress.total ?? contextTweetBudget,
							noun: "home tweets",
						}),
						formatPageDetail({
							source: progress.source,
							page: progress.page,
							maxPages: progress.maxPages,
							done: progress.done,
						}),
					),
			}).pipe(
				Effect.match({
					onFailure: () => null,
					onSuccess: (value) => value,
				}),
			);
			yield* Effect.sync(() =>
				emitDigestStatus(
					handlers,
					result
						? `Fetched ${String(result.count)} home tweets from ${result.source}`
						: "Home timeline fetch failed; using local data",
				),
			);
		}
		if (includeMentions) {
			yield* Effect.sync(() =>
				emitDigestStatus(
					handlers,
					"Fetching mentions from X",
					"Reading replies and mentions for the selected window.",
				),
			);
			const result = yield* syncMentionsEffect({
				account: options.account,
				mode: "xurl",
				limit: mentionsLimit,
				maxPages: mentionsMaxPages,
				startTime: liveStartTime,
				refresh: Boolean(options.refresh),
				cacheTtlMs: 2 * 60_000,
				onProgress: (progress) =>
					emitDigestStatus(
						handlers,
						formatFetchedStatus({
							fetched: progress.fetched,
							total: progress.total ?? contextTweetBudget,
							noun: "mentions",
						}),
						formatPageDetail({
							source: progress.source,
							page: progress.page,
							maxPages: progress.maxPages,
							done: progress.done,
						}),
					),
			}).pipe(
				Effect.match({
					onFailure: () => null,
					onSuccess: (value) => value,
				}),
			);
			yield* Effect.sync(() =>
				emitDigestStatus(
					handlers,
					result
						? `Fetched ${String(result.count)} mentions from ${result.source}`
						: "Mention fetch failed; using local data",
				),
			);
		}
		if (includeThreads) {
			yield* Effect.sync(() =>
				emitDigestStatus(
					handlers,
					"Fetching mention conversations",
					"Pulling parent tweets so the AI sees what replies refer to.",
				),
			);
			const result = yield* syncMentionThreadsEffect({
				account: options.account,
				mode: "xurl",
				limit: threadLimit,
				tweetIds: phase.threadTweetIds,
				delayMs: 100,
				timeoutMs: DEFAULT_LIVE_THREAD_TIMEOUT_MS,
				maxPages: 2,
				onProgress: (progress) =>
					emitDigestStatus(
						handlers,
						`Fetched conversations for ${String(progress.processed)}/${String(progress.total)} mentions`,
						`${String(progress.fetched)} tweets · ${progress.source}${
							progress.done ? " · done" : ""
						}`,
					),
			}).pipe(
				Effect.match({
					onFailure: () => null,
					onSuccess: (value) => value,
				}),
			);
			yield* Effect.sync(() =>
				emitDigestStatus(
					handlers,
					result
						? `Fetched ${String(result.uniqueTweets)} conversation tweets`
						: "Conversation fetch failed; using available context",
				),
			);
		}
		yield* Effect.sync(() =>
			emitDigestStatus(handlers, "Preparing local AI context"),
		);
		yield* maybeAutoSyncBackupEffect().pipe(Effect.catchAll(() => Effect.void));
	}).pipe(Effect.asVoid);
}

function digestCacheKey(
	context: PeriodDigestContext,
	options: PeriodDigestOptions,
) {
	const parts = [
		"period-digest:v2",
		modelFromOptions(options),
		reasoningEffortFromOptions(options),
		serviceTierFromOptions(options),
		context.hash,
	];
	const lang = languageFromOptions(options);
	if (lang) parts.push(`lang:${lang}`);
	return parts.join(":");
}

function latestDigestCacheKey(options: PeriodDigestOptions) {
	const period = normalizePeriod(options.period);
	const window = resolvePeriodDigestWindow(options);
	const identity = {
		period,
		day:
			period === "today" || period === "yesterday"
				? window.since
				: localDateStart(new Date()).toISOString(),
		since: options.since?.trim() || null,
		until: options.until?.trim() || null,
		account: options.account?.trim() || null,
		includeDms: Boolean(options.includeDms),
		maxTweets: Math.max(
			20,
			Math.trunc(options.maxTweets ?? DEFAULT_MAX_TWEETS),
		),
		maxLinks: Math.max(3, Math.trunc(options.maxLinks ?? DEFAULT_MAX_LINKS)),
		model: modelFromOptions(options),
		language: languageFromOptions(options) ?? null,
		reasoningEffort: reasoningEffortFromOptions(options),
		serviceTier: serviceTierFromOptions(options),
	};
	return `period-digest-latest:v1:${createHash("sha1")
		.update(JSON.stringify(identity))
		.digest("hex")}`;
}

function collectDigestTweetIds(digest: PeriodDigest) {
	const tweetIds = new Set(digest.sourceTweetIds);
	for (const topic of digest.keyTopics) {
		for (const tweetId of topic.tweetIds) tweetIds.add(tweetId);
	}
	for (const link of digest.notableLinks) {
		for (const tweetId of link.sourceTweetIds) tweetIds.add(tweetId);
	}
	for (const action of digest.actionItems) {
		if (action.tweetId) tweetIds.add(action.tweetId);
	}
	return [...tweetIds];
}

function enrichContextWithCitedTweets(
	context: PeriodDigestContext,
	digest: PeriodDigest,
) {
	const existingIds = new Set(context.tweets.map((tweet) => tweet.id));
	const missingIds = collectDigestTweetIds(digest).filter(
		(tweetId) => !existingIds.has(tweetId.replace(/^tweet_/, "")),
	);
	if (missingIds.length === 0) return context;
	const citedTweets = getTweetsByIds(missingIds, context.account).map(
		compactEmbeddedTweet,
	);
	return citedTweets.length > 0
		? { ...context, tweets: [...context.tweets, ...citedTweets] }
		: context;
}

interface CachedPeriodDigestValue {
	context?: PeriodDigestContext;
	digest: PeriodDigest;
	markdown: string;
	model: string;
	reasoningEffort: string;
	serviceTier: string;
	updatedAt?: string;
}

function cachedDigestResult(
	cached: { value: CachedPeriodDigestValue; updatedAt: string },
	context: PeriodDigestContext,
): PeriodDigestRunResult {
	const digest = PeriodDigestSchema.parse(cached.value.digest);
	return {
		context: enrichContextWithCitedTweets(context, digest),
		digest,
		markdown: cached.value.markdown,
		model: cached.value.model,
		reasoningEffort: cached.value.reasoningEffort,
		serviceTier: cached.value.serviceTier,
		cached: true,
		updatedAt: cached.value.updatedAt ?? cached.updatedAt,
	};
}

function isFreshDigestCache(updatedAt: string) {
	const timestamp = Date.parse(updatedAt);
	return (
		Number.isFinite(timestamp) &&
		Date.now() - timestamp <= DEFAULT_DIGEST_FRESHNESS_MS
	);
}

function emitCachedDigest(
	result: PeriodDigestRunResult,
	handlers: PeriodDigestStreamHandlers,
) {
	handlers.onEvent?.({ type: "start", context: result.context, cached: true });
	handlers.onDelta?.(result.markdown);
	handlers.onEvent?.({ type: "delta", delta: result.markdown });
	handlers.onEvent?.({ type: "done", result });
}

function buildPrompt(
	context: PeriodDigestContext,
	options?: { language?: string },
) {
	const language = normalizeDigestLanguage(options?.language);
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
		replyToId: tweet.replyToId,
		replyToTweet: tweet.replyToTweet,
	}));
	const fitDataset = () => {
		let tweetCount = promptTweets.length;
		let dmCount = context.dms.length;
		let linkCount = context.links.length;
		const datasetFor = (tweets: number, dms: number, links: number) => ({
			tweets: promptTweets.slice(0, tweets),
			dms: context.dms.slice(0, dms),
			links: context.links.slice(0, links),
		});
		const lengthFor = (tweets: number, dms: number, links: number) =>
			JSON.stringify(datasetFor(tweets, dms, links)).length;
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
		if (lengthFor(tweetCount, dmCount, linkCount) <= MAX_PROMPT_DATA_CHARS) {
			return {
				dataset: datasetFor(tweetCount, dmCount, linkCount),
				tweetCount,
			};
		}
		dmCount = fitCount(
			dmCount,
			(count) =>
				lengthFor(tweetCount, count, linkCount) <= MAX_PROMPT_DATA_CHARS,
		);
		if (lengthFor(tweetCount, dmCount, linkCount) > MAX_PROMPT_DATA_CHARS) {
			linkCount = fitCount(
				linkCount,
				(count) =>
					lengthFor(tweetCount, dmCount, count) <= MAX_PROMPT_DATA_CHARS,
			);
		}
		if (lengthFor(tweetCount, dmCount, linkCount) > MAX_PROMPT_DATA_CHARS) {
			tweetCount = fitCount(
				tweetCount,
				(count) =>
					lengthFor(count, dmCount, linkCount) <= MAX_PROMPT_DATA_CHARS,
			);
		}
		return { dataset: datasetFor(tweetCount, dmCount, linkCount), tweetCount };
	};
	const { dataset, tweetCount } = fitDataset();

	return `Window: ${context.window.label}
Since: ${context.window.since}
Until: ${context.window.until}
Sources: ${JSON.stringify(context.counts)}
Prompt tweets: ${String(tweetCount)} of ${String(context.tweets.length)} selected context tweets

Write a high-signal "what happened" report from this local Twitter/X dataset.

Requirements:
- Stream one readable Markdown report first. The UI will show this text directly; do not rely on separate cards or structured summaries.
- Target 700-1100 words when there is enough data.
- Start with a 2-3 sentence lead that immediately says what people are talking about.
- Use sections named "What people are talking about", "Important links shared", and "Worth opening". Add "Worth replying to" only if there are clearly high-signal replies. Translate these section titles when a report language is requested.
- When a tweet has replyToTweet, use that parent context to understand what the author was replying to and whether Peter already joined the conversation.
- Use bullets under each section. Each bullet should be specific and explain why it matters.
- For tweets: cite every claim with inline tweet ids at the end of the relevant sentence or bullet, e.g. (tweet_123, tweet_456). These citations become hoverable source links.
- For links: emit normal Markdown links with no space between the label and URL, e.g. [title](https://example.com), then cite the sharing tweet ids in the same bullet.
- Prefer synthesis over chronology. Group repeated chatter into one bullet.
- Mention handles when useful, but do not make the report a list of handles.
- Do not include a generic "Action items" section.
- If there is no data, say that plainly in one short paragraph.
- DMs are private context and only present when explicitly included.
- After the Markdown, output a blank line, then a line containing only three hyphens, then one compact JSON object.
- Keep actionItems empty unless you wrote a "Worth replying to" section.
- Put every tweet id cited in the Markdown into sourceTweetIds.
- JSON shape: { "title": string, "summary": string, "keyTopics": [{ "title": string, "summary": string, "tweetIds": string[], "handles": string[] }], "notableLinks": [{ "title": string, "url": string, "why": string, "sourceTweetIds": string[] }], "people": [{ "handle": string, "name"?: string, "why": string }], "actionItems": [{ "kind": "reply"|"follow_up"|"read"|"sync", "label": string, "tweetId"?: string, "dmConversationId"?: string }], "sourceTweetIds": string[] }
${language ? `- Write all human-readable prose, including section titles and JSON prose fields, in ${language}.\n- Preserve handles, URLs, tweet ids, and JSON property names exactly.` : ""}

Dataset:
${JSON.stringify(dataset)}`;
}

function fallbackDigest(
	context: PeriodDigestContext,
	markdown: string,
	language?: string,
): PeriodDigest {
	const normalized = markdown.replaceAll(/\s+/g, " ").trim();
	const heading = markdown
		.split("\n")
		.map((line) => line.match(/^#{1,6}\s+(.+)$/)?.[1]?.trim())
		.find(Boolean);
	const neutralFallback = language ? `[${language}]` : undefined;
	return {
		title:
			heading?.slice(0, 160) ??
			neutralFallback ??
			`${context.window.label} digest`,
		summary:
			normalized.slice(0, 280) ||
			neutralFallback ||
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
	language?: string,
): { digest: PeriodDigest; markdown: string } {
	const parsed = parseHybridAnalysis({
		rawText,
		parse: (value) => PeriodDigestSchema.parse(value),
		fallback: (markdown) => fallbackDigest(context, markdown, language),
		delimiterPattern: DELIMITER_PATTERN,
	});
	return { markdown: parsed.markdown, digest: parsed.value };
}

function processSseChunk(
	state: OpenAIStreamState,
	chunk: string,
	handlers: PeriodDigestStreamHandlers,
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
	context: PeriodDigestContext,
	options: PeriodDigestOptions,
) {
	return createAnalysisRequestBody({
		settings: resolveAnalysisModelSettings(options),
		system:
			"You are a precise local Twitter archive analyst. Stream Markdown first, then emit the requested JSON object after the delimiter. Do not invent events not present in the dataset.",
		prompt: buildPrompt(context, {
			language: languageFromOptions(options),
		}),
		stream: true,
	});
}

function completeOpenAIStreamEffect(
	stream: HybridAnalysisResult<PeriodDigest>,
	context: PeriodDigestContext,
	options: PeriodDigestOptions,
	handlers: PeriodDigestStreamHandlers,
): Effect.Effect<PeriodDigestRunResult, Error> {
	return Effect.gen(function* () {
		const enrichedContext = yield* tryDigestSync(() =>
			enrichContextWithCitedTweets(context, stream.value),
		);
		const cacheKey = digestCacheKey(context, options);
		const updatedAt = yield* tryDigestSync(() =>
			writeSyncCache(cacheKey, {
				digest: stream.value,
				markdown: stream.markdown,
				model: modelFromOptions(options),
				reasoningEffort: reasoningEffortFromOptions(options),
				serviceTier: serviceTierFromOptions(options),
				usage: stream.usage,
				responseId: stream.responseId,
			}),
		);
		const result: PeriodDigestRunResult = {
			context: enrichedContext,
			digest: stream.value,
			markdown: stream.markdown,
			model: modelFromOptions(options),
			reasoningEffort: reasoningEffortFromOptions(options),
			serviceTier: serviceTierFromOptions(options),
			cached: false,
			updatedAt,
		};
		yield* tryDigestSync(() =>
			writeSyncCache(latestDigestCacheKey(options), {
				context: result.context,
				digest: result.digest,
				markdown: result.markdown,
				model: result.model,
				reasoningEffort: result.reasoningEffort,
				serviceTier: result.serviceTier,
				updatedAt: result.updatedAt,
			}),
		);
		handlers.onEvent?.({ type: "done", result });
		return result;
	});
}

function readOpenAIStreamEffect(
	response: Response,
	context: PeriodDigestContext,
	options: PeriodDigestOptions,
	handlers: PeriodDigestStreamHandlers,
): Effect.Effect<PeriodDigestRunResult, Error> {
	return Effect.gen(function* () {
		const stream = yield* readHybridAnalysisStreamEffect(response, {
			parse: (value) => PeriodDigestSchema.parse(value),
			fallback: (markdown) =>
				fallbackDigest(context, markdown, languageFromOptions(options)),
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

export function streamPeriodDigestEffect(
	options: PeriodDigestOptions = {},
	handlers: PeriodDigestStreamHandlers = {},
): Effect.Effect<PeriodDigestRunResult, Error> {
	return Effect.gen(function* () {
		const resolvedOptions = {
			...options,
			language: yield* tryDigestSync(() => languageFromOptions(options)),
		};
		const latestCached = resolvedOptions.refresh
			? null
			: !resolvedOptions.liveSync
				? yield* tryDigestSync(() =>
						readSyncCache<CachedPeriodDigestValue>(
							latestDigestCacheKey(resolvedOptions),
						),
					)
				: null;
		const latestContext = latestCached?.value.context;
		if (
			latestCached &&
			latestContext &&
			isFreshDigestCache(latestCached.value.updatedAt ?? latestCached.updatedAt)
		) {
			const result = yield* tryDigestSync(() =>
				cachedDigestResult(latestCached, latestContext),
			);
			emitCachedDigest(result, handlers);
			return result;
		}

		yield* refreshPeriodDigestInputsEffect(
			resolvedOptions,
			{ threads: false },
			handlers,
		).pipe(Effect.catchAll(() => Effect.void));
		let context = yield* tryDigestSync(() =>
			collectPeriodDigestContext(resolvedOptions),
		);
		let cacheKey = digestCacheKey(context, resolvedOptions);
		const cached = resolvedOptions.refresh
			? null
			: yield* tryDigestSync(() =>
					readSyncCache<CachedPeriodDigestValue>(cacheKey),
				);

		if (cached) {
			const result = yield* tryDigestSync(() =>
				cachedDigestResult(cached, context),
			);
			yield* tryDigestSync(() =>
				writeSyncCache(latestDigestCacheKey(resolvedOptions), {
					context: result.context,
					digest: result.digest,
					markdown: result.markdown,
					model: result.model,
					reasoningEffort: result.reasoningEffort,
					serviceTier: result.serviceTier,
					updatedAt: result.updatedAt,
				}),
			);
			emitCachedDigest(result, handlers);
			return result;
		}

		yield* refreshPeriodDigestInputsEffect(
			resolvedOptions,
			{
				timeline: false,
				mentions: false,
				threads: true,
				threadTweetIds: context.tweets
					.filter((tweet) => tweet.source === "mentions")
					.map((tweet) => tweet.id),
			},
			handlers,
		).pipe(Effect.catchAll(() => Effect.void));
		context = yield* tryDigestSync(() =>
			collectPeriodDigestContext(resolvedOptions),
		);
		cacheKey = digestCacheKey(context, resolvedOptions);

		handlers.onEvent?.({ type: "start", context, cached: false });
		emitDigestStatus(handlers, "Streaming AI summary");
		const stream = yield* streamHybridAnalysisEffect({
			body: createOpenAIRequestBody(context, resolvedOptions),
			signal: resolvedOptions.signal,
			parse: (value) => PeriodDigestSchema.parse(value),
			fallback: (markdown) =>
				fallbackDigest(context, markdown, languageFromOptions(resolvedOptions)),
			delimiterPattern: DELIMITER_PATTERN,
			onDelta: (delta) => {
				handlers.onDelta?.(delta);
				handlers.onEvent?.({ type: "delta", delta });
			},
		});
		return yield* completeOpenAIStreamEffect(
			stream,
			context,
			resolvedOptions,
			handlers,
		);
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
	digestCacheKey,
	languageFromOptions,
	normalizeDigestLanguage,
	readOpenAIStreamEffect,
	parseDigestFromHybridText,
	processSseChunk,
	resolvePeriodDigestWindow,
};
