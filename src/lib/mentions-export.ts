import { listTimelineItems } from "./queries";
import { renderTweetMarkdown, renderTweetPlainText } from "./tweet-render";
import type {
	ReplyFilter,
	TimelineItem,
	XurlMentionData,
	XurlMentionsResponse,
	XurlMentionUser,
} from "./types";

export interface MentionExportItem {
	id: string;
	url: string;
	createdAt: string;
	accountId: string;
	accountHandle: string;
	isReplied: boolean;
	author: TimelineItem["author"];
	text: string;
	plainText: string;
	markdown: string;
	likeCount: number;
	mediaCount: number;
	bookmarked: boolean;
	liked: boolean;
	replyToTweetId?: string | null;
	quotedTweetId?: string | null;
}

function toXurlUserId(profileId: string) {
	if (profileId.startsWith("profile_user_")) {
		return profileId.replace(/^profile_user_/, "");
	}
	return profileId;
}

function toXurlEntities(item: TimelineItem) {
	const mentions = item.entities.mentions?.map((mention) => ({
		start: mention.start,
		end: mention.end,
		username: mention.profile?.handle ?? mention.username,
		...(mention.id ? { id: toXurlUserId(mention.id) } : {}),
	}));
	const urls = item.entities.urls?.map((url) => ({
		start: url.start,
		end: url.end,
		url: url.url,
		expanded_url: url.expandedUrl,
		display_url: url.displayUrl,
	}));

	if (!mentions?.length && !urls?.length) {
		return undefined;
	}

	return {
		...(mentions?.length ? { mentions } : {}),
		...(urls?.length ? { urls } : {}),
	};
}

export function exportMentionItems({
	account,
	search,
	replyFilter = "all",
	limit = 20,
}: {
	account?: string;
	search?: string;
	replyFilter?: ReplyFilter;
	limit?: number;
}) {
	const items = listTimelineItems({
		resource: "mentions",
		account,
		search,
		replyFilter,
		limit,
	});

	return items.map(
		(item): MentionExportItem => ({
			id: item.id,
			url: `https://x.com/${item.author.handle}/status/${item.id}`,
			createdAt: item.createdAt,
			accountId: item.accountId,
			accountHandle: item.accountHandle,
			isReplied: item.isReplied,
			author: item.author,
			text: item.text,
			plainText: renderTweetPlainText(item.text, item.entities),
			markdown: renderTweetMarkdown(item.text, item.entities),
			likeCount: item.likeCount,
			mediaCount: item.mediaCount,
			bookmarked: item.bookmarked,
			liked: item.liked,
			replyToTweetId: item.replyToTweet?.id ?? null,
			quotedTweetId: item.quotedTweet?.id ?? null,
		}),
	);
}

export function serializeMentionItemsAsXurlCompatible(
	items: TimelineItem[],
): XurlMentionsResponse {
	const users = new Map<string, XurlMentionUser>();
	const data = items.map((item): XurlMentionData => {
		const authorId = toXurlUserId(item.author.id);
		users.set(authorId, {
			id: authorId,
			name: item.author.displayName,
			username: item.author.handle,
		});

		const metrics = {
			retweet_count: 0,
			reply_count: item.isReplied ? 1 : 0,
			like_count: item.likeCount,
			quote_count: 0,
			bookmark_count: item.bookmarked ? 1 : 0,
			impression_count: 0,
		};

		return {
			id: item.id,
			author_id: authorId,
			text: item.text,
			created_at: item.createdAt,
			conversation_id: item.replyToTweet?.id ?? item.id,
			entities: toXurlEntities(item),
			public_metrics: metrics,
			edit_history_tweet_ids: [item.id],
		};
	});

	return {
		data,
		includes: {
			users: Array.from(users.values()),
		},
		meta: {
			result_count: data.length,
			...(data[0] ? { newest_id: data[0].id } : {}),
			...(data.at(-1) ? { oldest_id: data.at(-1)?.id } : {}),
		},
	};
}
