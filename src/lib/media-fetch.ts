/**
 * Respectful media caching for tweet records already present in birdclaw.
 *
 * This is not a scraper: it never crawls, enumerates, or derives Twitter/X CDN
 * URLs. It only downloads media URLs already stored in `tweets.media_json`,
 * skips files present on disk, paces requests, and backs off on 429.
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
} from "node:fs";
import { appendFile, copyFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { getBirdclawPaths } from "./config";
import { getNativeDb } from "./db";
import { runEffectPromise } from "./effect-runtime";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Row = { id: string; media_json: string };
type MediaKind = "image" | "video" | "gif";
type Candidate = {
	kind: MediaKind;
	mediaKey: string;
	tweetId: string;
	url: string;
	path: string;
	tmpPath: string;
	archivePath?: string;
};
type FetchOneResult = {
	fetched: number;
	bytes: number;
	rateLimited: boolean;
	kind?: MediaKind;
	reusedFromArchive?: boolean;
	failure?: MediaFetchResult["failures"][number];
};

export type MediaFetchResult = {
	ok: true;
	fetched: number;
	images_fetched: number;
	videos_fetched: number;
	gifs_fetched: number;
	reused_from_archive: number;
	skipped_cached: number;
	failed: number;
	rate_limited: number;
	bytes: number;
	image_bytes: number;
	video_bytes: number;
	gif_bytes: number;
	duration_ms: number;
	failures: Array<{ media_key: string; url: string; reason: string }>;
	dry_run?: true;
	would_fetch?: Array<{
		media_key: string;
		tweet_id: string;
		kind: MediaKind;
		url: string;
		path: string;
	}>;
};

export type MediaFetchOptions = {
	account?: string;
	limit?: number;
	kind?: string;
	since?: string;
	parallel?: number;
	pacingMs?: number;
	videoPacingMs?: number;
	retryMax?: number;
	dryRun?: boolean;
	includeVideo?: boolean;
	maxBytes?: number;
	fetchImpl?: FetchLike;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	userAgent?: string;
};

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const PBS_PREFIXES = [
	"/media/",
	"/ext_tw_video_thumb/",
	"/amplify_video_thumb/",
	"/tweet_video_thumb/",
	"/profile_images/",
] as const;
const packageVersion = (
	JSON.parse(
		readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
	) as { version?: string }
).version;

function defaultSleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function toMediaError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function tryMediaSync<T>(try_: () => T) {
	return Effect.try({
		try: try_,
		catch: toMediaError,
	});
}

function tryMediaPromise<T>(try_: () => Promise<T>) {
	return Effect.tryPromise({
		try: try_,
		catch: toMediaError,
	});
}

function fileSize(filePath: string) {
	try {
		return statSync(filePath).size;
	} catch {
		return 0;
	}
}

function basenameKey(url: URL) {
	return path.posix.parse(path.posix.basename(url.pathname)).name;
}

function imageExtension(url: URL) {
	const ext = path.posix.extname(url.pathname).toLowerCase();
	if (ext === ".jpeg" || ext === ".jpg") return ".jpg";
	if (ext === ".png" || ext === ".webp" || ext === ".gif" || ext === ".svg")
		return ext;
	const format = url.searchParams.get("format")?.toLowerCase();
	return format === "png" || format === "webp" || format === "gif"
		? `.${format}`
		: ".jpg";
}

function imageCandidate(
	urlValue: string,
	dir: string,
	tweetId: string,
): Candidate | null {
	let url: URL;
	try {
		url = new URL(urlValue);
	} catch {
		return null;
	}
	if (
		url.protocol !== "https:" ||
		url.hostname !== "pbs.twimg.com" ||
		!PBS_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))
	) {
		return null;
	}
	const mediaKey = basenameKey(url);
	const ext = imageExtension(url);
	return {
		kind: "image",
		mediaKey,
		tweetId,
		url: url.toString(),
		path: path.join(dir, `${mediaKey}${ext}`),
		tmpPath: path.join(dir, `${mediaKey}${ext}.tmp`),
	};
}

function record(value: unknown) {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function variantUrl(value: unknown) {
	const item = record(value);
	if (!item) return null;
	const contentType = String(item.content_type ?? item.contentType ?? "");
	if (contentType !== "video/mp4" || typeof item.url !== "string") return null;
	const bitrate = item.bitRate ?? item.bit_rate ?? item.bitrate;
	return {
		url: item.url,
		bitrate: Number.isFinite(Number(bitrate)) ? Number(bitrate) : 0,
	};
}

function videoCandidate(
	item: Record<string, unknown>,
	dir: string,
	tweetId: string,
): Candidate | null {
	const rawType = String(item.type ?? "");
	const kind: MediaKind | null =
		rawType === "video"
			? "video"
			: rawType === "animated_gif" || rawType === "gif"
				? "gif"
				: null;
	if (!kind) return null;
	const variants = Array.isArray(item.variants)
		? item.variants
		: Array.isArray(record(item.video_info)?.variants)
			? (record(item.video_info)?.variants as unknown[])
			: [];
	const best = variants
		.map(variantUrl)
		.filter(
			(variant): variant is { url: string; bitrate: number } =>
				variant !== null,
		)
		.sort((left, right) => right.bitrate - left.bitrate)[0];
	if (!best) return null;

	let url: URL;
	try {
		url = new URL(best.url);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.hostname !== "video.twimg.com")
		return null;
	const mediaKey = basenameKey(url);
	return {
		kind,
		mediaKey,
		tweetId,
		url: url.toString(),
		path: path.join(dir, `${mediaKey}.mp4`),
		tmpPath: path.join(dir, `${mediaKey}.mp4.tmp`),
	};
}

function archiveTweetDirs(dir: string, tweetId: string) {
	const archiveRoot = path.join(dir, "archive");
	try {
		return readdirSync(archiveRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(archiveRoot, entry.name, tweetId))
			.filter((tweetDir) => existsSync(tweetDir));
	} catch {
		return [];
	}
}

function archiveVideoCandidates(
	item: Record<string, unknown>,
	dir: string,
	tweetId: string,
) {
	const rawType = String(item.type ?? "");
	const kind: MediaKind | null =
		rawType === "video"
			? "video"
			: rawType === "animated_gif" || rawType === "gif"
				? "gif"
				: null;
	if (!kind) return [];

	const candidates: Candidate[] = [];
	for (const tweetDir of archiveTweetDirs(dir, tweetId)) {
		let entries;
		try {
			entries = readdirSync(tweetDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const ext = path.extname(entry.name).toLowerCase();
			if (!entry.isFile() || ext !== ".mp4") continue;
			const archivePath = path.join(tweetDir, entry.name);
			const prefix = `${tweetId}-`;
			const rawKey = path.basename(entry.name, ext);
			const mediaKey = rawKey.startsWith(prefix)
				? rawKey.slice(prefix.length)
				: rawKey;
			if (!mediaKey) continue;
			candidates.push({
				kind,
				mediaKey,
				tweetId,
				url: `archive:${archivePath}`,
				path: path.join(dir, `${mediaKey}${ext}`),
				tmpPath: path.join(dir, `${mediaKey}${ext}.tmp`),
				archivePath,
			});
		}
	}
	return candidates;
}

function rowCandidates(row: Row, dir: string, includeVideo: boolean) {
	let items: unknown;
	try {
		items = JSON.parse(row.media_json);
	} catch {
		return [];
	}
	if (!Array.isArray(items)) return [];

	const candidates: Candidate[] = [];
	for (const value of items) {
		const item = record(value);
		if (!item) continue;
		if (typeof item.url === "string") {
			const image = imageCandidate(item.url, dir, row.id);
			if (image) candidates.push(image);
		}
		if (includeVideo) {
			const archiveVideos = archiveVideoCandidates(item, dir, row.id);
			if (archiveVideos.length > 0) {
				candidates.push(...archiveVideos);
				continue;
			}
			const video = videoCandidate(item, dir, row.id);
			if (video) candidates.push(video);
		}
	}
	return candidates;
}

function queryRows(options: MediaFetchOptions) {
	const params: Array<string | number> = [];
	const account =
		options.account && options.account !== "all" ? options.account : undefined;
	const kind = normalizeKind(options.kind);
	let sql = `
    select t.id, t.media_json
    from tweets t
    where t.media_json not in ('', '[]', 'null')
  `;
	const scopeClause = buildScopeClause(params, account, kind);
	if (scopeClause) sql += ` and (${scopeClause})`;
	if (options.since) {
		params.push(options.since);
		sql += " and t.created_at >= ?";
	}
	sql += " order by t.created_at desc, t.id desc";
	if (options.limit !== undefined) {
		params.push(Math.max(0, Math.floor(options.limit)));
		sql += " limit ?";
	}
	return getNativeDb().prepare(sql).all(params) as Row[];
}

function normalizeKind(kind?: string) {
	const value = kind?.trim().toLowerCase();
	if (!value || value === "all") return undefined;
	if (value === "likes") return "like";
	if (value === "bookmarks") return "bookmark";
	return value;
}

function collectionKind(kind?: string) {
	if (kind === "like") return "likes";
	if (kind === "bookmark") return "bookmarks";
	return undefined;
}

function buildScopeClause(
	params: Array<string | number>,
	account?: string,
	kind?: string,
) {
	const clauses: string[] = [];
	const accountClause = (alias: string) =>
		account ? ` and ${alias}.account_id = ?` : "";
	const pushAccount = () => {
		if (account) params.push(account);
	};
	if (kind) {
		params.push(kind);
		pushAccount();
		clauses.push(
			`exists (select 1 from tweet_account_edges edge where edge.tweet_id = t.id and edge.kind = ?${accountClause("edge")})`,
		);
		const savedKind = collectionKind(kind);
		if (savedKind) {
			params.push(savedKind);
			pushAccount();
			clauses.push(
				`exists (select 1 from tweet_collections collection where collection.tweet_id = t.id and collection.kind = ?${accountClause("collection")})`,
			);
			const legacyColumn = savedKind === "likes" ? "liked" : "bookmarked";
			pushAccount();
			clauses.push(
				`t.${legacyColumn} = 1${account ? " and t.account_id = ?" : ""}`,
			);
		}
		params.push(kind);
		pushAccount();
		clauses.push(`t.kind = ?${account ? " and t.account_id = ?" : ""}`);
		return clauses.join(" or ");
	}
	if (account) {
		params.push(account, account, account);
		clauses.push(
			"exists (select 1 from tweet_account_edges edge where edge.tweet_id = t.id and edge.account_id = ?)",
		);
		clauses.push(
			"exists (select 1 from tweet_collections collection where collection.tweet_id = t.id and collection.account_id = ?)",
		);
		clauses.push("t.account_id = ?");
	}
	return clauses.join(" or ");
}

function collect(options: MediaFetchOptions, dir: string) {
	const seen = new Set<string>();
	const candidates: Candidate[] = [];
	const would_fetch: NonNullable<MediaFetchResult["would_fetch"]> = [];
	let skipped_cached = 0;

	for (const row of queryRows(options)) {
		for (const item of rowCandidates(row, dir, options.includeVideo ?? true)) {
			const identity = `${item.kind}:${item.mediaKey}`;
			if (seen.has(identity)) continue;
			seen.add(identity);
			if (existsSync(item.path)) {
				skipped_cached += 1;
			} else if (options.dryRun) {
				would_fetch.push({
					media_key: item.mediaKey,
					tweet_id: item.tweetId,
					kind: item.kind,
					url: item.url,
					path: item.path,
				});
			} else {
				candidates.push(item);
			}
		}
	}
	return { candidates, skipped_cached, would_fetch };
}

function fail(
	item: Candidate,
	reason: string,
	rateLimited = false,
): FetchOneResult {
	return {
		fetched: 0,
		bytes: 0,
		rateLimited,
		failure: { media_key: item.mediaKey, url: item.url, reason },
	};
}

/**
 * Archive reuse consumes files extracted by the sibling
 * `feat/import-archive-followers-following` branch into
 * `media/originals/archive/<kind>/<tweet_id>/...`.
 *
 * This fetcher intentionally does not extract archive ZIP media itself; it only
 * reuses that layout when it is already present.
 */
