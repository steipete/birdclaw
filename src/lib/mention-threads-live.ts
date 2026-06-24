import type { Database } from "./sqlite";
import { Effect } from "effect";
import { databaseWriteEffect } from "./database-writer";
import { getNativeDb } from "./db";
import { runEffectPromise, trySync } from "./effect-runtime";
import { liveTransportGateway } from "./live-transport-gateway";
import { resolveLiveSyncAccount } from "./live-sync-engine";
import { runSyncPlanEffect } from "./sync-plan";
import type {
	XurlMentionData,
	XurlMentionsResponse,
	XurlMentionUser,
	XurlMediaItem,
	XurlTweetsResponse,
} from "./types";
import {
	type TweetAccountEdgeKind,
	upsertTweetAccountEdge,
} from "./tweet-account-edges";
import { ingestTweetPayload } from "./tweet-repository";

const DEFAULT_LIMIT = 30;
const DEFAULT_DELAY_MS = 1500;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MODE = "bird";
const DEFAULT_FALLBACK_DEPTH = 12;
const MAX_XURL_SEARCH_RESULTS = 100;

export type MentionThreadsMode = "bird" | "xurl";
export interface MentionThreadsProgress {
	source: MentionThreadsMode;
	processed: number;
	total: number;
	fetched: number;
	done: boolean;
}
export interface SyncMentionThreadsOptions {
	account?: string;
	mode?: string;
	limit?: number;
	tweetIds?: string[];
	delayMs?: number;
	timeoutMs?: number;
	all?: boolean;
	maxPages?: number;
	onProgress?: (progress: MentionThreadsProgress) => void;
}

interface LocalMention {
	id: string;
	replyToId?: string;
	conversationId?: string;
	rawTweet?: XurlMentionData;
}
interface ThreadFetchResult {
	strategy: string;
	payload: XurlMentionsResponse;
	pages?: number;
	fallbackDepth?: number;
	generalReadTweets: number;
	truncated?: boolean;
	warnings: string[];
}

function assertPositiveInteger(value: number, name: string) {
	if (!Number.isFinite(value) || value < 1) {
		throw new Error(`${name} must be at least 1`);
	}
	return Math.floor(value);
}

function parseNonNegativeInteger(value: number | undefined, name: string) {
	if (value === undefined) {
		return undefined;
	}
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`${name} must be non-negative`);
	}
	return Math.floor(value);
}

function parseMode(value: string | undefined): MentionThreadsMode {
	const mode = value ?? DEFAULT_MODE;
	if (mode !== "bird" && mode !== "xurl") {
		throw new Error("--mode must be bird or xurl");
	}
	return mode;
}

function getRemainingThreadTimeoutMs(
	deadlineMs: number,
	originalTimeoutMs: number,
) {
	const remainingMs = deadlineMs - Date.now();
	if (remainingMs <= 0) {
		throw new Error(
			`xurl thread timed out after ${String(originalTimeoutMs)}ms`,
		);
	}
	return remainingMs;
}
function getReplyToId(tweet: XurlMentionData) {
	return tweet.referenced_tweets?.find((entry) => entry.type === "replied_to")
		?.id;
}

function mergePayloads(pages: XurlTweetsResponse[]): XurlMentionsResponse {
	const tweets: XurlMentionData[] = [];
	const seenTweetIds = new Set<string>();
	const users: XurlMentionUser[] = [];
	const seenUserIds = new Set<string>();
	const media: XurlMediaItem[] = [];
	const seenMediaKeys = new Set<string>();

	for (const page of pages) {
		for (const tweet of page.data) {
			if (seenTweetIds.has(tweet.id)) {
				continue;
			}
			seenTweetIds.add(tweet.id);
			tweets.push(tweet);
		}

		for (const user of page.includes?.users ?? []) {
			if (seenUserIds.has(user.id)) {
				continue;
			}
			seenUserIds.add(user.id);
			users.push(user);
		}

		for (const item of page.includes?.media ?? []) {
			if (seenMediaKeys.has(item.media_key)) {
				continue;
			}
			seenMediaKeys.add(item.media_key);
			media.push(item);
		}
	}

	const lastMeta = pages.at(-1)?.meta;
	return {
		data: tweets,
		includes:
			users.length > 0 || media.length > 0
				? {
						...(users.length > 0 ? { users } : {}),
						...(media.length > 0 ? { media } : {}),
					}
				: undefined,
		meta: {
			...lastMeta,
			result_count: tweets.length,
			page_count: pages.length,
			next_token:
				typeof lastMeta?.next_token === "string" ? lastMeta.next_token : null,
		},
	};
}

