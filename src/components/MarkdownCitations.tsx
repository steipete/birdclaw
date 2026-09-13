import { createPortal } from "react-dom";
import { Fragment, type MouseEventHandler, type ReactNode } from "react";
import { formatCompactNumber } from "#/lib/present";
import type { PeriodDigestContext } from "#/lib/period-digest";
import type { ProfileAnalysisContext } from "#/lib/profile-analysis";
import type { SearchDiscussionContext } from "#/lib/search-discussion";
import { renderTweetPlainText } from "#/lib/tweet-render";
import type { ProfileRecord, TweetEntities, TweetMediaItem } from "#/lib/types";
import { tweetLinkClass, tweetMentionClass } from "#/lib/ui";
import { safeHttpUrl } from "#/lib/url-safety";
import { AvatarChip } from "./AvatarChip";
import { useAvatarPreload } from "./AvatarPreload";
import { useFloatingPreview } from "./FloatingPreview";
import { ProfilePreview } from "./ProfilePreview";
import { SmartTimestamp } from "./SmartTimestamp";

type CitationTweet = {
	id: string;
	url: string;
	source: string;
	author: string;
	name: string;
	authorProfile: ProfileRecord;
	createdAt: string;
	text: string;
	entities?: TweetEntities;
	media?: TweetMediaItem[];
	likeCount: number;
	liked: boolean;
	bookmarked: boolean;
	needsReply: boolean;
};
export type CitationContext =
	| PeriodDigestContext
	| ProfileAnalysisContext
	| SearchDiscussionContext;
type InlineLookup = {
	tweetsById: Map<string, CitationTweet>;
	profilesByHandle: Map<string, ProfileRecord>;
};

function normalizeTweetReference(value: string) {
	return value
		.trim()
		.replace(/^\(/, "")
		.replace(/\)$/, "")
		.replace(/^tweet_/, "");
}

function isNumericTweetReference(value: string) {
	return /^\d{12,25}$/.test(normalizeTweetReference(value));
}

function tweetReferencesFromToken(token: string) {
	return Array.from(token.matchAll(/\b(?:tweet_)?[A-Za-z0-9_:-]{3,}\b/g))
		.map((match) => match[0])
		.filter((value) => value.startsWith("tweet_") || /^\d{12,25}$/.test(value));
}

function adjacentParenthesizedTweetReferences(value: string, cursor: number) {
	const references: string[] = [];
	let nextCursor = cursor;
	while (nextCursor < value.length) {
		const match =
			/^\s+\((?:\s*(?:tweet_[A-Za-z0-9_:-]+|\d{12,25})\s*,?)+\)/.exec(
				value.slice(nextCursor),
			);
		if (!match) break;
		references.push(...tweetReferencesFromToken(match[0]));
		nextCursor += match[0].length;
	}
	return { references, cursor: nextCursor };
}

function trailingReadableBounds(
	value: string,
	options: { preferClause?: boolean } = {},
) {
	let start = 0;
	for (const separator of [". ", "? ", "! ", "; ", ": "]) {
		const index = value.lastIndexOf(separator);
		if (index >= 0) start = Math.max(start, index + separator.length);
	}

	let end = value.length;
	while (start < end && /\s/.test(value[start] ?? "")) start += 1;
	while (end > start && /\s/.test(value[end - 1] ?? "")) end -= 1;

	let clauseStart = start;
	for (const separator of [", with ", ", while ", ", and "]) {
		const index = value.lastIndexOf(separator, end);
		if (index >= start) {
			clauseStart = index + 2;
			break;
		}
	}

	if (
		options.preferClause !== false &&
		(clauseStart > start || end - start > 140)
	) {
		while (clauseStart < end && /\s/.test(value[clauseStart] ?? "")) {
			clauseStart += 1;
		}
		if (end > clauseStart) start = clauseStart;
	}

	return end > start ? { start, end } : null;
}

export function trimBullet(value: string) {
	return value.replace(/^[-*]\s+/, "");
}

function skipRedundantSourceWords(value: string, cursor: number) {
	const match = /^((?:\s+source\b)+)(?=\s*(?:[.,;:!?)]|$))/i.exec(
		value.slice(cursor),
	);
	return match ? cursor + match[0].length : cursor;
}

function getTweetUrl(tweet: CitationTweet) {
	return tweet.url || `https://x.com/${tweet.author}/status/${tweet.id}`;
}

