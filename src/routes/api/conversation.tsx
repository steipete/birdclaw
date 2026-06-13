import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { maybeAutoUpdateBackupEffect } from "#/lib/backup";
import {
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { sanitizePublicEmbeddedTweet } from "#/lib/public-tweet";
import { getTweetConversation, isTweetInPublicTimeline } from "#/lib/queries";
import { isPublicReadonlyWeb } from "#/lib/web-profile";

function json(data: unknown, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"content-type": "application/json",
		},
	});
}

export const Route = createFileRoute("/api/conversation")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const publicReadonly = isPublicReadonlyWeb();
						if (!publicReadonly) {
							yield* maybeAutoUpdateBackupEffect();
						}
						const url = new URL(request.url);
						const tweetId = url.searchParams.get("tweetId")?.trim();
						if (!tweetId) {
							return json({ ok: false, error: "Missing tweetId" }, 400);
						}
						if (publicReadonly && !isTweetInPublicTimeline(tweetId)) {
							return json({ ok: false, error: "Tweet not found" }, 404);
						}

						const conversation = getTweetConversation(tweetId);
						if (!conversation) {
							return json({ ok: false, error: "Tweet not found" }, 404);
						}

						return json({
							ok: true,
							...conversation,
							items: publicReadonly
								? conversation.items
										.filter((tweet) => isTweetInPublicTimeline(tweet.id))
										.map(sanitizePublicEmbeddedTweet)
								: conversation.items,
						});
					}),
				),
		},
	},
});
