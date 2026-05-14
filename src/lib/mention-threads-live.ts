import type { Database } from "./sqlite";
import { listThreadViaBird } from "./bird";
import { getNativeDb } from "./db";
import type {
	XurlMentionData,
	XurlMentionsResponse,
	XurlMentionUser,
	XurlTweetsResponse,
} from "./types";
import { upsertTweetAccountEdge } from "./tweet-account-edges";
import { ensureStubProfileForXUser, upsertProfileFromXUser } from "./x-profile";
import { getTweetById, searchRecentByConversationId } from "./xurl";

const DEFAULT_LIMIT = 30;
const DEFAULT_DELAY_MS = 1500;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MODE = "bird";
const DEFAULT_FALLBACK_DEPTH = 12;
const MAX_XURL_SEARCH_RESULTS = 100;

export type MentionThreadsMode = "bird" | "xurl";

interface LocalMention {
	id: string;
	replyToId?: string;
	conversationId?: string;
	rawTweet?: XurlMentionData;
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

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

function getMediaCount(tweet: XurlMentionData) {
	const urls = Array.isArray(tweet.entities?.urls) ? tweet.entities.urls : [];
	return urls.filter(
		(url) =>
			url &&
			typeof url === "object" &&
			typeof (url as Record<string, unknown>).media_key === "string",
	).length;
}

function replaceTweetFts(db: Database, tweetId: string, text: string) {
	db.prepare("delete from tweets_fts where tweet_id = ?").run(tweetId);
	db.prepare("insert into tweets_fts (tweet_id, text) values (?, ?)").run(
		tweetId,
		text,
	);
}

function resolveAccount(db: Database, accountId?: string) {
	const row = accountId
		? (db
				.prepare("select id, handle from accounts where id = ?")
				.get(accountId) as { id: string; handle: string } | undefined)
		: (db
				.prepare(
					`
          select id, handle
          from accounts
          order by is_default desc, created_at asc
          limit 1
          `,
				)
				.get() as { id: string; handle: string } | undefined);

	if (!row) {
		throw new Error(`Unknown account: ${accountId ?? "default"}`);
	}

	return {
		accountId: row.id,
		handle: row.handle.replace(/^@/, "").toLowerCase(),
	};
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
	}

