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
import { SmartTimestamp } from "./SmartTimestamp";
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
			<p className={embeddedCardLabelClass}>{label}</p>
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
				entities={item.entities}
				text={item.text}
			/>
			<TweetMediaGrid items={item.media} />
		</section>
	);
}
