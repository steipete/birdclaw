import { Fragment } from "react";
import {
	collectTweetSegments,
	enrichFallbackUrlEntities,
} from "#/lib/tweet-render";
import type { TweetEntities } from "#/lib/types";
import {
	bodyCopyClass,
	tweetHashtagClass,
	tweetLinkClass,
	tweetMentionClass,
} from "#/lib/ui";
import { ProfilePreview } from "./ProfilePreview";

export function TweetRichText({
	text,
	entities,
	className = "body-copy",
}: {
	text: string;
	entities: TweetEntities;
	className?: string;
}) {
	const richEntities = enrichFallbackUrlEntities(text, entities);
	const segments = collectTweetSegments(richEntities);
	let cursor = 0;

	return (
		<p className={className === "body-copy" ? bodyCopyClass : className}>
			{segments.map((segment, index) => {
				if (
					segment.start < cursor ||
					segment.end <= segment.start ||
					segment.end > text.length
				) {
					return null;
				}

				const prefix = text.slice(cursor, segment.start);
				cursor = segment.end;

				let node = (
					<Fragment key={`segment-${String(index)}`}>
						{text.slice(segment.start, segment.end)}
					</Fragment>
				);
				if (segment.kind === "mention" && segment.profile) {
					node = (
						<ProfilePreview
							key={`segment-${String(index)}`}
							profile={segment.profile}
						>
							<span className={tweetMentionClass}>@{segment.username}</span>
						</ProfilePreview>
					);
				} else if (segment.kind === "url") {
					node = (
						<a
							key={`segment-${String(index)}`}
							className={tweetLinkClass}
							href={segment.expandedUrl}
							rel="noreferrer"
							target="_blank"
						>
							{segment.displayUrl}
						</a>
					);
				} else if (segment.kind === "hashtag") {
					node = (
						<span
							className={tweetHashtagClass}
							key={`segment-${String(index)}`}
						>
							#{segment.tag}
						</span>
					);
				}

				return (
					<Fragment key={`piece-${String(index)}`}>
						{prefix}
						{node}
					</Fragment>
				);
			})}
			{text.slice(cursor)}
		</p>
	);
}
