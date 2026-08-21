import { Effect } from "effect";

import { resolveOperationAccount } from "./account-selection";
import { runEffectPromise } from "./effect-runtime";
import { resolveProfileEffect } from "./moderation-target";
import type { ProfileRepliesResponse, XurlReferencedTweet } from "./types";
import { tweetContentFromXurl } from "./x-tweet-content";
import { listUserTweetsEffect } from "./xurl";

function getReplyTargetId(references?: XurlReferencedTweet[]) {
	return references?.find((item) => item.type === "replied_to")?.id;
}

function getScanSize(limit: number) {
	return Math.min(Math.max(limit * 3, 20), 100);
}

export function inspectProfileReplies(
	query: string,
	{ account, limit = 12 }: { account?: string; limit?: number } = {},
): Promise<ProfileRepliesResponse> {
	return runEffectPromise(
		inspectProfileRepliesEffect(query, { account, limit }),
	);
}

export function inspectProfileRepliesEffect(
	query: string,
	{ account, limit = 12 }: { account?: string; limit?: number } = {},
): Effect.Effect<ProfileRepliesResponse, unknown> {
	return Effect.gen(function* () {
		const operationAccount = account
			? yield* Effect.try({
					try: () => resolveOperationAccount(account),
					catch: (error) => error,
				})
			: undefined;
		const resolved = yield* resolveProfileEffect(query);
		const externalUserId = resolved.externalUserId;
		if (!externalUserId) {
			return yield* Effect.fail(
				new Error(`Profile has no external Twitter user id: ${query}`),
			);
		}

		const timeline = yield* listUserTweetsEffect(externalUserId, {
			maxResults: getScanSize(limit),
			excludeRetweets: true,
			...(operationAccount ? { username: operationAccount.username } : {}),
		});
		const items = timeline.items
			.map((tweet) => {
				const replyToTweetId = getReplyTargetId(tweet.referenced_tweets);
				if (!replyToTweetId) {
					return null;
				}
				const content = tweetContentFromXurl(tweet);

				return {
					id: tweet.id,
					text: content.text,
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
