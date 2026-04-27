import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getBirdCommand } from "./config";
import type {
	XurlMentionData,
	XurlMentionsResponse,
	XurlMentionUser,
} from "./types";

const execFileAsync = promisify(execFile);

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
	inReplyToStatusId?: string;
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
	const birdCommand = getBirdCommand();
	const { stdout } = await execFileAsync(birdCommand, [
		"mentions",
		"-n",
		String(maxResults),
		"--json",
	]);
	const payload = JSON.parse(stdout) as unknown;
	if (!Array.isArray(payload)) {
		throw new Error("bird mentions returned unexpected JSON");
	}

	return normalizeBirdTweets(payload as BirdTweetItem[]);
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
	const birdCommand = getBirdCommand();
	const args = [command, "-n", String(maxResults), "--json"];
	if (all) {
		args.push("--all");
	}
	if (maxPages !== undefined) {
		args.push("--max-pages", String(maxPages));
	}
	const { stdout } = await execFileAsync(birdCommand, args);
	const payload = JSON.parse(stdout) as unknown;
	if (!Array.isArray(payload)) {
		throw new Error(`bird ${command} returned unexpected JSON`);
	}

	return normalizeBirdTweets(payload as BirdTweetItem[]);
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

export async function listDirectMessagesViaBird({
	maxResults,
}: {
	maxResults: number;
}): Promise<BirdDmsResponse> {
	const birdCommand = getBirdCommand();
	const { stdout } = await execFileAsync(birdCommand, [
		"dms",
		"-n",
		String(maxResults),
		"--json",
	]);
	const payload = JSON.parse(stdout) as unknown;
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
