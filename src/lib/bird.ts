import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { getBirdCommand } from "./config";
import { runEffectPromise } from "./effect-runtime";
import type {
	XurlMentionData,
	XurlFollowUsersResponse,
	XurlMentionsResponse,
	XurlMentionUser,
	XurlReferencedTweet,
	XurlTweetsResponse,
	XListPage,
	XListRecord,
} from "./types";

const execFileAsync = promisify(execFile);
const BIRD_JSON_MAX_BUFFER_BYTES = 512 * 1024 * 1024;
const BIRD_STDOUT_REDIRECT_SCRIPT = 'out="$1"; shift; exec "$@" > "$out"';

interface BirdTweetMedia {
	type?: string;
	url?: string;
}

interface BirdTweetAuthor {
	username?: string;
	name?: string;
	profileImageUrl?: string;
}

interface BirdTweetArticle {
	title?: string;
	previewText?: string;
	coverImageUrl?: string;
}

interface BirdTweetItem {
	id: string;
	text: string;
	createdAt: string;
	replyCount?: number;
	retweetCount?: number;
	likeCount?: number;
	conversationId?: string;
	inReplyToStatusId?: string | null;
	quotedStatusId?: string | null;
	retweetedStatusId?: string | null;
	quotedTweet?: Partial<BirdTweetItem> | null;
	retweetedTweet?: { id?: string | null } | null;
	author?: BirdTweetAuthor;
	authorId?: string;
	_raw?: unknown;
	media?: BirdTweetMedia[];
	article?: BirdTweetArticle | null;
}

export interface BirdDmUser {
	id: string;
	username?: string;
	name?: string;
	profileImageUrl?: string;
}

export interface BirdDmEvent {
	id: string;
	conversationId?: string;
	text: string;
	createdAt?: string;
	senderId?: string;
	recipientId?: string;
	sender?: BirdDmUser;
	recipient?: BirdDmUser;
	inboxKind?: "accepted" | "request";
	isMessageRequest?: boolean;
}

export interface BirdDmConversation {
	id: string;
	participants: BirdDmUser[];
	messages: BirdDmEvent[];
	lastMessageAt?: string;
	lastMessagePreview?: string;
	inboxKind?: "accepted" | "request";
	isMessageRequest?: boolean;
}

export interface BirdDmsResponse {
	success: true;
	conversations: BirdDmConversation[];
	events: BirdDmEvent[];
}

export interface BirdAuthenticatedAccount {
	id?: string;
	username: string;
	name?: string;
}

export type BirdDmRequestAction = "accept" | "reject" | "block";

export type BirdDmMutationResponse =
	| {
			success: true;
			conversationId?: string;
			userId?: string;
			username?: string;
			blockedUserId?: string;
			blockedUsername?: string;
	  }
	| {
			success: false;
			error: string;
	  };

interface BirdUserOverviewPayload {
	user?: {
		id?: string;
		username?: string;
		name?: string;
		description?: string;
		location?: string;
		url?: string;
		verified?: boolean;
		verifiedType?: string;
		verified_type?: string;
		followersCount?: number;
		followingCount?: number;
		profileImageUrl?: string;
		createdAt?: string;
		entities?: Record<string, unknown>;
		affiliation?: Record<string, unknown>;
	};
}

interface BirdProfilesPayload {
	users?: NonNullable<BirdUserOverviewPayload["user"]>[];
	errors?: Array<{ target?: string; error?: string }>;
}

type BirdFollowUsersPayload =
	| NonNullable<BirdUserOverviewPayload["user"]>[]
	| {
			users?: NonNullable<BirdUserOverviewPayload["user"]>[];
			nextCursor?: string | null;
	  };

interface BirdListPayload {
	id?: string;
	name?: string;
	description?: string;
	memberCount?: number;
	subscriberCount?: number;
	isPrivate?: boolean;
	createdAt?: string;
	owner?: {
		id?: string;
		username?: string;
		name?: string;
	};
}

function toIsoTimestamp(value: string) {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return value;
	}
	return parsed.toISOString();
}

