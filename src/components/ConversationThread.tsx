import { MessageCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import type { EmbeddedTweet } from "#/lib/types";
import {
	cx,
	feedActionIconClass,
	feedRowHandleClass,
	feedRowNameClass,
	feedRowTimestampClass,
} from "#/lib/ui";
import { AvatarChip } from "./AvatarChip";
import { BirdclawLoading } from "./BrandMark";
import { ProfilePreview } from "./ProfilePreview";
import { OpenTweetLink } from "./OpenTweetLink";
import { TweetPermalinkLink } from "./TweetPermalinkLink";
import { SmartTimestamp } from "./SmartTimestamp";
import { TweetArticleCard } from "./TweetArticleCard";
import { TweetMediaGrid } from "./TweetMediaGrid";
import { TweetRichText } from "./TweetRichText";

export function ConversationThread({
	anchorId,
	error,
	items,
	loading,
	standalone = false,
}: {
	anchorId: string;
	error?: string | null;
	items: EmbeddedTweet[];
	loading: boolean;
	standalone?: boolean;
}) {
	const anchorRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!standalone || loading || error) return;
		anchorRef.current?.scrollIntoView({ block: "center" });
		anchorRef.current?.focus({ preventScroll: true });
	}, [anchorId, error, items, loading, standalone]);

	if (loading) {
		return (
			<section className="mt-3 rounded-2xl border border-[var(--line)] bg-[var(--bg-card)]">
				<BirdclawLoading
					detail="Finding archived replies around this post"
					label="Loading conversation"
				/>
			</section>
		);
	}

	if (error) {
		return (
			<section className="mt-3 rounded-2xl border border-[var(--alert)] bg-[var(--alert-soft)] px-4 py-3 text-[14px] text-[var(--alert)]">
				{error}
			</section>
		);
	}

	if (items.length === 0 || (!standalone && items.length === 1)) {
		return null;
	}

	return (
		<section
			aria-label="Conversation"
			className="mt-3 overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--bg-card)]"
		>
			<div className="flex items-center gap-2 border-b border-[var(--line)] px-4 py-2.5 text-[13px] font-bold text-[var(--ink)]">
				<MessageCircle className={feedActionIconClass} strokeWidth={1.8} />
				<span>
					{items.length} {items.length === 1 ? "tweet" : "tweets"} in
					conversation
				</span>
			</div>
			<div className="flex flex-col">
				{items.map((tweet, index) => {
					const isAnchor = tweet.id === anchorId;
					return (
						<div
							ref={isAnchor ? anchorRef : undefined}
							role="article"
							aria-label={isAnchor ? "Selected post" : undefined}
							aria-current={isAnchor ? "true" : undefined}
							data-tweet-id={tweet.id}
							tabIndex={standalone && isAnchor ? -1 : undefined}
							className={cx(
								"flex gap-3 px-4 py-3",
								index > 0 && "border-t border-[var(--line)]",
								isAnchor && "bg-[var(--accent-soft)]",
							)}
							key={tweet.id}
						>
							<div className="flex flex-col items-center">
								<AvatarChip
									avatarUrl={tweet.author.avatarUrl}
									hue={tweet.author.avatarHue}
									name={tweet.author.displayName}
									profileId={tweet.author.id}
									size="small"
								/>
								{index < items.length - 1 ? (
									<span className="mt-2 w-px flex-1 bg-[var(--line)]" />
								) : null}
							</div>
							<div className="min-w-0 flex-1">
								<header className="flex min-w-0 items-center gap-1.5 text-[14px]">
									<ProfilePreview profile={tweet.author}>
										<span className="flex min-w-0 items-center gap-1.5">
											<span className={feedRowNameClass}>
												{tweet.author.displayName}
											</span>
											<span className={feedRowHandleClass}>
												@{tweet.author.handle}
											</span>
										</span>
									</ProfilePreview>
									<span className="text-[var(--ink-soft)]">·</span>
									<SmartTimestamp
										className={feedRowTimestampClass}
										value={tweet.createdAt}
									/>
									{isAnchor ? (
										<span className="ml-auto rounded-full bg-[var(--accent)] px-2 py-0.5 text-[11px] font-bold text-white">
											selected
										</span>
									) : null}
								</header>
								<TweetRichText
									className="mt-1 whitespace-pre-wrap break-words text-[14px] leading-[1.45] text-[var(--ink)] [overflow-wrap:anywhere]"
									collapsible={Boolean(tweet.noteTweet)}
									entities={tweet.entities}
									text={tweet.text}
								/>
								<TweetMediaGrid items={tweet.media} />
								{tweet.entities.article ? (
									<TweetArticleCard article={tweet.entities.article} />
								) : null}
								<div className="mt-2 flex flex-wrap gap-1">
									<TweetPermalinkLink compact tweetId={tweet.id} />
									<OpenTweetLink compact tweetId={tweet.id} />
								</div>
							</div>
						</div>
					);
				})}
			</div>
		</section>
	);
}
