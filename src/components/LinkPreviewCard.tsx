import { ExternalLink, Image as ImageIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import type { TweetUrlEntity } from "#/lib/types";
import {
	linkPreviewResponseSchema,
	type LinkPreviewResponse,
} from "#/lib/api-contracts";
import { fetchJson } from "#/lib/api-client";
import {
	cx,
	linkPreviewCardClass,
	linkPreviewDescClass,
	linkPreviewHostClass,
	linkPreviewTitleClass,
} from "#/lib/ui";
import { assertSafePreviewUrl, safeHttpUrl } from "#/lib/url-safety";
import { queryKeys } from "#/lib/query-client";

type LinkPreviewState = Pick<
	TweetUrlEntity,
	| "expandedUrl"
	| "displayUrl"
	| "title"
	| "description"
	| "imageUrl"
	| "siteName"
>;

type LinkPreviewMetadata = LinkPreviewResponse["preview"];
const MAX_CONCURRENT_PREVIEW_FETCHES = 2;
let activePreviewFetches = 0;
const queuedPreviewFetches: Array<() => void> = [];

function needsHydration(preview: LinkPreviewState) {
	const targetUrl = preview.expandedUrl || "";
	if (
		preview.imageUrl &&
		preview.siteName &&
		preview.title &&
		isDirectImageUrl(targetUrl)
	) {
		return false;
	}
	return (
		!preview.imageUrl ||
		!preview.title ||
		!preview.description ||
		preview.title === preview.displayUrl ||
		preview.description === preview.displayUrl
	);
}

function runQueuedPreviewFetches() {
	while (
		activePreviewFetches < MAX_CONCURRENT_PREVIEW_FETCHES &&
		queuedPreviewFetches.length > 0
	) {
		const next = queuedPreviewFetches.shift();
		next?.();
	}
}

function schedulePreviewFetch(
	task: () => Promise<LinkPreviewMetadata | null>,
	signal: AbortSignal,
) {
	return new Promise<LinkPreviewMetadata | null>((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const cancel = () => {
			const index = queuedPreviewFetches.indexOf(start);
			if (index !== -1) queuedPreviewFetches.splice(index, 1);
			reject(signal.reason);
		};
		const start = () => {
			signal.removeEventListener("abort", cancel);
			activePreviewFetches += 1;
			Promise.resolve()
				.then(task)
				.then(resolve)
				.catch(reject)
				.finally(() => {
					activePreviewFetches = Math.max(0, activePreviewFetches - 1);
					runQueuedPreviewFetches();
				});
		};
		signal.addEventListener("abort", cancel, { once: true });
		queuedPreviewFetches.push(start);
		runQueuedPreviewFetches();
	});
}

export function linkPreviewQueryOptions(targetUrl: string) {
	const params = new URLSearchParams({ url: targetUrl });
	return queryOptions({
		queryKey: [...queryKeys.linkPreviews, targetUrl] as const,
		queryFn: ({ signal }) =>
			schedulePreviewFetch(
				() =>
					fetchJson(
						`/api/link-preview?${params.toString()}`,
						{ signal },
						linkPreviewResponseSchema,
						"Link preview unavailable",
					).then((data) => data.preview),
				signal,
			),
		staleTime: 30 * 60_000,
	});
}

function displayHost(url: string, fallback: string) {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return fallback;
	}
}

function isDirectImageUrl(url: string) {
	try {
		const parsed = new URL(url);
		return (
			parsed.protocol === "https:" &&
			parsed.hostname === "pbs.twimg.com" &&
			(parsed.pathname.startsWith("/media/") ||
				parsed.pathname.startsWith("/amplify_video_thumb/"))
		);
	} catch {
		return false;
	}
}

function safePreviewImageUrl(url: string | null | undefined) {
	if (!url) return null;
	try {
		const parsed = assertSafePreviewUrl(url);
		if (
			parsed.protocol === "https:" &&
			parsed.hostname === "pbs.twimg.com" &&
			(parsed.pathname.startsWith("/media/") ||
				parsed.pathname.startsWith("/amplify_video_thumb/"))
		) {
			return parsed.toString();
		}
		return `/api/link-preview?${new URLSearchParams({ imageUrl: parsed.toString() })}`;
	} catch {
		return null;
	}
}

