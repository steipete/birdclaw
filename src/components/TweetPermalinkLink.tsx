import { Link } from "@tanstack/react-router";
import { Link2 } from "lucide-react";
import {
	cx,
	feedActionButtonClass,
	feedActionIconClass,
	feedActionIconWrapClass,
} from "#/lib/ui";

export function TweetPermalinkLink({
	tweetId,
	compact = false,
}: {
	tweetId: string;
	compact?: boolean;
}) {
	return (
		<Link
			aria-label="Open archived post"
			className={cx(feedActionButtonClass, "shrink-0 whitespace-nowrap")}
			to="/tweets/$tweetId"
			params={{ tweetId }}
			title="Open archived post"
			onClick={(event) => event.stopPropagation()}
		>
			<span className={compact ? "inline-flex" : feedActionIconWrapClass}>
				<Link2
					aria-hidden="true"
					className={compact ? "size-3.5" : feedActionIconClass}
					strokeWidth={1.7}
				/>
			</span>
			<span>Permalink</span>
		</Link>
	);
}
