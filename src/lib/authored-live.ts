import type { Database } from "./sqlite";
import { Effect } from "effect";
import { listAuthoredTweetsViaBirdEffect } from "./bird";
import { verifyBirdAccountMatchesEffect } from "./bird-account";
import { getAutoTransportOrder } from "./config";
import { databaseWriteEffect } from "./database-writer";
import { getNativeDb } from "./db";
import { runEffectPromise, trySync } from "./effect-runtime";
import {
	parseOptionalMaxPages,
	parseLiveSyncMode,
	type LiveSyncMode,
	parseLivePageSize,
	resolveLiveSyncAccount,
} from "./live-sync-engine";
import { readSyncCache, writeSyncCache } from "./sync-cache";
import { runSyncPlanEffect } from "./sync-plan";
import type { XurlMentionData } from "./types";
import { ingestTweetPayload } from "./tweet-repository";
import {
	adaptUserTimelinePage,
	mergeTweetPages,
	type TweetPage,
} from "./tweet-page";
import {
	getTransportStatusEffect,
	listUserTweetsEffect,
	lookupAuthenticatedUserEffect,
} from "./xurl";

export type AuthoredSyncMode = LiveSyncMode;
type AuthoredSource = "bird" | "xurl";

export interface SyncAuthoredTweetsOptions {
	account?: string;
	mode?: AuthoredSyncMode;
	limit?: number;
	maxPages?: number;
	sinceId?: string;
	untilId?: string;
}

export class AuthoredSyncError extends Error {
	constructor(
		message: string,
		public readonly exitCode: number,
	) {
		super(message);
		this.name = "AuthoredSyncError";
	}
}

// sync_cache JSON shapes:
// { state: "committed", sinceId }
// { state: "pending-forward", sinceId, token, pendingNewestId }
// { state: "pending-until", sinceId, token, untilId, requestedSinceId }
type AuthoredCursorState =
	| { state: "committed"; sinceId: string | null }
	| {
			state: "pending-forward";
			sinceId: string | null;
			token: string;
			pendingNewestId: string | null;
	  }
	| {
			state: "pending-until";
			sinceId: string | null;
			token: string;
			untilId: string;
			requestedSinceId?: string | null;
	  };

interface AuthoredPayload {
	data: XurlMentionData[];
	includes?: TweetPage["includes"];
	meta: {
		result_count: number;
		page_count: number;
		next_token: string | null;
		newest_id?: string;
		oldest_id?: string;
	};
}

const MIN_XURL_LIMIT = 5;
const MAX_XURL_LIMIT = 100;
const DEFAULT_LIMIT = 100;
const AUTHORED_TWEET_FIELDS = [
	"author_id",
	"created_at",
	"conversation_id",
	"entities",
	"note_tweet",
	"attachments",
	"public_metrics",
	"referenced_tweets",
];
const AUTHORED_EXPANSIONS = [
	"author_id",
	"referenced_tweets.id",
	"referenced_tweets.id.author_id",
	"attachments.media_keys",
];
const AUTHORED_USER_FIELDS = [
	"description",
	"entities",
	"location",
	"public_metrics",
	"profile_image_url",
	"url",
	"created_at",
	"verified",
	"verified_type",
];
function cursorKey(accountId: string, source: AuthoredSource) {
	return `authored:${source}:${accountId}:cursor`;
}

function normalizeCursor(value: unknown): AuthoredCursorState {
	if (!value || typeof value !== "object") {
		return { state: "committed", sinceId: null };
	}
	const record = value as Record<string, unknown>;
	const sinceId = typeof record.sinceId === "string" ? record.sinceId : null;
	if (record.state === "pending-forward" && typeof record.token === "string") {
		return {
			state: "pending-forward",
			sinceId,
			token: record.token,
			pendingNewestId:
				typeof record.pendingNewestId === "string"
					? record.pendingNewestId
					: null,
		};
	}
	if (
		record.state === "pending-until" &&
		typeof record.token === "string" &&
		typeof record.untilId === "string"
	) {
		const requestedSinceId =
			"requestedSinceId" in record
				? typeof record.requestedSinceId === "string"
					? record.requestedSinceId
					: null
				: undefined;
		return {
			state: "pending-until",
			sinceId,
			token: record.token,
			untilId: record.untilId,
			...(requestedSinceId !== undefined ? { requestedSinceId } : {}),
		};
	}
	return { state: "committed", sinceId };
}

