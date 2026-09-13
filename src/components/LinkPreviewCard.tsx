import { ArrowUpRight, Globe2 } from "lucide-react";
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
	const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
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
		if (!metadata || metadata.error) return initialPreview;
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
		setFailedImageUrl(null);
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

	const host = displayHost(preview.expandedUrl, entry.displayUrl);
	const previewHref = safeHttpUrl(preview.expandedUrl) ?? targetUrl;
	const labels = [
		host,
		displayUrl,
		targetUrl,
		previewHref,
		preview.siteName ?? "",
	];
	const title = distinctPreviewText(preview.title, labels);
	const description = distinctPreviewText(preview.description, [
		...labels,
		title ?? "",
	]);
	const pathLabel = previewPath(previewHref);
	const imageUrl = safePreviewImageUrl(preview.imageUrl);
	const showImage = Boolean(imageUrl && imageUrl !== failedImageUrl);

	return (
		<a
			key={`${entry.expandedUrl}-${String(index)}`}
			className={cx(
				linkPreviewCardClass,
				"items-center gap-3 px-3.5 py-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] max-[480px]:gap-2 max-[480px]:px-3",
				showImage && "max-[480px]:flex-col max-[480px]:items-stretch",
			)}
			data-perf="link-preview-card"
			aria-label={`Open ${title ?? `${host}${pathLabel ?? ""}`} (opens in a new tab)`}
			href={previewHref}
			ref={cardRef}
			rel="noreferrer"
			target="_blank"
			onClick={(event) => event.stopPropagation()}
		>
			{showImage ? (
				<div className="size-20 shrink-0 overflow-hidden rounded-xl bg-[var(--bg-soft)] max-[480px]:h-24 max-[480px]:w-full">
					<img
						alt={title ?? host}
						className="size-full object-cover transition-transform duration-200 group-hover/link-preview:scale-[1.03]"
						loading="lazy"
						onError={() => setFailedImageUrl(imageUrl)}
						src={imageUrl ?? ""}
					/>
				</div>
			) : (
				<span className="grid size-10 shrink-0 place-items-center rounded-xl border border-[var(--line)] bg-[var(--bg-soft)] text-[var(--ink-soft)] max-[480px]:size-8">
					<Globe2 aria-hidden="true" className="size-4.5" strokeWidth={1.6} />
				</span>
			)}
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<span
					className={cx(
						linkPreviewHostClass,
						!title && "font-semibold text-[var(--ink)]",
					)}
				>
					{host}
				</span>
				{title ? <span className={linkPreviewTitleClass}>{title}</span> : null}
				{description ? (
					<span className={linkPreviewDescClass}>{description}</span>
				) : !title && pathLabel ? (
					<span className={cx(linkPreviewDescClass, "line-clamp-1!")}>
						{pathLabel}
					</span>
				) : null}
			</div>
			<ArrowUpRight
				aria-hidden="true"
				className="size-4 shrink-0 text-[var(--ink-faint)] transition-colors group-hover/link-preview:text-[var(--accent)] max-[480px]:hidden"
				strokeWidth={1.7}
			/>
		</a>
	);
}

function distinctPreviewText(
	value: string | null | undefined,
	duplicates: string[],
) {
	const text = value?.trim();
	const normalize = (value: string) =>
		value
			.toLowerCase()
			.replace(/^https?:\/\/(?:www\.)?/, "")
			.replace(/\/$/, "");
	return text &&
		!duplicates.some((duplicate) => normalize(duplicate) === normalize(text))
		? text
		: null;
}

function previewPath(url: string) {
	try {
		const pathname = new URL(url).pathname;
		if (pathname === "/") return null;
		try {
			return decodeURIComponent(pathname);
		} catch {
			return pathname;
		}
	} catch {
		return null;
	}
}
