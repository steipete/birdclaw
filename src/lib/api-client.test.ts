import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiFetchError, fetchJson, postSync } from "./api-client";
import { createRuntimeServices } from "./runtime-services";

describe("api client", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it.each([
		{ cause: new Error("offline"), message: "offline" },
		{ cause: "transport failed", message: "transport failed" },
		{ cause: null, message: "Fallback" },
	])(
		"preserves transport failure details: $message",
		async ({ cause, message }) => {
			const fetch = vi.fn().mockRejectedValue(cause);
			await expect(
				fetchJson(
					"/api/test",
					undefined,
					z.object({ ok: z.boolean() }),
					"Fallback",
					createRuntimeServices({ fetch }),
				),
			).rejects.toMatchObject({ _tag: "ApiFetchError", message, cause });
		},
	);

	it("uses the fallback for non-JSON HTTP errors and rejects malformed JSON success", async () => {
		for (const status of [503, 200]) {
			const fetch = vi.fn(
				async () => new Response("<html>unavailable</html>", { status }),
			);
			await expect(
				fetchJson(
					"/api/test",
					undefined,
					z.object({ ok: z.boolean() }),
					"Unavailable",
					createRuntimeServices({ fetch }),
				),
			).rejects.toMatchObject({
				_tag: "ApiFetchError",
				message: "Unavailable",
				...(status === 503 ? { status } : {}),
			});
		}
	});

	it("passes cancellation to an active fetch without wrapping its AbortError", async () => {
		const controller = new AbortController();
		const fetch = vi.fn(
			(_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(init.signal?.reason),
						{ once: true },
					);
				}),
		);
		const pending = fetchJson(
			"/api/test",
			{ signal: controller.signal },
			z.object({ ok: z.boolean() }),
			"Unavailable",
			createRuntimeServices({ fetch }),
		);
		controller.abort();
		await expect(pending).rejects.toBe(controller.signal.reason);
	});

	it("paces repeated sync polls and preserves the final result", async () => {
		vi.useFakeTimers();
		const job = {
			id: "demo_sync",
			kind: "timeline",
			status: "running",
			startedAt: "2026-01-01T00:00:00Z",
			summary: "Running",
			inProgress: true,
		};
		const result = {
			ok: true,
			kind: "timeline",
			startedAt: "2026-01-01T00:00:00Z",
			summary: "Complete",
			steps: [],
		};
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(Response.json(job))
			.mockResolvedValueOnce(Response.json(job))
			.mockResolvedValueOnce(
				Response.json({
					...job,
					status: "succeeded",
					inProgress: false,
					result,
				}),
			);
		vi.stubGlobal("fetch", fetch);
		const pending = postSync("timeline", "acct_demo", { limit: 20 });
		await vi.advanceTimersByTimeAsync(499);
		expect(fetch).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(String(fetch.mock.calls[1]?.[0])).toContain(
			"/api/sync?id=demo_sync",
		);
		await vi.advanceTimersByTimeAsync(500);
		await expect(pending).resolves.toEqual(result);
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({
			kind: "timeline",
			accountId: "acct_demo",
			limit: 20,
		});
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

	it("accepts an injected fetch service", async () => {
		const fetch = vi.fn(async () => Response.json({ ok: true }));

		await expect(
			fetchJson(
				"/api/test",
				undefined,
				z.object({ ok: z.boolean() }),
				"Failed",
				createRuntimeServices({ fetch }),
			),
		).resolves.toEqual({ ok: true });
		expect(fetch).toHaveBeenCalledWith("/api/test");
	});

	it("rejects malformed successful responses at the shared boundary", async () => {
		const fetch = vi.fn(async () => Response.json({ ok: "yes" }));

		await expect(
			fetchJson(
				"/api/test",
				undefined,
				z.object({ ok: z.boolean() }),
				"Malformed response",
				createRuntimeServices({ fetch }),
			),
		).rejects.toMatchObject({
			_tag: "ApiFetchError",
			message: "Malformed response",
		});
	});
});