function archivePathFor(item: Candidate, mediaOriginalsDir: string) {
	if (item.archivePath) return item.archivePath;
	if (!item.tweetId || !item.mediaKey) return null;
	const ext = path.extname(item.path);
	if (!ext) return null;
	const fileName = `${item.tweetId}-${item.mediaKey}${ext}`;
	return (
		archiveTweetDirs(mediaOriginalsDir, item.tweetId)
			.map((tweetDir) => path.join(tweetDir, fileName))
			.find((archivePath) => existsSync(archivePath)) ?? null
	);
}

function reuseFromArchiveEffect(
	item: Candidate,
	mediaOriginalsDir: string,
	maxBytes: number,
): Effect.Effect<FetchOneResult | null, Error> {
	return Effect.gen(function* () {
		const archivePath = archivePathFor(item, mediaOriginalsDir);
		if (!archivePath || !existsSync(archivePath)) return null;
		const bytes = fileSize(archivePath);
		if (bytes > maxBytes) return fail(item, "max-bytes");
		yield* tryMediaPromise(() => copyFile(archivePath, item.tmpPath));
		yield* tryMediaPromise(() => rename(item.tmpPath, item.path));
		return {
			fetched: 1,
			bytes,
			rateLimited: false,
			kind: item.kind,
			reusedFromArchive: true,
		} satisfies FetchOneResult;
	});
}

