import type {
	XurlMediaItem,
	XurlMentionData,
	XurlMentionUser,
	XurlMentionsResponse,
	XurlTweetData,
	XurlUserTweetsResponse,
} from "./types";

export type TweetPage = XurlMentionsResponse;

interface MergeTweetPageOptions {
	itemLimit?: number;
}

export function adaptUserTimelinePage(
	page: XurlUserTweetsResponse,
	fallbackAuthorId: string,
): TweetPage {
	return {
		data: page.items.map((tweet) => ({
			...tweet,
			author_id: tweet.author_id ?? fallbackAuthorId,
		})),
		includes: page.includes,
		meta: {
			result_count: page.items.length,
			next_token: page.nextToken,
		},
	};
}

export function mergeTweetPages(
	pages: readonly TweetPage[],
	{ itemLimit }: MergeTweetPageOptions = {},
): TweetPage {
	const dataById = new Map<string, XurlMentionData>();
	const usersById = new Map<string, XurlMentionUser>();
	const tweetsById = new Map<string, XurlTweetData>();
	const mediaByKey = new Map<string, XurlMediaItem>();
	for (const page of pages) {
		for (const item of page.data) {
			if (!dataById.has(item.id)) dataById.set(item.id, item);
		}
		for (const user of page.includes?.users ?? []) usersById.set(user.id, user);
		for (const tweet of page.includes?.tweets ?? [])
			tweetsById.set(tweet.id, tweet);
		for (const media of page.includes?.media ?? [])
			mediaByKey.set(media.media_key, media);
	}

	const data = [...dataById.values()].slice(0, itemLimit);
	const lastMeta = pages.at(-1)?.meta;
	const includes = {
		...(usersById.size ? { users: [...usersById.values()] } : {}),
		...(tweetsById.size ? { tweets: [...tweetsById.values()] } : {}),
		...(mediaByKey.size ? { media: [...mediaByKey.values()] } : {}),
	};
	return {
		data,
		...(Object.keys(includes).length ? { includes } : {}),
		meta: {
			...lastMeta,
			result_count: data.length,
			page_count: pages.length,
			next_token:
				lastMeta && "next_token" in lastMeta ? lastMeta.next_token : null,
		},
	};
}