function parseRawTweet(value: string | null | undefined) {
	if (!value || value === "{}" || value === "null") {
		return undefined;
	}

	try {
		const parsed = JSON.parse(value) as unknown;
		if (parsed && typeof parsed === "object") {
			return parsed as XurlMentionData;
		}
	} catch {
		return undefined;
	}

	return undefined;
}

function listRecentMentions(
	db: Database,
	accountId: string,
	limit: number,
): LocalMention[] {
	const rows = db
		.prepare(
			`
      with local_mentions as (
        select
          t.id,
          t.created_at as createdAt,
          t.reply_to_id as replyToId,
          edge.raw_json as rawJson
        from tweet_account_edges edge
        join tweets t on t.id = edge.tweet_id
        where edge.kind = 'mention' and edge.account_id = ?
      )
      select id, createdAt, replyToId, rawJson
      from local_mentions
      order by createdAt desc
      limit ?
      `,
		)
		.all(accountId, limit) as Array<{
		id: string;
		createdAt: string;
		replyToId: string | null;
		rawJson: string | null;
	}>;

	return rows.map((row) => {
		const rawTweet = parseRawTweet(row.rawJson);
		return {
			id: row.id,
			replyToId:
				row.replyToId ?? (rawTweet ? getReplyToId(rawTweet) : undefined),
			conversationId:
				typeof rawTweet?.conversation_id === "string"
					? rawTweet.conversation_id
					: undefined,
			rawTweet,
		};
	});
}

function listMentionsByIds(
	db: Database,
	accountId: string,
	tweetIds: string[],
	limit: number,
): LocalMention[] {
	const ids = [...new Set(tweetIds.filter((id) => id.trim().length > 0))].slice(
		0,
		limit,
	);
	if (ids.length === 0) return [];
	const placeholders = ids.map(() => "?").join(", ");
	const rows = db
		.prepare(
			`
      select
        t.id,
        t.created_at as createdAt,
        t.reply_to_id as replyToId,
        coalesce(edge.raw_json, '{}') as rawJson
      from tweets t
		join tweet_account_edges edge
        on edge.tweet_id = t.id
        and edge.account_id = ?
        and edge.kind = 'mention'
      where t.id in (${placeholders})
      order by t.created_at desc
      limit ?
      `,
		)
		.all(accountId, ...ids, limit) as Array<{
		id: string;
		createdAt: string;
		replyToId: string | null;
		rawJson: string | null;
	}>;

	return rows.map((row) => {
		const rawTweet = parseRawTweet(row.rawJson);
		return {
			id: row.id,
			replyToId:
				row.replyToId ?? (rawTweet ? getReplyToId(rawTweet) : undefined),
			conversationId:
				typeof rawTweet?.conversation_id === "string"
					? rawTweet.conversation_id
					: undefined,
			rawTweet,
		};
	});
}