	const lastMeta = pages.at(-1)?.meta;
	return {
		data: tweets,
		includes: users.length > 0 ? { users } : undefined,
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
        union all
        select
          t.id,
          t.created_at as createdAt,
          t.reply_to_id as replyToId,
          '{}' as rawJson
        from tweets t
        where t.kind = 'mention' and t.account_id = ?
          and not exists (
            select 1
            from tweet_account_edges edge
            where edge.account_id = t.account_id
              and edge.tweet_id = t.id
              and edge.kind = 'mention'
          )
      )
      select id, createdAt, replyToId, rawJson
      from local_mentions
      order by createdAt desc
      limit ?
      `,
		)
		.all(accountId, accountId, limit) as Array<{
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
	const upsertTweet = db.prepare(
		`
    insert into tweets (
      id, account_id, author_profile_id, kind, text, created_at,
      is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
      entities_json, media_json, quoted_tweet_id
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, '[]', null)
    on conflict(id) do update set
      account_id = excluded.account_id,
      author_profile_id = excluded.author_profile_id,
      kind = case
        when tweets.kind in ('authored', 'home', 'mention') then tweets.kind
        when excluded.kind in ('authored', 'home', 'mention') then excluded.kind
        else coalesce(nullif(tweets.kind, ''), excluded.kind)
      end,
      text = excluded.text,
      created_at = excluded.created_at,
      is_replied = max(tweets.is_replied, excluded.is_replied),
      reply_to_id = coalesce(excluded.reply_to_id, tweets.reply_to_id),
      like_count = excluded.like_count,
      media_count = max(tweets.media_count, excluded.media_count),
      entities_json = excluded.entities_json,
      media_json = case
        when excluded.media_json not in ('', '[]', 'null') then excluded.media_json
        else tweets.media_json
      end,
      bookmarked = tweets.bookmarked,
      liked = tweets.liked
    `,
	);

	db.transaction(() => {
		const seenAt = new Date().toISOString();
		for (const tweet of payload.data) {
			const author =
				usersById.get(tweet.author_id) ??
				({
					id: tweet.author_id,
					username: `user_${tweet.author_id}`,
					name: `user_${tweet.author_id}`,
				} as const);
			const profile = usersById.has(tweet.author_id)
				? upsertProfileFromXUser(db, author)
				: ensureStubProfileForXUser(db, tweet.author_id);
			const handle = author.username.toLowerCase();
			const kind = mentionIds.has(tweet.id)
				? "mention"
				: handle === accountHandle
					? "home"
					: "thread";
			const replyToId = getReplyToId(tweet);
			upsertTweet.run(
				tweet.id,
				accountId,
				profile.profile.id,
				kind,
				tweet.text,
				tweet.created_at,
				replyToId ? 1 : 0,
				replyToId ?? null,
				Number(tweet.public_metrics?.like_count ?? 0),
				getMediaCount(tweet),
				JSON.stringify(tweet.entities ?? {}),
			);
			if (writeThreadContextEdges) {
				upsertTweetAccountEdge(db, {
					accountId,
					tweetId: tweet.id,
					kind: "thread_context",
					source,
					seenAt,
					rawJson: JSON.stringify(tweet),
				});
			}
			replaceTweetFts(db, tweet.id, tweet.text);
		}
	})();
}

async function fetchConversationViaRecentSearch({
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
	const pages: XurlTweetsResponse[] = [];
	let nextToken: string | undefined;
	let pageCount = 0;

	do {
		const payload = await searchRecentByConversationId(conversationId, {
			maxResults: MAX_XURL_SEARCH_RESULTS,
			paginationToken: nextToken,
			timeoutMs: getRemainingThreadTimeoutMs(deadlineMs, timeoutMs),
		});
		pages.push(payload);
		nextToken =
			typeof payload.meta?.next_token === "string"
				? payload.meta.next_token
				: undefined;
		pageCount += 1;
	} while (
		(all || maxPages !== undefined) &&
		nextToken &&
		(maxPages === undefined || pageCount < maxPages)
	);

	const payload = mergePayloads(pages);
	const paginationRequested = all || maxPages !== undefined;
	return {
		payload,
		pages: pageCount,
		truncated: paginationRequested && Boolean(nextToken),
		generalReadTweets: payload.data.length,
	};
}

async function fetchParentChainViaXurl({
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
		const anchorPayload = await getTweetById(mention.id, {
			timeoutMs: getRemainingThreadTimeoutMs(deadlineMs, timeoutMs),
		});
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
		const parentPayload = await getTweetById(nextParentId, {
			timeoutMs: getRemainingThreadTimeoutMs(deadlineMs, timeoutMs),
		});
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

async function fetchThreadContextViaXurl({
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
	const deadlineMs = Date.now() + timeoutMs;
	if (!mention.conversationId) {
		if (mention.replyToId) {
			const fallback = await fetchParentChainViaXurl({
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

	const search = await fetchConversationViaRecentSearch({
		conversationId: mention.conversationId,
		all,
		maxPages,
		timeoutMs,
		deadlineMs,
	});
	if (search.payload.data.length > 0) {
		const missingAncestorId = findMissingAncestorId(mention, search.payload);
		if (missingAncestorId) {
			const fallback = await fetchParentChainViaXurl({
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

	const fallback = await fetchParentChainViaXurl({
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
}

export async function syncMentionThreads({
	account,
	mode = DEFAULT_MODE,
	limit = DEFAULT_LIMIT,
	delayMs = DEFAULT_DELAY_MS,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	all = false,
	maxPages,
}: {
	account?: string;
	mode?: string;
	limit?: number;
	delayMs?: number;
	timeoutMs?: number;
	all?: boolean;
	maxPages?: number;
}) {
	const parsedMode = parseMode(mode);
	const parsedLimit = assertPositiveInteger(limit, "--limit");
	const parsedDelayMs = parseNonNegativeInteger(delayMs, "--delay-ms") ?? 0;
	const parsedTimeoutMs = assertPositiveInteger(timeoutMs, "--timeout-ms");
	const parsedMaxPages = parseNonNegativeInteger(maxPages, "--max-pages");
	const db = getNativeDb();
	const resolvedAccount = resolveAccount(db, account);
	const mentions = listRecentMentions(
		db,
		resolvedAccount.accountId,
		parsedLimit,
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
			await sleep(parsedDelayMs);
		}
		try {
			const fetchResult =
				parsedMode === "bird"
					? {
							strategy: "bird" as const,
							payload: await listThreadViaBird({
								tweetId: mention.id,
								all,
								maxPages: parsedMaxPages,
								timeoutMs: parsedTimeoutMs,
							}),
							pages: undefined,
							fallbackDepth: undefined,
							generalReadTweets: 0,
							truncated: undefined,
							warnings: [] as string[],
						}
					: await fetchThreadContextViaXurl({
							mention,
							all,
							maxPages: parsedMaxPages,
							maxFallbackDepth: DEFAULT_FALLBACK_DEPTH,
							timeoutMs: parsedTimeoutMs,
						});
			const { payload } = fetchResult;
			mergeMentionThreadIntoLocalStore({
				db,
				accountId: resolvedAccount.accountId,
				accountHandle: resolvedAccount.handle,
				mentionIds: mentionIdSet,
				payload,
				source: parsedMode,
				writeThreadContextEdges: parsedMode === "xurl",
			});
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
		} catch (error) {
			results.push({
				tweetId: mention.id,
				conversationId: mention.conversationId ?? null,
				ok: false,
				count: 0,
				strategy: parsedMode,
				error: error instanceof Error ? error.message : String(error),
			});
		}
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
		},
		results,
		failures,
		warnings,
	};
}