function readAuthoredCursor(
	db: Database,
	accountId: string,
	source: AuthoredSource,
) {
	return normalizeCursor(
		readSyncCache(cursorKey(accountId, source), db)?.value,
	);
}

function writeAuthoredCursor(
	db: Database,
	accountId: string,
	state: AuthoredCursorState,
	source: AuthoredSource,
) {
	writeSyncCache(cursorKey(accountId, source), state, db);
}

function writeCommittedCursor(
	db: Database,
	accountId: string,
	sinceId: string | null,
	source: AuthoredSource,
) {
	writeAuthoredCursor(db, accountId, { state: "committed", sinceId }, source);
}

function writePendingForwardCursor(
	db: Database,
	accountId: string,
	{
		sinceId,
		token,
		pendingNewestId,
	}: {
		sinceId: string | null;
		token: string;
		pendingNewestId: string | null;
	},
	source: AuthoredSource,
) {
	writeAuthoredCursor(
		db,
		accountId,
		{
			state: "pending-forward",
			sinceId,
			token,
			pendingNewestId,
		},
		source,
	);
}

function writePendingUntilCursor(
	db: Database,
	accountId: string,
	{
		sinceId,
		token,
		untilId,
		requestedSinceId,
	}: {
		sinceId: string | null;
		token: string;
		untilId: string;
		requestedSinceId: string | null;
	},
	source: AuthoredSource,
) {
	writeAuthoredCursor(
		db,
		accountId,
		{
			state: "pending-until",
			sinceId,
			token,
			untilId,
			requestedSinceId,
		},
		source,
	);
}

// Archive seeds stay archive-only because backups can contain live edges without sync_cache.
function findArchiveAuthoredSinceSeed(db: Database, accountId: string) {
	const row = db
		.prepare(
			`
    select t.id
    from tweets t
    join accounts a on a.id = ?
    where t.id glob '[0-9]*'
      and t.id not glob '*[^0-9]*'
      and (
      exists (
        select 1
        from tweet_account_edges e
	        where e.account_id = ?
	          and e.tweet_id = t.id
	          and e.kind = 'authored'
	          and e.source = 'archive'
      )
      or (
        exists (
          select 1
          from tweet_account_edges e2
          where e2.account_id = ?
            and e2.tweet_id = t.id
            and e2.source = 'archive'
            and e2.kind = 'home'
        )
        and t.author_profile_id in ('profile_me', 'profile_user_' || a.external_user_id)
      )
    )
    order by length(t.id) desc, t.id desc
    limit 1
    `,
		)
		.get(accountId, accountId, accountId) as { id: string } | undefined;
	return row?.id ?? null;
}

function compareTweetIds(
	left: string | null | undefined,
	right: string | null | undefined,
) {
	if (!left && !right) {
		return 0;
	}
	if (!left) {
		return -1;
	}
	if (!right) {
		return 1;
	}
	try {
		const leftBigInt = BigInt(left);
		const rightBigInt = BigInt(right);
		return leftBigInt === rightBigInt ? 0 : leftBigInt > rightBigInt ? 1 : -1;
	} catch {
		if (left.length !== right.length) {
			return left.length > right.length ? 1 : -1;
		}
		return left.localeCompare(right);
	}
}

function maxTweetId(...ids: Array<string | null | undefined>) {
	return ids.reduce<string | null>((current, next) => {
		if (!next) {
			return current;
		}
		return compareTweetIds(next, current) > 0 ? next : current;
	}, null);
}

function getNewestTweetId(tweets: XurlMentionData[]) {
	return maxTweetId(...tweets.map((tweet) => tweet.id));
}

function getOldestTweetId(tweets: XurlMentionData[]) {
	return tweets.reduce<string | null>((current, tweet) => {
		if (!current) {
			return tweet.id;
		}
		return compareTweetIds(tweet.id, current) < 0 ? tweet.id : current;
	}, null);
}

function normalizeUsername(value: string) {
	return value.replace(/^@/, "").trim().toLowerCase();
}