function getFallbackTweetUrl(tweetId: string) {
	return `https://x.com/i/status/${normalizeTweetReference(tweetId)}`;
}

function comparableUrl(value: string) {
	try {
		const parsed = new URL(value);
		return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
	} catch {
		return value.split("?")[0] ?? value;
	}
}

function isOwnStatusMediaUrl(value: string, tweetId: string) {
	try {
		const parsed = new URL(value);
		const host = parsed.hostname.replace(/^www\./, "");
		if (host !== "x.com" && host !== "twitter.com") return false;
		return new RegExp(
			`/status/${tweetId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(?:photo|video)(?:/|$)`,
		).test(parsed.pathname);
	} catch {
		return false;
	}
}

function previewTextWithoutMediaLink(
	text: string,
	tweet: CitationTweet,
	media: TweetMediaItem[],
) {
	if (media.length === 0) return text;
	const match = /(https?:\/\/[^\s]+)\s*$/.exec(text);
	if (!match) return text;
	const trailingUrl = match[1];
	if (!trailingUrl) return text;
	const mediaUrls = new Set(
		media.flatMap((item) =>
			item.thumbnailUrl ? [item.url, item.thumbnailUrl] : [item.url],
		),
	);
	const comparableTrailing = comparableUrl(trailingUrl);
	const directlyMatchesMedia = [...mediaUrls].some(
		(url) => comparableUrl(url) === comparableTrailing,
	);
	const mediaEntityLostItsRange = (tweet.entities?.urls ?? []).some((entry) => {
		if (entry.end > entry.start) return false;
		return [...mediaUrls].some(
			(url) => comparableUrl(url) === comparableUrl(entry.expandedUrl),
		);
	});
	const isUnresolvedShortUrl = (() => {
		try {
			return new URL(trailingUrl).hostname.replace(/^www\./, "") === "t.co";
		} catch {
			return false;
		}
	})();
	if (
		!directlyMatchesMedia &&
		!isOwnStatusMediaUrl(trailingUrl, tweet.id) &&
		!(isUnresolvedShortUrl && mediaEntityLostItsRange)
	) {
		return text;
	}
	return text.slice(0, match.index).trimEnd();
}

function TweetPreviewMedia({ items }: { items: TweetMediaItem[] }) {
	const images = items
		.flatMap((item) => {
			const url =
				item.type === "image"
					? safeHttpUrl(item.thumbnailUrl ?? item.url)
					: safeHttpUrl(item.thumbnailUrl);
			return url ? [{ item, url }] : [];
		})
		.slice(0, 4);
	if (images.length === 0) return null;

	return (
		<span
			className={
				images.length === 1
					? "mt-2 block overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--bg-active)]"
					: "mt-2 grid grid-cols-2 gap-1.5 overflow-hidden rounded-xl"
			}
		>
			{images.map(({ item, url }, index) => (
				<img
					key={`${url}-${String(index)}`}
					alt={item.altText ?? `Tweet media ${String(index + 1)}`}
					className={
						images.length === 1
							? "block max-h-64 w-full object-contain"
							: "block aspect-square size-full rounded-lg border border-[var(--line)] object-cover"
					}
					decoding="async"
					src={url}
				/>
			))}
		</span>
	);
}

function TweetSourceLink({
	children,
	href,
	onClick,
	describedBy,
}: {
	children: ReactNode;
	href: string;
	onClick?: MouseEventHandler<HTMLAnchorElement>;
	describedBy?: string;
}) {
	return (
		<a
			aria-describedby={describedBy}
			className="rounded-sm px-0.5 text-[var(--accent)] hover:bg-[var(--accent-soft)] hover:no-underline"
			href={href}
			onClick={onClick}
			rel="noreferrer"
			target="_blank"
		>
			{children}
		</a>
	);
}

