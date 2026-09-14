import type { EmbeddedTweet } from "#/lib/types";
import {
	embeddedCardBodyClass,
	embeddedCardCopyClass,
	embeddedCardHandleClass,
	embeddedCardHeaderClass,
	embeddedCardLabelClass,
	embeddedCardNameClass,
	feedRowTimestampClass,
} from "#/lib/ui";
import { ProfilePreview } from "./ProfilePreview";
import { OpenTweetLink } from "./OpenTweetLink";
import { TweetPermalinkLink } from "./TweetPermalinkLink";
import { SmartTimestamp } from "./SmartTimestamp";
import { TweetArticleCard } from "./TweetArticleCard";
import { TweetMediaGrid } from "./TweetMediaGrid";
import { TweetRichText } from "./TweetRichText";

export function EmbeddedTweetCard({
	item,
	label,
}: {
	item: EmbeddedTweet;
	label: string;
}) {
	return (
		<section className={embeddedCardBodyClass}>
			<div className="flex flex-wrap items-center justify-between gap-1">
				<p className={embeddedCardLabelClass}>{label}</p>
				<div className="flex flex-wrap gap-1">
					<TweetPermalinkLink compact tweetId={item.id} />
					<OpenTweetLink compact tweetId={item.id} />
				</div>
			</div>
			<header className={embeddedCardHeaderClass}>
				<ProfilePreview profile={item.author}>
					<span className="flex min-w-0 items-center gap-1.5">
						<span className={embeddedCardNameClass}>
							{item.author.displayName}
						</span>
						<span className={embeddedCardHandleClass}>
							@{item.author.handle}
						</span>
					</span>
				</ProfilePreview>
				<span className="text-[var(--ink-soft)]">·</span>
				<SmartTimestamp
					className={feedRowTimestampClass}
					value={item.createdAt}
				/>
			</header>
			<TweetRichText
				className={embeddedCardCopyClass}
				collapsible={Boolean(item.noteTweet)}
				entities={item.entities}
				text={item.text}
			/>
			<TweetMediaGrid items={item.media} tweetId={item.id} />
			{item.entities.article ? (
				<TweetArticleCard article={item.entities.article} />
			) : null}
		</section>
	);
}