function persistAccountExternalUserId(
	db: Database,
	accountId: string,
	externalUserId: string,
) {
	db.prepare(
		`
    update accounts
    set external_user_id = ?
    where id = ?
      and (external_user_id is null or external_user_id = '')
    `,
	).run(externalUserId, accountId);
}

function userFromAuthenticatedPayload(
	payload: Record<string, unknown> | null,
): { id: string; username: string } | undefined {
	if (!payload || typeof payload.id !== "string") {
		return undefined;
	}
	const username =
		typeof payload.username === "string"
			? payload.username.replace(/^@/, "")
			: "";
	if (!username) {
		return undefined;
	}
	return {
		id: payload.id,
		username,
	};
}

function resolveAuthoredIdentityEffect({
	account,
	db,
}: {
	account?: string;
	db: Database;
}) {
	return Effect.gen(function* () {
		const status = yield* getTransportStatusEffect();
		if (status.availableTransport !== "xurl") {
			return yield* Effect.fail(new AuthoredSyncError(status.statusText, 4));
		}

		const resolvedAccount = yield* trySync(() =>
			resolveLiveSyncAccount(db, account),
		);
		if (resolvedAccount.externalUserId) {
			return {
				accountId: resolvedAccount.accountId,
				username: resolvedAccount.username,
				userId: resolvedAccount.externalUserId,
			};
		}

		const authenticated = yield* lookupAuthenticatedUserEffect();
		const authenticatedUser = userFromAuthenticatedPayload(authenticated);
		if (!authenticatedUser?.id) {
			return yield* Effect.fail(
				new AuthoredSyncError(
					"Could not resolve authenticated Twitter user id",
					4,
				),
			);
		}

		if (
			normalizeUsername(authenticatedUser.username) !==
			normalizeUsername(resolvedAccount.username)
		) {
			return yield* Effect.fail(
				new AuthoredSyncError(
					`xurl is authenticated as @${authenticatedUser.username}, but selected account ${resolvedAccount.accountId} is @${resolvedAccount.username}. Link the account external_user_id or switch xurl login before syncing authored tweets.`,
					4,
				),
			);
		}

		yield* trySync(() =>
			persistAccountExternalUserId(
				db,
				resolvedAccount.accountId,
				authenticatedUser.id,
			),
		);

		return {
			accountId: resolvedAccount.accountId,
			username: resolvedAccount.username,
			userId: authenticatedUser.id,
		};
	});
}