export function LinkPreviewCard({
	entry,
	index,
}: {
	entry: TweetUrlEntity;
	index: number;
}) {
	const targetUrl = safeHttpUrl(entry.expandedUrl || entry.url);
	const previewUrl = targetUrl ?? "";
	const displayUrl =
		entry.displayUrl || (targetUrl ? displayHost(targetUrl, targetUrl) : "");
	const directImageUrl =
		targetUrl && isDirectImageUrl(targetUrl) ? targetUrl : null;
	const initialPreview = useMemo<LinkPreviewState>(
		() => ({
			expandedUrl: previewUrl,
			displayUrl,
			title:
				entry.title ??
				(directImageUrl ? displayHost(previewUrl, displayUrl) : undefined),
			description:
				entry.description ?? (directImageUrl ? displayUrl : undefined),
			imageUrl: entry.imageUrl ?? directImageUrl,
			siteName:
				entry.siteName ??
				(directImageUrl ? displayHost(previewUrl, displayUrl) : undefined),
		}),
		[
			directImageUrl,
			displayUrl,
			entry.description,
			entry.imageUrl,
			entry.siteName,
			entry.title,
			previewUrl,
		],
	);
	const [imageFailed, setImageFailed] = useState(false);
	const [canHydrate, setCanHydrate] = useState(false);
	const [hydrationReady, setHydrationReady] = useState(false);
	const cardRef = useRef<HTMLAnchorElement | null>(null);
	const shouldHydrate = Boolean(targetUrl && needsHydration(initialPreview));
	const previewQuery = useQuery({
		...linkPreviewQueryOptions(targetUrl ?? ""),
		enabled: shouldHydrate && canHydrate && hydrationReady,
	});
	const preview = useMemo<LinkPreviewState>(() => {
		const metadata = previewQuery.data;
		if (!metadata) return initialPreview;
		return {
			expandedUrl: safeHttpUrl(metadata.url) ?? initialPreview.expandedUrl,
			displayUrl: initialPreview.displayUrl,
			title: metadata.title ?? initialPreview.title,
			description: metadata.description ?? initialPreview.description,
			imageUrl: metadata.imageUrl ?? initialPreview.imageUrl,
			siteName: metadata.siteName ?? initialPreview.siteName,
		};
	}, [initialPreview, previewQuery.data]);

	useEffect(() => {
		setImageFailed(false);
		setCanHydrate(false);
		setHydrationReady(false);
	}, [initialPreview]);

	useEffect(() => {
		if (!targetUrl) return;
		if (!shouldHydrate) return;
		const node = cardRef.current;
		if (!node || typeof IntersectionObserver === "undefined") {
			setCanHydrate(true);
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					setCanHydrate(true);
					observer.disconnect();
				}
			},
			{ rootMargin: "320px 0px" },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, [shouldHydrate, targetUrl]);

	useEffect(() => {
		if (!targetUrl || !canHydrate || !shouldHydrate) return;
		const timer = window.setTimeout(() => {
			setHydrationReady(true);
		}, 100);
		return () => window.clearTimeout(timer);
	}, [canHydrate, shouldHydrate, targetUrl]);

	if (!targetUrl) return null;

	const title = preview.title || entry.displayUrl;
	const description =
		preview.description && preview.description !== title
			? preview.description
			: preview.siteName || displayHost(preview.expandedUrl, entry.displayUrl);
	const host =
		preview.siteName || displayHost(preview.expandedUrl, entry.displayUrl);
	const imageUrl = safePreviewImageUrl(preview.imageUrl);
	const showImage = Boolean(imageUrl && !imageFailed);
	const previewHref = safeHttpUrl(preview.expandedUrl) ?? targetUrl;

	return (
		<a
			key={`${entry.expandedUrl}-${String(index)}`}
			className={linkPreviewCardClass}
			data-perf="link-preview-card"
			href={previewHref}
			ref={cardRef}
			rel="noreferrer"
			target="_blank"
		>
			<div className="flex min-w-0 flex-1 flex-col justify-center gap-1 px-3.5 py-3">
				<div className="flex min-w-0 items-center gap-2">
					<span className={linkPreviewHostClass}>{host}</span>
					<ExternalLink
						aria-hidden="true"
						className="size-3.5 shrink-0 text-[var(--ink-soft)] opacity-0 transition-opacity group-hover/link-preview:opacity-100"
						strokeWidth={1.8}
					/>
				</div>
				<span className={linkPreviewTitleClass}>{title}</span>
				<span className={linkPreviewDescClass}>{description}</span>
				<span className={cx(linkPreviewHostClass, "text-[12px]")}>
					{entry.displayUrl}
				</span>
			</div>
			<div className="flex aspect-[1.45] w-40 shrink-0 items-center justify-center overflow-hidden border-l border-[var(--line)] bg-[var(--bg-soft)] max-[720px]:w-28">
				{showImage ? (
					<img
						alt={title}
						className="size-full object-cover transition-transform duration-200 group-hover/link-preview:scale-[1.03]"
						loading="lazy"
						onError={() => setImageFailed(true)}
						src={imageUrl ?? ""}
					/>
				) : (
					<ImageIcon
						aria-hidden="true"
						className="size-8 text-[var(--ink-soft)]"
						strokeWidth={1.7}
					/>
				)}
			</div>
		</a>
	);
}
