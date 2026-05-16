import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { getBirdclawPaths } from "./config";
import { getNativeDb } from "./db";
import { runEffectPromise, tryPromise } from "./effect-runtime";

const AVATAR_SIZE_SUFFIX =
	/(?:(?:_normal|_bigger|_mini))(?=\.(?:jpg|jpeg|png|webp|gif)(?:$|\?))/i;

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
	if (mime === "image/svg+xml") return ".svg";
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
		case ".svg":
			return "image/svg+xml";
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
		return extension === ".svg" ? ".svg" : ".jpg";
	} catch {
		return ".jpg";
	}
}

function decodeDataUrl(dataUrl: string) {
	if (!dataUrl.startsWith("data:")) {
		throw new Error("Invalid avatar data URL");
	}

	const separatorIndex = dataUrl.indexOf(",");
	if (separatorIndex < 0) {
		throw new Error("Invalid avatar data URL");
	}

	const metadata = dataUrl.slice(5, separatorIndex);
	const payload = dataUrl.slice(separatorIndex + 1);
	const contentType = metadata.split(";")[0] || "application/octet-stream";
	const isBase64 = metadata.includes(";base64");
	return {
		contentType,
		buffer: isBase64
			? Buffer.from(payload, "base64")
			: Buffer.from(decodeURIComponent(payload), "utf8"),
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
		const response = yield* tryPromise(() =>
			fetch(avatarUrl, {
				headers: {
					"user-agent": "birdclaw/avatar-cache",
				},
			}),
		);
		if (!response.ok) {
			return yield* Effect.fail(
				new Error(`Avatar fetch failed with ${response.status}`),
			);
		}

		const buffer = Buffer.from(yield* tryPromise(() => response.arrayBuffer()));
		return {
			contentType: response.headers.get("content-type") ?? "image/jpeg",
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

export const __test__ = {
	decodeDataUrl,
	getAvatarCacheDir,
	getContentTypeFromExtension,
	getExtensionFromAvatarUrl,
	sanitizeFileToken,
};
