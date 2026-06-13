// @vitest-environment node
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEffectNdjsonResponse } from "./ndjson-stream";

afterEach(() => {
	vi.useRealTimers();
});

describe("createEffectNdjsonResponse", () => {
	it("opens immediately and sends heartbeats while work is pending", async () => {
		vi.useFakeTimers();
		let resolveRun: (() => void) | undefined;
		type TestEvent =
			| { type: "status"; label: string }
			| { type: "error"; error: string };
		const response = createEffectNdjsonResponse<TestEvent>({
			request: new Request("http://localhost/api/stream"),
			initialEvents: [{ type: "status", label: "Starting" }],
			run: () =>
				Effect.promise(
					() =>
						new Promise<void>((resolve) => {
							resolveRun = resolve;
						}),
				),
			errorEvent: (error) => ({ type: "error", error: String(error) }),
		});
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();

		const first = await reader!.read();
		expect(new TextDecoder().decode(first.value)).toBe(
			'{"type":"status","label":"Starting"}\n',
		);

		const initialPadding = new TextDecoder().decode(
			(await reader!.read()).value,
		);
		expect(initialPadding.trim()).toBe("");
		expect(initialPadding.length).toBeGreaterThanOrEqual(16_384);
		expect(resolveRun).toBeUndefined();
		await vi.advanceTimersByTimeAsync(25);
		expect(resolveRun).toBeTypeOf("function");

		const heartbeat = reader!.read();
		await vi.advanceTimersByTimeAsync(15_000);
		const heartbeatText = new TextDecoder().decode((await heartbeat).value);
		expect(heartbeatText.trim()).toBe("");
		expect(heartbeatText.length).toBeGreaterThanOrEqual(16_384);

		resolveRun?.();
		await reader!.cancel();
	});

	it("does not start work for an already-aborted request", async () => {
		const requestController = new AbortController();
		requestController.abort();
		const run = vi.fn(() => Effect.void);
		type TestEvent =
			| { type: "status"; label: string }
			| { type: "error"; error: string };

		const response = createEffectNdjsonResponse<TestEvent>({
			request: new Request("http://localhost/api/stream", {
				signal: requestController.signal,
			}),
			initialEvents: [{ type: "status", label: "Starting" }],
			run,
			errorEvent: (error) => ({ type: "error", error: String(error) }),
		});

		expect(run).not.toHaveBeenCalled();
		expect(await response.text()).toBe("");
	});
});
