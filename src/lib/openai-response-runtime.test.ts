// @vitest-environment node
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createOpenAIStreamState,
	processOpenAIResponseSseChunk,
	readOpenAIResponseStreamEffect,
	requestOpenAIResponseEffect,
} from "./openai-response-runtime";

afterEach(() => {
	delete process.env.OPENAI_API_KEY;
	delete process.env.OPENAI_BASE_URL;
	vi.unstubAllGlobals();
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

	it("uses OPENAI_BASE_URL for response requests", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));

		await Effect.runPromise(
			requestOpenAIResponseEffect({
				body: {},
				runtime: {
					fetch: fetchMock,
					now: () => new Date("2026-06-24T00:00:00Z"),
					random: () => 0,
					env: (name) =>
						name === "OPENAI_API_KEY"
							? "test"
							: name === "OPENAI_BASE_URL"
								? "http://127.0.0.1:8080/openai/v1/"
								: undefined,
				},
			}),
		);

		expect(fetchMock).toHaveBeenCalledWith(
			"http://127.0.0.1:8080/openai/v1/responses",
			expect.any(Object),
		);
	});
});
