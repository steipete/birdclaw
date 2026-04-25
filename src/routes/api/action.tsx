import { createFileRoute } from "@tanstack/react-router";
import { addBlock, removeBlock, syncBlocks } from "#/lib/blocks";
import { scoreInbox } from "#/lib/inbox";
import { addMute, removeMute } from "#/lib/mutes";
import { createDmReply, createPost, createTweetReply } from "#/lib/queries";
import type { InboxKind } from "#/lib/types";

export const Route = createFileRoute("/api/action")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const body = (await request.json()) as Record<string, string>;
				let result: unknown;

				if (body.kind === "post") {
					result = await createPost(
						body.accountId || "acct_primary",
						body.text || "",
					);
				} else if (body.kind === "replyTweet") {
					result = await createTweetReply(
						body.accountId || "acct_primary",
						body.tweetId || "",
						body.text || "",
					);
				} else if (body.kind === "replyDm") {
					result = await createDmReply(
						body.conversationId || "",
						body.text || "",
					);
				} else if (body.kind === "scoreInbox") {
					result = await scoreInbox({
						kind: ((body.scoreKind as InboxKind) || "mixed") as InboxKind,
						limit: body.limit ? Number(body.limit) : 8,
					});
				} else if (body.kind === "blockProfile") {
					result = await addBlock(
						body.accountId || "acct_primary",
						body.query || "",
						{
							transport: body.transport,
						},
					);
				} else if (body.kind === "unblockProfile") {
					result = await removeBlock(
						body.accountId || "acct_primary",
						body.query || "",
						{
							transport: body.transport,
						},
					);
				} else if (body.kind === "muteProfile") {
					result = await addMute(
						body.accountId || "acct_primary",
						body.query || "",
						{
							transport: body.transport,
						},
					);
				} else if (body.kind === "unmuteProfile") {
					result = await removeMute(
						body.accountId || "acct_primary",
						body.query || "",
						{
							transport: body.transport,
						},
					);
				} else if (body.kind === "syncBlocks") {
					result = await syncBlocks(body.accountId || "acct_primary");
				} else {
					return new Response(
						JSON.stringify({ ok: false, message: "Unknown action kind" }),
						{
							status: 400,
							headers: { "content-type": "application/json" },
						},
					);
				}

				return new Response(JSON.stringify(result), {
					headers: {
						"content-type": "application/json",
					},
				});
			},
		},
	},
});
