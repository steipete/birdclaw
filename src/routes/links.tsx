import { createFileRoute } from "@tanstack/react-router";
import {
	ChevronDown,
	ChevronUp,
	ExternalLink,
	MessageCircle,
	Play,
	Repeat2,
	Search,
	Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AvatarChip } from "#/components/AvatarChip";
import {
	FeedEmpty,
	FeedError,
	FeedLoading,
	LinkSkeletonRows,
} from "#/components/FeedState";
import { ProfilePreview } from "#/components/ProfilePreview";
import { SmartTimestamp } from "#/components/SmartTimestamp";
import { formatCompactNumber } from "#/lib/present";
import type {
	LinkInsightItem,
	LinkInsightKind,
	LinkInsightMention,
	LinkInsightRange,
	LinkInsightResponse,
	LinkInsightSort,
	LinkInsightSource,
	ProfileRecord,
	TweetMediaItem,
} from "#/lib/types";
import {
	cx,
	pageHeaderClass,
	pageHeaderRowClass,
	pageSubtitleClass,
	pageTitleClass,
	searchFieldIconClass,
	searchFieldInputClass,
	searchFieldShellClass,
	secondaryButtonClass,
	segmentActiveClass,
	segmentClass,
	segmentedClass,
} from "#/lib/ui";

export const Route = createFileRoute("/links")({
	component: LinksRoute,
});

const INITIAL_VISIBLE_COMMENTS = 3;
const MORE_COMMENTS_BATCH = 6;
const LINK_INSIGHTS_LIMIT = 30;
const LINK_INSIGHTS_COMMENTS_LIMIT = 30;
const PROFILE_HYDRATION_LIMIT = 30;
const PROFILE_HYDRATION_DELAY_MS = 1200;

const ranges: Array<{ value: LinkInsightRange; label: string }> = [
	{ value: "today", label: "Today" },
	{ value: "week", label: "Week" },
	{ value: "month", label: "Month" },
	{ value: "year", label: "Year" },
	{ value: "all", label: "All" },
];

function itemTitle(item: LinkInsightItem) {
	return item.title?.trim() || item.displayUrl;
}

function itemSubtitle(item: LinkInsightItem) {
	const description = item.description?.trim();
	if (description) {
		return description;
	}
	return item.displayUrl.split("?")[0] || item.displayUrl;
}

function insightCacheKey(
	kind: LinkInsightKind,
	range: LinkInsightRange,
	sort: LinkInsightSort,
	source: LinkInsightSource,
	refreshTick: number,
) {
	return `${kind}:${range}:${sort}:${source}:${refreshTick}`;
}

function linkInsightsUrl(
	kind: LinkInsightKind,
	range: LinkInsightRange,
	sort: LinkInsightSort,
	source: LinkInsightSource,
	refreshTick: number,
) {
	const url = new URL("/api/link-insights", window.location.origin);
	url.searchParams.set("kind", kind);
	url.searchParams.set("range", range);
	url.searchParams.set("sort", sort);
	url.searchParams.set("source", source);
	url.searchParams.set("limit", String(LINK_INSIGHTS_LIMIT));
	url.searchParams.set("commentsLimit", String(LINK_INSIGHTS_COMMENTS_LIMIT));
	url.searchParams.set("refresh", String(refreshTick));
	return url;
}

function mentionHref(mention: LinkInsightMention, item: LinkInsightItem) {
	return mention.sourceUrl || mention.contentTweetUrl || item.url;
}

function mentionCopy(mention: LinkInsightMention) {
	return (
		mention.commentText ||
		mention.sharedContentText ||
		mention.rawText ||
		"Shared without comment"
	);
}

function isSameProfile(
	left: ProfileRecord | null | undefined,
	right: ProfileRecord | null | undefined,
) {
	return Boolean(left && right && left.id === right.id);
}

function mediaImage(media: TweetMediaItem[]) {
	return media.find((item) => item.thumbnailUrl || item.url) ?? null;
}