function mergeMentionThreadIntoLocalStore({
	db,
	accountId,
	accountHandle,
	mentionIds,
	payload,
	source = "bird",
	writeThreadContextEdges = false,
}: {
	db: Database;
	accountId: string;
	accountHandle: string;
	mentionIds: Set<string>;
	payload: XurlMentionsResponse;
	source?: "bird" | "xurl";
	writeThreadContextEdges?: boolean;
}) {
	const usersById = new Map(
		(payload.includes?.users ?? []).map((user) => [user.id, user]),
	);
	const groups = new Map<"mention" | "home" | "thread", typeof payload.data>([
		["mention", []],
		["home", []],
		["thread", []],
	]);
	for (const tweet of payload.data) {
		const handle = usersById.get(tweet.author_id)?.username.toLowerCase();
		const kind = mentionIds.has(tweet.id)
			? "mention"
			: handle === accountHandle
				? "home"
				: "thread";
		groups.get(kind)?.push(tweet);
	}
	for (const [kind, data] of groups) {
		if (data.length === 0) continue;
		const classificationEdge: TweetAccountEdgeKind =
			kind === "thread" ? "thread_context" : kind;
		ingestTweetPayload(db, {
			accountId,
			payload: { ...payload, data },
			edgeKind: classificationEdge,
			markRepliesAsReplied: true,
			source,
		});
		if (writeThreadContextEdges && classificationEdge !== "thread_context") {
			const observedAt = new Date().toISOString();
			for (const tweet of data) {
				upsertTweetAccountEdge(db, {
					accountId,
					tweetId: tweet.id,
					kind: "thread_context",
					source,
					seenAt: observedAt,
					rawJson: JSON.stringify(tweet),
				});
			}
		}
	}
}

function fetchConversationViaRecentSearchEffect({
	conversationId,
	all,
	maxPages,
	timeoutMs,
	deadlineMs,
}: {
	conversationId: string;
	all: boolean;
	maxPages?: number;
	timeoutMs: number;
	deadlineMs: number;
}) {
	return Effect.gen(function* () {
		const result = yield* runSyncPlanEffect({
			fetchPage: ({ cursor }) =>
				trySync(() => getRemainingThreadTimeoutMs(deadlineMs, timeoutMs)).pipe(
					Effect.flatMap((remainingTimeoutMs) =>
						liveTransportGateway.xurl.searchConversation(conversationId, {
							maxResults: MAX_XURL_SEARCH_RESULTS,
							paginationToken: cursor,
							timeoutMs: remainingTimeoutMs,
						}),
					),
				),
			getNextCursor: (page) =>
				typeof page.meta?.next_token === "string"
					? page.meta.next_token
					: undefined,
			maxPages: all || maxPages !== undefined ? maxPages : 1,
		});
		const payload = mergePayloads(result.pages);
		const paginationRequested = all || maxPages !== undefined;
		return {
			payload,
			pages: result.pages.length,
			truncated: paginationRequested && Boolean(result.nextCursor),
			generalReadTweets: payload.data.length,
		};
	});
}

function fetchParentChainViaXurlEffect({
	mention,
	maxDepth,
	timeoutMs,
	deadlineMs,
}: {
	mention: LocalMention;
	maxDepth: number;
	timeoutMs: number;
	deadlineMs: number;
}) {
	return Effect.gen(function* () {
		const pages: XurlTweetsResponse[] = [];
		const warnings: string[] = [];
		const seenTweetIds = new Set([mention.id]);
		let nextParentId = mention.replyToId;
		let fallbackDepth = 0;
		let generalReadTweets = 0;

		const rawAnchorPayload =
			mention.rawTweet && mention.rawTweet.id === mention.id
				? ({ data: [mention.rawTweet] } satisfies XurlTweetsResponse)
				: undefined;
		let shouldUseRawAnchor = Boolean(rawAnchorPayload);

		if (!nextParentId) {
			const anchorPayload = yield* liveTransportGateway.xurl.getTweetById(
				mention.id,
				{
					timeoutMs: yield* trySync(() =>
						getRemainingThreadTimeoutMs(deadlineMs, timeoutMs),
					),
				},
			);
			pages.push(anchorPayload);
			generalReadTweets += anchorPayload.data.length;
			const anchorTweet = anchorPayload.data[0];
			if (anchorTweet) {
				shouldUseRawAnchor = false;
				seenTweetIds.add(anchorTweet.id);
				nextParentId = anchorTweet.in_reply_to_user_id
					? getReplyToId(anchorTweet)
					: undefined;
			}
		}

		if (shouldUseRawAnchor && rawAnchorPayload) {
			pages.unshift(rawAnchorPayload);
		}

		while (nextParentId) {
			if (fallbackDepth >= maxDepth) {
				warnings.push(
					`fallback parent-chain depth cap reached for ${mention.id} after ${maxDepth} hops`,
				);
				break;
			}
			if (seenTweetIds.has(nextParentId)) {
				warnings.push(
					`fallback parent-chain cycle detected for ${mention.id} at ${nextParentId}`,
				);
				break;
			}

			fallbackDepth += 1;
			const parentPayload = yield* liveTransportGateway.xurl.getTweetById(
				nextParentId,
				{
					timeoutMs: yield* trySync(() =>
						getRemainingThreadTimeoutMs(deadlineMs, timeoutMs),
					),
				},
			);
			pages.push(parentPayload);
			generalReadTweets += parentPayload.data.length;
			const parentTweet = parentPayload.data[0];
			if (!parentTweet) {
				break;
			}
			seenTweetIds.add(parentTweet.id);
			nextParentId = parentTweet.in_reply_to_user_id
				? getReplyToId(parentTweet)
				: undefined;
		}

		const payload = mergePayloads(pages);
		return {
			payload,
			fallbackDepth,
			warnings,
			generalReadTweets,
		};
	});
}

