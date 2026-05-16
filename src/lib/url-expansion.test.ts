// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { resetDatabaseForTests } from "./db";

let homeDir = "";

describe("URL expansion cache", () => {
	beforeEach(() => {
		homeDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-url-expansion-"));
		process.env.BIRDCLAW_HOME = homeDir;
		resetBirdclawPathsForTests();
		resetDatabaseForTests();
	});

	afterEach(() => {
		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		delete process.env.BIRDCLAW_HOME;
		rmSync(homeDir, { recursive: true, force: true });
	});

	it("extracts URLs and avoids repeated network expansion when cached", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			url: "https://docs.blacksmith.sh/blacksmith-testbox/overview",
		});
		const { expandUrlsFromTexts, extractUrls } =
			await import("./url-expansion");

		expect(
			extractUrls("See https://t.co/uEKD3k4vep, and https://example.com/x."),
		).toEqual(["https://t.co/uEKD3k4vep", "https://example.com/x"]);

		await expect(
			expandUrlsFromTexts(["See https://t.co/uEKD3k4vep"], {
				fetchImpl,
			}),
		).resolves.toEqual([
			expect.objectContaining({
				url: "https://t.co/uEKD3k4vep",
				finalUrl: "https://docs.blacksmith.sh/blacksmith-testbox/overview",
				status: "hit",
				source: "network",
			}),
		]);
		await expect(
			expandUrlsFromTexts(["Again https://t.co/uEKD3k4vep"], {
				fetchImpl,
			}),
		).resolves.toEqual([
			expect.objectContaining({
				finalUrl: "https://docs.blacksmith.sh/blacksmith-testbox/overview",
				source: "cache",
			}),
		]);
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		const { getNativeDb } = await import("./db");
		expect(
			getNativeDb()
				.prepare(
					"select final_url from url_expansions where short_url = 'https://t.co/uEKD3k4vep'",
				)
				.get(),
		).toEqual({
			final_url: "https://docs.blacksmith.sh/blacksmith-testbox/overview",
		});
	});

	it("falls back from HEAD to GET and caches misses", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce({
				ok: false,
				status: 500,
				url: "https://t.co/bad",
			})
			.mockResolvedValueOnce({
				ok: false,
				status: 404,
				url: "https://t.co/bad",
			});
		const { expandUrls } = await import("./url-expansion");

		await expect(
			expandUrls(["https://t.co/bad"], { fetchImpl }),
		).resolves.toEqual([
			expect.objectContaining({
				url: "https://t.co/bad",
				finalUrl: "https://t.co/bad",
				status: "miss",
				error: "HTTP 404",
				source: "network",
			}),
		]);
		await expect(
			expandUrls(["https://t.co/bad"], { fetchImpl }),
		).resolves.toEqual([
			expect.objectContaining({
				status: "miss",
				error: "HTTP 404",
				source: "cache",
			}),
		]);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("caches network expansion errors", async () => {
		const fetchImpl = vi.fn().mockRejectedValue("network down");
		const { expandUrls } = await import("./url-expansion");

		await expect(
			expandUrls(["https://t.co/error"], { fetchImpl }),
		).resolves.toEqual([
			expect.objectContaining({
				url: "https://t.co/error",
				status: "error",
				error: "network down",
				source: "network",
			}),
		]);
		await expect(
			expandUrls(["https://t.co/error"], { fetchImpl }),
		).resolves.toEqual([
			expect.objectContaining({
				status: "error",
				error: "network down",
				source: "cache",
			}),
		]);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("returns rich cached metadata and refreshes stale entries", async () => {
		const { writeSyncCache } = await import("./sync-cache");
		const { __test__, expandUrls } = await import("./url-expansion");
		writeSyncCache(__test__.cacheKeyForUrl("https://t.co/card"), {
			expandedUrl: "https://example.com/card",
			finalUrl: "https://example.com/card",
			status: "hit",
			title: "Card title",
			description: "Card description",
		});
		writeSyncCache(__test__.cacheKeyForUrl("https://t.co/stale"), {
			expandedUrl: "https://example.com/stale",
			finalUrl: "https://example.com/stale",
			status: "hit",
		});
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			url: "",
		});

		await expect(
			expandUrls(["https://t.co/card"], { fetchImpl }),
		).resolves.toEqual([
			expect.objectContaining({
				title: "Card title",
				description: "Card description",
				source: "cache",
			}),
		]);
		await expect(
			expandUrls(["https://t.co/stale"], {
				fetchImpl,
				successMaxAgeMs: -1,
			}),
		).resolves.toEqual([
			expect.objectContaining({
				finalUrl: "https://t.co/stale",
				source: "network",
			}),
		]);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("exposes URL expansion as Effect programs", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			url: "https://example.com/final",
		});
		const { expandUrlsEffect, expandUrlsFromTextsEffect } =
			await import("./url-expansion");

		await expect(
			Effect.runPromise(
				expandUrlsEffect(["https://t.co/effect"], { fetchImpl }),
			),
		).resolves.toEqual([
			expect.objectContaining({
				finalUrl: "https://example.com/final",
				source: "network",
			}),
		]);
		await expect(
			Effect.runPromise(
				expandUrlsFromTextsEffect(["Again https://t.co/effect"], {
					fetchImpl,
				}),
			),
		).resolves.toEqual([
			expect.objectContaining({
				finalUrl: "https://example.com/final",
				source: "cache",
			}),
		]);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});