function youtubeVideoId(rawUrl: string) {
	try {
		const url = new URL(rawUrl);
		const host = url.hostname.toLowerCase().replace(/^www\./, "");
		if (host === "youtu.be") {
			return url.pathname.split("/").filter(Boolean)[0] ?? null;
		}
		if (!host.endsWith("youtube.com")) {
			return null;
		}
		if (url.pathname === "/watch") {
			return url.searchParams.get("v");
		}
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts[0] === "embed" || parts[0] === "shorts" || parts[0] === "live") {
			return parts[1] ?? null;
		}
		return null;
	} catch {
		return null;
	}
}

function youtubeThumbnailUrl(rawUrl: string) {
	const id = youtubeVideoId(rawUrl);
	if (!id || !/^[\w-]{6,}$/.test(id)) {
		return null;
	}
	return `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
}

function commentCount(item: LinkInsightItem) {
	return (
		item.commentCount ??
		item.mentions.filter((mention) => mention.hasComment).length
	);
}

function pureShareCount(item: LinkInsightItem) {
	return (
		item.pureShareCount ??
		item.mentions.filter(
			(mention) => mention.isPureShare || !mention.hasComment,
		).length
	);
}

function isArchivePlaceholderProfile(profile: ProfileRecord) {
	return (
		/^id\d+$/i.test(profile.handle) &&
		profile.displayName === profile.handle &&
		profile.id === `profile_user_${profile.handle.slice(2)}`
	);
}

function profileNeedsHydration(profile: ProfileRecord | null | undefined) {
	if (!profile?.handle || isArchivePlaceholderProfile(profile)) {
		return false;
	}
	return !profile.avatarUrl || profile.followersCount === 0;
}

function collectProfilesForHydration(data: LinkInsightResponse | null) {
	const handles = new Set<string>();
	for (const item of data?.items ?? []) {
		for (const profile of [
			item.topSharer,
			...item.sharers,
			...item.mentions.flatMap((mention) => [
				mention.sharedBy,
				mention.contentAuthor,
				mention.participant,
			]),
		]) {
			if (!profile || !profileNeedsHydration(profile)) {
				continue;
			}
			handles.add(profile.handle.replace(/^@/, ""));
			if (handles.size >= PROFILE_HYDRATION_LIMIT) {
				return [...handles];
			}
		}
	}
	return [...handles];
}

function ProfilePill({
	profile,
	className,
}: {
	profile: ProfileRecord | null | undefined;
	className?: string;
}) {
	if (!profile) {
		return (
			<span className={cx("text-[var(--ink-soft)]", className)}>unknown</span>
		);
	}
	return (
		<ProfilePreview profile={profile}>
			<span
				className={cx("font-bold text-[var(--ink)] hover:underline", className)}
			>
				@{profile.handle}
			</span>
		</ProfilePreview>
	);
}

function SharerStrip({ item }: { item: LinkInsightItem }) {
	const itemSharers = item.sharers ?? [];
	const sharers =
		itemSharers.length > 0
			? itemSharers
			: item.topSharer
				? [item.topSharer]
				: [];
	const visible = sharers.slice(0, 5);
	const hidden = Math.max(0, item.uniqueSharers - visible.length);

	if (visible.length === 0) {
		return <span>top unknown</span>;
	}

	return (
		<div className="group/sharers relative z-10 inline-flex items-center gap-1 hover:z-50 focus-within:z-50">
			<div className="flex -space-x-2">
				{visible.slice(0, 4).map((profile) => (
					<a
						aria-label={`Open @${profile.handle}`}
						className="inline-flex rounded-full bg-[var(--bg)] ring-2 ring-[var(--bg)]"
						href={`https://x.com/${profile.handle}`}
						key={profile.id}
						rel="noreferrer"
						target="_blank"
					>
						<AvatarChip
							avatarUrl={profile.avatarUrl}
							hue={profile.avatarHue}
							name={profile.displayName}
							profileId={profile.id}
							size="small"
						/>
					</a>
				))}
			</div>
			<span className="inline-flex items-center gap-1 text-[13px] text-[var(--ink-soft)]">
				<span>top</span>
				<a
					className="font-medium text-[var(--ink-soft)] hover:underline"
					href={`https://x.com/${visible[0]?.handle ?? ""}`}
					rel="noreferrer"
					target="_blank"
				>
					@{visible[0]?.handle}
				</a>
			</span>
			{hidden > 0 ? (
				<span className="text-[13px] text-[var(--ink-soft)]">
					+{formatCompactNumber(hidden)}
				</span>
			) : null}
			<div className="pointer-events-none absolute left-0 top-[calc(100%+8px)] z-[80] grid w-[280px] translate-y-1 gap-2 rounded-2xl border border-[var(--line)] bg-[var(--bg-elevated)] p-3 opacity-0 shadow-[0_8px_28px_var(--shadow-strong)] transition-all duration-150 group-hover/sharers:pointer-events-auto group-hover/sharers:translate-y-0 group-hover/sharers:opacity-100 group-focus-within/sharers:pointer-events-auto group-focus-within/sharers:translate-y-0 group-focus-within/sharers:opacity-100">
				<div className="flex items-center gap-2 text-[13px] font-bold text-[var(--ink)]">
					<Users className="size-4" />
					<span>{formatCompactNumber(item.uniqueSharers)} sharers</span>
				</div>
				<div className="grid gap-2">
					{visible.map((profile) => (
						<a
							className="flex min-w-0 items-center gap-2 rounded-xl p-1 transition-colors hover:bg-[var(--bg-hover)]"
							href={`https://x.com/${profile.handle}`}
							key={profile.id}
							rel="noreferrer"
							target="_blank"
						>
							<AvatarChip
								avatarUrl={profile.avatarUrl}
								hue={profile.avatarHue}
								name={profile.displayName}
								profileId={profile.id}
								size="small"
							/>
							<span className="min-w-0">
								<span className="block truncate text-[14px] font-bold text-[var(--ink)]">
									{profile.displayName}
								</span>
								<span className="block truncate text-[13px] text-[var(--ink-soft)]">
									@{profile.handle} /{" "}
									{formatCompactNumber(profile.followersCount)} followers
								</span>
							</span>
						</a>
					))}
				</div>
			</div>
		</div>
	);
}

