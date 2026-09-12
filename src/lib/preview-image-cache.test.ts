// @vitest-environment node
import {
	mkdtempSync,
	rmSync,
	readdirSync,
	mkdirSync,
	writeFileSync,
	truncateSync,
	existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { readPreviewImage } from "./preview-image-cache";

const homes: string[] = [];
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=",
	"base64",
);
function setup() {
	const home = mkdtempSync(path.join(os.tmpdir(), "birdclaw-preview-"));
	homes.push(home);
	vi.stubEnv("BIRDCLAW_HOME", home);
	resetBirdclawPathsForTests();
	return home;
}
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	resetBirdclawPathsForTests();
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
});

it("caches a public raster and serves it read-only without network or writes", async () => {
	const home = setup();
	const fetchImpl = vi.fn(
		async () => new Response(png, { headers: { "content-type": "image/png" } }),
	);
	const image = await readPreviewImage("https://example.com/preview.png", {
		fetchImpl,
	});
	expect(image?.buffer).toEqual(png);
	expect(image?.contentType).toBe("image/png");
	expect(readdirSync(path.join(home, "media/thumbs/previews"))).toHaveLength(1);
	vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "1");
	expect(
		(await readPreviewImage("https://example.com/preview.png", { fetchImpl }))
			?.buffer,
	).toEqual(png);
	expect(
		await readPreviewImage("https://example.com/missing.png", { fetchImpl }),
	).toBeNull();
	expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("rejects private redirect targets before fetching them", async () => {
	setup();
	const fetchImpl = vi.fn(
		async () =>
			new Response(null, {
				status: 302,
				headers: { location: "http://127.0.0.1/secret" },
			}),
	);
	await expect(
		readPreviewImage("https://example.com/image", { fetchImpl }),
	).rejects.toThrow(/private host/);
	expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("rejects HTML or SVG disguised as a raster and oversized streams", async () => {
	setup();
	for (const content of ["<html>secret</html>", "<svg onload='alert(1)'/>"]) {
		await expect(
			readPreviewImage("https://example.com/image", {
				fetchImpl: async () =>
					new Response(content, { headers: { "content-type": "image/jpeg" } }),
			}),
		).rejects.toThrow(/raster/);
	}
	let cancelled = false;
	const stream = new ReadableStream({
		pull(c) {
			c.enqueue(new Uint8Array(1024 * 1024));
		},
		cancel() {
			cancelled = true;
		},
	});
	await expect(
		readPreviewImage("https://example.com/large", {
			fetchImpl: async () => new Response(stream),
		}),
	).rejects.toThrow(/too large/);
	expect(cancelled).toBe(true);
});

it("accepts AVIF compatible brands and deduplicates URL fragments", async () => {
	setup();
	const avif = Buffer.alloc(24);
	avif.writeUInt32BE(24);
	avif.write("ftyp", 4);
	avif.write("mif1", 8);
	avif.write("avif", 16);
	const fetchImpl = vi.fn(async () => new Response(avif));
	expect(
		(await readPreviewImage("https://example.com/photo#one", { fetchImpl }))
			?.contentType,
	).toBe("image/avif");
	await readPreviewImage("https://example.com/photo#two", { fetchImpl });
	expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("evicts oversized old cache entries without deleting unrelated files", async () => {
	const home = setup();
	const directory = path.join(home, "media/thumbs/previews");
	mkdirSync(directory, { recursive: true });
	const old = path.join(directory, "0".repeat(64) + ".image");
	writeFileSync(old, png);
	truncateSync(old, 256 * 1024 * 1024);
	const unrelated = path.join(directory, "keep.txt");
	writeFileSync(unrelated, "operator note");
	await readPreviewImage("https://example.com/new", {
		fetchImpl: async () => new Response(png),
	});
	expect(existsSync(old)).toBe(false);
	expect(existsSync(unrelated)).toBe(true);
});