function contentLength(response: Response) {
	const value = Number(response.headers.get("content-length"));
	return Number.isFinite(value) && value >= 0 ? value : null;
}

function contentRangeTotal(response: Response) {
	const total = /\/(\d+)\s*$/.exec(
		response.headers.get("content-range") ?? "",
	)?.[1];
	return total ? Number(total) : null;
}

function writeResponseBodyEffect(
	response: Response,
	tmpPath: string,
	append: boolean,
	maxBytes: number,
	initialBytes: number,
): Effect.Effect<number, Error> {
	return Effect.gen(function* () {
		if (!response.body)
			return yield* Effect.fail(new Error("missing response body"));
		let bytes = 0;
		if (!append) {
			yield* tryMediaPromise(() => writeFile(tmpPath, Buffer.alloc(0)));
		}
		const reader = response.body.getReader();
		const result = yield* Effect.gen(function* () {
			for (;;) {
				const { done, value } = yield* tryMediaPromise(() => reader.read());
				if (done) {
					break;
				}
				const chunk = Buffer.from(value);
				bytes += chunk.length;
				if (initialBytes + bytes > maxBytes) {
					yield* tryMediaPromise(() => rm(tmpPath, { force: true })).pipe(
						Effect.catchAll(() => Effect.void),
					);
					return yield* Effect.fail(new Error("max-bytes"));
				}
				yield* tryMediaPromise(() => appendFile(tmpPath, chunk));
			}
			return bytes;
		}).pipe(
			Effect.map((writtenBytes) => ({ ok: true as const, writtenBytes })),
			Effect.catchAll((error) =>
				Effect.gen(function* () {
					if (error.message === "max-bytes") {
						yield* tryMediaPromise(() => rm(tmpPath, { force: true })).pipe(
							Effect.catchAll(() => Effect.void),
						);
					}
					yield* tryMediaPromise(() => reader.cancel(error)).pipe(
						Effect.catchAll(() => Effect.void),
					);
					return { error, ok: false as const };
				}),
			),
			Effect.ensuring(Effect.sync(() => reader.releaseLock())),
		);
		if (!result.ok) return yield* Effect.fail(result.error);
		return result.writtenBytes;
	});
}