function mergePages(pages: readonly TweetPage[]): AuthoredPayload {
	const merged = mergeTweetPages(pages);
	const newestId = getNewestTweetId(merged.data);
	const oldestId = getOldestTweetId(merged.data);
	return {
		...merged,
		meta: {
			...merged.meta,
			result_count: merged.data.length,
			page_count: pages.length,
			next_token:
				typeof merged.meta?.next_token === "string"
					? merged.meta.next_token
					: null,
			...(newestId ? { newest_id: newestId } : {}),
			...(oldestId ? { oldest_id: oldestId } : {}),
		},
	};
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function buildResult({
	source,
	accountId,
	userId,
	effectiveSinceId,
	nextSinceId,
	nextToken,
	pageCount,
	payload,
	partial,
	error,
}: {
	source: AuthoredSource;
	accountId: string;
	userId: string;
	effectiveSinceId: string | null;
	nextSinceId: string | null;
	nextToken: string | null;
	pageCount: number;
	payload: AuthoredPayload;
	partial: boolean;
	error?: string;
}) {
	return {
		ok: !partial,
		kind: "authored" as const,
		source,
		accountId,
		userId,
		count: payload.data.length,
		pages: pageCount,
		sinceId: effectiveSinceId,
		nextSinceId,
		nextToken,
		partial,
		...(error ? { error } : {}),
		cursor: {
			sinceId: nextSinceId,
			paginationToken: nextToken,
			pending: Boolean(nextToken),
		},
		payload,
	};
}

function syncAuthoredTweetsViaSourceEffect({
	account,
	mode,
	limit = DEFAULT_LIMIT,
	maxPages,
	sinceId,
	untilId,
}: SyncAuthoredTweetsOptions & { mode: AuthoredSource }) {
	return Effect.gen(function* () {
		const pageLimit = yield* trySync(() =>
			parseLivePageSize(limit, { min: MIN_XURL_LIMIT, max: MAX_XURL_LIMIT }),
		);
		const parsedMaxPages = yield* trySync(() =>
			parseOptionalMaxPages(maxPages),
		);
		const db = yield* trySync(() => getNativeDb());
		const identity =
			mode === "xurl"
				? yield* resolveAuthoredIdentityEffect({ account, db })
				: yield* Effect.gen(function* () {
						const selected = resolveLiveSyncAccount(db, account);
						const authenticated =
							yield* verifyBirdAccountMatchesEffect(selected);
						const userId = selected.externalUserId ?? authenticated.id;
						if (!userId)
							return yield* Effect.fail(
								new AuthoredSyncError(
									"Bird authenticated user id unavailable",
									4,
								),
							);
						persistAccountExternalUserId(db, selected.accountId, userId);
						return {
							accountId: selected.accountId,
							username: selected.username,
							userId,
						};
					});
		const cursor = yield* trySync(() =>
			readAuthoredCursor(db, identity.accountId, mode),
		);
		const usePersistedForward =
			sinceId === undefined && !untilId && cursor.state === "pending-forward";
		const usePersistedUntil =
			sinceId === undefined &&
			Boolean(untilId) &&
			cursor.state === "pending-until" &&
			cursor.untilId === untilId;
		const shouldSeedFromArchive =
			!usePersistedForward &&
			!cursor.sinceId &&
			sinceId === undefined &&
			!untilId;
		const archiveSinceSeed = shouldSeedFromArchive
			? yield* trySync(() =>
					findArchiveAuthoredSinceSeed(db, identity.accountId),
				)
			: null;
		if (shouldSeedFromArchive && !archiveSinceSeed) {
			console.error(
				"birdclaw sync authored: no archive baseline found; starting a full backwards scan",
			);
		}
		const persistedUntilSinceId: string | null = usePersistedUntil
			? (("requestedSinceId" in cursor
					? cursor.requestedSinceId
					: cursor.sinceId) ?? null)
			: null;
		const effectiveSinceId: string | null =
			sinceId ??
			archiveSinceSeed ??
			(untilId ? persistedUntilSinceId : cursor.sinceId) ??
			null;
		const initialToken = usePersistedForward
			? cursor.token
			: usePersistedUntil
				? cursor.token
				: undefined;
		let newestSeenId = usePersistedForward
			? maxTweetId(cursor.sinceId, cursor.pendingNewestId)
			: cursor.sinceId;
		const planResult = yield* runSyncPlanEffect({
			allowPartialFailure: true,
			initialCursor: initialToken,
			maxPages: parsedMaxPages ?? undefined,
			fetchPage: ({
				cursor: paginationToken,
			}): Effect.Effect<
				{ payload: TweetPage; nextToken: string | null | undefined },
				unknown
			> =>
				mode === "bird"
					? listAuthoredTweetsViaBirdEffect({
							username: identity.username,
							maxResults: pageLimit,
							paginationToken,
							sinceId: effectiveSinceId ?? undefined,
							untilId,
						}).pipe(
							Effect.map((payload) => ({
								payload,
								nextToken:
									typeof payload.meta?.next_token === "string"
										? payload.meta.next_token
										: undefined,
							})),
						)
					: listUserTweetsEffect(identity.userId, {
							maxResults: pageLimit,
							paginationToken,
							excludeRetweets: false,
							sinceId: effectiveSinceId ?? undefined,
							untilId,
							tweetFields: AUTHORED_TWEET_FIELDS,
							expansions: AUTHORED_EXPANSIONS,
							userFields: AUTHORED_USER_FIELDS,
							auth: "oauth2",
							username: identity.username,
						}).pipe(
							Effect.map((page) => ({
								payload: adaptUserTimelinePage(page, identity.userId),
								nextToken: page.nextToken,
							})),
						),
			getNextCursor: (page) => page.nextToken,
			persistPage: ({ page }) => {
				return databaseWriteEffect((writeDb) =>
					ingestTweetPayload(writeDb, {
						accountId: identity.accountId,
						payload: page.payload,
						source: mode,
						edgeKind: "authored",
						markRepliesAsReplied: true,
					}),
				).pipe(
					Effect.tap(() =>
						Effect.sync(() => {
							newestSeenId = maxTweetId(
								newestSeenId,
								getNewestTweetId(page.payload.data),
							);
						}),
					),
				);
			},
		});
		const pages = planResult.pages.map((page) => page.payload);
		const pageCount = pages.length;
		const nextToken =
			planResult.stopReason === "page-limit" ||
			planResult.stopReason === "error"
				? planResult.nextCursor
				: undefined;
		const partial = !planResult.complete;
		const nextSinceId = untilId
			? cursor.sinceId
			: partial
				? effectiveSinceId
				: maxTweetId(newestSeenId, effectiveSinceId, cursor.sinceId);
		if (planResult.stopReason === "error") {
			if (nextToken && untilId) {
				yield* trySync(() =>
					writePendingUntilCursor(
						db,
						identity.accountId,
						{
							sinceId: cursor.sinceId,
							token: nextToken,
							untilId,
							requestedSinceId: effectiveSinceId,
						},
						mode,
					),
				);
			} else if (nextToken) {
				yield* trySync(() =>
					writePendingForwardCursor(
						db,
						identity.accountId,
						{
							sinceId: effectiveSinceId,
							token: nextToken,
							pendingNewestId: newestSeenId,
						},
						mode,
					),
				);
			}
		} else if (untilId && nextToken) {
			yield* trySync(() =>
				writePendingUntilCursor(
					db,
					identity.accountId,
					{
						sinceId: cursor.sinceId,
						token: nextToken,
						untilId,
						requestedSinceId: effectiveSinceId,
					},
					mode,
				),
			);
		} else if (untilId) {
			yield* trySync(() =>
				writeCommittedCursor(db, identity.accountId, cursor.sinceId, mode),
			);
		} else if (nextToken) {
			yield* trySync(() =>
				writePendingForwardCursor(
					db,
					identity.accountId,
					{
						sinceId: nextSinceId,
						token: nextToken,
						pendingNewestId: newestSeenId,
					},
					mode,
				),
			);
		} else {
			yield* trySync(() =>
				writeCommittedCursor(db, identity.accountId, nextSinceId, mode),
			);
		}

		const payload = mergePages(pages);
		return buildResult({
			source: mode,
			accountId: identity.accountId,
			userId: identity.userId,
			effectiveSinceId,
			nextSinceId,
			nextToken: nextToken ?? null,
			pageCount,
			payload,
			partial,
			...(planResult.stopReason === "error"
				? { error: formatError(planResult.error) }
				: partial
					? {
							error:
								planResult.stopReason === "repeated-cursor"
									? "pagination stopped on a repeated cursor"
									: "max pages reached before sync completed",
						}
					: {}),
		});
	});
}

export function syncAuthoredTweetsEffect(options: SyncAuthoredTweetsOptions) {
	return Effect.gen(function* () {
		const mode = yield* trySync(() => parseLiveSyncMode(options.mode, "auto"));
		yield* trySync(() =>
			parseLivePageSize(options.limit ?? DEFAULT_LIMIT, {
				min: MIN_XURL_LIMIT,
				max: MAX_XURL_LIMIT,
			}),
		);
		yield* trySync(() => parseOptionalMaxPages(options.maxPages));
		if (mode !== "auto")
			return yield* syncAuthoredTweetsViaSourceEffect({ ...options, mode });
		const [first, second] = getAutoTransportOrder();
		return yield* syncAuthoredTweetsViaSourceEffect({
			...options,
			mode: first,
		}).pipe(
			Effect.catchAll((firstError) =>
				syncAuthoredTweetsViaSourceEffect({ ...options, mode: second }).pipe(
					Effect.mapError(
						(secondError) =>
							new AuthoredSyncError(
								`${first}: ${formatError(firstError)}; ${second}: ${formatError(secondError)}`,
								firstError instanceof AuthoredSyncError
									? firstError.exitCode
									: 1,
							),
					),
				),
			),
		);
	});
}

export function syncAuthoredTweets(options: SyncAuthoredTweetsOptions) {
	return runEffectPromise(syncAuthoredTweetsEffect(options));
}