function SourceActions({
	item,
	mention,
}: {
	item: LinkInsightItem;
	mention: LinkInsightMention;
}) {
	const links = [
		mention.sourceUrl
			? {
					href: mention.sourceUrl,
					label: mention.sourceKind === "dm" ? "Open DM" : "Open tweet",
				}
			: null,
		mention.contentTweetUrl
			? { href: mention.contentTweetUrl, label: "Open source tweet" }
			: null,
		{ href: item.url, label: "Open link" },
	].filter(Boolean) as Array<{ href: string; label: string }>;

	return (
		<div className="flex flex-wrap items-center gap-3 text-[13px]">
			{links.map((link) => (
				<a
					key={`${link.label}:${link.href}`}
					className="inline-flex items-center gap-1 font-semibold text-[var(--accent)] hover:underline"
					href={link.href}
					rel="noreferrer"
					target="_blank"
				>
					<span>{link.label}</span>
					<ExternalLink className="size-3.5" />
				</a>
			))}
		</div>
	);
}

function MentionCard({
	item,
	mention,
}: {
	item: LinkInsightItem;
	mention: LinkInsightMention;
}) {
	const image = mediaImage(mention.media);
	const href = mentionHref(mention, item);
	const contentAuthor =
		mention.contentAuthor &&
		!isSameProfile(mention.sharedBy, mention.contentAuthor)
			? mention.contentAuthor
			: null;

	return (
		<article className="grid gap-2 rounded-2xl border border-[var(--line)] bg-[var(--bg)] px-3 py-2.5">
			<div className="flex min-w-0 items-center gap-2 text-[13px] text-[var(--ink-soft)]">
				<ProfilePill profile={mention.sharedBy} />
				<span>{mention.sourceLabel ?? mention.sourceKind}</span>
				<span>/</span>
				<a
					className="hover:underline"
					href={href}
					rel="noreferrer"
					target="_blank"
				>
					<SmartTimestamp value={mention.createdAt} />
				</a>
			</div>
			<p className="m-0 whitespace-pre-wrap text-[14px] leading-[1.45] text-[var(--ink)] [overflow-wrap:anywhere]">
				{mentionCopy(mention)}
			</p>
			{contentAuthor ? (
				<div className="text-[13px] text-[var(--ink-soft)]">
					source by <ProfilePill profile={contentAuthor} />
				</div>
			) : null}
			{image ? (
				<a
					className="block max-w-[220px] overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--bg-active)]"
					href={href}
					rel="noreferrer"
					target="_blank"
				>
					<img
						alt={image.altText || "Mention media"}
						className="aspect-video h-auto w-full object-cover"
						src={image.thumbnailUrl || image.url}
					/>
				</a>
			) : null}
			<SourceActions item={item} mention={mention} />
		</article>
	);
}

