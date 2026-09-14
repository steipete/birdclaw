import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowLeft, Check, Copy } from "lucide-react";
import { useState } from "react";
import { ConversationThread } from "#/components/ConversationThread";
import { FeedEmpty, FeedError, FeedLoading } from "#/components/FeedState";
import {
	TimelineFeedHeader,
	TimelineHeaderSubtitle,
} from "#/components/TimelineFeedShell";
import { ApiFetchError } from "#/lib/api-client";
import { conversationQueryOptions } from "#/lib/conversation-surface";
import { tweetPermalinkPath } from "#/lib/tweet-permalink";
import { secondaryButtonClass, statusCopyClass } from "#/lib/ui";

export const Route = createFileRoute("/tweets/$tweetId")({
	component: TweetRoute,
	head: () => ({ meta: [{ title: "Conversation · birdclaw" }] }),
});

function TweetRoute() {
	const { tweetId } = Route.useParams();
	return <TweetRouteView key={tweetId} tweetId={tweetId} />;
}

export function TweetRouteView({ tweetId }: { tweetId: string }) {
	const query = useQuery({
		...conversationQueryOptions(tweetId),
		retry: false,
	});
	const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
		"idle",
	);
	const [copyUrl, setCopyUrl] = useState("");
	const anchorId = query.data?.anchorId || tweetId;
	const missing =
		(query.error instanceof ApiFetchError && query.error.status === 404) ||
		(query.data && !query.data.items.some((tweet) => tweet.id === anchorId));

	async function copyLink() {
		const url = new URL(tweetPermalinkPath(anchorId), window.location.origin)
			.href;
		setCopyUrl(url);
		try {
			await navigator.clipboard.writeText(url);
			setCopyState("copied");
		} catch {
			setCopyState("error");
		}
	}

	return (
		<section className="min-h-screen">
			<TimelineFeedHeader
				title="Conversation"
				subtitles={
					<TimelineHeaderSubtitle>
						Saved posts and replies
					</TimelineHeaderSubtitle>
				}
				action={
					<div className="flex flex-wrap gap-2">
						<a className={secondaryButtonClass} href="/">
							<ArrowLeft aria-hidden="true" className="size-4" /> Archive
						</a>
						<button
							className={secondaryButtonClass}
							onClick={() => void copyLink()}
							type="button"
						>
							{copyState === "copied" ? (
								<Check aria-hidden="true" className="size-4" />
							) : (
								<Copy aria-hidden="true" className="size-4" />
							)}
							{copyState === "copied" ? "Copied" : "Copy link"}
						</button>
					</div>
				}
			/>
			{copyState === "error" ? (
				<div className="space-y-2 px-4 py-3" role="alert">
					<p className={statusCopyClass}>
						Could not copy automatically. Copy this permalink:
					</p>
					<input
						aria-label="Post permalink"
						className="w-full rounded border border-[var(--line)] px-3 py-2 text-sm"
						onFocus={(event) => event.currentTarget.select()}
						readOnly
						value={copyUrl}
					/>
				</div>
			) : null}
			{query.isPending ? (
				<FeedLoading
					label="Loading conversation"
					detail="Finding the saved post and its replies"
				/>
			) : missing ? (
				<FeedEmpty
					label="Post not found"
					detail="This post is not available in this archive."
				/>
			) : query.isError ? (
				<FeedError
					title="Could not load conversation"
					message={
						query.error instanceof Error
							? query.error.message
							: "Conversation unavailable"
					}
					action={
						<button
							className={secondaryButtonClass}
							onClick={() => void query.refetch()}
							type="button"
						>
							Retry
						</button>
					}
				/>
			) : (
				<div className="px-4 pb-8">
					{query.data.truncated ? (
						<p className={statusCopyClass}>
							Showing a limited portion of the archived conversation.
						</p>
					) : null}
					<ConversationThread
						anchorId={anchorId}
						items={query.data.items}
						loading={false}
						standalone
					/>
				</div>
			)}
		</section>
	);
}
