// @vitest-environment node
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createOpenAIStreamState,
	processOpenAIResponseSseChunk,
	readOpenAIResponseStreamEffect,
	requestOpenAIResponseEffect,
	resolveOpenAIBaseUrl,
} from "./openai-response-runtime";

afterEach(() => {
	delete process.env.OPENAI_API_KEY;
	vi.unstubAllGlobals();
});

describe("resolveOpenAIBaseUrl", () => {
	it("defaults to the OpenAI endpoint", () => {
		expect(resolveOpenAIBaseUrl(() => undefined)).toBe(
			"https://api.openai.com/v1",
		);
	});

	it("uses the birdclaw override and trims trailing slashes", () => {
		const env: Record<string, string> = {
			BIRDCLAW_OPENAI_BASE_URL: "http://localhost:11434/v1/",
		};
		expect(resolveOpenAIBaseUrl((name) => env[name])).toBe(
			"http://localhost:11434/v1",
		);
	});

	it("retains OPENAI_BASE_URL as a compatibility fallback", () => {
		const env: Record<string, string> = {
			OPENAI_BASE_URL: "http://localhost:1234/v1",
		};
		expect(resolveOpenAIBaseUrl((name) => env[name])).toBe(
			"http://localhost:1234/v1",
		);
	});
});

describe("OpenAI response runtime", () => {
	it("streams visible markdown while retaining hybrid output and metadata", async () => {
		const visible: string[] = [];
		const stream = new ReadableStream({
			start(controller) {
				for (const event of [
					{ type: "response.output_text.delta", delta: "Hello\n-" },
					{ type: "response.output_text.delta", delta: '--\n{"ok":true}' },
					{
						type: "response.completed",
						response: { id: "resp_1", usage: { output_tokens: 2 } },
					},
				]) {
					controller.enqueue(
						new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
					);
				}
				controller.close();
			},
		});
		const result = await Effect.runPromise(
			readOpenAIResponseStreamEffect(new Response(stream), {
				onDelta: (delta) => visible.push(delta),
			}),
		);

		expect(visible.join("")).toBe("Hello");
		expect(result).toEqual({
			rawText: 'Hello\n---\n{"ok":true}',
			responseId: "resp_1",
			usage: { output_tokens: 2 },
		});
	});

	it("retains incomplete SSE frames and ignores malformed events", () => {
		const state = createOpenAIStreamState();
		processOpenAIResponseSseChunk(state, "data: {bad}\n\n");
		processOpenAIResponseSseChunk(
			state,
			`data: ${JSON.stringify({
				type: "response.output_text.delta",
				delta: "ok",
			})}`,
		);
		expect(state.rawText).toBe("");
		processOpenAIResponseSseChunk(state, "\n\n");
		expect(state.rawText).toBe("ok");
	});

	it("checks credentials and HTTP failures centrally", async () => {
		await expect(
			Effect.runPromise(requestOpenAIResponseEffect({ body: {} })),
		).rejects.toThrow("OPENAI_API_KEY");

		process.env.OPENAI_API_KEY = "test";
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("bad request", { status: 400 })),
		);
		await expect(
			Effect.runPromise(requestOpenAIResponseEffect({ body: {} })),
		).rejects.toThrow("400 bad request");
	});

	it("targets the configured base URL", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response("{}", { status: 200 }));
		const runtime = {
			fetch: fetchMock,
			now: () => new Date(),
			random: () => 0,
			env: (name: string) =>
				({
					OPENAI_API_KEY: "test",
					BIRDCLAW_OPENAI_BASE_URL: "http://localhost:11434/v1",
				})[name],
		};
		await Effect.runPromise(
			requestOpenAIResponseEffect({ body: { ok: true }, runtime }),
		);
		expect(fetchMock).toHaveBeenCalledWith(
			"http://localhost:11434/v1/responses",
			expect.objectContaining({ method: "POST" }),
		);
	});
});