function PureShareCluster({
	item,
	mentions,
}: {
	item: LinkInsightItem;
	mentions: LinkInsightMention[];
}) {
	const profiles = mentions
		.map((mention) => mention.sharedBy)
		.filter(Boolean) as ProfileRecord[];
	const visible = profiles.slice(0, 6);
	const firstSource = mentions.find((mention) => mention.sourceUrl)?.sourceUrl;

	return (
		<div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--line)] bg-[var(--bg-hover)] px-3 py-2.5">
			<div className="flex min-w-0 items-center gap-2">
				<div className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--bg-active)] text-[var(--ink-soft)]">
					<Repeat2 className="size-4" />
				</div>
				<div className="min-w-0">
					<div className="text-[14px] font-bold text-[var(--ink)]">
						{formatCompactNumber(pureShareCount(item))} shares without comment
					</div>
					<div className="flex min-w-0 flex-wrap items-center gap-1 text-[13px] text-[var(--ink-soft)]">
						{visible.map((profile) => (
							<ProfilePill key={profile.id} profile={profile} />
						))}
						{pureShareCount(item) > visible.length ? (
							<span>
								+{formatCompactNumber(pureShareCount(item) - visible.length)}{" "}
								more
							</span>
						) : null}
					</div>
				</div>
			</div>
			{firstSource ? (
				<a
					className="inline-flex items-center gap-1 text-[13px] font-semibold text-[var(--accent)] hover:underline"
					href={firstSource}
					rel="noreferrer"
					target="_blank"
				>
					<span>Open first source</span>
					<ExternalLink className="size-3.5" />
				</a>
			) : null}
		</div>
	);
}

function CommentsSection({ item }: { item: LinkInsightItem }) {
	const [expanded, setExpanded] = useState(false);
	const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COMMENTS);
	const comments = item.mentions.filter((mention) => mention.hasComment);
	const pureShares = item.mentions.filter(
		(mention) => mention.isPureShare || !mention.hasComment,
	);
	const itemCommentCount = commentCount(item);
	const itemPureShareCount = pureShareCount(item);
	const totalDiscussion = itemCommentCount + itemPureShareCount;
	const visibleComments = comments.slice(0, visibleCount);
	const remainingLocalComments = Math.max(0, comments.length - visibleCount);
	const remainingComments = Math.max(
		0,
		itemCommentCount - visibleComments.length,
	);

	if (totalDiscussion === 0) {
		return null;
	}

	return (
		<div className="mt-2 grid gap-2 border-t border-[var(--line)] pt-2">
			<button
				className="inline-flex w-fit items-center gap-1 rounded-full border-0 bg-transparent px-2 py-1 text-[13px] font-bold text-[var(--accent)] transition-colors hover:bg-[var(--accent-soft)]"
				onClick={() => setExpanded((value) => !value)}
				type="button"
			>
				<MessageCircle className="size-4" />
				<span>
					{expanded ? "Hide" : "Show"} {formatCompactNumber(itemCommentCount)}{" "}
					comments
					{itemPureShareCount > 0
						? ` / ${formatCompactNumber(itemPureShareCount)} shares`
						: ""}
				</span>
				{expanded ? (
					<ChevronUp className="size-4" />
				) : (
					<ChevronDown className="size-4" />
				)}
			</button>
			{expanded ? (
				<div className="grid gap-2">
					{visibleComments.map((mention) => (
						<MentionCard key={mention.id} item={item} mention={mention} />
					))}
					{remainingLocalComments > 0 ? (
						<button
							className={cx(secondaryButtonClass, "w-fit")}
							onClick={() =>
								setVisibleCount((value) => value + MORE_COMMENTS_BATCH)
							}
							type="button"
						>
							Show{" "}
							{formatCompactNumber(
								Math.min(MORE_COMMENTS_BATCH, remainingLocalComments),
							)}{" "}
							more
						</button>
					) : null}
					{remainingComments > 0 && remainingLocalComments === 0 ? (
						<div className="rounded-2xl border border-[var(--line)] bg-[var(--bg-hover)] px-3 py-2 text-[13px] text-[var(--ink-soft)]">
							{formatCompactNumber(remainingComments)} more mentions in archive.
							Narrow the range or raise the API limit to inspect them.
						</div>
					) : null}
					{itemPureShareCount > 0 ? (
						<PureShareCluster item={item} mentions={pureShares} />
					) : null}
				</div>
			) : null}
		</div>
	);
}

