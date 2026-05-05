import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getBirdCommand } from "./config";
import type {
	XurlMentionData,
	XurlMentionsResponse,
	XurlMentionUser,
	XurlReferencedTweet,
	XurlTweetsResponse,
} from "./types";

const execFileAsync = promisify(execFile);
const BIRD_JSON_MAX_BUFFER_BYTES = 512 * 1024 * 1024;

function formatBirdCommandError(error: unknown, birdCommand: string) {
	if (
		error instanceof Error &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	) {
		return new Error(
			`bird CLI not found at ${birdCommand}. Install @steipete/bird or set BIRDCLAW_BIRD_COMMAND / mentions.birdCommand to a valid bird binary.`,
		);
	}

	return error;
}

async function runBirdJsonCommand(args: string[]) {
	const birdCommand = getBirdCommand();
	try {
		const { stdout } = await execFileAsync(birdCommand, args, {
			maxBuffer: BIRD_JSON_MAX_BUFFER_BYTES,
		});
		return stdout;
	} catch (error) {
		throw formatBirdCommandError(error, birdCommand);
	}
}

interface BirdTweetMedia {
	type?: string;
	url?: string;
}

interface BirdTweetAuthor {
	username?: string;
	name?: string;
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
	quotedTweet?: { id?: string | null } | null;
	author?: BirdTweetAuthor;
	authorId?: string;
	media?: BirdTweetMedia[];
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
}

export interface BirdDmConversation {
	id: string;
	participants: BirdDmUser[];
	messages: BirdDmEvent[];
	lastMessageAt?: string;
	lastMessagePreview?: string;
}

export interface BirdDmsResponse {
	success: true;
	conversations: BirdDmConversation[];
	events: BirdDmEvent[];
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

	return references.length > 0 ? references : undefined;
}

function normalizeBirdTweets(items: BirdTweetItem[]): XurlMentionsResponse {
	const users = new Map<string, XurlMentionUser>();
	const data = items.map((item): XurlMentionData => {
		const authorId = String(
			item.authorId ?? item.author?.username ?? "unknown",
		);
		if (!users.has(authorId)) {
			users.set(authorId, {
				id: authorId,
				username: item.author?.username ?? `user_${authorId}`,
				name: item.author?.name ?? item.author?.username ?? `user_${authorId}`,
			});
		}

		return {
			id: item.id,
			author_id: authorId,
			text: item.text,
			created_at: toIsoTimestamp(item.createdAt),
			conversation_id: item.conversationId ?? item.id,
			entities: toMediaEntities(item.media),
			referenced_tweets: toReferencedTweets(item),
			public_metrics: {
				reply_count: Number(item.replyCount ?? 0),
				retweet_count: Number(item.retweetCount ?? 0),
				like_count: Number(item.likeCount ?? 0),
			},
			edit_history_tweet_ids: [item.id],
		};
	});

	return {
		data,
		includes:
			users.size > 0 ? { users: Array.from(users.values()) } : undefined,
		meta: {
			result_count: data.length,
			page_count: 1,
			next_token: null,
			...(data[0] ? { newest_id: data[0].id } : {}),
			...(data.at(-1) ? { oldest_id: data.at(-1)?.id } : {}),
		},
	};
}

export async function listMentionsViaBird({
	maxResults,
}: {
	maxResults: number;
}): Promise<XurlMentionsResponse> {
	const stdout = await runBirdJsonCommand([
		"mentions",
		"-n",
		String(maxResults),
		"--json",
	]);
	const payload = parseBirdJson(stdout);

	return normalizeBirdTweets(getBirdTweetItems(payload, "mentions"));
}

async function listTweetsViaBirdCommand({
	command,
	maxResults,
	all,
	maxPages,
}: {
	command: "likes" | "bookmarks";
	maxResults: number;
	all?: boolean;
	maxPages?: number;
}): Promise<XurlMentionsResponse> {
	const args = [command, "-n", String(maxResults), "--json"];
	if (all) {
		args.push("--all");
	}
	if (maxPages !== undefined) {
		args.push("--max-pages", String(maxPages));
	}
	const stdout = await runBirdJsonCommand(args);
	const payload = parseBirdJson(stdout);

	return normalizeBirdTweets(getBirdTweetItems(payload, command));
}

export async function listLikedTweetsViaBird({
	maxResults,
	all,
	maxPages,
}: {
	maxResults: number;
	all?: boolean;
	maxPages?: number;
}): Promise<XurlMentionsResponse> {
	return listTweetsViaBirdCommand({
		command: "likes",
		maxResults,
		all,
		maxPages,
	});
}

export async function listBookmarkedTweetsViaBird({
	maxResults,
	all,
	maxPages,
}: {
	maxResults: number;
	all?: boolean;
	maxPages?: number;
}): Promise<XurlMentionsResponse> {
	return listTweetsViaBirdCommand({
		command: "bookmarks",
		maxResults,
		all,
		maxPages,
	});
}

export async function lookupTweetsByIdsViaBird(
	ids: string[],
): Promise<XurlTweetsResponse> {
	if (ids.length === 0) {
		return { data: [] };
	}

	const tweets = await Promise.all(
		ids.map(async (id) => {
			const stdout = await runBirdJsonCommand(["read", id, "--json"]);
			return getBirdTweetItem(parseBirdJson(stdout), "read");
		}),
	);

	return normalizeBirdTweets(tweets);
}

export async function listDirectMessagesViaBird({
	maxResults,
}: {
	maxResults: number;
}): Promise<BirdDmsResponse> {
	const stdout = await runBirdJsonCommand([
		"dms",
		"-n",
		String(maxResults),
		"--json",
	]);
	const payload = parseBirdJson(stdout);
	if (
		!payload ||
		typeof payload !== "object" ||
		(payload as { success?: unknown }).success !== true ||
		!Array.isArray((payload as { conversations?: unknown }).conversations) ||
		!Array.isArray((payload as { events?: unknown }).events)
	) {
		throw new Error("bird dms returned unexpected JSON");
	}

	return payload as BirdDmsResponse;
}
