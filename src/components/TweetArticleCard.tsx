import { BookOpen, ExternalLink } from "lucide-react";
import type { TweetArticle } from "#/lib/types";
import {
	linkPreviewCardClass,
	linkPreviewDescClass,
	linkPreviewHostClass,
	linkPreviewTitleClass,
} from "#/lib/ui";
import { safeHttpUrl } from "#/lib/url-safety";

function safeArticleImageUrl(value: string | undefined) {
	const url = safeHttpUrl(value);
	if (!url) return null;
	try {
		return new URL(url).hostname === "pbs.twimg.com" ? url : null;
	} catch {
		return null;
	}
}

export function TweetArticleCard({ article }: { article: TweetArticle }) {
	const href = safeHttpUrl(article.url);
	if (!href) return null;
	const imageUrl = safeArticleImageUrl(article.coverImageUrl);

	return (
		<a
			aria-label={`Read article: ${article.title}`}
			className={linkPreviewCardClass}
			data-perf="tweet-article-card"
			href={href}
			rel="noreferrer"
			target="_blank"
		>
			<div className="flex min-w-0 flex-1 flex-col justify-center gap-1 px-3.5 py-3">
				<div className="flex min-w-0 items-center gap-2">
					<BookOpen
						aria-hidden="true"
						className="size-3.5 shrink-0 text-[var(--ink-soft)]"
						strokeWidth={1.8}
					/>
					<span className={linkPreviewHostClass}>Article on X</span>
					<ExternalLink
						aria-hidden="true"
						className="size-3.5 shrink-0 text-[var(--ink-soft)] opacity-0 transition-opacity group-hover/link-preview:opacity-100"
						strokeWidth={1.8}
					/>
				</div>
				<span className={linkPreviewTitleClass}>{article.title}</span>
				{article.previewText ? (
					<span className={linkPreviewDescClass}>{article.previewText}</span>
				) : null}
			</div>
			{imageUrl ? (
				<div className="flex aspect-[1.45] w-40 shrink-0 overflow-hidden border-l border-[var(--line)] bg-[var(--bg-soft)] max-[720px]:w-28">
					<img
						alt=""
						className="size-full object-cover transition-transform duration-200 group-hover/link-preview:scale-[1.03]"
						loading="lazy"
						src={imageUrl}
					/>
				</div>
			) : null}
		</a>
	);
}
