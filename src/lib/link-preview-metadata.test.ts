// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import {
	__test__,
	extractLinkPreviewMetadata,
	fetchLinkPreviewMetadata,
	fetchLinkPreviewMetadataEffect,
	getOrFetchLinkPreview,
	getOrFetchLinkPreviewEffect,
} from "./link-preview-metadata";

const tempDirs: string[] = [];

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("link preview metadata", () => {
	it("extracts Open Graph, Twitter card, and relative images", () => {
		const metadata = extractLinkPreviewMetadata(
			`
      <html>
        <head>
          <meta property="og:title" content="Peekaboo">
          <meta name="description" content="A macOS automation tool">
          <meta property="og:site_name" content="Peekaboo">
          <meta property="og:image" content="/og.png">
        </head>
      </html>
      `,
			"https://peekaboo.sh/",
		);

		expect(metadata).toEqual({
			url: "https://peekaboo.sh/",
			title: "Peekaboo",
			description: "A macOS automation tool",
			imageUrl: "https://peekaboo.sh/og.png",
			siteName: "Peekaboo",
		});
	});

	it("falls back to YouTube thumbnails", () => {
		const metadata = extractLinkPreviewMetadata(
			"<title>Demo video</title>",
			"https://www.youtube.com/watch?v=mCO-D3pkviM",
		);

		expect(metadata.imageUrl).toBe(
			"https://i.ytimg.com/vi/mCO-D3pkviM/hqdefault.jpg",
		);
		expect(__test__.youtubeThumbnail("https://youtu.be/GMIWm5y90xA")).toBe(
			"https://i.ytimg.com/vi/GMIWm5y90xA/hqdefault.jpg",
		);
	});

	it("keeps malformed numeric HTML entities as text", () => {
		const metadata = extractLinkPreviewMetadata(
			"<title>&#999999999999; Demo</title>",
			"https://example.com/",
		);

		expect(metadata.title).toBe("&#999999999999; Demo");
	});

	it("treats direct image responses as image previews", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			url: "https://example.com/card.png",
			headers: new Headers({ "content-type": "image/png" }),
			text: vi.fn(),
		});

		await expect(
			fetchLinkPreviewMetadata("https://example.com/card.png", { fetchImpl }),
		).resolves.toMatchObject({
			imageUrl: "https://example.com/card.png",
			siteName: "example.com",
			title: "example.com",
		});
	});

	it("keeps link preview fetch effects lazy", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			url: "https://example.com/card.png",
			headers: new Headers({ "content-type": "image/png" }),
			text: vi.fn(),
		});

		const effect = fetchLinkPreviewMetadataEffect(
			"https://example.com/card.png",
			{ fetchImpl },
		);

		expect(fetchImpl).not.toHaveBeenCalled();
		await expect(Effect.runPromise(effect)).resolves.toMatchObject({
			imageUrl: "https://example.com/card.png",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("persists fetched previews on url expansions", async () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-preview-"));
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;
		resetBirdclawPathsForTests();
		resetDatabaseForTests();

		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			url: "https://peekaboo.sh/",
			headers: new Headers({ "content-type": "text/html" }),
			text: vi.fn().mockResolvedValue(`
        <meta property="og:title" content="Peekaboo">
        <meta property="og:image" content="https://peekaboo.sh/og.png">
      `),
		});

		await expect(
			getOrFetchLinkPreview("https://peekaboo.sh/", {
				shortUrl: "https://t.co/demo",
				fetchImpl,
			}),
		).resolves.toMatchObject({
			title: "Peekaboo",
			imageUrl: "https://peekaboo.sh/og.png",
		});

		expect(
			getNativeDb({ seedDemoData: false })
				.prepare(
					"select title, image_url from url_expansions where short_url = ?",
				)
				.get("https://t.co/demo"),
		).toEqual({
			title: "Peekaboo",
			image_url: "https://peekaboo.sh/og.png",
		});
	});

	it("keeps cached-preview effects lazy until run", async () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-preview-"));
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;
		resetBirdclawPathsForTests();
		resetDatabaseForTests();

		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			url: "https://example.com/",
			headers: new Headers({ "content-type": "text/html" }),
			text: vi.fn().mockResolvedValue("<title>Example</title>"),
		});

		const effect = getOrFetchLinkPreviewEffect("https://example.com/", {
			fetchImpl,
		});
		expect(fetchImpl).not.toHaveBeenCalled();

		await expect(Effect.runPromise(effect)).resolves.toMatchObject({
			title: "Example",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});