function findMissingAncestorId(
	mention: LocalMention,
	payload: XurlMentionsResponse,
) {
	const tweetsById = new Map(payload.data.map((tweet) => [tweet.id, tweet]));
	const seenTweetIds = new Set<string>([mention.id]);
	const anchorTweet = tweetsById.get(mention.id) ?? mention.rawTweet;
	let nextParentId = anchorTweet
		? getReplyToId(anchorTweet)
		: mention.replyToId;

	while (nextParentId) {
		if (seenTweetIds.has(nextParentId)) {
			return undefined;
		}
		const parentTweet = tweetsById.get(nextParentId);
		if (!parentTweet) {
			return nextParentId;
		}
		seenTweetIds.add(parentTweet.id);
		nextParentId = parentTweet.in_reply_to_user_id
			? getReplyToId(parentTweet)
			: undefined;
	}

	if (
		mention.conversationId &&
		mention.conversationId !== mention.id &&
		!tweetsById.has(mention.conversationId)
	) {
		return mention.conversationId;
	}

	return undefined;
}

function fetchThreadContextViaXurlEffect({
	mention,
	all,
	maxPages,
	maxFallbackDepth,
	timeoutMs,
}: {
	mention: LocalMention;
	all: boolean;
	maxPages?: number;
	maxFallbackDepth: number;
	timeoutMs: number;
}) {
	return Effect.gen(function* () {
		const deadlineMs = Date.now() + timeoutMs;
		if (!mention.conversationId) {
			if (mention.replyToId) {
				const fallback = yield* fetchParentChainViaXurlEffect({
					mention,
					maxDepth: maxFallbackDepth,
					timeoutMs,
					deadlineMs,
				});
				return {
					strategy: "parent_walk" as const,
					pages: 0,
					truncated: false,
					payload: fallback.payload,
					fallbackDepth: fallback.fallbackDepth,
					generalReadTweets: fallback.generalReadTweets,
					warnings: [
						`missing conversation_id for ${mention.id}; used parent walk`,
						...fallback.warnings,
					],
				};
			}
			return {
				strategy: "skipped:no_conversation_id" as const,
				payload: { data: [] } satisfies XurlMentionsResponse,
				pages: 0,
				fallbackDepth: 0,
				generalReadTweets: 0,
				warnings: [`skipped ${mention.id}: missing conversation_id`],
				truncated: false,
			};
		}

		const search = yield* fetchConversationViaRecentSearchEffect({
			conversationId: mention.conversationId,
			all,
			maxPages,
			timeoutMs,
			deadlineMs,
		});
		if (search.payload.data.length > 0) {
			const missingAncestorId = findMissingAncestorId(mention, search.payload);
			if (missingAncestorId) {
				const fallback = yield* fetchParentChainViaXurlEffect({
					mention,
					maxDepth: maxFallbackDepth,
					timeoutMs,
					deadlineMs,
				});
				return {
					strategy: "conversation_search+parent_walk" as const,
					pages: search.pages,
					truncated: search.truncated,
					payload: mergePayloads([search.payload, fallback.payload]),
					fallbackDepth: fallback.fallbackDepth,
					generalReadTweets:
						search.generalReadTweets + fallback.generalReadTweets,
					warnings: [
						`recent search missed ancestor ${missingAncestorId} for conversation ${mention.conversationId}; used parent walk`,
						...fallback.warnings,
					],
				};
			}
			return {
				strategy: "conversation_search" as const,
				fallbackDepth: 0,
				warnings: [] as string[],
				...search,
			};
		}

		const fallback = yield* fetchParentChainViaXurlEffect({
			mention,
			maxDepth: maxFallbackDepth,
			timeoutMs,
			deadlineMs,
		});
		return {
			strategy: "parent_walk" as const,
			pages: search.pages,
			truncated: search.truncated,
			payload: fallback.payload,
			fallbackDepth: fallback.fallbackDepth,
			generalReadTweets: search.generalReadTweets + fallback.generalReadTweets,
			warnings: [
				`recent search returned no tweets for conversation ${mention.conversationId}; used parent walk`,
				...fallback.warnings,
			],
		};
	});
}