function TweetPreviewToken({
	tweet,
	children,
}: {
	tweet: CitationTweet;
	children: ReactNode;
}) {
	const preview = useFloatingPreview();
	useAvatarPreload(
		preview.referenceRef,
		tweet.authorProfile.id,
		tweet.authorProfile.avatarUrl,
	);

	const article = tweet.entities?.article;
	const media = tweet.media ?? [];
	const renderedText = renderTweetPlainText(tweet.text, tweet.entities ?? {});
	const previewText = article
		? [article.title, article.previewText]
				.filter(
					(value, index, values): value is string =>
						Boolean(value) && values.indexOf(value) === index,
				)
				.join("\n\n")
		: previewTextWithoutMediaLink(renderedText, tweet, media);

	return (
		<span
			ref={preview.referenceRef}
			className="inline align-baseline"
			{...preview.referenceProps}
		>
			<TweetSourceLink
				describedBy={preview.open ? preview.floatingId : undefined}
				href={getTweetUrl(tweet)}
				onClick={(event) => {
					preview.closePreview();
					event.currentTarget.blur();
				}}
			>
				{children}
			</TweetSourceLink>
			{preview.open
				? createPortal(
						<span
							id={preview.floatingId}
							ref={preview.floatingRef}
							className="fixed z-40 w-[360px] overflow-y-auto rounded-2xl border border-[var(--line)] bg-[var(--bg-elevated)] p-3 text-left text-[14px] leading-[1.4] text-[var(--ink)] shadow-[0_14px_40px_var(--shadow-strong)]"
							role="tooltip"
							style={preview.floatingStyle}
							{...preview.floatingProps}
						>
							<span className="block" data-floating-preview-content>
								<span className="mb-2 flex items-center gap-2">
									<AvatarChip
										avatarUrl={tweet.authorProfile.avatarUrl}
										hue={tweet.authorProfile.avatarHue}
										name={tweet.name}
										profileId={tweet.authorProfile.id}
										size="small"
									/>
									<span className="min-w-0">
										<span className="block truncate font-bold">
											{tweet.name}
										</span>
										<span className="block truncate text-[12px] text-[var(--ink-soft)]">
											@{tweet.author} ·{" "}
											<SmartTimestamp value={tweet.createdAt} />
										</span>
									</span>
								</span>
								<span className="whitespace-pre-wrap [overflow-wrap:anywhere]">
									{previewText}
								</span>
								<TweetPreviewMedia items={media} />
								<span className="mt-2 flex gap-3 text-[12px] text-[var(--ink-soft)]">
									<span>{tweet.source}</span>
									{tweet.likeCount > 0 ? (
										<span>{formatCompactNumber(tweet.likeCount)} likes</span>
									) : null}
									{tweet.needsReply ? <span>reply open</span> : null}
								</span>
							</span>
						</span>,
						document.body,
					)
				: null}
		</span>
	);
}

function splitReadableForSourceLinks(value: string, count: number) {
	if (count < 2) return null;
	const separators = Array.from(
		value.matchAll(/,\s+and\s+|,\s+or\s+|;\s+|,\s+|\s+and\s+|\s+or\s+/g),
	);
	if (separators.length < count - 1) return null;

	const selected = separators.slice(-(count - 1));
	const parts: Array<{ text: string; separatorAfter: string }> = [];
	let cursor = 0;
	for (const separator of selected) {
		const index = separator.index;
		if (index === undefined) return null;
		const text = value.slice(cursor, index);
		if (!text.trim()) return null;
		parts.push({ text, separatorAfter: separator[0] });
		cursor = index + separator[0].length;
	}

	const lastText = value.slice(cursor);
	if (!lastText.trim()) return null;
	parts.push({ text: lastText, separatorAfter: "" });
	return parts.length === count ? parts : null;
}

type CitationSource = CitationTweet | string;

function citationLink(
	source: CitationSource,
	children: ReactNode,
	key: string,
) {
	return typeof source === "string" ? (
		<TweetSourceLink key={key} href={getFallbackTweetUrl(source)}>
			{children}
		</TweetSourceLink>
	) : (
		<TweetPreviewToken key={key} tweet={source}>
			{children}
		</TweetPreviewToken>
	);
}

function citationLinks(sources: CitationSource[], key: string, start = 0) {
	return sources
		.slice(start)
		.flatMap((source, index) => [
			index > 0 ? ", " : start > 0 ? " " : "",
			citationLink(
				source,
				sources.length === 1 ? "source" : `source ${index + start + 1}`,
				`${key}-source-${index + start}`,
			),
		]);
}

