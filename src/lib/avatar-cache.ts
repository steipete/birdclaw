import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { getBirdclawPaths } from "./config";
import { getNativeDb } from "./db";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import { assertSafePreviewUrl } from "./url-safety";

const AVATAR_SIZE_SUFFIX =
	/(?:(?:_normal|_bigger|_mini))(?=\.(?:jpg|jpeg|png|webp|gif)(?:$|\?))/i;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const MAX_AVATAR_DATA_URL_CHARS = MAX_AVATAR_BYTES * 4;
const REMOTE_AVATAR_TIMEOUT_MS = 10_000;
const DEFAULT_AVATAR_PREFETCH_CONCURRENCY = 8;
const ALLOWED_REMOTE_AVATAR_HOSTS = new Set(["pbs.twimg.com"]);
const RASTER_CONTENT_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/gif",
]);

function sanitizeFileToken(value: string) {
	return value.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

function getAvatarCacheDir() {
	const { mediaThumbsDir } = getBirdclawPaths();
	const dir = path.join(mediaThumbsDir, "avatars");
	mkdirSync(dir, { recursive: true });
	return dir;
}

function getExtensionFromContentType(contentType: string | null) {
	const mime = contentType?.split(";")[0].trim().toLowerCase() ?? "";
	if (mime === "image/png") return ".png";
	if (mime === "image/webp") return ".webp";
	if (mime === "image/gif") return ".gif";
	return ".jpg";
}

function getContentTypeFromExtension(extension: string) {
	switch (extension.toLowerCase()) {
		case ".png":
			return "image/png";
		case ".webp":
			return "image/webp";
		case ".gif":
			return "image/gif";
		default:
			return "image/jpeg";
	}
}

function getExtensionFromAvatarUrl(avatarUrl: string) {
	try {
		const url = new URL(avatarUrl);
		const extension = path.extname(url.pathname).toLowerCase();
		if (extension === ".png" || extension === ".webp" || extension === ".gif") {
			return extension;
		}
		return ".jpg";
	} catch {
		return ".jpg";
	}
}

function decodeDataUrl(dataUrl: string) {
	if (!dataUrl.startsWith("data:")) {
		throw new Error("Invalid avatar data URL");
	}
	if (dataUrl.length > MAX_AVATAR_DATA_URL_CHARS) {
		throw new Error("Avatar data URL is too large");
	}

	const separatorIndex = dataUrl.indexOf(",");
	if (separatorIndex < 0) {
		throw new Error("Invalid avatar data URL");
	}

	const metadata = dataUrl.slice(5, separatorIndex);
	const payload = dataUrl.slice(separatorIndex + 1);
	const contentType = metadata.split(";")[0] || "application/octet-stream";
	if (!RASTER_CONTENT_TYPES.has(contentType.toLowerCase())) {
		throw new Error("Avatar data URL must be a raster image");
	}
	const isBase64 = metadata.includes(";base64");
	const buffer = isBase64
		? Buffer.from(payload, "base64")
		: Buffer.from(decodeURIComponent(payload), "utf8");
	if (buffer.byteLength > MAX_AVATAR_BYTES) {
		throw new Error("Avatar data URL is too large");
	}
	return {
		contentType,
		buffer,
	};
}

function getAvatarUrlForProfile(profileId: string) {
	const row = getNativeDb()
		.prepare("select avatar_url from profiles where id = ?")
		.get(profileId) as { avatar_url: string | null } | undefined;
	return row?.avatar_url ?? null;
}

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function trySync<T>(try_: () => T) {
	return Effect.try({
		try: try_,
		catch: toError,
	});
}

function assertSafeRemoteAvatarUrl(avatarUrl: string) {
	const parsed = assertSafePreviewUrl(avatarUrl);
	if (parsed.protocol !== "https:") {
		throw new Error("Remote avatar URL must use https");
	}
	if (!ALLOWED_REMOTE_AVATAR_HOSTS.has(parsed.hostname.toLowerCase())) {
		throw new Error("Remote avatar host is not allowed");
	}
	return parsed.toString();
}

function normalizeContentType(value: string | null) {
	return value?.split(";")[0]?.trim().toLowerCase() ?? "image/jpeg";
}

function detectRasterContentType(buffer: Buffer, declared: string) {
	if (
		buffer.length >= 3 &&
		buffer[0] === 0xff &&
		buffer[1] === 0xd8 &&
		buffer[2] === 0xff
	) {
		return "image/jpeg";
	}
	if (
		buffer.length >= 4 &&
		buffer[0] === 0x89 &&
		buffer[1] === 0x50 &&
		buffer[2] === 0x4e &&
		buffer[3] === 0x47
	) {
		return "image/png";
	}
	if (
		buffer.length >= 12 &&
		buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
		buffer.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		return "image/webp";
	}
	if (
		buffer.length >= 6 &&
		(buffer.subarray(0, 6).toString("ascii") === "GIF87a" ||
			buffer.subarray(0, 6).toString("ascii") === "GIF89a")
	) {
		return "image/gif";
	}
	if (declared === "image/jpeg") {
		return "image/jpeg";
	}
	throw new Error("Avatar response is not a supported raster image");
}

export function normalizeAvatarUrl(value: unknown) {
	if (typeof value !== "string" || value.trim().length === 0) {
		return null;
	}

	const trimmed = value.trim();
	if (trimmed.startsWith("data:image/")) {
		return trimmed;
	}

	try {
		const url = new URL(trimmed);
		url.pathname = url.pathname.replace(AVATAR_SIZE_SUFFIX, "");
		return url.toString();
	} catch {
		return trimmed;
	}
}

export function getAvatarCachePath(profileId: string, avatarUrl: string) {
	const normalizedAvatarUrl = normalizeAvatarUrl(avatarUrl);
	if (!normalizedAvatarUrl) {
		throw new Error("Missing avatar URL");
	}

	const hash = createHash("sha1").update(normalizedAvatarUrl).digest("hex");
	const extension = normalizedAvatarUrl.startsWith("data:")
		? getExtensionFromContentType(
				/^data:([^;,]+)/i.exec(normalizedAvatarUrl)?.[1] ?? null,
			)
		: getExtensionFromAvatarUrl(normalizedAvatarUrl);

	return path.join(
		getAvatarCacheDir(),
		`${sanitizeFileToken(profileId)}-${hash}${extension}`,
	);
}

function fetchRemoteAvatarEffect(avatarUrl: string) {
	return Effect.gen(function* () {
		const safeUrl = yield* trySync(() => assertSafeRemoteAvatarUrl(avatarUrl));
		const response = yield* tryPromise(() =>
			fetch(safeUrl, {
				headers: {
					"user-agent": "birdclaw/avatar-cache",
				},
				redirect: "error",
				signal: AbortSignal.timeout(REMOTE_AVATAR_TIMEOUT_MS),
			}),
		);
		if (!response.ok) {
			return yield* Effect.fail(
				new Error(`Avatar fetch failed with ${response.status}`),
			);
		}

		const buffer = Buffer.from(yield* tryPromise(() => response.arrayBuffer()));
		if (buffer.byteLength > MAX_AVATAR_BYTES) {
			return yield* Effect.fail(new Error("Avatar response is too large"));
		}
		const contentType = yield* trySync(() =>
			detectRasterContentType(
				buffer,
				normalizeContentType(response.headers.get("content-type")),
			),
		);
		return {
			contentType,
			buffer,
		};
	});
}

export function readCachedAvatarEffect(profileId: string) {
	return Effect.gen(function* () {
		const avatarUrl = yield* trySync(() => getAvatarUrlForProfile(profileId));
		if (!avatarUrl) {
			return null;
		}

		const normalizedAvatarUrl = normalizeAvatarUrl(avatarUrl);
		if (!normalizedAvatarUrl) {
			return null;
		}

		const cachePath = yield* trySync(() =>
			getAvatarCachePath(profileId, normalizedAvatarUrl),
		);
		const cachedExtension = path.extname(cachePath);

		const cached = yield* trySync(() => readFileSync(cachePath)).pipe(
			Effect.map((buffer) => ({ ok: true as const, buffer })),
			Effect.catchAll(() => Effect.succeed({ ok: false as const })),
		);
		if (cached.ok) {
			return {
				buffer: cached.buffer,
				contentType: getContentTypeFromExtension(cachedExtension),
				cachePath,
				avatarUrl: normalizedAvatarUrl,
			};
		}

		const payload = normalizedAvatarUrl.startsWith("data:")
			? yield* trySync(() => decodeDataUrl(normalizedAvatarUrl))
			: yield* fetchRemoteAvatarEffect(normalizedAvatarUrl);

		yield* trySync(() => writeFileSync(cachePath, payload.buffer));
		return {
			buffer: payload.buffer,
			contentType: payload.contentType,
			cachePath,
			avatarUrl: normalizedAvatarUrl,
		};
	});
}

export function readCachedAvatar(profileId: string) {
	return runEffectPromise(readCachedAvatarEffect(profileId));
}

function normalizePrefetchConcurrency(value: number | undefined) {
	if (!Number.isFinite(value) || value === undefined) {
		return DEFAULT_AVATAR_PREFETCH_CONCURRENCY;
	}
	return Math.max(1, Math.min(Math.floor(value), 32));
}

export function prefetchCachedAvatarsForProfileIdsEffect(
	profileIds: string[],
	options: { concurrency?: number } = {},
) {
	const uniqueProfileIds = Array.from(
		new Set(
			profileIds
				.map((profileId) => profileId.trim())
				.filter((profileId) => profileId.length > 0),
		),
	);
	const concurrency = normalizePrefetchConcurrency(options.concurrency);

	return Effect.forEach(
		uniqueProfileIds,
		(profileId) =>
			readCachedAvatarEffect(profileId).pipe(
				Effect.map((avatar) =>
					avatar ? ("available" as const) : ("missing" as const),
				),
				Effect.catchAll(() => Effect.succeed("failed" as const)),
			),
		{ concurrency },
	).pipe(
		Effect.map((statuses) => ({
			requested: uniqueProfileIds.length,
			available: statuses.filter((status) => status === "available").length,
			missing: statuses.filter((status) => status === "missing").length,
			failed: statuses.filter((status) => status === "failed").length,
		})),
	);
}

export function prefetchCachedAvatarsForProfileIds(
	profileIds: string[],
	options: { concurrency?: number } = {},
) {
	return runEffectPromise(
		prefetchCachedAvatarsForProfileIdsEffect(profileIds, options),
	);
}

export const __test__ = {
	decodeDataUrl,
	detectRasterContentType,
	getAvatarCacheDir,
	getContentTypeFromExtension,
	getExtensionFromAvatarUrl,
	sanitizeFileToken,
};
