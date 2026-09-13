import { ExternalLink, Play, X } from "lucide-react";
import { useState } from "react";
import type { TweetMediaItem } from "#/lib/types";
import { cx, tweetMediaGridClass, tweetMediaTileClass } from "#/lib/ui";

export function TweetMediaGrid({
	items,
	tweetId,
}: {
	items: TweetMediaItem[];
	tweetId?: string;
}) {
	const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
	if (items.length === 0) {
		return null;
	}

	const visibleItems = items.slice(0, 4);
	const selectedItem =
		selectedIndex === null ? null : (visibleItems[selectedIndex] ?? null);
	const singleImage =
		visibleItems.length === 1 && visibleItems[0]?.type === "image"
			? visibleItems[0]
			: null;

	return (
		<>
			{singleImage ? (
				<button
					aria-label="Open tweet media 1"
					className={cx(
						"tweet-media-single mt-2 max-w-full overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--bg-active)] p-0 text-left",
						singleImage.width && singleImage.height
							? "block"
							: "inline-block align-top",
					)}
					onClick={(event) => {
						event.stopPropagation();
						setSelectedIndex(0);
					}}
					style={singleImageStyle(singleImage)}
					type="button"
				>
					<img
						alt={singleImage.altText ?? "Tweet media 1"}
						className={cx(
							"tweet-media-image block max-h-[720px] max-w-full",
							singleImage.width && singleImage.height
								? "size-full object-cover"
								: "h-auto w-auto object-contain",
						)}
						height={singleImage.height}
						loading="lazy"
						src={singleImage.thumbnailUrl ?? singleImage.url}
						width={singleImage.width}
					/>
				</button>
			) : (
				<div className={tweetMediaGridClass(Math.min(items.length, 4))}>
					{visibleItems.map((item, index) =>
						item.type === "video" || item.type === "gif" ? (
							<TweetVideo
								key={`${item.type}:${item.url}:${JSON.stringify(videoSources(item))}`}
								item={item}
								index={index}
								count={visibleItems.length}
								tweetId={tweetId}
							/>
						) : (
							<button
								key={item.url + String(index)}
								aria-label={`Open tweet media ${String(index + 1)}`}
								className={tweetMediaTileClass(
									index,
									Math.min(items.length, 4),
								)}
								onClick={(event) => {
									event.stopPropagation();
									setSelectedIndex(index);
								}}
								style={
									visibleItems.length === 1 && item.width && item.height
										? {
												aspectRatio: `${String(item.width)} / ${String(item.height)}`,
											}
										: undefined
								}
								type="button"
							>
								{item.type === "image" ? (
									<img
										alt={item.altText ?? `Tweet media ${String(index + 1)}`}
										className="tweet-media-image block size-full object-contain"
										loading="lazy"
										src={item.thumbnailUrl ?? item.url}
									/>
								) : (
									<span className="tweet-media-fallback grid min-h-40 place-items-center font-semibold text-[var(--ink-soft)]">
										Media
									</span>
								)}
							</button>
						),
					)}
				</div>
			)}
			{selectedItem ? (
				<div
					aria-modal="true"
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
					onClick={(event) => {
						event.stopPropagation();
						setSelectedIndex(null);
					}}
					role="dialog"
				>
					<button
						aria-label="Close media viewer"
						className="absolute right-4 top-4 grid size-10 place-items-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
						onClick={(event) => {
							event.stopPropagation();
							setSelectedIndex(null);
						}}
						type="button"
					>
						<X className="size-5" strokeWidth={1.8} />
					</button>
					{selectedItem.type === "image" ? (
						<img
							alt={selectedItem.altText ?? "Tweet media"}
							className="max-h-[92vh] max-w-[92vw] object-contain"
							onClick={(event) => event.stopPropagation()}
							src={selectedItem.url}
						/>
					) : (
						<div
							className="grid min-h-64 min-w-80 place-items-center gap-3 rounded-2xl border border-white/20 bg-black p-6 text-white"
							onClick={(event) => event.stopPropagation()}
						>
							<span>
								{selectedItem.type === "video"
									? "Video"
									: selectedItem.type === "gif"
										? "GIF"
										: "Media"}
							</span>
							<a
								className="rounded-full bg-white/10 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-white/20"
								href={selectedItem.url}
								rel="noreferrer"
								target="_blank"
							>
								Open media
							</a>
						</div>
					)}
				</div>
			) : null}
		</>
	);
}

