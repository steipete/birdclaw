import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	ApiFetchError,
	fetchJson,
	fetchQueryEnvelope,
	fetchCachedQueryResponse,
} from "./api-client";
import { clearClientCache } from "./client-cache";

describe("api client", () => {
	afterEach(() => {
		clearClientCache();
		vi.unstubAllGlobals();
	});

	it("preserves ApiFetchError and status across the Promise boundary", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ message: "Rate limited" }), {
						status: 429,
					}),
			),
		);

		await expect(
			fetchJson(
				"/api/test",
				undefined,
				z.object({ ok: z.boolean() }),
				"Failed",
			),
		).rejects.toMatchObject({
			_tag: "ApiFetchError",
			message: "Rate limited",
			status: 429,
		});
		await expect(
			fetchJson(
				"/api/test",
				undefined,
				z.object({ ok: z.boolean() }),
				"Failed",
			),
		).rejects.toBeInstanceOf(ApiFetchError);
	});

	it("preserves AbortError so route hooks can ignore stale requests", async () => {
		const abortError = new DOMException(
			"The operation was aborted.",
			"AbortError",
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw abortError;
			}),
		);

		await expect(
			fetchJson(
				"/api/test",
				undefined,
				z.object({ ok: z.boolean() }),
				"Failed",
			),
		).rejects.toBe(abortError);
	});

	it("deduplicates status requests and reuses the fresh response", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				accounts: [],
				archives: [],
				transport: { statusText: "local" },
				stats: { home: 1, mentions: 2, dms: 3, needsReply: 4, inbox: 5 },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const [first, second] = await Promise.all([
			fetchQueryEnvelope(),
			fetchQueryEnvelope(),
		]);
		const third = await fetchQueryEnvelope();

		expect(first).toEqual(second);
		expect(third.stats.home).toBe(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("reuses cached query responses across remount-style requests", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				resource: "home",
				items: [{ id: "tweet-1" }],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const url = "/api/query?resource=home&refresh=0";

		const first = await fetchCachedQueryResponse(url);
		const second = await fetchCachedQueryResponse(
			"/api/query?refresh=99&resource=home",
		);

		expect(second).toEqual(first);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