function VideoPreview({ item }: { item: LinkInsightItem }) {
	if (item.kind !== "videos") {
		return null;
	}
	const image = mediaImage(item.mentions.flatMap((mention) => mention.media));
	const thumbnailUrl =
		image?.thumbnailUrl || image?.url || youtubeThumbnailUrl(item.url);

	return (
		<a
			className="mt-2 flex max-w-md items-center gap-3 overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--bg-hover)] transition-colors hover:bg-[var(--bg-active)]"
			href={item.url}
			rel="noreferrer"
			target="_blank"
		>
			<div className="relative grid aspect-video w-36 shrink-0 place-items-center overflow-hidden bg-[var(--bg-active)] text-[var(--ink-soft)]">
				{thumbnailUrl ? (
					<img
						alt={image?.altText || itemTitle(item)}
						className="h-full w-full object-cover transition-transform duration-150 hover:scale-105"
						src={thumbnailUrl}
					/>
				) : (
					<Play className="size-6" />
				)}
				<div className="absolute inset-0 grid place-items-center bg-black/20">
					<span className="grid size-9 place-items-center rounded-full bg-black/70 text-white shadow-[0_4px_18px_rgba(0,0,0,0.35)]">
						<Play className="ml-0.5 size-4 fill-current" />
					</span>
				</div>
			</div>
			<div className="min-w-0 py-2 pr-3">
				<div className="truncate text-[13px] font-bold text-[var(--ink)]">
					{itemTitle(item)}
				</div>
				<div className="truncate text-[13px] text-[var(--ink-soft)]">
					{item.displayUrl}
				</div>
			</div>
		</a>
	);
}

function LinkInsightRow({
	index,
	item,
}: {
	index: number;
	item: LinkInsightItem;
}) {
	return (
		<article
			className="flex flex-col gap-2 border-b border-[var(--line)] px-4 py-3 transition-colors duration-150 hover:bg-[var(--bg-hover)]"
			data-perf="link-insight-row"
		>
			<div className="flex items-start gap-3">
				<div className="grid size-9 shrink-0 place-items-center rounded-full bg-[var(--bg-active)] text-[14px] font-bold text-[var(--ink-soft)]">
					{index + 1}
				</div>
				<div className="min-w-0 flex-1">
					<a
						className="block break-words text-[15px] font-bold text-[var(--ink)] [overflow-wrap:anywhere] hover:underline"
						href={item.url}
						rel="noreferrer"
						target="_blank"
					>
						{itemTitle(item)}
					</a>
					<p className="mt-0.5 truncate text-[13px] text-[var(--ink-soft)]">
						{itemSubtitle(item)}
					</p>
					<div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-[var(--ink-soft)]">
						<span>{item.host}</span>
						<span>/</span>
						<span>{formatCompactNumber(item.shareCount)} shares</span>
						<span>/</span>
						<span>{formatCompactNumber(item.uniqueSharers)} sharers</span>
						<span>/</span>
						<span>{formatCompactNumber(commentCount(item))} comments</span>
						<span>/</span>
						<SharerStrip item={item} />
						<span>/</span>
						<SmartTimestamp value={item.lastSeenAt} />
					</div>
					<VideoPreview item={item} />
				</div>
			</div>
			<CommentsSection item={item} />
		</article>
	);
}