function singleImageStyle(item: TweetMediaItem) {
	if (!item.width || !item.height) return undefined;
	const maxHeight = 720;
	const width = Math.min(
		item.width,
		Math.round((item.width / item.height) * maxHeight),
	);
	return {
		aspectRatio: `${String(item.width)} / ${String(item.height)}`,
		width: `${String(width)}px`,
	};
}

function safeMediaUrl(url: string) {
	if (/^\/(?![\\/])/.test(url)) return url;
	try {
		const parsed = new URL(url);
		return ["https:", "http:"].includes(parsed.protocol) &&
			!parsed.username &&
			!parsed.password
			? url
			: undefined;
	} catch {
		return undefined;
	}
}

function videoSources(item: TweetMediaItem) {
	const candidates: NonNullable<TweetMediaItem["variants"]> = [
		...(item.variants ?? []),
		{ url: item.url },
	];
	const sources: Array<{ url: string; contentType: string; bitRate?: number }> =
		[];
	for (const candidate of candidates) {
		if (
			!safeMediaUrl(candidate.url) ||
			sources.some((source) => source.url === candidate.url)
		)
			continue;
		const extension = candidate.url
			.match(/\.(mp4|webm|m3u8)(?:$|[?#])/i)?.[1]
			?.toLowerCase();
		const contentType =
			candidate.contentType ??
			(extension === "m3u8"
				? "application/vnd.apple.mpegurl"
				: extension
					? `video/${extension}`
					: "");
		const mime = contentType.split(";")[0].trim().toLowerCase();
		if (
			![
				"video/mp4",
				"video/webm",
				"application/x-mpegurl",
				"application/vnd.apple.mpegurl",
			].includes(mime)
		)
			continue;
		sources.push({ ...candidate, contentType });
	}
	return sources.sort(
		(a, b) =>
			Number(!a.contentType.toLowerCase().startsWith("video/")) -
				Number(!b.contentType.toLowerCase().startsWith("video/")) ||
			Number(b.bitRate ?? 0) - Number(a.bitRate ?? 0),
	);
}

function TweetVideo({
	item,
	index,
	count,
	tweetId,
}: {
	item: TweetMediaItem;
	index: number;
	count: number;
	tweetId?: string;
}) {
	const [failed, setFailed] = useState(false);
	const sources = videoSources(item);
	const poster =
		item.thumbnailUrl ??
		(!videoSources({ ...item, variants: undefined }).length
			? item.url
			: undefined);
	const fallback = tweetId
		? `https://x.com/i/status/${encodeURIComponent(tweetId)}`
		: safeMediaUrl(item.url);
	return (
		<div
			className={cx(
				tweetMediaTileClass(index, count),
				"bg-black!",
				count === 1 && "max-h-[640px]",
			)}
			style={
				count === 1
					? {
							aspectRatio:
								item.width && item.height
									? `${item.width} / ${item.height}`
									: "16 / 9",
						}
					: undefined
			}
			onClick={(event) => event.stopPropagation()}
		>
			{sources.length > 0 && !failed ? (
				<video
					aria-label={
						item.altText ??
						`Tweet ${item.type === "gif" ? "GIF" : "video"} ${index + 1}`
					}
					className="block size-full object-contain"
					controls
					playsInline
					preload="none"
					loop={item.type === "gif"}
					muted={item.type === "gif"}
					poster={poster}
					onError={() => setFailed(true)}
				>
					{sources.map((source, sourceIndex) => (
						<source
							key={source.url}
							src={source.url}
							type={source.contentType}
							onError={(event) => {
								event.stopPropagation();
								if (sourceIndex === sources.length - 1) setFailed(true);
							}}
						/>
					))}
				</video>
			) : (
				<div className="relative grid size-full min-h-40 place-items-center">
					{poster ? (
						<img
							alt=""
							className="absolute inset-0 size-full object-contain opacity-45"
							src={poster}
							loading="lazy"
						/>
					) : null}
					<div className="relative flex flex-col items-center gap-3 p-4 text-center text-white">
						<Play aria-hidden="true" className="size-8" />
						<span className="text-sm font-medium">
							{failed
								? "Video unavailable"
								: "No playable video in this archive"}
						</span>
						{fallback ? (
							<a
								className="inline-flex items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-sm font-semibold hover:bg-white/25"
								href={fallback}
								target="_blank"
								rel="noopener noreferrer"
							>
								{tweetId ? "Watch on X" : "Open media"}
								<ExternalLink aria-hidden="true" className="size-3.5" />
							</a>
						) : null}
					</div>
				</div>
			)}
		</div>
	);
}