function linkedCitationParts(
	readable: string,
	sources: CitationSource[],
	key: string,
) {
	const first = sources[0];
	if (!first) return [];
	const parts = splitReadableForSourceLinks(readable, sources.length);
	if (!parts)
		return [
			citationLink(first, readable, key),
			...citationLinks(sources, key, 1),
		];
	return parts.flatMap((part, index) => [
		citationLink(sources[index]!, part.text, `${key}-part-${index}`),
		part.separatorAfter,
	]);
}

function linkTrailingCitationText(
	nodes: ReactNode[],
	sources: CitationSource[],
	key: string,
) {
	const first = sources[0];
	const last = nodes.at(-1);
	if (!first || typeof last !== "string") return false;
	// Cached tweets can attach a preview to a quoted phrase; direct links use the clause.
	const quote =
		typeof first === "string" ? null : /(["“][^"”]+["”])(\s*)$/.exec(last);
	if (quote) {
		nodes[nodes.length - 1] = last.slice(0, quote.index);
		nodes.push(
			citationLink(first, quote[1], key),
			...citationLinks(sources, key, 1),
			"",
		);
		return true;
	}
	const bounds = trailingReadableBounds(last, {
		preferClause: sources.length === 1,
	});
	if (!bounds) return false;
	nodes[nodes.length - 1] = last.slice(0, bounds.start);
	const trailing = last.slice(bounds.end);
	nodes.push(
		...linkedCitationParts(last.slice(bounds.start, bounds.end), sources, key),
		/^\s*$/.test(trailing) ? "" : trailing,
	);
	return true;
}

export function renderInline(text: string, lookup: InlineLookup) {
	const pattern =
		/(\[[^\]\n]+\]\s*\(https?:\/\/[^\s)]+\)|\*\*[^*]+\*\*|@[A-Za-z0-9_]{1,20}|\((?:\s*(?:tweet_[A-Za-z0-9_:-]+|\d{12,25})\s*,?)+\)|\btweet_[A-Za-z0-9_:-]+\b|\b\d{12,25}\b)/g;
	const nodes: ReactNode[] = [];
	let cursor = 0;
	let match: RegExpExecArray | null;

	while ((match = pattern.exec(text))) {
		const token = match[0];
		const tokenKey = `${token}-${String(match.index)}`;
		if (match.index > cursor) {
			nodes.push(text.slice(cursor, match.index));
		}
		cursor = match.index + token.length;

		if (token.startsWith("**") && token.endsWith("**")) {
			nodes.push(<strong key={tokenKey}>{token.slice(2, -2)}</strong>);
			continue;
		}

		const markdownLink = /^\[([^\]\n]+)\]\s*\((https?:\/\/[^\s)]+)\)$/.exec(
			token,
		);
		if (markdownLink) {
			const href = safeHttpUrl(markdownLink[2]);
			nodes.push(
				href ? (
					<a
						key={tokenKey}
						className={tweetLinkClass}
						href={href}
						rel="noreferrer"
						target="_blank"
					>
						{markdownLink[1]}
					</a>
				) : (
					markdownLink[1]
				),
			);
			continue;
		}

		if (token.startsWith("@")) {
			const profile = lookup.profilesByHandle.get(token.slice(1).toLowerCase());
			nodes.push(
				profile ? (
					<ProfilePreview key={tokenKey} profile={profile}>
						<span className={tweetMentionClass}>{token}</span>
					</ProfilePreview>
				) : (
					<a
						key={tokenKey}
						className={tweetMentionClass}
						href={`/profiles/${encodeURIComponent(token.slice(1))}`}
					>
						{token}
					</a>
				),
			);
			continue;
		}

		const isParenthesizedTweetRef =
			token.startsWith("(") && token.endsWith(")");
		let references = tweetReferencesFromToken(token);
		if (isParenthesizedTweetRef) {
			const adjacent = adjacentParenthesizedTweetReferences(text, cursor);
			const groupedReferences = [...references, ...adjacent.references];
			if (
				adjacent.references.length > 0 &&
				groupedReferences.every(isNumericTweetReference)
			) {
				references = groupedReferences;
				cursor = adjacent.cursor;
				pattern.lastIndex = cursor;
			}
		}
		const resolvedTweets = references.map((reference) =>
			lookup.tweetsById.get(normalizeTweetReference(reference)),
		);
		const allReferencesResolved =
			references.length > 0 && resolvedTweets.every(Boolean);
		const tweets = resolvedTweets.filter((tweet): tweet is CitationTweet =>
			Boolean(tweet),
		);
		const tweet = tweets[0];
		if (isParenthesizedTweetRef) {
			const sources = allReferencesResolved
				? tweets
				: references.length > 0 && references.every(isNumericTweetReference)
					? references
					: null;
			if (sources) {
				if (!linkTrailingCitationText(nodes, sources, tokenKey))
					nodes.push(...citationLinks(sources, tokenKey));
				cursor = skipRedundantSourceWords(text, cursor);
				continue;
			}
			// A partially resolved group containing nonnumeric archive IDs remains literal.
			if (references.length > 1) {
				nodes.push(token);
				continue;
			}
		}
		nodes.push(
			tweet
				? citationLink(
						tweet,
						isParenthesizedTweetRef ? "source" : token,
						tokenKey,
					)
				: token,
		);
	}

	if (cursor < text.length) {
		nodes.push(text.slice(cursor));
	}

	return nodes.map((node, index) => (
		<Fragment
			key={typeof node === "string" ? `${node}-${String(index)}` : index}
		>
			{node}
		</Fragment>
	));
}

