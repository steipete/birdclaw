// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import {
	__test__,
	collectPeriodDigestContext,
	resolvePeriodDigestWindow,
	streamPeriodDigest,
	streamPeriodDigestEffect,
} from "./period-digest";

const tempRoots: string[] = [];

function setupTempHome() {
	const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-digest-"));
	tempRoots.push(tempRoot);
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
}

function sseFrame(value: unknown) {
	return `data: ${JSON.stringify(value)}\n\n`;
}

function streamResponse(text: string) {
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(text));
				controller.close();
			},
		}),
	);
}

beforeEach(() => {
	setupTempHome();
	process.env.OPENAI_API_KEY = "test-key";
});

afterEach(() => {
	vi.useRealTimers();
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	delete process.env.OPENAI_API_KEY;
	delete process.env.BIRDCLAW_AI_MODEL;
	delete process.env.BIRDCLAW_OPENAI_REASONING_EFFORT;
	delete process.env.BIRDCLAW_OPENAI_SERVICE_TIER;
	vi.unstubAllGlobals();
	for (const tempRoot of tempRoots.splice(0)) {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

describe("period digest", () => {
	it("resolves named local windows", () => {
		const now = new Date("2026-05-16T10:30:00.000Z");
		const today = resolvePeriodDigestWindow({ period: "today", now });
		const yesterday = resolvePeriodDigestWindow({ period: "yesterday", now });

		expect(today.label).toBe("Today");
		expect(today.until).toBe("2026-05-16T10:30:00.000Z");
		expect(new Date(today.since).getTime()).toBeLessThan(
			new Date(today.until).getTime(),
		);
		expect(yesterday.label).toBe("Yesterday");
		expect(new Date(yesterday.until).getTime()).toBe(
			new Date(today.since).getTime(),
		);
	});

	it("collects a deterministic local context hash", () => {
		const first = collectPeriodDigestContext({
			since: "2026-01-01T00:00:00.000Z",
			until: "2027-01-01T00:00:00.000Z",
			maxTweets: 20,
		});
		const second = collectPeriodDigestContext({
			since: "2026-01-01T00:00:00.000Z",
			until: "2027-01-01T00:00:00.000Z",
			maxTweets: 20,
		});

		expect(first.hash).toBe(second.hash);
		expect(first.tweets.length).toBeGreaterThan(0);
		expect(first.counts.home).toBeGreaterThan(0);
	});

	it("keeps same-day default windows on a stable cache key", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2028-05-16T10:30:00.000Z"));
		const first = collectPeriodDigestContext({ period: "today" });
		vi.setSystemTime(new Date("2028-05-16T12:30:00.000Z"));
		const second = collectPeriodDigestContext({ period: "today" });

		expect(first.window.until).not.toBe(second.window.until);
		expect(first.hash).toBe(second.hash);
	});

	it("streams markdown, parses final JSON, and sends GPT-5.5 medium priority", async () => {
		const streamed = [
			sseFrame({
				type: "response.output_text.delta",
				delta: "# Today\n\nA useful thing happened.\n",
			}),
			sseFrame({
				type: "response.output_text.delta",
				delta:
					'\n---\n{"title":"Today","summary":"Useful things happened","keyTopics":[{"title":"Launch","summary":"People discussed the launch","tweetIds":["tweet_1"],"handles":["alice"]}],"notableLinks":[],"people":[],"actionItems":[{"kind":"read","label":"Read the linked launch notes","tweetId":"tweet_1"}],"sourceTweetIds":["tweet_1"]}',
			}),
			sseFrame({
				type: "response.completed",
				response: { id: "resp_1", usage: { input_tokens: 10 } },
			}),
			"data: [DONE]\n\n",
		].join("");
		const fetchMock = vi.fn().mockResolvedValue(streamResponse(streamed));
		vi.stubGlobal("fetch", fetchMock);

		let markdown = "";
		const result = await streamPeriodDigest(
			{
				since: "2026-01-01T00:00:00.000Z",
				until: "2027-01-01T00:00:00.000Z",
				refresh: true,
			},
			{ onDelta: (delta) => (markdown += delta) },
		);

		expect(markdown).toBe("# Today\n\nA useful thing happened.\n");
		expect(result.digest.title).toBe("Today");
		expect(result.digest.actionItems).toHaveLength(1);
		expect(result.markdown).toBe(markdown.trimEnd());
		expect(result.cached).toBe(false);

		const body = JSON.parse(
			String(fetchMock.mock.calls[0]?.[1]?.body),
		) as Record<string, unknown>;
		expect(body.model).toBe("gpt-5.5");
		expect(body.reasoning).toEqual({ effort: "medium" });
		expect(body.service_tier).toBe("priority");
		expect(body.stream).toBe(true);
	});

	it("exposes the streaming digest as an Effect program", async () => {
		const streamed = [
			sseFrame({
				type: "response.output_text.delta",
				delta:
					'# Effect\n\nThe stream is effectful.\n\n---\n{"title":"Effect","summary":"Effect stream","keyTopics":[],"notableLinks":[],"people":[],"actionItems":[],"sourceTweetIds":[]}',
			}),
			"data: [DONE]\n\n",
		].join("");
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse(streamed)));

		const result = await Effect.runPromise(
			streamPeriodDigestEffect({
				since: "2026-01-01T00:00:00.000Z",
				until: "2027-01-01T00:00:00.000Z",
				refresh: true,
			}),
		);

		expect(result.digest.title).toBe("Effect");
		expect(result.markdown).toBe("# Effect\n\nThe stream is effectful.");
	});

	it("serves cached digests without calling OpenAI again", async () => {
		const streamed = [
			sseFrame({
				type: "response.output_text.delta",
				delta:
					'# Cached\n\nFirst pass.\n\n---\n{"title":"Cached","summary":"First pass","keyTopics":[],"notableLinks":[],"people":[],"actionItems":[],"sourceTweetIds":[]}',
			}),
			"data: [DONE]\n\n",
		].join("");
		const fetchMock = vi.fn().mockResolvedValue(streamResponse(streamed));
		vi.stubGlobal("fetch", fetchMock);
		const options = {
			since: "2026-01-01T00:00:00.000Z",
			until: "2027-01-01T00:00:00.000Z",
		};

		await streamPeriodDigest({ ...options, refresh: true });
		const cached = await streamPeriodDigest(options);

		expect(cached.cached).toBe(true);
		expect(cached.digest.title).toBe("Cached");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("rejects invalid cached digests through the Promise boundary", async () => {
		const streamed = [
			sseFrame({
				type: "response.output_text.delta",
				delta:
					'# Cached\n\nFirst pass.\n\n---\n{"title":"Cached","summary":"First pass","keyTopics":[],"notableLinks":[],"people":[],"actionItems":[],"sourceTweetIds":[]}',
			}),
			"data: [DONE]\n\n",
		].join("");
		const fetchMock = vi.fn().mockResolvedValue(streamResponse(streamed));
		vi.stubGlobal("fetch", fetchMock);
		const options = {
			since: "2026-01-01T00:00:00.000Z",
			until: "2027-01-01T00:00:00.000Z",
		};

		await streamPeriodDigest({ ...options, refresh: true });
		getNativeDb()
			.prepare(
				`
				update sync_cache
				set value_json = ?
				where cache_key like 'period-digest:%'
				`,
			)
			.run(
				JSON.stringify({
					digest: { title: "Invalid" },
					markdown: "# Invalid",
					model: "gpt-5.5",
					reasoningEffort: "medium",
					serviceTier: "priority",
				}),
			);

		let promise: Promise<unknown> | undefined;
		expect(() => {
			promise = streamPeriodDigest(options);
		}).not.toThrow();
		await expect(promise).rejects.toBeInstanceOf(Error);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("rejects failed Responses streams instead of caching partial output", async () => {
		const streamed = [
			sseFrame({
				type: "response.output_text.delta",
				delta: "# Partial\n\nThis should not be cached.\n",
			}),
			sseFrame({
				type: "response.failed",
				response: { error: { message: "model overloaded" } },
			}),
			"data: [DONE]\n\n",
		].join("");
		const fetchMock = vi.fn().mockResolvedValue(streamResponse(streamed));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			streamPeriodDigest({
				since: "2026-01-01T00:00:00.000Z",
				until: "2027-01-01T00:00:00.000Z",
				refresh: true,
			}),
		).rejects.toThrow("model overloaded");
	});

	it("rejects missing OpenAI credentials before starting the request", async () => {
		delete process.env.OPENAI_API_KEY;
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			streamPeriodDigest({
				since: "2026-01-01T00:00:00.000Z",
				until: "2027-01-01T00:00:00.000Z",
				refresh: true,
			}),
		).rejects.toThrow("OPENAI_API_KEY is not set");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects non-ok OpenAI responses with the response body", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 })),
		);

		await expect(
			streamPeriodDigest({
				since: "2026-01-01T00:00:00.000Z",
				until: "2027-01-01T00:00:00.000Z",
				refresh: true,
			}),
		).rejects.toThrow("OpenAI request failed: 429 rate limited");
	});

	it("passes abort signals to the OpenAI stream request", async () => {
		const controller = new AbortController();
		const fetchMock = vi.fn(
			(_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					);
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const promise = streamPeriodDigest({
			since: "2026-01-01T00:00:00.000Z",
			until: "2027-01-01T00:00:00.000Z",
			refresh: true,
			signal: controller.signal,
		});
		controller.abort();

		await expect(promise).rejects.toThrow("aborted");
		expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
	});

	it("falls back when the streamed JSON is malformed", () => {
		const parsed = __test__.parseDigestFromHybridText(
			collectPeriodDigestContext({
				since: "2026-01-01T00:00:00.000Z",
				until: "2027-01-01T00:00:00.000Z",
			}),
			"# Report\n\nOnly Markdown\n\n---\n{bad",
		);

		expect(parsed.markdown).toContain("Only Markdown");
		expect(parsed.digest.title).toContain("digest");
	});
});
