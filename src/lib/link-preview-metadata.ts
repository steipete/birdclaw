import { getNativeDb } from "./db";
import type { Database } from "./sqlite";
import {
	normalizeUrlExpansionForIndex,
	upsertUrlExpansion,
} from "./url-expansion-store";

const FETCH_TIMEOUT_MS = 12_000;
const MAX_HTML_CHARS = 2_000_000;

export interface LinkPreviewMetadata {
	url: string;
	title: string | null;
	description: string | null;
	imageUrl: string | null;
	siteName: string | null;
	error?: string | null;
}

export interface GetLinkPreviewOptions {
	shortUrl?: string | null;
	refresh?: boolean;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

type UrlExpansionPreviewRow = {
	short_url: string;
	expanded_url: string;
	final_url: string;
	status: "hit" | "miss" | "error";
	title: string | null;
	description: string | null;
	image_url: string | null;
	site_name: string | null;
	error: string | null;
	source: string;
	updated_at: string;
};

function cleanText(value: string | null | undefined) {
	if (!value) return null;
	const cleaned = decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
	return cleaned.length > 0 ? cleaned : null;
}

function decodeHtmlEntities(value: string) {
	return value
		.replace(/&#(\d+);/g, (_, code: string) =>
			String.fromCodePoint(Number(code)),
		)
		.replace(/&#x([a-f0-9]+);/gi, (_, code: string) =>
			String.fromCodePoint(Number.parseInt(code, 16)),
		)
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'");
}

function parseAttributes(tag: string) {
	const attributes = new Map<string, string>();
	for (const match of tag.matchAll(
		/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g,
	)) {
		const key = match[1]?.toLowerCase();
		const value = match[3] ?? match[4] ?? match[5] ?? "";
		if (key) {
			attributes.set(key, value);
		}
	}
	return attributes;
}

function metaContents(html: string) {
	const values = new Map<string, string>();
	for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
		const attributes = parseAttributes(match[0]);
		const key = (
			attributes.get("property") ??
			attributes.get("name") ??
			""
		).toLowerCase();
		const content = cleanText(
			attributes.get("content") ?? attributes.get("value") ?? "",
		);
		if (key && content && !values.has(key)) {
			values.set(key, content);
		}
	}
	return values;
}

function pick(values: Map<string, string>, keys: string[]) {
	for (const key of keys) {
		const value = cleanText(values.get(key));
		if (value) return value;
	}
	return null;
}

function titleFromHtml(html: string) {
	const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
	return cleanText(match?.[1]);
}

function absoluteUrl(value: string | null, baseUrl: string) {
	if (!value) return null;
	try {
		return new URL(value, baseUrl).toString();
	} catch {
		return null;
	}
}

