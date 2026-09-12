import { ExternalLink } from "lucide-react";
import {
	cx,
	feedActionButtonClass,
	feedActionIconClass,
	feedActionIconWrapClass,
} from "#/lib/ui";

export function OpenTweetLink({
	tweetId,
	compact = false,
}: {
	tweetId: string;
	compact?: boolean;
}) {
	return (
		<a
			aria-label="Open on X (opens in a new tab)"
			className={cx(feedActionButtonClass, "shrink-0 whitespace-nowrap")}
			href={`https://x.com/i/status/${encodeURIComponent(tweetId)}`}
			rel="noopener noreferrer"
			target="_blank"
			title="Open on X (opens in a new tab)"
			onClick={(event) => event.stopPropagation()}
		>
			<span className={compact ? "inline-flex" : feedActionIconWrapClass}>
				<ExternalLink
					aria-hidden="true"
					className={compact ? "size-3.5" : feedActionIconClass}
					strokeWidth={1.7}
				/>
			</span>
			<span>Open on X</span>
		</a>
	);
}
