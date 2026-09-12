import { createHash, randomUUID } from "node:crypto";
import {
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { getBirdclawPaths, isReadOnlyDeployment } from "./config";
import { runEffectPromise } from "./effect-runtime";
import {
	decodedResponseBody,
	safePreviewFetchEffect,
	type GetLinkPreviewOptions,
} from "./link-preview-metadata";
import { assertSafePreviewUrl } from "./url-safety";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const MAX_CACHE_BYTES = 256 * 1024 * 1024;
const MAX_CACHE_FILES = 2048;
let cacheWrite: Promise<void> = Promise.resolve();

function bufferIsAvif(bytes: Buffer) {
	if (bytes.length < 16 || bytes.subarray(4, 8).toString("ascii") !== "ftyp")
		return false;
	const boxSize = bytes.readUInt32BE(0);
	if (boxSize < 16 || boxSize > bytes.length) return false;
	const brands = [bytes.subarray(8, 12).toString("ascii")];
	for (let offset = 16; offset + 4 <= boxSize; offset += 4)
		brands.push(bytes.subarray(offset, offset + 4).toString("ascii"));
	return brands.some((brand) => brand === "avif" || brand === "avis");
}

async function saveImage(cachePath: string, buffer: Buffer) {
	const save = cacheWrite
		.catch(() => {})
		.then(async () => {
			const directory = path.dirname(cachePath);
			await mkdir(directory, { recursive: true });
			const entries = await Promise.all(
				(await readdir(directory))
					.filter((name) => /^[a-f0-9]{64}\.image$/.test(name))
					.map(async (name) => {
						const filename = path.join(directory, name);
						const info = await stat(filename).catch(
							(error: NodeJS.ErrnoException) => {
								if (error.code === "ENOENT") return null;
								throw error;
							},
						);
						return info?.isFile()
							? { filename, size: info.size, modified: info.mtimeMs }
							: null;
					}),
			);
			const files = entries
				.filter((entry) => entry !== null)
				.sort((a, b) => a.modified - b.modified);
			let total = files.reduce((sum, file) => sum + file.size, 0);
			while (
				files.length &&
				(total + buffer.length > MAX_CACHE_BYTES ||
					files.length >= MAX_CACHE_FILES)
			) {
				const oldest = files.shift();
				if (!oldest) break;
				await rm(oldest.filename, { force: true });
				total -= oldest.size;
			}
			const temporaryPath = `${cachePath}.${randomUUID()}.tmp`;
			try {
				await writeFile(temporaryPath, buffer);
				await rename(temporaryPath, cachePath);
			} finally {
				await rm(temporaryPath, { force: true });
			}
		});
	cacheWrite = save;
	await save;
}

function rasterContentType(bytes: Buffer) {
	if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
		return "image/jpeg";
	if (
		bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
	)
		return "image/png";
	if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii")))
		return "image/gif";
	if (
		bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
		bytes.subarray(8, 12).toString("ascii") === "WEBP"
	)
		return "image/webp";
	if (bufferIsAvif(bytes)) return "image/avif";
	throw new Error("Preview is not a supported raster image");
}

export async function readPreviewImage(
	url: string,
	options: Pick<
		GetLinkPreviewOptions,
		"fetchImpl" | "resolveHost" | "timeoutMs"
	> = {},
) {
	const parsed = assertSafePreviewUrl(url);
	parsed.hash = "";
	const safeUrl = parsed.toString();
	const cachePath = path.join(
		getBirdclawPaths().mediaThumbsDir,
		"previews",
		`${createHash("sha256").update(safeUrl).digest("hex")}.image`,
	);
	try {
		const buffer = await readFile(cachePath);
		return { buffer, contentType: rasterContentType(buffer) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (isReadOnlyDeployment()) return null;
	const response = await runEffectPromise(
		safePreviewFetchEffect(safeUrl, options),
	);
	const body = decodedResponseBody(response);
	if (
		!response.ok ||
		Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES
	) {
		await body?.cancel();
		throw new Error("Preview image unavailable or too large");
	}
	if (!body) throw new Error("Preview image is empty");
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_IMAGE_BYTES) throw new Error("Preview image is too large");
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	const buffer = Buffer.concat(chunks);
	const contentType = rasterContentType(buffer);
	await saveImage(cachePath, buffer);
	return { buffer, contentType };
}

export function readPreviewImageEffect(url: string) {
	return Effect.tryPromise(() => readPreviewImage(url));
}
