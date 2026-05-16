import { Effect } from "effect";

import { runEffectPromise, tryPromise } from "./effect-runtime";
import { resolveProfile } from "./moderation-target";
import type { ProfileRepliesResponse, XurlReferencedTweet } from "./types";
import { listUserTweets } from "./xurl";

function getReplyTargetId(references?: XurlReferencedTweet[]) {
	return references?.find((item) => item.type === "replied_to")?.id;
}

function getScanSize(limit: number) {
	return Math.min(Math.max(limit * 3, 20), 100);
}

export function inspectProfileReplies(
	query: string,
	{ limit = 12 }: { limit?: number } = {},
): Promise<ProfileRepliesResponse> {
	return runEffectPromise(inspectProfileRepliesEffect(query, { limit }));
}

export function inspectProfileRepliesEffect(
	query: string,
	{ limit = 12 }: { limit?: number } = {},
): Effect.Effect<ProfileRepliesResponse, unknown> {
	return Effect.gen(function* () {
		const resolved = yield* tryPromise(() => resolveProfile(query));
		const externalUserId = resolved.externalUserId;
		if (!externalUserId) {
			return yield* Effect.fail(
				new Error(`Profile has no external Twitter user id: ${query}`),
			);
		}

		const timeline = yield* tryPromise(() =>
			listUserTweets(externalUserId, {
				maxResults: getScanSize(limit),
				excludeRetweets: true,
			}),
		);
		const items = timeline.items
			.map((tweet) => {
				const replyToTweetId = getReplyTargetId(tweet.referenced_tweets);
				if (!replyToTweetId) {
					return null;
				}

				return {
					id: tweet.id,
					text: tweet.text,
					createdAt: tweet.created_at,
					conversationId: tweet.conversation_id,
					replyToTweetId,
					likeCount: Number(tweet.public_metrics?.like_count ?? 0),
					replyCount: Number(tweet.public_metrics?.reply_count ?? 0),
					retweetCount: Number(tweet.public_metrics?.retweet_count ?? 0),
					quoteCount: Number(tweet.public_metrics?.quote_count ?? 0),
					bookmarkCount: Number(tweet.public_metrics?.bookmark_count ?? 0),
					impressionCount: Number(tweet.public_metrics?.impression_count ?? 0),
				};
			})
			.filter((item): item is NonNullable<typeof item> => item !== null)
			.slice(0, limit);

		return {
			profile: resolved.profile,
			externalUserId,
			items,
			meta: {
				scannedCount: timeline.items.length,
				returnedCount: items.length,
				nextToken: timeline.nextToken,
			},
		};
	});
}
