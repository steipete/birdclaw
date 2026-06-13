import {
	Fragment,
	type MouseEventHandler,
	type ReactNode,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { formatCompactNumber } from "#/lib/present";
import type { PeriodDigestContext } from "#/lib/period-digest";
import type { ProfileAnalysisContext } from "#/lib/profile-analysis";
import { renderTweetPlainText } from "#/lib/tweet-render";
import type { ProfileRecord } from "#/lib/types";
import { cx, tweetLinkClass, tweetMentionClass } from "#/lib/ui";
import { safeHttpUrl } from "#/lib/url-safety";
import { AvatarChip } from "./AvatarChip";
import { ProfilePreview } from "./ProfilePreview";
import { SmartTimestamp } from "./SmartTimestamp";

type CitationTweet = PeriodDigestContext["tweets"][number];
type CitationContext = PeriodDigestContext | ProfileAnalysisContext;
type VerticalBounds = { top: number; bottom: number };

type InlineLookup = {
	tweetsById: Map<string, CitationTweet>;
	profilesByHandle: Map<string, ProfileRecord>;
};

function nearestVerticalClipBounds(element: HTMLElement): VerticalBounds {
	let top = 0;
	let bottom = window.innerHeight;
	for (
		let current = element.parentElement;
		current;
		current = current.parentElement
	) {
		const style = window.getComputedStyle(current);
		if (!/(auto|scroll|hidden|clip)/.test(style.overflowY)) continue;
		const rect = current.getBoundingClientRect();
		top = Math.max(top, rect.top);
		bottom = Math.min(bottom, rect.bottom);
	}
	return { top, bottom };
}

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

function trimBullet(value: string) {
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

function TweetSourceLink({
	children,
	href,
	onClick,
}: {
	children: ReactNode;
	href: string;
	onClick?: MouseEventHandler<HTMLAnchorElement>;
}) {
	return (
		<a
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
	const [open, setOpen] = useState(false);
	const [placeAbove, setPlaceAbove] = useState(false);
	const shellRef = useRef<HTMLSpanElement | null>(null);
	const cardRef = useRef<HTMLSpanElement | null>(null);

	useLayoutEffect(() => {
		if (!open) return;
		const updatePlacement = () => {
			const shell = shellRef.current;
			if (!shell) return;
			const shellRect = shell.getBoundingClientRect();
			const card = cardRef.current;
			const cardRect = card?.getBoundingClientRect();
			const cardHeight = Math.max(
				card?.offsetHeight ?? 0,
				cardRect?.height ?? 0,
				220,
			);
			const bounds = nearestVerticalClipBounds(shell);
			const belowSpace = bounds.bottom - shellRect.bottom;
			const aboveSpace = shellRect.top - bounds.top;
			setPlaceAbove(belowSpace < cardHeight + 18 && aboveSpace >= belowSpace);
		};
		updatePlacement();
		const frame = window.requestAnimationFrame(updatePlacement);
		return () => window.cancelAnimationFrame(frame);
	}, [open]);

	function closePreview() {
		setOpen(false);
	}

	const previewText = renderTweetPlainText(tweet.text, tweet.entities ?? {});

	return (
		<span
			ref={shellRef}
			className="relative inline align-baseline"
			onBlur={closePreview}
			onFocus={() => setOpen(true)}
			onPointerEnter={() => setOpen(true)}
			onPointerLeave={closePreview}
		>
			<TweetSourceLink
				href={getTweetUrl(tweet)}
				onClick={(event) => {
					closePreview();
					event.currentTarget.blur();
				}}
			>
				{children}
			</TweetSourceLink>
			<span
				ref={cardRef}
				aria-hidden={!open}
				className={cx(
					"absolute left-1/2 z-40 w-[360px] -translate-x-1/2 rounded-2xl border border-[var(--line)] bg-[var(--bg-elevated)] p-3 text-left text-[14px] leading-[1.4] text-[var(--ink)] shadow-[0_14px_40px_var(--shadow-strong)]",
					placeAbove ? "bottom-[calc(100%+10px)]" : "top-[calc(100%+10px)]",
					open ? "block" : "hidden",
				)}
			>
				<span className="mb-2 flex items-center gap-2">
					<AvatarChip
						avatarUrl={tweet.authorProfile.avatarUrl}
						hue={tweet.authorProfile.avatarHue}
						name={tweet.name}
						profileId={tweet.authorProfile.id}
						size="small"
					/>
					<span className="min-w-0">
						<span className="block truncate font-bold">{tweet.name}</span>
						<span className="block truncate text-[12px] text-[var(--ink-soft)]">
							@{tweet.author} · <SmartTimestamp value={tweet.createdAt} />
						</span>
					</span>
				</span>
				<span className="line-clamp-6 whitespace-pre-wrap [overflow-wrap:anywhere]">
					{previewText}
				</span>
				<span className="mt-2 flex gap-3 text-[12px] text-[var(--ink-soft)]">
					<span>{tweet.source}</span>
					{tweet.likeCount > 0 ? (
						<span>{formatCompactNumber(tweet.likeCount)} likes</span>
					) : null}
					{tweet.needsReply ? <span>reply open</span> : null}
				</span>
			</span>
		</span>
	);
}

function additionalDirectCitationLinks(references: string[], key: string) {
	return references.slice(1).flatMap((reference, index) => [
		index === 0 ? " " : ", ",
		<TweetSourceLink
			key={`${key}-direct-source-${String(index + 2)}`}
			href={getFallbackTweetUrl(reference)}
		>
			{`source ${String(index + 2)}`}
		</TweetSourceLink>,
	]);
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

function linkedCitationParts(
	readable: string,
	tweets: CitationTweet[],
	key: string,
) {
	const parts = splitReadableForSourceLinks(readable, tweets.length);
	if (!parts) {
		const tweet = tweets[0];
		if (!tweet) return [];
		return [
			<TweetPreviewToken key={key} tweet={tweet}>
				{readable}
			</TweetPreviewToken>,
			...additionalCitationLinks(tweets, key),
		];
	}
	return parts.flatMap((part, index) => {
		const tweet = tweets[index];
		if (!tweet) return [];
		return [
			<TweetPreviewToken key={`${key}-part-${String(index)}`} tweet={tweet}>
				{part.text}
			</TweetPreviewToken>,
			part.separatorAfter,
		];
	});
}

function linkedDirectCitationParts(
	readable: string,
	references: string[],
	key: string,
) {
	const parts = splitReadableForSourceLinks(readable, references.length);
	if (!parts) {
		const reference = references[0];
		if (!reference) return [];
		return [
			<TweetSourceLink key={key} href={getFallbackTweetUrl(reference)}>
				{readable}
			</TweetSourceLink>,
			...additionalDirectCitationLinks(references, key),
		];
	}
	return parts.flatMap((part, index) => {
		const reference = references[index];
		if (!reference) return [];
		return [
			<TweetSourceLink
				key={`${key}-direct-part-${String(index)}`}
				href={getFallbackTweetUrl(reference)}
			>
				{part.text}
			</TweetSourceLink>,
			part.separatorAfter,
		];
	});
}

function additionalCitationLinks(tweets: CitationTweet[], key: string) {
	return tweets.slice(1).flatMap((tweet, index) => [
		index === 0 ? " " : ", ",
		<TweetPreviewToken key={`${key}-source-${String(index + 2)}`} tweet={tweet}>
			{`source ${String(index + 2)}`}
		</TweetPreviewToken>,
	]);
}

function fallbackCitationLinks(tweets: CitationTweet[], key: string) {
	return tweets.flatMap((tweet, index) => [
		index === 0 ? "" : ", ",
		<TweetPreviewToken
			key={`${key}-fallback-${String(index + 1)}`}
			tweet={tweet}
		>
			{tweets.length === 1 ? "source" : `source ${String(index + 1)}`}
		</TweetPreviewToken>,
	]);
}

function linkTrailingCitationText(
	nodes: ReactNode[],
	tweets: CitationTweet[],
	key: string,
) {
	const tweet = tweets[0];
	if (!tweet) return false;
	const last = nodes.at(-1);
	if (typeof last !== "string") return false;

	const match = /(["“][^"”]+["”])(\s*)$/.exec(last);
	if (match) {
		const quoted = match[1];
		const trailing = match[2] ?? "";
		const before = last.slice(0, match.index);
		nodes[nodes.length - 1] = before;
		nodes.push(
			<TweetPreviewToken key={key} tweet={tweet}>
				{quoted}
			</TweetPreviewToken>,
			...additionalCitationLinks(tweets, key),
			/^\s*$/.test(trailing) ? "" : trailing,
		);
		return true;
	}

	const bounds = trailingReadableBounds(last, {
		preferClause: tweets.length === 1,
	});
	if (!bounds) return false;

	const before = last.slice(0, bounds.start);
	const readable = last.slice(bounds.start, bounds.end);
	const trailing = last.slice(bounds.end);
	nodes[nodes.length - 1] = before;
	nodes.push(
		...linkedCitationParts(readable, tweets, key),
		/^\s*$/.test(trailing) ? "" : trailing,
	);
	return true;
}

function linkTrailingDirectCitationText(
	nodes: ReactNode[],
	references: string[],
	key: string,
) {
	const reference = references[0];
	if (!reference) return false;
	const last = nodes.at(-1);
	if (typeof last !== "string") return false;
	const bounds = trailingReadableBounds(last, {
		preferClause: references.length === 1,
	});
	if (!bounds) return false;

	const before = last.slice(0, bounds.start);
	const readable = last.slice(bounds.start, bounds.end);
	const trailing = last.slice(bounds.end);
	nodes[nodes.length - 1] = before;
	nodes.push(
		...linkedDirectCitationParts(readable, references, key),
		/^\s*$/.test(trailing) ? "" : trailing,
	);
	return true;
}

function renderInline(text: string, lookup: InlineLookup) {
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
		if (
			isParenthesizedTweetRef &&
			references.length > 1 &&
			!allReferencesResolved
		) {
			if (references.every(isNumericTweetReference)) {
				const cursorAfterSourceWords = skipRedundantSourceWords(text, cursor);
				if (linkTrailingDirectCitationText(nodes, references, tokenKey)) {
					cursor = cursorAfterSourceWords;
					continue;
				}
				nodes.push(
					...references.flatMap((reference, index) => [
						index === 0 ? "" : ", ",
						<TweetSourceLink
							key={`${tokenKey}-direct-${String(index)}`}
							href={getFallbackTweetUrl(reference)}
						>
							{`source ${String(index + 1)}`}
						</TweetSourceLink>,
					]),
				);
				cursor = cursorAfterSourceWords;
				continue;
			}
			nodes.push(token);
			continue;
		}
		if (
			tweet &&
			isParenthesizedTweetRef &&
			allReferencesResolved &&
			linkTrailingCitationText(nodes, tweets, tokenKey)
		) {
			cursor = skipRedundantSourceWords(text, cursor);
			continue;
		}
		if (tweet && isParenthesizedTweetRef && allReferencesResolved) {
			nodes.push(...fallbackCitationLinks(tweets, tokenKey));
			cursor = skipRedundantSourceWords(text, cursor);
			continue;
		}
		if (tweet) {
			nodes.push(
				<TweetPreviewToken key={tokenKey} tweet={tweet}>
					{isParenthesizedTweetRef ? "source" : token}
				</TweetPreviewToken>,
			);
		} else if (
			isParenthesizedTweetRef &&
			references.length === 1 &&
			isNumericTweetReference(references[0] ?? "")
		) {
			const cursorAfterSourceWords = skipRedundantSourceWords(text, cursor);
			if (linkTrailingDirectCitationText(nodes, references, tokenKey)) {
				cursor = cursorAfterSourceWords;
				continue;
			}
			nodes.push(
				<TweetSourceLink
					key={`${tokenKey}-direct`}
					href={getFallbackTweetUrl(references[0])}
				>
					source
				</TweetSourceLink>,
			);
			cursor = cursorAfterSourceWords;
			continue;
		} else {
			nodes.push(token);
		}
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
	};
}

function buildLookup(context?: CitationContext | null): InlineLookup {
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

export function MarkdownViewer({
	markdown,
	context,
	className,
}: {
	markdown: string;
	context?: CitationContext | null;
	className?: string;
}) {
	const lookup = buildLookup(context);
	const normalizedMarkdown = markdown.replace(
		/\]\s*\r?\n\s*\((https?:\/\/[^\s)]+)\)/g,
		"]($1)",
	);
	const lines = normalizedMarkdown.split(/\r?\n/);
	const nodes: ReactNode[] = [];
	let listItems: ReactNode[][] = [];

	const flushList = () => {
		if (listItems.length === 0) return;
		nodes.push(
			<ul
				className="my-2.5 flex list-disc flex-col gap-1.5 pl-5 first:mt-0 marker:text-[var(--ink-soft)]"
				key={`list-${String(nodes.length)}`}
			>
				{listItems.map((item, index) => (
					<li key={String(index)}>{item}</li>
				))}
			</ul>,
		);
		listItems = [];
	};

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) {
			flushList();
			continue;
		}
		if (trimmed.startsWith("### ")) {
			flushList();
			nodes.push(
				<h3
					className="mt-5 mb-1.5 text-[14px] font-bold uppercase tracking-wide text-[var(--ink-soft)] first:mt-0"
					key={`h3-${String(nodes.length)}`}
				>
					{renderInline(trimmed.slice(4), lookup)}
				</h3>,
			);
			continue;
		}
		if (trimmed.startsWith("## ")) {
			flushList();
			nodes.push(
				<h2
					className="mt-6 mb-2 text-[18px] font-bold text-[var(--ink)] first:mt-0"
					key={`h2-${String(nodes.length)}`}
				>
					{renderInline(trimmed.slice(3), lookup)}
				</h2>,
			);
			continue;
		}
		if (trimmed.startsWith("# ")) {
			flushList();
			nodes.push(
				<h1
					className="mt-0 mb-2.5 text-[20px] font-bold text-[var(--ink)]"
					key={`h1-${String(nodes.length)}`}
				>
					{renderInline(trimmed.slice(2), lookup)}
				</h1>,
			);
			continue;
		}
		if (/^[-*]\s+/.test(trimmed)) {
			listItems.push(renderInline(trimBullet(trimmed), lookup));
			continue;
		}
		flushList();
		nodes.push(
			<p
				className="my-2.5 whitespace-pre-wrap first:mt-0 [overflow-wrap:anywhere]"
				key={`p-${String(nodes.length)}`}
			>
				{renderInline(trimmed, lookup)}
			</p>,
		);
	}
	flushList();

	return (
		<article
			className={cx(
				"max-w-none px-4 py-3 text-[15px] leading-[1.55] text-[var(--ink)]",
				className,
			)}
		>
			{nodes}
		</article>
	);
}
