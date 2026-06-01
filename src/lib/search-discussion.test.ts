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
	collectSearchDiscussionContext,
	streamSearchDiscussion,
	streamSearchDiscussionEffect,
} from "./search-discussion";

const tempRoots: string[] = [];

function setupTempHome() {
	const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-discuss-"));
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

describe("search discussion", () => {
	it("collects keyword matches from tweets and optional DMs", () => {
		const context = collectSearchDiscussionContext({
			query: "local-first",
			includeDms: true,
			limit: 20,
		});

		expect(context.query).toBe("local-first");
		expect(context.tweets.map((tweet) => tweet.id)).toContain("tweet_001");
		expect(context.dms.map((dm) => dm.id)).toContain("dm_001");
		expect(context.hash).toHaveLength(40);
	});

	it("keeps live search scoped to the search bucket", () => {
		const context = collectSearchDiscussionContext({
			query: "local-first",
			source: "search",
			limit: 20,
		});

		expect(context.counts.home).toBe(0);
		expect(context.tweets.map((tweet) => tweet.id)).not.toContain("tweet_001");
	});

	it("changes the context hash when profile prompt context changes", () => {
		const first = collectSearchDiscussionContext({
			query: "local-first",
			limit: 20,
		});
		getNativeDb()
			.prepare("update profiles set bio = ? where id = 'profile_sam'")
			.run("Updated search discussion profile context.");
		const second = collectSearchDiscussionContext({
			query: "local-first",
			limit: 20,
		});

		expect(second.hash).not.toBe(first.hash);
	});

	it("keeps fitting tweets in the discussion prompt dataset", () => {
		const context = collectSearchDiscussionContext({
			query: "local-first",
			limit: 20,
		});
		const prompt = __test__.buildPrompt(context);

		expect(prompt).toContain(
			`Prompt tweets: ${String(context.tweets.length)} of ${String(context.tweets.length)}`,
		);
		expect(prompt).toContain(context.tweets[0]?.text);
	});

	it("preserves discussion tweets when DM matches exceed the prompt budget", () => {
		const context = collectSearchDiscussionContext({
			query: "local-first",
			limit: 20,
		});
		const prompt = __test__.buildPrompt({
			...context,
			dms: [
				{
					id: "huge_dm",
					participant: "person",
					name: "Person",
					lastMessageAt: "2026-01-01T00:00:00.000Z",
					text: "x".repeat(2_000_000),
					needsReply: false,
					influenceScore: 0,
				},
			],
		});

		expect(prompt).toContain(context.tweets[0]?.text);
		expect(prompt).toContain(`"dms":[]`);
	});

	it("keeps the context hash stable for cached live search provenance", () => {
		const first = collectSearchDiscussionContext({
			query: "local-first",
			source: "search",
			limit: 20,
			liveSearch: {
				ok: true,
				source: "bird",
				accountId: "acct_primary",
				query: "local-first",
				count: 1,
				pageCount: 1,
				tweetIds: ["tweet_001"],
			},
		});
		const second = collectSearchDiscussionContext({
			query: "local-first",
			source: "search",
			limit: 20,
			liveSearch: {
				ok: true,
				source: "cache",
				accountId: "acct_primary",
				query: "local-first",
				count: 1,
				pageCount: 1,
				tweetIds: ["tweet_001"],
			},
		});

		expect(second.hash).toBe(first.hash);
	});

	it("streams markdown, parses final JSON, and sends Responses API options", async () => {
		const streamed = [
			sseFrame({
				type: "response.output_text.delta",
				delta: "# Local-first\n\nThe thread is about durable local state.\n",
			}),
			sseFrame({
				type: "response.output_text.delta",
				delta:
					'\n---\n{"title":"Local-first","summary":"People discussed local-first durability","themes":[{"title":"Durability","summary":"Local state and repairability were the center.","tweetIds":["tweet_001"],"dmConversationIds":[],"handles":["sam"]}],"tensions":["Shipping fast vs repairable systems"],"followUps":["Open the linked local-first note"],"sourceTweetIds":["tweet_001"],"sourceDmConversationIds":[]}',
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
		const result = await streamSearchDiscussion(
			{
				query: "local-first",
				question: "What should I pay attention to?",
				mode: "local",
				refresh: true,
				limit: 20,
			},
			{ onDelta: (delta) => (markdown += delta) },
		);

		expect(markdown).toBe(
			"# Local-first\n\nThe thread is about durable local state.\n",
		);
		expect(result.discussion.title).toBe("Local-first");
		expect(result.discussion.themes[0]?.tweetIds).toEqual(["tweet_001"]);
		expect(result.markdown).toBe(markdown.trimEnd());
		expect(result.cached).toBe(false);

		const body = JSON.parse(
			String(fetchMock.mock.calls[0]?.[1]?.body),
		) as Record<string, unknown>;
		expect(body.model).toBe("gpt-5.5");
		expect(body.reasoning).toEqual({ effort: "medium" });
		expect(body.service_tier).toBe("priority");
		expect(body.stream).toBe(true);
		expect(JSON.stringify(body)).toContain("What should I pay attention to?");
	});

	it("uses environment AI defaults and renders optional prompt context", async () => {
		process.env.BIRDCLAW_AI_MODEL = "gpt-env";
		process.env.BIRDCLAW_OPENAI_REASONING_EFFORT = "low";
		process.env.BIRDCLAW_OPENAI_SERVICE_TIER = "flex";
		const streamed = [
			sseFrame({
				type: "response.output_text.delta",
				delta:
					'# Env\n\nDone.\n\n---\n{"title":"Env","summary":"Env defaults","themes":[],"tensions":[],"followUps":[],"sourceTweetIds":[],"sourceDmConversationIds":[]}',
			}),
			"data: [DONE]\n\n",
		].join("");
		const fetchMock = vi.fn().mockResolvedValue(streamResponse(streamed));
		vi.stubGlobal("fetch", fetchMock);

		await streamSearchDiscussion({
			query: "local-first",
			account: "acct_primary",
			source: "all",
			includeDms: true,
			since: "2026-05-01",
			until: "2026-05-24",
			question: "What changed?",
			mode: "local",
			refresh: true,
			limit: 20,
		});

		const body = JSON.parse(
			String(fetchMock.mock.calls[0]?.[1]?.body),
		) as Record<string, unknown>;
		expect(body.model).toBe("gpt-env");
		expect(body.reasoning).toEqual({ effort: "low" });
		expect(body.service_tier).toBe("flex");
		expect(JSON.stringify(body)).toContain("Account: acct_primary");
		expect(JSON.stringify(body)).toContain("Since: 2026-05-01");
		expect(JSON.stringify(body)).toContain("Until: 2026-05-24");
		expect(JSON.stringify(body)).toContain(
			"Discussion question: What changed?",
		);
	});

	it("exposes the discussion stream as an Effect program", async () => {
		const streamed = [
			sseFrame({
				type: "response.output_text.delta",
				delta:
					'# Effect\n\nThe stream is effectful.\n\n---\n{"title":"Effect","summary":"Effect stream","themes":[],"tensions":[],"followUps":[],"sourceTweetIds":[],"sourceDmConversationIds":[]}',
			}),
			"data: [DONE]\n\n",
		].join("");
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse(streamed)));

		const result = await Effect.runPromise(
			streamSearchDiscussionEffect({
				query: "local-first",
				mode: "local",
				refresh: true,
				limit: 20,
			}),
		);

		expect(result.discussion.title).toBe("Effect");
		expect(result.markdown).toBe("# Effect\n\nThe stream is effectful.");
	});

	it("serves cached discussions without calling OpenAI again", async () => {
		const streamed = [
			sseFrame({
				type: "response.output_text.delta",
				delta:
					'# Cached\n\nFirst pass.\n\n---\n{"title":"Cached","summary":"First pass","themes":[],"tensions":[],"followUps":[],"sourceTweetIds":[],"sourceDmConversationIds":[]}',
			}),
			"data: [DONE]\n\n",
		].join("");
		const fetchMock = vi.fn().mockResolvedValue(streamResponse(streamed));
		vi.stubGlobal("fetch", fetchMock);
		const options = { query: "local-first", mode: "local" as const, limit: 20 };

		await streamSearchDiscussion({ ...options, refresh: true });
		const cached = await streamSearchDiscussion(options);

		expect(cached.cached).toBe(true);
		expect(cached.discussion.title).toBe("Cached");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("rejects missing OpenAI credentials before starting the request", async () => {
		delete process.env.OPENAI_API_KEY;
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			streamSearchDiscussion({
				query: "local-first",
				mode: "local",
				refresh: true,
				limit: 20,
			}),
		).rejects.toThrow("OPENAI_API_KEY is not set");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("surfaces OpenAI response failures", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response("rate limited", {
					status: 429,
					statusText: "Too Many Requests",
				}),
			),
		);

		await expect(
			streamSearchDiscussion({
				query: "local-first",
				mode: "local",
				refresh: true,
				limit: 20,
			}),
		).rejects.toThrow("OpenAI request failed: 429 rate limited");
	});

	it("processes OpenAI stream event variants", () => {
		const handlers = {
			onDelta: vi.fn(),
			onEvent: vi.fn(),
		};
		const state: {
			eventBuffer: string;
			rawText: string;
			pendingVisible: string;
			jsonMode: boolean;
			responseId?: string;
			usage?: unknown;
		} = {
			eventBuffer: "",
			rawText: "",
			pendingVisible: "",
			jsonMode: false,
		};

		__test__.processSseChunk(
			state,
			sseFrame({
				type: "response.output_text.delta",
				delta: "# Title\n\nVisible text",
			}),
			handlers,
		);
		__test__.processSseChunk(
			state,
			sseFrame({
				type: "response.output_text.delta",
				delta: '\n\n---\n{"title":"Hidden"}',
			}),
			handlers,
		);
		__test__.processSseChunk(
			state,
			sseFrame({
				type: "response.completed",
				response: { id: "resp_123", usage: { output_tokens: 4 } },
			}),
			handlers,
		);
		__test__.processSseChunk(state, "data: {bad json}\n\n", handlers);
		__test__.processSseChunk(state, "data: [DONE]\n\n", handlers);

		expect(state.jsonMode).toBe(true);
		expect(state.responseId).toBe("resp_123");
		expect(state.usage).toEqual({ output_tokens: 4 });
		expect(handlers.onDelta.mock.calls.flat().join("")).toContain(
			"Visible text",
		);

		const failedState: {
			eventBuffer: string;
			rawText: string;
			pendingVisible: string;
			jsonMode: boolean;
			error?: string;
		} = {
			eventBuffer: "",
			rawText: "",
			pendingVisible: "",
			jsonMode: false,
		};
		__test__.processSseChunk(
			failedState,
			sseFrame({
				type: "response.failed",
				response: { incomplete_details: { reason: "max_output_tokens" } },
			}),
			{},
		);
		expect(failedState.error).toBe(
			"OpenAI response incomplete: max_output_tokens",
		);

		const errorState: {
			eventBuffer: string;
			rawText: string;
			pendingVisible: string;
			jsonMode: boolean;
			error?: string;
		} = {
			eventBuffer: "",
			rawText: "",
			pendingVisible: "",
			jsonMode: false,
		};
		__test__.processSseChunk(
			errorState,
			sseFrame({ type: "error", error: { message: "stream denied" } }),
			{},
		);
		expect(errorState.error).toBe("stream denied");
	});

	it("handles edge cases in streamed event parsing", () => {
		const holdState = {
			eventBuffer: "",
			rawText: "",
			pendingVisible: "",
			jsonMode: false,
		};
		const handlers = { onDelta: vi.fn(), onEvent: vi.fn() };
		__test__.processSseChunk(
			holdState,
			sseFrame({ type: "response.output_text.delta", delta: "tiny" }),
			handlers,
		);
		expect(holdState.pendingVisible).toBe("tiny");
		expect(handlers.onDelta).not.toHaveBeenCalled();

		const failedWithMessage: {
			eventBuffer: string;
			rawText: string;
			pendingVisible: string;
			jsonMode: boolean;
			error?: string;
		} = {
			eventBuffer: "",
			rawText: "",
			pendingVisible: "",
			jsonMode: false,
		};
		__test__.processSseChunk(
			failedWithMessage,
			sseFrame({
				type: "response.failed",
				response: { error: { message: "quota exhausted" } },
			}),
			{},
		);
		expect(failedWithMessage.error).toBe("quota exhausted");

		const failedDefault: {
			eventBuffer: string;
			rawText: string;
			pendingVisible: string;
			jsonMode: boolean;
			error?: string;
		} = {
			eventBuffer: "",
			rawText: "",
			pendingVisible: "",
			jsonMode: false,
		};
		__test__.processSseChunk(
			failedDefault,
			sseFrame({ type: "response.incomplete", response: {} }),
			{},
		);
		expect(failedDefault.error).toBe("OpenAI stream failed");

		const errorDefault: {
			eventBuffer: string;
			rawText: string;
			pendingVisible: string;
			jsonMode: boolean;
			error?: string;
		} = {
			eventBuffer: "",
			rawText: "",
			pendingVisible: "",
			jsonMode: false,
		};
		__test__.processSseChunk(
			errorDefault,
			sseFrame({ type: "response.error", error: "plain" }),
			{},
		);
		expect(errorDefault.error).toBe("OpenAI stream failed");

		const completedDefault = {
			eventBuffer: "",
			rawText: "",
			pendingVisible: "",
			jsonMode: false,
		};
		__test__.processSseChunk(
			completedDefault,
			sseFrame({ type: "response.completed", response: null }),
			{},
		);
		expect(completedDefault).not.toHaveProperty("responseId");
	});

	it("falls back when the streamed JSON is malformed", () => {
		const parsed = __test__.parseDiscussionFromHybridText(
			collectSearchDiscussionContext({
				query: "local-first",
				limit: 20,
			}),
			"# Report\n\nOnly Markdown\n\n---\n{bad",
		);

		expect(parsed.markdown).toContain("Only Markdown");
		expect(parsed.discussion.title).toContain("local-first");
	});
});
