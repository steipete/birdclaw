import type { EmbeddedTweet, TweetEntities } from "./types";

export function sanitizePublicTweetEntities(
	entities: TweetEntities,
): TweetEntities {
	return {
		...entities,
		mentions: entities.mentions?.map(
			({ profile: _profile, ...mention }) => mention,
		),
	};
}

export function sanitizePublicEmbeddedTweet(
	tweet: EmbeddedTweet,
): EmbeddedTweet {
	return {
		...tweet,
		isReplied: false,
		bookmarked: false,
		liked: false,
		entities: sanitizePublicTweetEntities(tweet.entities),
	};
}
