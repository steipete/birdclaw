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
		expect(extractUrls("https://t.co/Drt7bgAjGC(GLM5.1")).toEqual([
			"https://t.co/Drt7bgAjGC",
		]);

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

	it.each([false, true])(
		"does not treat unresolved t.co HTTP 200 responses as hits (resolved DNS: %s)",
		async (resolvedDns) => {
			const fetchImpl = vi
				.fn()
				.mockImplementation((url: string) =>
					Promise.resolve({ ok: true, status: 200, url } as Response),
				);
			const { expandUrls } = await import("./url-expansion");
			const result = await expandUrls(["https://t.co/unresolved"], {
				fetchImpl,
				...(resolvedDns ? { resolveHost: async () => ["93.184.216.34"] } : {}),
			});
			expect(result[0]).toMatchObject({
				status: "miss",
				finalUrl: "https://t.co/unresolved",
			});
		},
	);

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

	it("does not cache custom-fetch redirect loops as successful expansions", async () => {
		const fetchImpl = vi.fn().mockImplementation((url: string) =>
			Promise.resolve({
				headers: new Headers({ location: `${url}/next` }),
				ok: false,
				status: 302,
				url,
			} as Response),
		);
		const { expandUrlsEffect } = await import("./url-expansion");

		await expect(
			Effect.runPromise(
				expandUrlsEffect(["https://t.co/loop"], {
					fetchImpl,
					successMaxAgeMs: -1,
				}),
			),
		).resolves.toEqual([
			expect.objectContaining({
				finalUrl: "https://t.co/loop",
				source: "network",
				status: "error",
			}),
		]);
	});

	it("reports unsafe expansion URLs without fetching", async () => {
		const fetchImpl = vi.fn();
		const { expandUrlsEffect } = await import("./url-expansion");

		await expect(
			Effect.runPromise(
				expandUrlsEffect(["http://127.0.0.1/admin"], {
					fetchImpl,
					successMaxAgeMs: -1,
				}),
			),
		).resolves.toEqual([
			expect.objectContaining({
				finalUrl: "http://127.0.0.1/admin",
				source: "network",
				status: "error",
				error: "Link preview URL points to a private host",
			}),
		]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("reports redirects without locations as expansion errors", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 302 }));
		const { expandUrlsEffect } = await import("./url-expansion");

		await expect(
			Effect.runPromise(
				expandUrlsEffect(["https://t.co/no-location"], {
					fetchImpl,
					successMaxAgeMs: -1,
				}),
			),
		).resolves.toEqual([
			expect.objectContaining({
				finalUrl: "https://t.co/no-location",
				source: "network",
				status: "error",
				error: "URL expansion ended on a redirect",
			}),
		]);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("follows GET redirects after a HEAD miss", async () => {
		const fetchImpl = vi
			.fn()
			.mockImplementation((url: string, init: RequestInit) =>
				Promise.resolve(
					init.method === "GET" && url === "https://t.co/get-redirect"
						? new Response(null, {
								status: 302,
								headers: { location: "https://example.com/get-final" },
							})
						: ({
								ok: true,
								status: 200,
								url,
							} as Response),
				),
			);
		const { expandUrlsEffect } = await import("./url-expansion");

		await expect(
			Effect.runPromise(
				expandUrlsEffect(["https://t.co/get-redirect"], {
					fetchImpl,
					successMaxAgeMs: -1,
				}),
			),
		).resolves.toEqual([
			expect.objectContaining({
				finalUrl: "https://example.com/get-final",
				source: "network",
				status: "hit",
			}),
		]);
		expect(fetchImpl.mock.calls.map(([, init]) => init?.method)).toEqual([
			"HEAD",
			"GET",
			"HEAD",
			"GET",
		]);
	});

	it("keeps safe resolved-address expansion HEAD-first through redirects", async () => {
		const fetchImpl = vi.fn().mockImplementation((url: string) =>
			Promise.resolve(
				url === "https://t.co/head"
					? ({
							headers: new Headers({
								location: "https://example.com/final",
							}),
							ok: false,
							status: 302,
							url,
						} as Response)
					: ({
							headers: new Headers(),
							ok: true,
							status: 200,
							url: "https://example.com/final",
						} as Response),
			),
		);
		const resolveHost = vi.fn().mockResolvedValue(["93.184.216.34"]);
		const { expandUrlsEffect } = await import("./url-expansion");

		await expect(
			Effect.runPromise(
				expandUrlsEffect(["https://t.co/head"], {
					fetchImpl,
					resolveHost,
					successMaxAgeMs: -1,
				}),
			),
		).resolves.toEqual([
			expect.objectContaining({
				finalUrl: "https://example.com/final",
				source: "network",
				status: "hit",
			}),
		]);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(fetchImpl.mock.calls.map(([, init]) => init?.method)).toEqual([
			"HEAD",
			"HEAD",
		]);
		expect(
			new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("user-agent"),
		).toBe("birdclaw/0.3 url-expander");
		expect(
			new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).get("user-agent"),
		).toContain("Mozilla/5.0");
	});
});
