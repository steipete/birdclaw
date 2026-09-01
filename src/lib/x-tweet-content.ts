import { tweetEntitiesFromXurl } from "./tweet-render";
import type { XurlUserTweet } from "./types";

type XurlTweetContent = Pick<XurlUserTweet, "text" | "entities" | "note_tweet">;

export function tweetContentFromXurl(tweet: XurlTweetContent) {
	const content = tweet.note_tweet ?? tweet;
	return {
		text: content.text,
		entities: tweetEntitiesFromXurl(content.entities),
	};
}