function isProfileAnalysisContext(
	context: CitationContext,
): context is ProfileAnalysisContext {
	return "conversations" in context && "profile" in context;
}

function addLookupTweet(
	tweetsById: Map<string, CitationTweet>,
	profilesByHandle: Map<string, ProfileRecord>,
	tweet: CitationTweet,
) {
	const normalized = normalizeTweetReference(tweet.id);
	tweetsById.set(normalized, tweet);
	tweetsById.set(`tweet_${normalized}`, tweet);
	profilesByHandle.set(tweet.author.toLowerCase(), tweet.authorProfile);
}

function syntheticProfileForConversationTweet(
	tweet: ProfileAnalysisContext["conversations"][number],
): ProfileRecord {
	return {
		id: tweet.profileId,
		handle: tweet.author,
		displayName: tweet.name || tweet.author,
		bio: tweet.bio,
		followersCount: tweet.followersCount,
		avatarHue: 210,
		avatarUrl: tweet.avatarUrl,
		createdAt: tweet.createdAt,
	};
}

function profileAnalysisTweetToCitation(
	tweet: ProfileAnalysisContext["tweets"][number],
	profile: ProfileRecord,
): CitationTweet {
	return {
		id: tweet.id,
		url: tweet.url,
		source: "authored",
		author: profile.handle,
		name: profile.displayName,
		authorProfile: profile,
		createdAt: tweet.createdAt,
		text: tweet.text,
		entities: tweet.entities,
		likeCount: tweet.likeCount,
		liked: false,
		bookmarked: false,
		needsReply: false,
		media: [],
	};
}

function conversationTweetToCitation(
	tweet: ProfileAnalysisContext["conversations"][number],
): CitationTweet {
	const authorProfile = syntheticProfileForConversationTweet(tweet);
	return {
		id: tweet.id,
		url: tweet.url,
		source: "mentions",
		author: tweet.author,
		name: tweet.name || tweet.author,
		authorProfile,
		createdAt: tweet.createdAt,
		text: tweet.text,
		entities: tweet.entities,
		likeCount: tweet.likeCount,
		liked: false,
		bookmarked: false,
		needsReply: false,
		media: [],
	};
}

export function buildLookup(context?: CitationContext | null): InlineLookup {
	const tweetsById = new Map<string, CitationTweet>();
	const profilesByHandle = new Map<string, ProfileRecord>();
	if (!context) {
		return { tweetsById, profilesByHandle };
	}
	if (isProfileAnalysisContext(context)) {
		profilesByHandle.set(context.profile.handle.toLowerCase(), context.profile);
		for (const profile of context.profiles ?? []) {
			profilesByHandle.set(profile.handle.toLowerCase(), profile);
		}
		for (const tweet of context.tweets) {
			addLookupTweet(
				tweetsById,
				profilesByHandle,
				profileAnalysisTweetToCitation(tweet, context.profile),
			);
		}
		for (const tweet of context.conversations) {
			addLookupTweet(
				tweetsById,
				profilesByHandle,
				conversationTweetToCitation(tweet),
			);
		}
		return { tweetsById, profilesByHandle };
	}
	for (const tweet of context.tweets) {
		addLookupTweet(tweetsById, profilesByHandle, tweet);
	}
	return { tweetsById, profilesByHandle };
}