function hostLabel(url: string) {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

function youtubeThumbnail(url: string) {
	try {
		const parsed = new URL(url);
		let videoId: string | null = null;
		if (parsed.hostname === "youtu.be") {
			videoId = parsed.pathname.split("/").filter(Boolean)[0] ?? null;
		}
		if (
			parsed.hostname.endsWith("youtube.com") ||
			parsed.hostname.endsWith("youtube-nocookie.com")
		) {
			videoId = parsed.searchParams.get("v");
			if (!videoId && parsed.pathname.startsWith("/shorts/")) {
				videoId = parsed.pathname.split("/").filter(Boolean)[1] ?? null;
			}
			if (!videoId && parsed.pathname.startsWith("/embed/")) {
				videoId = parsed.pathname.split("/").filter(Boolean)[1] ?? null;
			}
		}
		if (!videoId || !/^[\w-]{6,}$/.test(videoId)) return null;
		return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
	} catch {
		return null;
	}
}

export function extractLinkPreviewMetadata(
	html: string,
	url: string,
): LinkPreviewMetadata {
	const meta = metaContents(html);
	const title =
		pick(meta, ["og:title", "twitter:title"]) ??
		titleFromHtml(html) ??
		hostLabel(url);
	const description = pick(meta, [
		"og:description",
		"twitter:description",
		"description",
	]);
	const siteName =
		pick(meta, ["og:site_name", "application-name"]) ?? hostLabel(url);
	const image =
		pick(meta, [
			"og:image:secure_url",
			"og:image:url",
			"og:image",
			"twitter:image:src",
			"twitter:image",
		]) ?? youtubeThumbnail(url);

	return {
		url,
		title,
		description,
		imageUrl: absoluteUrl(image, url),
		siteName,
	};
}

export async function fetchLinkPreviewMetadata(
	url: string,
	options: Pick<GetLinkPreviewOptions, "fetchImpl" | "timeoutMs"> = {},
): Promise<LinkPreviewMetadata> {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
	const headers = {
		"user-agent":
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 birdclaw/0.4",
		accept:
			"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
		"accept-language": "en-US,en;q=0.9",
	} satisfies HeadersInit;

	try {
		const response = await fetchImpl(url, {
			headers,
			redirect: "follow",
			signal: AbortSignal.timeout(timeoutMs),
		});
		const finalUrl = response.url || url;
		const contentType = response.headers.get("content-type") ?? "";
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		if (contentType.toLowerCase().startsWith("image/")) {
			return {
				url: finalUrl,
				title: hostLabel(finalUrl),
				description: null,
				imageUrl: finalUrl,
				siteName: hostLabel(finalUrl),
			};
		}
		const html = (await response.text()).slice(0, MAX_HTML_CHARS);
		return extractLinkPreviewMetadata(html, finalUrl);
	} catch (error) {
		return {
			url,
			title: hostLabel(url),
			description: null,
			imageUrl: youtubeThumbnail(url),
			siteName: hostLabel(url),
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function readCachedPreview(
	db: Database,
	url: string,
	shortUrl: string | null | undefined,
) {
	return db
		.prepare(
			`
      select short_url, expanded_url, final_url, status, title, description,
        image_url, site_name, error, source, updated_at
      from url_expansions
      where short_url in (?, ?)
        or expanded_url in (?, ?)
        or final_url in (?, ?)
      order by
        case
          when short_url = ? then 0
          when final_url = ? then 1
          else 2
        end
      limit 1
      `,
		)
		.get(
			shortUrl ?? url,
			url,
			shortUrl ?? url,
			url,
			shortUrl ?? url,
			url,
			shortUrl ?? url,
			url,
		) as UrlExpansionPreviewRow | undefined;
}

function hasUsefulPreview(row: UrlExpansionPreviewRow) {
	return Boolean(
		row.title || row.description || row.image_url || row.site_name,
	);
}

function rowToPreview(row: UrlExpansionPreviewRow): LinkPreviewMetadata {
	const url = row.final_url || row.expanded_url || row.short_url;
	return {
		url,
		title: row.title ?? null,
		description: row.description ?? null,
		imageUrl: row.image_url ?? null,
		siteName: row.site_name ?? null,
		...(row.error ? { error: row.error } : {}),
	};
}

function persistPreview(
	db: Database,
	url: string,
	shortUrl: string | null | undefined,
	cached: UrlExpansionPreviewRow | undefined,
	preview: LinkPreviewMetadata,
) {
	const now = new Date().toISOString();
	upsertUrlExpansion(
		db,
		normalizeUrlExpansionForIndex({
			url: cached?.short_url ?? shortUrl ?? url,
			expandedUrl: cached?.expanded_url ?? preview.url,
			finalUrl: preview.url,
			status: preview.error ? "error" : "hit",
			title: preview.title,
			description: preview.description,
			imageUrl: preview.imageUrl,
			siteName: preview.siteName,
			...(preview.error ? { error: preview.error } : {}),
			source: "metadata",
			updatedAt: now,
		}),
	);
}

export async function getOrFetchLinkPreview(
	url: string,
	options: GetLinkPreviewOptions = {},
): Promise<LinkPreviewMetadata> {
	const db = getNativeDb({ seedDemoData: false });
	const cached = readCachedPreview(db, url, options.shortUrl);
	if (cached && hasUsefulPreview(cached) && !options.refresh) {
		return rowToPreview(cached);
	}

	const preview = await fetchLinkPreviewMetadata(
		cached?.final_url || cached?.expanded_url || url,
		options,
	);
	persistPreview(db, url, options.shortUrl, cached, preview);
	return preview;
}

export const __test__ = {
	decodeHtmlEntities,
	youtubeThumbnail,
};