function fetchOneEffect({
	item,
	fetchImpl,
	sleep,
	retryMax,
	userAgent,
	maxBytes,
}: {
	item: Candidate;
	fetchImpl: FetchLike;
	sleep: (ms: number) => Promise<void>;
	retryMax: number;
	userAgent: string;
	maxBytes: number;
}): Effect.Effect<FetchOneResult, Error> {
	return Effect.gen(function* () {
		let rateLimited = false;
		for (let attempt = 0; attempt <= retryMax; attempt += 1) {
			const partialBytes = item.kind === "image" ? 0 : fileSize(item.tmpPath);
			if (partialBytes > maxBytes) {
				yield* tryMediaPromise(() => rm(item.tmpPath, { force: true })).pipe(
					Effect.catchAll(() => Effect.void),
				);
				return fail(item, "max-bytes");
			}
			const responseResult = yield* tryMediaPromise(() =>
				fetchImpl(item.url, {
					headers: {
						"user-agent": userAgent,
						...(partialBytes > 0 ? { range: `bytes=${partialBytes}-` } : {}),
					},
				}),
			).pipe(
				Effect.map((response) => ({ ok: true as const, response })),
				Effect.catchAll((error) =>
					Effect.succeed({ error, ok: false as const }),
				),
			);
			if (!responseResult.ok) {
				return fail(item, responseResult.error.message, rateLimited);
			}
			const { response } = responseResult;
			if (response.status === 429) {
				rateLimited = true;
				if (attempt < retryMax) {
					yield* tryMediaPromise(() => sleep(1000 * 2 ** attempt)).pipe(
						Effect.catchAll(() => Effect.void),
					);
					continue;
				}
				return fail(item, "429", true);
			}
			if (!response.ok && response.status !== 206) {
				return fail(item, String(response.status), rateLimited);
			}

			const expectedTotal =
				contentRangeTotal(response) ??
				(contentLength(response) ?? 0) +
					(response.status === 206 ? partialBytes : 0);
			if (expectedTotal > maxBytes) {
				yield* tryMediaPromise(() => rm(item.tmpPath, { force: true })).pipe(
					Effect.catchAll(() => Effect.void),
				);
				return fail(item, "max-bytes");
			}

			const append = partialBytes > 0 && response.status === 206;
			const bytesResult = yield* writeResponseBodyEffect(
				response,
				item.tmpPath,
				append,
				maxBytes,
				append ? partialBytes : 0,
			).pipe(
				Effect.map((bytes) => ({ bytes, ok: true as const })),
				Effect.catchAll((error) =>
					Effect.succeed({ error, ok: false as const }),
				),
			);
			if (!bytesResult.ok) {
				return fail(item, bytesResult.error.message, rateLimited);
			}
			yield* tryMediaPromise(() => rename(item.tmpPath, item.path));
			return {
				fetched: 1,
				bytes: bytesResult.bytes,
				rateLimited,
				kind: item.kind,
			};
		}
		return fail(item, "retry exhausted", rateLimited);
	});
}