export function syncMentionThreadsEffect({
	account,
	mode = DEFAULT_MODE,
	limit = DEFAULT_LIMIT,
	tweetIds,
	delayMs = DEFAULT_DELAY_MS,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	all = false,
	maxPages,
	onProgress,
}: SyncMentionThreadsOptions) {
	return Effect.gen(function* () {
		const parsedMode = yield* trySync(() => parseMode(mode));
		const parsedLimit = yield* trySync(() =>
			assertPositiveInteger(limit, "--limit"),
		);
		const parsedDelayMs =
			(yield* trySync(() => parseNonNegativeInteger(delayMs, "--delay-ms"))) ??
			0;
		const parsedTimeoutMs = yield* trySync(() =>
			assertPositiveInteger(timeoutMs, "--timeout-ms"),
		);
		const parsedMaxPages = yield* trySync(() =>
			parseNonNegativeInteger(maxPages, "--max-pages"),
		);
		const db = yield* trySync(() => getNativeDb());
		const resolvedAccount = yield* trySync(() =>
			resolveLiveSyncAccount(db, account),
		);
		const mentions = yield* trySync(() =>
			tweetIds
				? listMentionsByIds(
						db,
						resolvedAccount.accountId,
						tweetIds,
						parsedLimit,
					)
				: listRecentMentions(db, resolvedAccount.accountId, parsedLimit),
		);
		const mentionIds = mentions.map((mention) => mention.id);
		const mentionIdSet = new Set(mentionIds);
		const results: Array<{
			tweetId: string;
			conversationId?: string | null;
			ok: boolean;
			count: number;
			strategy?: string;
			pages?: number;
			fallbackDepth?: number;
			truncated?: boolean;
			warnings?: string[];
			error?: string;
		}> = [];
		let mergedTweets = 0;
		let generalReadTweets = 0;
		const uniqueTweetIds = new Set<string>();
		const warnings: string[] = [];

		for (const [index, mention] of mentions.entries()) {
			if (index > 0 && parsedDelayMs > 0) {
				yield* Effect.sleep(parsedDelayMs);
			}
			const fetchEffect: Effect.Effect<ThreadFetchResult, unknown, never> =
				parsedMode === "bird"
					? liveTransportGateway.bird
							.listThread({
								tweetId: mention.id,
								all,
								maxPages: parsedMaxPages,
								timeoutMs: parsedTimeoutMs,
								profileName: resolvedAccount.birdProfileName!,
							})
							.pipe(
								Effect.map((payload) => ({
									strategy: "bird" as const,
									payload,
									pages: undefined,
									fallbackDepth: undefined,
									generalReadTweets: 0,
									truncated: undefined,
									warnings: [] as string[],
								})),
							)
					: fetchThreadContextViaXurlEffect({
							mention,
							all,
							maxPages: parsedMaxPages,
							maxFallbackDepth: DEFAULT_FALLBACK_DEPTH,
							timeoutMs: parsedTimeoutMs,
						});
			const fetched = yield* fetchEffect.pipe(
				Effect.flatMap((fetchResult) =>
					databaseWriteEffect((writeDb) =>
						mergeMentionThreadIntoLocalStore({
							db: writeDb,
							accountId: resolvedAccount.accountId,
							accountHandle: resolvedAccount.username.toLowerCase(),
							mentionIds: mentionIdSet,
							payload: fetchResult.payload,
							source: parsedMode,
							writeThreadContextEdges: parsedMode === "xurl",
						}),
					).pipe(Effect.as(fetchResult)),
				),
				Effect.map((fetchResult) => ({ ok: true as const, fetchResult })),
				Effect.catchAll((error) =>
					Effect.succeed({ ok: false as const, error }),
				),
			);

			if (!fetched.ok) {
				results.push({
					tweetId: mention.id,
					conversationId: mention.conversationId ?? null,
					ok: false,
					count: 0,
					strategy: parsedMode,
					error:
						fetched.error instanceof Error
							? fetched.error.message
							: String(fetched.error),
				});
				yield* Effect.sync(() =>
					onProgress?.({
						source: parsedMode,
						processed: index + 1,
						total: mentions.length,
						fetched: uniqueTweetIds.size,
						done: index + 1 === mentions.length,
					}),
				);
				continue;
			}

			const { fetchResult } = fetched;
			const { payload } = fetchResult;
			for (const tweet of payload.data) {
				uniqueTweetIds.add(tweet.id);
			}
			mergedTweets += payload.data.length;
			generalReadTweets += fetchResult.generalReadTweets;
			warnings.push(...fetchResult.warnings);
			results.push({
				tweetId: mention.id,
				conversationId: mention.conversationId ?? null,
				ok: true,
				count: payload.data.length,
				strategy: fetchResult.strategy,
				pages: fetchResult.pages,
				fallbackDepth: fetchResult.fallbackDepth,
				truncated: fetchResult.truncated,
				warnings:
					fetchResult.warnings.length > 0 ? fetchResult.warnings : undefined,
			});
			yield* Effect.sync(() =>
				onProgress?.({
					source: parsedMode,
					processed: index + 1,
					total: mentions.length,
					fetched: uniqueTweetIds.size,
					done: index + 1 === mentions.length,
				}),
			);
		}

		const failures = results.filter((item) => !item.ok);
		const skipped = results.filter((item) =>
			item.strategy?.startsWith("skipped:"),
		);
		const partial = results.some((item) => item.truncated === true);
		return {
			ok: true,
			source: parsedMode,
			accountId: resolvedAccount.accountId,
			mentions: mentionIds.length,
			threads: results.length,
			succeeded: results.length - failures.length - skipped.length,
			skipped: skipped.length,
			failed: failures.length,
			mergedTweets,
			uniqueTweets: uniqueTweetIds.size,
			generalReadTweets: parsedMode === "xurl" ? generalReadTweets : 0,
			partial,
			options: {
				mode: parsedMode,
				limit: parsedLimit,
				delayMs: parsedDelayMs,
				timeoutMs: parsedTimeoutMs,
				all,
				maxPages: parsedMaxPages ?? null,
				maxFallbackDepth: DEFAULT_FALLBACK_DEPTH,
				tweetIds: tweetIds ?? null,
			},
			results,
			failures,
			warnings,
		};
	});
}

export function syncMentionThreads(options: SyncMentionThreadsOptions) {
	return runEffectPromise(syncMentionThreadsEffect(options));
}