function LinksRoute() {
	const [kind, setKind] = useState<LinkInsightKind>("links");
	const [range, setRange] = useState<LinkInsightRange>("week");
	const [source, setSource] = useState<LinkInsightSource>("all");
	const [sort, setSort] = useState<LinkInsightSort>("rank");
	const [search, setSearch] = useState("");
	const [refreshTick, setRefreshTick] = useState(0);
	const hydratedHandlesRef = useRef(new Set<string>());
	const cacheRef = useRef(new Map<string, LinkInsightResponse>());
	const inFlightRef = useRef(new Set<string>());
	const mountedRef = useRef(true);
	const [errorByKey, setErrorByKey] = useState<Record<string, string>>({});
	const [, bumpCacheVersion] = useState(0);
	const currentCacheKey = insightCacheKey(
		kind,
		range,
		sort,
		source,
		refreshTick,
	);
	const data = cacheRef.current.get(currentCacheKey) ?? null;
	const error = errorByKey[currentCacheKey] ?? null;
	const loading = !data && !error;

	useEffect(() => {
		return () => {
			mountedRef.current = false;
		};
	}, []);

	const fetchInsights = useCallback(
		(fetchKind: LinkInsightKind) => {
			const key = insightCacheKey(fetchKind, range, sort, source, refreshTick);
			if (cacheRef.current.has(key) || inFlightRef.current.has(key)) {
				return;
			}
			inFlightRef.current.add(key);
			setErrorByKey((current) => {
				const rest = { ...current };
				delete rest[key];
				return rest;
			});
			fetch(linkInsightsUrl(fetchKind, range, sort, source, refreshTick))
				.then((response) => response.json())
				.then((response: LinkInsightResponse) => {
					cacheRef.current.set(key, response);
					if (mountedRef.current) {
						bumpCacheVersion((value) => value + 1);
					}
				})
				.catch((error: unknown) => {
					if (error instanceof DOMException && error.name === "AbortError") {
						return;
					}
					if (!mountedRef.current) {
						return;
					}
					console.warn("Link insights failed", error);
					setErrorByKey((current) => ({
						...current,
						[key]:
							error instanceof Error
								? error.message
								: "Link insights unavailable",
					}));
				})
				.finally(() => {
					inFlightRef.current.delete(key);
				});
		},
		[range, refreshTick, sort, source],
	);

	useEffect(() => {
		fetchInsights(kind);
	}, [fetchInsights, kind]);

	useEffect(() => {
		if (!data) {
			return;
		}
		const prefetchKind = kind === "links" ? "videos" : "links";
		const timer = window.setTimeout(() => fetchInsights(prefetchKind), 250);
		return () => window.clearTimeout(timer);
	}, [data, fetchInsights, kind]);

	useEffect(() => {
		const handles = collectProfilesForHydration(data).filter(
			(handle) => !hydratedHandlesRef.current.has(handle.toLowerCase()),
		);
		if (handles.length === 0) {
			return;
		}

		const controller = new AbortController();
		const url = new URL("/api/profile-hydrate", window.location.origin);
		url.searchParams.set("handles", handles.join(","));
		for (const handle of handles) {
			hydratedHandlesRef.current.add(handle.toLowerCase());
		}

		let idleId: number | null = null;
		const runHydration = () => {
			fetch(url, { signal: controller.signal })
				.then((response) => response.json())
				.then((response: { hydratedProfiles?: number }) => {
					if ((response.hydratedProfiles ?? 0) > 0) {
						setRefreshTick((value) => value + 1);
					}
				})
				.catch((error: unknown) => {
					if (error instanceof DOMException && error.name === "AbortError") {
						return;
					}
					console.warn("Profile hydration failed", error);
				});
		};
		const timer = window.setTimeout(() => {
			if ("requestIdleCallback" in window) {
				idleId = window.requestIdleCallback(runHydration, { timeout: 2500 });
			} else {
				runHydration();
			}
		}, PROFILE_HYDRATION_DELAY_MS);

		return () => {
			controller.abort();
			window.clearTimeout(timer);
			if (idleId !== null && "cancelIdleCallback" in window) {
				window.cancelIdleCallback(idleId);
			}
		};
	}, [data]);

	const items = useMemo(() => {
		const query = search.trim().toLowerCase();
		const filtered = (data?.items ?? []).filter((item) => {
			if (!query) {
				return true;
			}
			return [
				item.title,
				item.description,
				item.displayUrl,
				item.host,
				item.topSharer?.handle,
				...item.mentions.map((mention) => mention.commentText),
			]
				.filter(Boolean)
				.some((value) => String(value).toLowerCase().includes(query));
		});
		return filtered;
	}, [data?.items, search]);

	const subtitle = useMemo(() => {
		if (!data) {
			return "Loading link memory...";
		}
		const label = kind === "videos" ? "video URLs" : "URLs";
		return `${formatCompactNumber(data.stats.occurrences)} ${label} across ${formatCompactNumber(data.stats.groups)} groups`;
	}, [data, kind]);

	return (
		<>
			<header className={pageHeaderClass}>
				<div className={pageHeaderRowClass}>
					<div className="flex min-w-0 flex-col">
						<h1 className={pageTitleClass}>Links</h1>
						<p className={pageSubtitleClass}>{subtitle}</p>
					</div>
				</div>
				<div className="flex flex-wrap items-center gap-2 px-4 pb-3">
					<label className={cx(searchFieldShellClass, "min-w-[180px] flex-1")}>
						<Search className={searchFieldIconClass} strokeWidth={2} />
						<input
							className={searchFieldInputClass}
							onChange={(event) => setSearch(event.target.value)}
							placeholder="Search links"
							value={search}
						/>
					</label>
					<div className={segmentedClass}>
						{(["links", "videos"] as const).map((value) => (
							<button
								key={value}
								className={cx(
									segmentClass,
									kind === value && segmentActiveClass,
								)}
								onClick={() => setKind(value)}
								type="button"
							>
								{value}
							</button>
						))}
					</div>
					<div className={segmentedClass}>
						{ranges.map((entry) => (
							<button
								key={entry.value}
								className={cx(
									segmentClass,
									range === entry.value && segmentActiveClass,
								)}
								onClick={() => setRange(entry.value)}
								type="button"
							>
								{entry.label}
							</button>
						))}
					</div>
					<div className={segmentedClass}>
						{(["all", "tweet", "dm"] as const).map((value) => (
							<button
								key={value}
								className={cx(
									segmentClass,
									source === value && segmentActiveClass,
								)}
								onClick={() => setSource(value)}
								type="button"
							>
								{value}
							</button>
						))}
					</div>
					<div className={segmentedClass}>
						{(["rank", "recent", "comments"] as const).map((value) => (
							<button
								key={value}
								className={cx(
									segmentClass,
									sort === value && segmentActiveClass,
								)}
								onClick={() => setSort(value)}
								type="button"
							>
								{value}
							</button>
						))}
					</div>
				</div>
			</header>

			<section className="flex flex-col">
				{loading ? (
					<FeedLoading
						detail="Ranking URLs and collecting local discussion"
						label="Loading links"
					>
						<LinkSkeletonRows />
					</FeedLoading>
				) : error ? (
					<FeedError
						action={
							<button
								className="rounded-full bg-[var(--accent)] px-4 py-1.5 text-[14px] font-bold text-white"
								onClick={() => setRefreshTick((value) => value + 1)}
								type="button"
							>
								Retry
							</button>
						}
						message={error}
						title="Could not load links"
					/>
				) : items.length === 0 ? (
					<FeedEmpty
						detail="Try a different range, source, or search term."
						label="No links in this window"
					/>
				) : null}
				{items.map((item, index) => (
					<LinkInsightRow
						index={index}
						item={item}
						key={`${kind}:${range}:${source}:${item.id}`}
					/>
				))}
			</section>
		</>
	);
}