function applyFetched(result: MediaFetchResult, fetched: FetchOneResult) {
	result.fetched += fetched.fetched;
	result.bytes += fetched.bytes;
	if (fetched.kind === "image") {
		result.images_fetched += 1;
		result.image_bytes += fetched.bytes;
	}
	if (fetched.kind === "video") {
		result.videos_fetched += 1;
		result.video_bytes += fetched.bytes;
	}
	if (fetched.kind === "gif") {
		result.gifs_fetched += 1;
		result.gif_bytes += fetched.bytes;
	}
	if (fetched.reusedFromArchive) result.reused_from_archive += 1;
	if (fetched.rateLimited) result.rate_limited += 1;
	if (fetched.failure) result.failures.push(fetched.failure);
}

function runGroupEffect(
	items: Candidate[],
	parallel: number,
	pacingMs: number,
	now: () => number,
	sleep: (ms: number) => Promise<void>,
	worker: (item: Candidate) => Promise<void>,
) {
	let lastStart: number | null = null;
	let pace = Promise.resolve();
	const pacedItems = items.map((item) => {
		const previous = pace;
		let release = () => {};
		pace = new Promise<void>((resolve) => {
			release = resolve;
		});
		return { item, previous, release };
	});
	const runPaced = ({
		item,
		previous,
		release,
	}: {
		item: Candidate;
		previous: Promise<void>;
		release: () => void;
	}) =>
		tryMediaPromise(() =>
			previous.then(() => {
				const waitMs =
					lastStart !== null ? Math.max(0, lastStart + pacingMs - now()) : 0;
				const wait = waitMs > 0 ? sleep(waitMs) : Promise.resolve();
				return wait.then(
					() => {
						let work: Promise<void>;
						try {
							lastStart = now();
							work = worker(item);
						} finally {
							release();
						}
						return work;
					},
					(error: unknown) => {
						release();
						throw error;
					},
				);
			}),
		);
	return Effect.forEach(pacedItems, runPaced, {
		concurrency: Math.min(parallel, items.length),
		discard: true,
	});
}

