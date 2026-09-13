// @vitest-environment node
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	analysisReportCacheKey,
	emitCachedAnalysis,
	generateAnalysisReportEffect,
	readAnalysisReport,
} from "./analysis-report";
import { runEffectPromise } from "./effect-runtime";

const io = vi.hoisted(() => ({
	read: vi.fn(),
	write: vi.fn(),
	stream: vi.fn(),
	complete: vi.fn(),
}));
vi.mock("./sync-cache", () => ({
	readSyncCache: io.read,
	writeSyncCache: io.write,
}));
vi.mock("./analysis-runtime", async (importOriginal) => ({
	...(await importOriginal<typeof import("./analysis-runtime")>()),
	streamHybridAnalysisEffect: io.stream,
	requestHybridAnalysisEffect: io.complete,
}));

const settings = {
	model: "test-model",
	reasoningEffort: "high",
	serviceTier: "flex",
} as const;
const output = {
	value: { title: "Report" },
	markdown: "Summary",
	rawText: "raw",
	responseId: "response",
	usage: { output_tokens: 7 },
};
const parse = (value: unknown) => {
	if (
		!value ||
		typeof value !== "object" ||
		!("title" in value) ||
		typeof value.title !== "string"
	)
		throw new Error("Invalid report");
	return { title: value.title };
};
const input = {
	context: { hash: "context", citations: [] as string[] },
	key: "analysis" as const,
	cacheKey: () =>
		analysisReportCacheKey("profile-analysis:result", settings, "context"),
	options: settings,
	system: "system",
	prompt: () => "prompt",
	parse,
	fallback: () => ({ title: "Fallback" }),
};

beforeEach(() => {
	vi.resetAllMocks();
	io.read.mockReturnValue(null);
	io.write.mockReturnValue("2026-09-12T00:00:00Z");
	io.complete.mockReturnValue(Effect.succeed(output));
	io.stream.mockReturnValue(Effect.succeed(output));
});

describe("analysis report lifecycle", () => {
	it("keeps streamed deltas ahead of persistence, enrichment, and completion", async () => {
		const order: string[] = [];
		io.stream.mockImplementation(({ onDelta }) =>
			Effect.sync(() => {
				onDelta("Summary");
				return output;
			}),
		);
		io.write.mockImplementation(() => {
			order.push("persist");
			return "saved-at";
		});
		const result = await runEffectPromise(
			generateAnalysisReportEffect({
				...input,
				handlers: { onEvent: (event) => order.push(event.type) },
				onStart: () => order.push("status"),
				enrichContext: () => ({ ...input.context, citations: ["tweet_1"] }),
				onSaved: () => order.push("latest-cache"),
			}),
		);
		expect(order).toEqual([
			"start",
			"status",
			"delta",
			"persist",
			"latest-cache",
			"done",
		]);
		expect(result).toMatchObject({
			context: { citations: ["tweet_1"] },
			analysis: output.value,
			cached: false,
			updatedAt: "saved-at",
		});
		expect(io.write).toHaveBeenCalledWith(
			"profile-analysis:result:test-model:high:flex:context",
			{
				...settings,
				analysis: output.value,
				markdown: output.markdown,
				responseId: output.responseId,
				usage: output.usage,
			},
		);
		expect(io.stream.mock.calls[0]![0].body).toMatchObject({
			stream: true,
			input: [
				{ role: "system", content: "system" },
				{ role: "user", content: "prompt" },
			],
		});
		expect(io.complete).not.toHaveBeenCalled();
	});

	it("publishes a complete profile response only after persistence and omits stream usage", async () => {
		const order: string[] = [];
		io.write.mockImplementation(() => {
			order.push("persist");
			return "saved-at";
		});
		await runEffectPromise(
			generateAnalysisReportEffect({
				...input,
				delivery: "complete",
				handlers: { onEvent: (event) => order.push(event.type) },
			}),
		);
		expect(order).toEqual(["start", "persist", "delta", "done"]);
		expect(io.write.mock.calls[0]![1]).toEqual({
			...settings,
			analysis: output.value,
			markdown: output.markdown,
		});
		expect(io.complete.mock.calls[0]![0].body).not.toHaveProperty("stream");
		expect(io.stream).not.toHaveBeenCalled();
	});

	it.each(["stream", "complete"] as const)(
		"does not cache or complete a failed %s request",
		async (delivery) => {
			const failure = new Error("Request aborted");
			io.stream.mockReturnValue(Effect.fail(failure));
			io.complete.mockReturnValue(Effect.fail(failure));
			const events: string[] = [];
			const controller = new AbortController();
			await expect(
				runEffectPromise(
					generateAnalysisReportEffect({
						...input,
						delivery,
						options: { ...settings, signal: controller.signal },
						handlers: { onEvent: (event) => events.push(event.type) },
					}),
				),
			).rejects.toBe(failure);
			expect(events).toEqual(["start"]);
			expect(io.write).not.toHaveBeenCalled();
			expect(
				(delivery === "stream" ? io.stream : io.complete).mock.calls[0]![0]
					.signal,
			).toBe(controller.signal);
		},
	);

	it("does not emit done when post-save bookkeeping fails", async () => {
		const events: string[] = [];
		await expect(
			runEffectPromise(
				generateAnalysisReportEffect({
					...input,
					handlers: { onEvent: (event) => events.push(event.type) },
					onSaved: () => {
						throw new Error("Cache unavailable");
					},
				}),
			),
		).rejects.toThrow("Cache unavailable");
		expect(io.write).toHaveBeenCalledOnce();
		expect(events).toEqual(["start"]);
	});

	it("validates cached values and replays them without model work", () => {
		expect(
			readAnalysisReport("key", input.context, "analysis", parse),
		).toBeNull();
		io.read.mockReturnValue({
			value: { ...settings, analysis: output.value, markdown: "Cached" },
			updatedAt: "stored-at",
		});
		const result = readAnalysisReport("key", input.context, "analysis", parse)!;
		const events: string[] = [];
		emitCachedAnalysis(result, { onEvent: (event) => events.push(event.type) });
		expect(result).toEqual({
			...settings,
			context: input.context,
			analysis: output.value,
			markdown: "Cached",
			cached: true,
			updatedAt: "stored-at",
		});
		expect(events).toEqual(["start", "delta", "done"]);
		expect(io.stream).not.toHaveBeenCalled();
		expect(io.complete).not.toHaveBeenCalled();
		io.read.mockReturnValue({
			value: { analysis: null },
			updatedAt: "stored-at",
		});
		expect(() =>
			readAnalysisReport("key", input.context, "analysis", parse),
		).toThrow("Invalid report");
	});
});