function escapeJsonStringControlChars(value: string) {
	let output = "";
	let inString = false;
	let escaped = false;

	for (const character of value) {
		if (!inString) {
			output += character;
			if (character === '"') {
				inString = true;
			}
			continue;
		}

		if (escaped) {
			output += character;
			escaped = false;
			continue;
		}

		if (character === "\\") {
			output += character;
			escaped = true;
			continue;
		}

		if (character === '"') {
			output += character;
			inString = false;
			continue;
		}

		if (character === "\n") {
			output += "\\n";
			continue;
		}
		if (character === "\r") {
			output += "\\r";
			continue;
		}
		if (character === "\t") {
			output += "\\t";
			continue;
		}
		if (character.charCodeAt(0) < 0x20) {
			output += `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
			continue;
		}

		output += character;
	}

	return output;
}

function parseBirdJson(stdout: string) {
	try {
		return JSON.parse(stdout) as unknown;
	} catch (error) {
		if (!(error instanceof SyntaxError)) {
			throw error;
		}
		return JSON.parse(escapeJsonStringControlChars(stdout)) as unknown;
	}
}

function formatBirdCommandError(error: unknown, birdCommand: string) {
	const text = [
		error instanceof Error ? error.message : "",
		error &&
		typeof error === "object" &&
		"stderr" in error &&
		typeof error.stderr === "string"
			? error.stderr
			: "",
		error &&
		typeof error === "object" &&
		"stdout" in error &&
		typeof error.stdout === "string"
			? error.stdout
			: "",
	].join("\n");
	if (
		(error instanceof Error &&
			"code" in error &&
			(error as { code?: unknown }).code === "ENOENT") ||
		(/No such file or directory|command not found|cannot execute/i.test(text) &&
			text.includes(birdCommand))
	) {
		return new Error(
			`bird command unavailable: ${birdCommand}\nInstall bird on PATH, set BIRDCLAW_BIRD_COMMAND, or update ~/.birdclaw/config.json mentions.birdCommand.`,
		);
	}

	return error;
}

function isUnsupportedBirdOptionError(error: unknown, option: string) {
	if (!error || typeof error !== "object") {
		return false;
	}
	const text = [
		error instanceof Error ? error.message : "",
		"stderr" in error && typeof error.stderr === "string" ? error.stderr : "",
		"stdout" in error && typeof error.stdout === "string" ? error.stdout : "",
	].join("\n");
	return text.includes(option) && /unknown option|error:/i.test(text);
}

function makeBirdStdoutTempEffect() {
	return Effect.acquireRelease(
		Effect.sync(() => {
			const tempDir = mkdtempSync(join(tmpdir(), "birdclaw-bird-"));
			return { tempDir, stdoutPath: join(tempDir, "stdout.json") };
		}),
		({ tempDir }) =>
			Effect.sync(() => rmSync(tempDir, { recursive: true, force: true })),
	);
}

export const runBirdJsonCommandEffect = Effect.fn("bird.runJsonCommand")(
	(args: string[], timeoutMs?: number) =>
		Effect.scoped(
			Effect.gen(function* () {
				const birdCommand = yield* Effect.try({
					try: () => getBirdCommand(),
					catch: (error) =>
						error instanceof Error ? error : new Error(String(error)),
				});
				const { stdoutPath } = yield* makeBirdStdoutTempEffect();
				yield* Effect.tryPromise({
					try: () =>
						execFileAsync(
							"/bin/bash",
							[
								"-c",
								BIRD_STDOUT_REDIRECT_SCRIPT,
								"birdclaw-bird",
								stdoutPath,
								birdCommand,
								...args,
							],
							{ maxBuffer: BIRD_JSON_MAX_BUFFER_BYTES, timeout: timeoutMs },
						),
					catch: (error) => formatBirdCommandError(error, birdCommand),
				});
				return yield* Effect.try({
					try: () => readFileSync(stdoutPath, "utf8"),
					catch: (error) => error,
				});
			}),
		),
);

const runBirdJsonCommandAllowFailureEffect = Effect.fn(
	"bird.runJsonCommandAllowFailure",
)((args: string[], timeoutMs?: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const birdCommand = yield* Effect.try({
				try: () => getBirdCommand(),
				catch: (error) =>
					error instanceof Error ? error : new Error(String(error)),
			});
			const { stdoutPath } = yield* makeBirdStdoutTempEffect();
			yield* Effect.tryPromise({
				try: () =>
					execFileAsync(
						"/bin/bash",
						[
							"-c",
							BIRD_STDOUT_REDIRECT_SCRIPT,
							"birdclaw-bird",
							stdoutPath,
							birdCommand,
							...args,
						],
						{ maxBuffer: BIRD_JSON_MAX_BUFFER_BYTES, timeout: timeoutMs },
					).catch((error: unknown) => {
						const stdout = readFileSync(stdoutPath, "utf8");
						if (stdout.trim().length > 0) {
							return { stdout: "", stderr: "" };
						}
						throw formatBirdCommandError(error, birdCommand);
					}),
				catch: (error) => error,
			});
			return yield* Effect.try({
				try: () => readFileSync(stdoutPath, "utf8"),
				catch: (error) => error,
			});
		}),
	),
);

function runBirdTweetJsonCommandEffect(args: string[], timeoutMs?: number) {
	return runBirdJsonCommandEffect([...args, "--json-full"], timeoutMs).pipe(
		Effect.catchAll((error) => {
			if (!isUnsupportedBirdOptionError(error, "--json-full")) {
				return Effect.fail(error);
			}
			return runBirdJsonCommandEffect([...args, "--json"], timeoutMs);
		}),
	);
}

function getBirdTweetItems(payload: unknown, command: string) {
	if (Array.isArray(payload)) {
		return payload as BirdTweetItem[];
	}

	if (
		payload &&
		typeof payload === "object" &&
		Array.isArray((payload as { tweets?: unknown }).tweets)
	) {
		return (payload as { tweets: BirdTweetItem[] }).tweets;
	}

	throw new Error(`bird ${command} returned unexpected JSON`);
}

function getBirdTweetItem(payload: unknown, command: string) {
	if (payload && typeof payload === "object") {
		const record = payload as { id?: unknown };
		if (typeof record.id === "string" && record.id.length > 0) {
			return payload as BirdTweetItem;
		}
	}

	throw new Error(`bird ${command} returned unexpected JSON`);
}

function toMediaEntities(media: BirdTweetMedia[] | undefined) {
	if (!Array.isArray(media) || media.length === 0) {
		return undefined;
	}

	return {
		urls: media
			.filter((item) => typeof item?.url === "string" && item.url.length > 0)
			.map((item, index) => ({
				start: index,
				end: index,
				url: item.url as string,
				expanded_url: item.url as string,
				display_url: item.url as string,
				media_key: `bird_media_${index}`,
			})),
	};
}

function toTweetEntities(item: BirdTweetItem) {
	const mediaEntities = toMediaEntities(item.media);
	const title = item.article?.title?.trim();
	if (!title) return mediaEntities;
	const handle = item.author?.username?.replace(/^@/, "");
	const url = handle
		? `https://x.com/${handle}/status/${item.id}`
		: `https://x.com/i/status/${item.id}`;
	return {
		...mediaEntities,
		article: {
			title,
			url,
			...(item.article?.previewText?.trim()
				? { previewText: item.article.previewText.trim() }
				: {}),
			...(item.article?.coverImageUrl?.trim()
				? { coverImageUrl: item.article.coverImageUrl.trim() }
				: {}),
		},
	};
}

function toReferencedTweets(item: BirdTweetItem) {
	const references: XurlReferencedTweet[] = [];
	if (typeof item.inReplyToStatusId === "string" && item.inReplyToStatusId) {
		references.push({ type: "replied_to", id: item.inReplyToStatusId });
	}

	const quotedTweetId =
		typeof item.quotedStatusId === "string" && item.quotedStatusId
			? item.quotedStatusId
			: typeof item.quotedTweet?.id === "string" && item.quotedTweet.id
				? item.quotedTweet.id
				: null;
	if (quotedTweetId) {
		references.push({ type: "quoted", id: quotedTweetId });
	}

	const retweetedTweetId =
		typeof item.retweetedStatusId === "string" && item.retweetedStatusId
			? item.retweetedStatusId
			: typeof item.retweetedTweet?.id === "string" && item.retweetedTweet.id
				? item.retweetedTweet.id
				: null;
	if (retweetedTweetId) {
		references.push({ type: "retweeted", id: retweetedTweetId });
	}

	return references.length > 0 ? references : undefined;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

function findGraphqlAvatarUrl(value: unknown, authorId: string) {
	const pending: unknown[] = [value];
	const seen = new Set<object>();

	while (pending.length > 0) {
		const current = pending.pop();
		const record = getRecord(current);
		if (!record || seen.has(record)) continue;
		seen.add(record);

		if (record.rest_id === authorId) {
			const avatar = getRecord(record.avatar);
			if (typeof avatar?.image_url === "string" && avatar.image_url) {
				return avatar.image_url;
			}
		}

		for (const child of Object.values(record)) {
			if (child && typeof child === "object") {
				pending.push(child);
			}
		}
	}

	return undefined;
}

function isHydratedBirdTweetItem(value: unknown): value is BirdTweetItem {
	const item = value as BirdTweetItem | undefined;
	return (
		typeof item?.id === "string" &&
		typeof item.text === "string" &&
		typeof item.createdAt === "string"
	);
}

function normalizeBirdTweets(items: BirdTweetItem[]): XurlMentionsResponse {
	const users = new Map<string, XurlMentionUser>();
	const includedTweets = new Map<string, XurlMentionData>();
	const normalizeItem = (
		item: BirdTweetItem,
		preserveMissingMetrics = false,
	): XurlMentionData => {
		const authorId = String(
			item.authorId ?? item.author?.username ?? "unknown",
		);
		const profileImageUrl =
			item.author?.profileImageUrl ?? findGraphqlAvatarUrl(item._raw, authorId);
		const existingUser = users.get(authorId);
		if (!existingUser) {
			users.set(authorId, {
				id: authorId,
				username: item.author?.username ?? `user_${authorId}`,
				name: item.author?.name ?? item.author?.username ?? `user_${authorId}`,
				...(profileImageUrl ? { profile_image_url: profileImageUrl } : {}),
			});
		} else if (profileImageUrl && !existingUser.profile_image_url) {
			users.set(authorId, {
				...existingUser,
				profile_image_url: profileImageUrl,
			});
		}

		if (isHydratedBirdTweetItem(item.quotedTweet)) {
			const quotedTweet = normalizeItem(item.quotedTweet, true);
			if (quotedTweet.id !== item.id) {
				includedTweets.set(quotedTweet.id, quotedTweet);
			}
		}

		return {
			id: item.id,
			author_id: authorId,
			text: item.text,
			created_at: toIsoTimestamp(item.createdAt),
			conversation_id: item.conversationId ?? item.id,
			entities: toTweetEntities(item),
			referenced_tweets: toReferencedTweets(item),
			public_metrics: preserveMissingMetrics
				? {
						...(item.replyCount === undefined
							? {}
							: { reply_count: Number(item.replyCount) }),
						...(item.retweetCount === undefined
							? {}
							: { retweet_count: Number(item.retweetCount) }),
						...(item.likeCount === undefined
							? {}
							: { like_count: Number(item.likeCount) }),
					}
				: {
						reply_count: Number(item.replyCount ?? 0),
						retweet_count: Number(item.retweetCount ?? 0),
						like_count: Number(item.likeCount ?? 0),
					},
			edit_history_tweet_ids: [item.id],
		};
	};
	const data = items.map((item): XurlMentionData => normalizeItem(item));
	const includes: XurlMentionsResponse["includes"] = {};
	if (users.size > 0) {
		includes.users = Array.from(users.values());
	}
	if (includedTweets.size > 0) {
		includes.tweets = Array.from(includedTweets.values());
	}

	return {
		data,
		includes: users.size > 0 || includedTweets.size > 0 ? includes : undefined,
		meta: {
			result_count: data.length,
			page_count: 1,
			next_token: null,
			...(data[0] ? { newest_id: data[0].id } : {}),
			...(data.at(-1) ? { oldest_id: data.at(-1)?.id } : {}),
		},
	};
}

function parseBirdJsonEffect(stdout: string) {
	return Effect.try({
		try: () => parseBirdJson(stdout),
		catch: (error) => error,
	});
}

function normalizeBirdTweetsPayloadEffect(payload: unknown, command: string) {
	return Effect.try({
		try: () => normalizeBirdTweets(getBirdTweetItems(payload, command)),
		catch: (error) => error,
	});
}

function normalizeBirdTweetItemEffect(payload: unknown, command: string) {
	return Effect.try({
		try: () => getBirdTweetItem(payload, command),
		catch: (error) => error,
	});
}

export const listMentionsViaBirdEffect = Effect.fn("bird.listMentions")(
	function* ({ maxResults }: { maxResults: number }) {
		const stdout = yield* runBirdTweetJsonCommandEffect([
			"mentions",
			"-n",
			String(maxResults),
		]);
		const payload = yield* parseBirdJsonEffect(stdout);
		return yield* normalizeBirdTweetsPayloadEffect(payload, "mentions");
	},
);

export function listMentionsViaBird(options: {
	maxResults: number;
}): Promise<XurlMentionsResponse> {
	return runEffectPromise(listMentionsViaBirdEffect(options));
}

const listTweetsViaBirdCommandEffect = Effect.fn("bird.listTweets")(function* ({
	command,
	maxResults,
	all,
	maxPages,
}: {
	command: "likes" | "bookmarks";
	maxResults: number;
	all?: boolean;
	maxPages?: number;
}) {
	const args = [command, "-n", String(maxResults)];
	if (all) {
		args.push("--all");
		if (maxPages !== undefined) {
			args.push("--max-pages", String(maxPages));
		}
	}
	const stdout = yield* runBirdTweetJsonCommandEffect(args);
	const payload = yield* parseBirdJsonEffect(stdout);
	return yield* normalizeBirdTweetsPayloadEffect(payload, command);
});

export function listLikedTweetsViaBirdEffect(options: {
	maxResults: number;
	all?: boolean;
	maxPages?: number;
}): Effect.Effect<XurlMentionsResponse, unknown> {
	return listTweetsViaBirdCommandEffect({
		command: "likes",
		...options,
	});
}

export function listLikedTweetsViaBird(options: {
	maxResults: number;
	all?: boolean;
	maxPages?: number;
}): Promise<XurlMentionsResponse> {
	return runEffectPromise(listLikedTweetsViaBirdEffect(options));
}

export function listBookmarkedTweetsViaBirdEffect(options: {
	maxResults: number;
	all?: boolean;
	maxPages?: number;
}): Effect.Effect<XurlMentionsResponse, unknown> {
	return listTweetsViaBirdCommandEffect({
		command: "bookmarks",
		...options,
	});
}

export function listBookmarkedTweetsViaBird(options: {
	maxResults: number;
	all?: boolean;
	maxPages?: number;
}): Promise<XurlMentionsResponse> {
	return runEffectPromise(listBookmarkedTweetsViaBirdEffect(options));
}

export const searchTweetsViaBirdEffect = Effect.fn("bird.searchTweets")(
	function* (
		query: string,
		options: {
			maxResults: number;
			all?: boolean;
			maxPages?: number;
		},
	) {
		const args = ["search", query, "-n", String(options.maxResults)];
		if (options.all) {
			args.push("--all");
		}
		if (options.all && options.maxPages !== undefined) {
			args.push("--max-pages", String(options.maxPages));
		}
		const stdout = yield* runBirdTweetJsonCommandEffect(args);
		const payload = yield* parseBirdJsonEffect(stdout);
		return yield* normalizeBirdTweetsPayloadEffect(payload, "search");
	},
);

export function searchTweetsViaBird(
	query: string,
	options: {
		maxResults: number;
		all?: boolean;
		maxPages?: number;
	},
): Promise<XurlMentionsResponse> {
	return runEffectPromise(searchTweetsViaBirdEffect(query, options));
}

export const lookupTweetsByIdsViaBirdEffect = Effect.fn(
	"bird.lookupTweetsByIds",
)(function* (ids: string[]): Effect.fn.Return<XurlTweetsResponse, unknown> {
	if (ids.length === 0) {
		return { data: [] };
	}

	const tweets = yield* Effect.forEach(
		ids,
		Effect.fn("bird.readTweet")(function* (id: string) {
			const stdout = yield* runBirdTweetJsonCommandEffect(["read", id]);
			const payload = yield* parseBirdJsonEffect(stdout);
			return yield* normalizeBirdTweetItemEffect(payload, "read");
		}),
		{ concurrency: "unbounded" },
	);
	return normalizeBirdTweets(tweets);
});

export function lookupTweetsByIdsViaBird(
	ids: string[],
): Promise<XurlTweetsResponse> {
	return runEffectPromise(lookupTweetsByIdsViaBirdEffect(ids));
}

export const listHomeTimelineViaBirdEffect = Effect.fn("bird.listHomeTimeline")(
	function* ({
		maxResults,
		following = true,
	}: {
		maxResults: number;
		following?: boolean;
	}) {
		const args = ["home", "-n", String(maxResults)];
		if (following) {
			args.push("--following");
		}
		const stdout = yield* runBirdTweetJsonCommandEffect(args);
		const payload = yield* parseBirdJsonEffect(stdout);
		return yield* normalizeBirdTweetsPayloadEffect(payload, "home");
	},
);

export function listHomeTimelineViaBird(options: {
	maxResults: number;
	following?: boolean;
}): Promise<XurlMentionsResponse> {
	return runEffectPromise(listHomeTimelineViaBirdEffect(options));
}

function normalizeBirdFollowUsers(
	payload: unknown,
	command: "followers" | "following" | "list-members",
	maxResults: number,
): XurlFollowUsersResponse {
	const rawPayload = payload as BirdFollowUsersPayload;
	const users = Array.isArray(rawPayload) ? rawPayload : rawPayload.users;
	if (!Array.isArray(users)) {
		throw new Error(`bird ${command} returned unexpected JSON`);
	}

	const data = users
		.map(toXurlMentionUser)
		.filter((user): user is XurlMentionUser => Boolean(user));
	const nextToken =
		!Array.isArray(rawPayload) && typeof rawPayload.nextCursor === "string"
			? rawPayload.nextCursor
			: null;
	const paginationKnownComplete = Array.isArray(rawPayload)
		? data.length < maxResults
		: nextToken === null;

	return {
		data,
		meta: {
			result_count: data.length,
			page_count:
				data.length > 0 ? Math.max(1, Math.ceil(data.length / maxResults)) : 1,
			next_token: nextToken,
			pagination_known_complete: paginationKnownComplete,
		},
	};
}

function normalizeBirdFollowUsersEffect(
	payload: unknown,
	command: "followers" | "following" | "list-members",
	maxResults: number,
) {
	return Effect.try({
		try: () => normalizeBirdFollowUsers(payload, command, maxResults),
		catch: (error) => error,
	});
}

export const listFollowUsersViaBirdEffect = Effect.fn("bird.listFollowUsers")(
	function* ({
		direction,
		userId,
		maxResults,
		all,
		maxPages,
	}: {
		direction: "followers" | "following";
		userId?: string;
		maxResults: number;
		all?: boolean;
		maxPages?: number;
	}) {
		const args = [direction, "-n", String(maxResults), "--json"];
		if (userId) {
			args.push("--user", userId);
		}
		if (all) {
			args.push("--all");
		}
		if (maxPages !== undefined) {
			args.push("--max-pages", String(maxPages));
		}
		const stdout = yield* runBirdJsonCommandEffect(args);
		const payload = yield* parseBirdJsonEffect(stdout);
		return yield* normalizeBirdFollowUsersEffect(
			payload,
			direction,
			maxResults,
		);
	},
);

export function listFollowUsersViaBird(options: {
	direction: "followers" | "following";
	userId?: string;
	maxResults: number;
	all?: boolean;
	maxPages?: number;
}): Promise<XurlFollowUsersResponse> {
	return runEffectPromise(listFollowUsersViaBirdEffect(options));
}

function normalizeBirdLists(payload: unknown): XListPage {
	if (!Array.isArray(payload)) {
		throw new Error("bird lists returned unexpected JSON");
	}
	const data = payload
		.map((value): XListRecord | null => {
			const item = value as BirdListPayload;
			if (!item.id || !item.name) return null;
			return {
				id: item.id,
				name: item.name,
				...(item.description ? { description: item.description } : {}),
				...(typeof item.memberCount === "number"
					? { memberCount: item.memberCount }
					: {}),
				...(typeof item.subscriberCount === "number"
					? { followerCount: item.subscriberCount }
					: {}),
				...(typeof item.isPrivate === "boolean"
					? { isPrivate: item.isPrivate }
					: {}),
				...(item.owner?.id ? { ownerId: item.owner.id } : {}),
				...(item.owner?.username ? { ownerUsername: item.owner.username } : {}),
				...(item.owner?.name ? { ownerName: item.owner.name } : {}),
				...(item.createdAt ? { createdAt: item.createdAt } : {}),
				raw: value as Record<string, unknown>,
			};
		})
		.filter((item): item is XListRecord => Boolean(item));
	return { data, meta: { result_count: data.length, next_token: null } };
}

export const listOwnedXListsViaBirdEffect = Effect.fn("bird.listOwnedXLists")(
	function* ({ maxResults }: { maxResults: number }) {
		const stdout = yield* runBirdJsonCommandEffect([
			"lists",
			"-n",
			String(maxResults),
			"--json",
		]);
		const payload = yield* parseBirdJsonEffect(stdout);
		return yield* Effect.try({
			try: () => normalizeBirdLists(payload),
			catch: (error) => error,
		});
	},
);

export function listOwnedXListsViaBird(options: { maxResults: number }) {
	return runEffectPromise(listOwnedXListsViaBirdEffect(options));
}

export const listXListMembersViaBirdEffect = Effect.fn("bird.listXListMembers")(
	function* ({
		listId,
		maxResults,
		maxPages = 1,
	}: {
		listId: string;
		maxResults: number;
		maxPages?: number;
	}) {
		const args = ["list-members", listId, "-n", String(maxResults), "--json"];
		if (maxPages > 1) {
			args.push("--all", "--max-pages", String(maxPages));
		}
		const stdout = yield* runBirdJsonCommandEffect(args);
		const payload = yield* parseBirdJsonEffect(stdout);
		const normalized = yield* normalizeBirdFollowUsersEffect(
			payload,
			"list-members",
			maxResults,
		);
		if (Array.isArray(payload)) {
			normalized.meta = {
				...normalized.meta,
				pagination_known_complete: false,
				pagination_inferred_complete: normalized.data.length < maxResults,
			};
		}
		return normalized;
	},
);

export function listXListMembersViaBird(options: {
	listId: string;
	maxResults: number;
	maxPages?: number;
}) {
	return runEffectPromise(listXListMembersViaBirdEffect(options));
}

export const listThreadViaBirdEffect = Effect.fn("bird.listThread")(function* ({
	tweetId,
	all,
	maxPages,
	timeoutMs,
}: {
	tweetId: string;
	all?: boolean;
	maxPages?: number;
	timeoutMs?: number;
}) {
	const args = ["thread", tweetId];
	if (all) {
		args.push("--all");
	}
	if (maxPages !== undefined) {
		args.push("--max-pages", String(maxPages));
	}
	const stdout = yield* runBirdTweetJsonCommandEffect(args, timeoutMs);
	const payload = yield* parseBirdJsonEffect(stdout);
	return yield* normalizeBirdTweetsPayloadEffect(payload, "thread");
});

export function listThreadViaBird(options: {
	tweetId: string;
	all?: boolean;
	maxPages?: number;
	timeoutMs?: number;
}): Promise<XurlMentionsResponse> {
	return runEffectPromise(listThreadViaBirdEffect(options));
}

function normalizeBirdDmsPayloadEffect(payload: unknown) {
	return Effect.try({
		try: () => {
			if (
				!payload ||
				typeof payload !== "object" ||
				(payload as { success?: unknown }).success !== true ||
				!Array.isArray(
					(payload as { conversations?: unknown }).conversations,
				) ||
				!Array.isArray((payload as { events?: unknown }).events)
			) {
				throw new Error("bird dms returned unexpected JSON");
			}

			return payload as BirdDmsResponse;
		},
		catch: (error) => error,
	});
}

function parseBirdWhoami(stdout: string): BirdAuthenticatedAccount {
	const usernameMatch = stdout.match(/@([A-Za-z0-9_]{1,15})\b/);
	if (!usernameMatch?.[1]) {
		throw new Error("bird whoami did not report an authenticated username");
	}
	const id = stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.map((line) => {
			const labeled = line.match(/(?:🪪|user_?id:?)[^\d]*(\d{2,})/i);
			if (labeled?.[1]) {
				return labeled[1];
			}
			if (/[A-Za-z@]/.test(line)) {
				return undefined;
			}
			return line.match(/^\D*(\d{2,})\D*$/)?.[1];
		})
		.find((value): value is string => Boolean(value));
	// bird prints the display name in parentheses after the handle, e.g.
	// "🙋 @handle (Display Name)".
	const name = stdout.match(/@[A-Za-z0-9_]{1,15}\s*\(([^)]+)\)/)?.[1]?.trim();
	return {
		username: usernameMatch[1],
		...(id ? { id } : {}),
		...(name ? { name } : {}),
	};
}

export const getAuthenticatedBirdAccountEffect = Effect.fn(
	"bird.getAuthenticatedAccount",
)(function* () {
	const stdout = yield* runBirdJsonCommandEffect(["whoami"]);
	return yield* Effect.try({
		try: () => parseBirdWhoami(stdout),
		catch: (error) => error,
	});
});

export function getAuthenticatedBirdAccount(): Promise<BirdAuthenticatedAccount> {
	return runEffectPromise(getAuthenticatedBirdAccountEffect());
}

export const listDirectMessagesViaBirdEffect = Effect.fn(
	"bird.listDirectMessages",
)(function* ({
	maxResults,
	inbox = "all",
	maxPages,
	allPages = false,
	pageDelayMs,
}: {
	maxResults: number;
	inbox?: "all" | "accepted" | "requests";
	maxPages?: number;
	allPages?: boolean;
	pageDelayMs?: number;
}) {
	const args = ["dms", "-n", String(maxResults), "--json"];
	if (inbox !== "all") {
		args.push("--inbox", inbox);
	}
	if (allPages) {
		args.push("--all-pages");
	} else if (typeof maxPages === "number") {
		args.push("--max-pages", String(maxPages));
	}
	if (typeof pageDelayMs === "number" && pageDelayMs > 0) {
		args.push("--page-delay-ms", String(pageDelayMs));
	}
	const stdout = yield* runBirdJsonCommandEffect(args);
	const payload = yield* parseBirdJsonEffect(stdout);
	return yield* normalizeBirdDmsPayloadEffect(payload);
});

export function listDirectMessagesViaBird(options: {
	maxResults: number;
	inbox?: "all" | "accepted" | "requests";
	maxPages?: number;
	allPages?: boolean;
	pageDelayMs?: number;
}): Promise<BirdDmsResponse> {
	return runEffectPromise(listDirectMessagesViaBirdEffect(options));
}

export const runDirectMessageRequestMutationViaBirdEffect = Effect.fn(
	"bird.runDirectMessageRequestMutation",
)(function* ({
	action,
	conversationId,
	maxPages,
	allPages = false,
}: {
	action: BirdDmRequestAction;
	conversationId: string;
	maxPages?: number;
	allPages?: boolean;
}): Effect.fn.Return<BirdDmMutationResponse, unknown> {
	const command =
		action === "accept"
			? "dm-accept"
			: action === "reject"
				? "dm-reject"
				: "dm-block";
	const args = [command, conversationId, "--json"];
	if (action === "block") {
		if (allPages) {
			args.push("--all-pages");
		} else if (typeof maxPages === "number") {
			args.push("--max-pages", String(maxPages));
		}
	}
	const stdout = yield* runBirdJsonCommandAllowFailureEffect(args);
	const payload = yield* parseBirdJsonEffect(stdout);
	if (
		payload &&
		typeof payload === "object" &&
		typeof (payload as { success?: unknown }).success === "boolean"
	) {
		return payload as BirdDmMutationResponse;
	}
	throw new Error(`bird ${command} returned unexpected JSON`);
});

export function runDirectMessageRequestMutationViaBird(options: {
	action: BirdDmRequestAction;
	conversationId: string;
	maxPages?: number;
	allPages?: boolean;
}): Promise<BirdDmMutationResponse> {
	return runEffectPromise(
		runDirectMessageRequestMutationViaBirdEffect(options),
	);
}

export const lookupProfileViaBirdEffect = Effect.fn("bird.lookupProfile")(
	function* (usernameOrId: string) {
		const target = usernameOrId.trim().replace(/^@/, "");
		if (!target) {
			return null;
		}

		const stdout = yield* runBirdJsonCommandEffect([
			"user",
			target,
			"--json",
			"--profile-only",
		]).pipe(
			Effect.catchAll((error) => {
				if (!isUnsupportedBirdOptionError(error, "--profile-only")) {
					return Effect.fail(error);
				}
				return runBirdJsonCommandEffect([
					"user",
					target,
					"--json",
					"--count",
					"1",
				]);
			}),
		);
		const payload = (yield* parseBirdJsonEffect(
			stdout,
		)) as BirdUserOverviewPayload;
		return toXurlMentionUser(payload.user);
	},
);

export function lookupProfileViaBird(
	usernameOrId: string,
): Promise<XurlMentionUser | null> {
	return runEffectPromise(lookupProfileViaBirdEffect(usernameOrId));
}

function toXurlMentionUser(
	user: BirdUserOverviewPayload["user"],
): XurlMentionUser | null {
	if (!user?.id || !user.username) {
		return null;
	}

	return {
		id: String(user.id),
		username: String(user.username).replace(/^@/, ""),
		name: String(user.name ?? user.username),
		description:
			typeof user.description === "string" ? user.description : undefined,
		location: typeof user.location === "string" ? user.location : undefined,
		url: typeof user.url === "string" ? user.url : undefined,
		verified: typeof user.verified === "boolean" ? user.verified : undefined,
		verified_type:
			typeof user.verifiedType === "string"
				? user.verifiedType
				: typeof user.verified_type === "string"
					? user.verified_type
					: undefined,
		profile_image_url:
			typeof user.profileImageUrl === "string"
				? user.profileImageUrl
				: undefined,
		entities:
			user.entities && typeof user.entities === "object"
				? user.entities
				: undefined,
		affiliation:
			user.affiliation && typeof user.affiliation === "object"
				? user.affiliation
				: undefined,
		created_at: typeof user.createdAt === "string" ? user.createdAt : undefined,
		public_metrics: {
			followers_count: Number(user.followersCount ?? 0),
			following_count: Number(user.followingCount ?? 0),
		},
	};
}

export const lookupProfilesViaBirdEffect = Effect.fn("bird.lookupProfiles")((
	usernameOrIds: string[],
): Effect.Effect<
	Array<{ target: string; user: XurlMentionUser | null; error?: string }>,
	unknown
> => {
	const targets = Array.from(
		new Set(
			usernameOrIds
				.map((target) => target.trim().replace(/^@/, ""))
				.filter((target) => target.length > 0),
		),
	);
	if (targets.length === 0) {
		return Effect.succeed([]);
	}

	return runBirdJsonCommandEffect(["profiles", ...targets, "--json"]).pipe(
		Effect.flatMap((stdout) =>
			Effect.gen(function* () {
				const payload = (yield* parseBirdJsonEffect(
					stdout,
				)) as BirdProfilesPayload;
				const users = (payload.users ?? [])
					.map(toXurlMentionUser)
					.filter((user): user is XurlMentionUser => Boolean(user));
				const byTarget = new Map<string, XurlMentionUser>();
				for (const user of users) {
					byTarget.set(String(user.id), user);
					byTarget.set(user.username.toLowerCase(), user);
				}
				const errors = new Map(
					(payload.errors ?? []).map((item) => [
						String(item.target ?? "")
							.replace(/^@/, "")
							.toLowerCase(),
						item.error ?? "Unknown error",
					]),
				);
				return targets.map((target) => ({
					target,
					user: byTarget.get(target.toLowerCase()) ?? null,
					...(errors.has(target.toLowerCase())
						? { error: errors.get(target.toLowerCase()) }
						: {}),
				}));
			}),
		),
		Effect.catchAll((error) => {
			if (!isUnsupportedBirdOptionError(error, "profiles")) {
				return Effect.fail(error);
			}
			return Effect.forEach(
				targets,
				(target) =>
					lookupProfileViaBirdEffect(target).pipe(
						Effect.map((user) => ({ target, user })),
						Effect.catchAll((lookupError) =>
							Effect.succeed({
								target,
								user: null,
								error:
									lookupError instanceof Error
										? lookupError.message
										: String(lookupError),
							}),
						),
					),
				{ concurrency: "unbounded" },
			);
		}),
	);
});

export function lookupProfilesViaBird(
	usernameOrIds: string[],
): Promise<
	Array<{ target: string; user: XurlMentionUser | null; error?: string }>
> {
	return runEffectPromise(lookupProfilesViaBirdEffect(usernameOrIds));
}

export const __test__ = {
	toIsoTimestamp,
	escapeJsonStringControlChars,
	parseBirdJson,
	formatBirdCommandError,
	isUnsupportedBirdOptionError,
	getBirdTweetItems,
	getBirdTweetItem,
	toMediaEntities,
	toTweetEntities,
	toReferencedTweets,
	normalizeBirdTweets,
};