export function fetchTweetMedia(options: MediaFetchOptions = {}) {
	return runEffectPromise(fetchTweetMediaEffect(options));
}

export function fetchTweetMediaEffect(options: MediaFetchOptions = {}) {
	return Effect.gen(function* () {
		const now = options.now ?? Date.now;
		const startedAt = now();
		const sleep = options.sleep ?? defaultSleep;
		const fetchImpl = options.fetchImpl ?? fetch;
		const retryMax = Math.max(0, Math.floor(options.retryMax ?? 3));
		const parallel = Math.min(
			5,
			Math.max(1, Math.floor(options.parallel ?? 1)),
		);
		const pacingMs = Math.max(0, Math.floor(options.pacingMs ?? 250));
		const videoPacingMs = Math.max(
			0,
			Math.floor(options.videoPacingMs ?? pacingMs),
		);
		const maxBytes = Math.max(
			0,
			Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES),
		);
		const userAgent =
			options.userAgent ??
			`birdclaw/${packageVersion ?? "0.0.0"} (https://github.com/steipete/birdclaw)`;
		const { mediaOriginalsDir } = getBirdclawPaths();
		yield* tryMediaSync(() =>
			mkdirSync(mediaOriginalsDir, { recursive: true }),
		);

		const { candidates, skipped_cached, would_fetch } = yield* tryMediaSync(
			() => collect(options, mediaOriginalsDir),
		);
		const result: MediaFetchResult = {
			ok: true,
			fetched: 0,
			images_fetched: 0,
			videos_fetched: 0,
			gifs_fetched: 0,
			reused_from_archive: 0,
			skipped_cached,
			failed: 0,
			rate_limited: 0,
			bytes: 0,
			image_bytes: 0,
			video_bytes: 0,
			gif_bytes: 0,
			duration_ms: 0,
			failures: [],
			...(options.dryRun ? { dry_run: true as const, would_fetch } : {}),
		};

		if (!options.dryRun) {
			const httpCandidates: Candidate[] = [];
			for (const item of candidates) {
				const reused = yield* reuseFromArchiveEffect(
					item,
					mediaOriginalsDir,
					maxBytes,
				);
				if (reused) {
					applyFetched(result, reused);
				} else {
					httpCandidates.push(item);
				}
			}
			const fetchCandidate = (item: Candidate) =>
				runEffectPromise(
					fetchOneEffect({
						item,
						fetchImpl,
						sleep,
						retryMax,
						userAgent,
						maxBytes,
					}).pipe(Effect.map((fetched) => applyFetched(result, fetched))),
				);
			yield* runGroupEffect(
				httpCandidates.filter((item) => item.kind === "image"),
				parallel,
				pacingMs,
				now,
				sleep,
				fetchCandidate,
			);
			yield* runGroupEffect(
				httpCandidates.filter((item) => item.kind !== "image"),
				1,
				videoPacingMs,
				now,
				sleep,
				fetchCandidate,
			);
		}

		result.failed = result.failures.length;
		result.duration_ms = Math.max(0, Math.round(now() - startedAt));
		return result;
	});
}

export function formatMediaFetchResult(result: MediaFetchResult) {
	if (result.dry_run) {
		return [
			...(result.would_fetch ?? []).map(
				(item) => `${item.kind}\t${item.media_key}\t${item.url}\t${item.path}`,
			),
			`would_fetch=${result.would_fetch?.length ?? 0} skipped_cached=${result.skipped_cached}`,
		].join("\n");
	}
	return [
		`fetched=${result.fetched}`,
		`images=${result.images_fetched}`,
		`videos=${result.videos_fetched}`,
		`gifs=${result.gifs_fetched}`,
		`reused_from_archive=${result.reused_from_archive}`,
		`skipped_cached=${result.skipped_cached}`,
		`failed=${result.failed}`,
		`rate_limited=${result.rate_limited}`,
		`bytes=${result.bytes}`,
		`duration_ms=${result.duration_ms}`,
	].join(" ");
}
