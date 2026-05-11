import { ExternalLink, Image as ImageIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LinkPreviewMetadata } from "#/lib/link-preview-metadata";
import type { TweetUrlEntity } from "#/lib/types";
import {
	cx,
	linkPreviewCardClass,
	linkPreviewDescClass,
	linkPreviewHostClass,
	linkPreviewTitleClass,
} from "#/lib/ui";

type LinkPreviewState = Pick<
	TweetUrlEntity,
	| "expandedUrl"
	| "displayUrl"
	| "title"
	| "description"
	| "imageUrl"
	| "siteName"
>;

const previewCache = new Map<string, Promise<LinkPreviewMetadata | null>>();
const IMAGE_EXTENSION_PATTERN = /\.(?:avif|gif|jpe?g|png|webp)(?:[?#].*)?$/i;
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

function schedulePreviewFetch(task: () => Promise<LinkPreviewMetadata | null>) {
	return new Promise<LinkPreviewMetadata | null>((resolve) => {
		queuedPreviewFetches.push(() => {
			activePreviewFetches += 1;
			task()
				.then(resolve)
				.catch(() => resolve(null))
				.finally(() => {
					activePreviewFetches = Math.max(0, activePreviewFetches - 1);
					runQueuedPreviewFetches();
				});
		});
		runQueuedPreviewFetches();
	});
}

function fetchPreview(entry: TweetUrlEntity) {
	const targetUrl = entry.expandedUrl || entry.url;
	if (!targetUrl) return Promise.resolve(null);
	const key = `${entry.url} ${targetUrl}`;
	const cached = previewCache.get(key);
	if (cached) return cached;

	const params = new URLSearchParams({ url: targetUrl });
	if (entry.url && entry.url !== targetUrl) {
		params.set("shortUrl", entry.url);
	}
	const promise = schedulePreviewFetch(() =>
		fetch(`/api/link-preview?${params.toString()}`)
			.then(async (response) => {
				if (!response.ok) return null;
				const data = (await response.json()) as {
					ok?: boolean;
					preview?: LinkPreviewMetadata;
				};
				return data.ok ? (data.preview ?? null) : null;
			})
			.catch(() => null),
	);
	previewCache.set(key, promise);
	return promise;
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
		if (IMAGE_EXTENSION_PATTERN.test(parsed.pathname)) return true;
		return (
			parsed.hostname === "pbs.twimg.com" &&
			(parsed.pathname.startsWith("/media/") ||
				parsed.pathname.startsWith("/amplify_video_thumb/"))
		);
	} catch {
		return IMAGE_EXTENSION_PATTERN.test(url);
	}
}

export function LinkPreviewCard({
	entry,
	index,
}: {
	entry: TweetUrlEntity;
	index: number;
}) {
	const targetUrl = entry.expandedUrl || entry.url;
	const displayUrl = entry.displayUrl || displayHost(targetUrl, targetUrl);
	const directImageUrl = isDirectImageUrl(targetUrl) ? targetUrl : null;
	const initialPreview = useMemo<LinkPreviewState>(
		() => ({
			expandedUrl: targetUrl,
			displayUrl,
			title:
				entry.title ??
				(directImageUrl ? displayHost(targetUrl, displayUrl) : undefined),
			description:
				entry.description ?? (directImageUrl ? displayUrl : undefined),
			imageUrl: entry.imageUrl ?? directImageUrl,
			siteName:
				entry.siteName ??
				(directImageUrl ? displayHost(targetUrl, displayUrl) : undefined),
		}),
		[
			directImageUrl,
			displayUrl,
			entry.description,
			entry.imageUrl,
			entry.siteName,
			entry.title,
			targetUrl,
		],
	);
	const [preview, setPreview] = useState(initialPreview);
	const [imageFailed, setImageFailed] = useState(false);
	const [hydratedKey, setHydratedKey] = useState("");
	const [canHydrate, setCanHydrate] = useState(false);
	const cardRef = useRef<HTMLAnchorElement | null>(null);
	const cacheKey = `${entry.url} ${targetUrl}`;

	useEffect(() => {
		setPreview(initialPreview);
		setImageFailed(false);
		setHydratedKey("");
		setCanHydrate(false);
	}, [initialPreview]);

	useEffect(() => {
		if (!targetUrl) return;
		if (!needsHydration(preview)) return;
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
	}, [preview, targetUrl]);

	useEffect(() => {
		if (!targetUrl || !canHydrate) return;
		if (!needsHydration(preview)) return;
		if (hydratedKey === cacheKey) return;
		let cancelled = false;
		const timer = window.setTimeout(() => {
			setHydratedKey(cacheKey);
			void fetchPreview(entry).then((metadata) => {
				if (cancelled || !metadata) return;
				setPreview((current) => ({
					expandedUrl: metadata.url || current.expandedUrl,
					displayUrl: current.displayUrl,
					title: metadata.title ?? current.title,
					description: metadata.description ?? current.description,
					imageUrl: metadata.imageUrl ?? current.imageUrl,
					siteName: metadata.siteName ?? current.siteName,
				}));
			});
		}, 100);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [cacheKey, canHydrate, entry, hydratedKey, preview, targetUrl]);

	const title = preview.title || entry.displayUrl;
	const description =
		preview.description && preview.description !== title
			? preview.description
			: preview.siteName || displayHost(preview.expandedUrl, entry.displayUrl);
	const host =
		preview.siteName || displayHost(preview.expandedUrl, entry.displayUrl);
	const showImage = Boolean(preview.imageUrl && !imageFailed);

	return (
		<a
			key={`${entry.expandedUrl}-${String(index)}`}
			className={linkPreviewCardClass}
			data-perf="link-preview-card"
			href={preview.expandedUrl}
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
						src={preview.imageUrl ?? ""}
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
