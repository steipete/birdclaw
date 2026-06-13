import { Effect } from "effect";
import { runEffectBackground } from "./effect-runtime";

const encoder = new TextEncoder();
const HEARTBEAT_INTERVAL_MS = 15_000;
const STREAM_START_DELAY_MS = 25;
const FLUSH_PADDING = `${" ".repeat(16_384)}\n`;

export function createEffectNdjsonResponse<Event>({
	request,
	initialEvents = [],
	run,
	errorEvent,
}: {
	request: Request;
	initialEvents?: Event[];
	run: (context: {
		signal: AbortSignal;
		emit: (event: Event) => void;
	}) => Effect.Effect<unknown, unknown>;
	errorEvent: (error: unknown) => Event;
}) {
	let abortStream: (() => void) | undefined;

	return new Response(
		new ReadableStream<Uint8Array>({
			cancel() {
				abortStream?.();
			},
			start(controller) {
				const abortController = new AbortController();
				let closed = false;
				let heartbeat: ReturnType<typeof setInterval> | undefined;
				let startTimer: ReturnType<typeof setTimeout> | undefined;

				const cleanup = () => {
					request.signal.removeEventListener("abort", abort);
					if (heartbeat !== undefined) clearInterval(heartbeat);
					if (startTimer !== undefined) clearTimeout(startTimer);
				};
				const abort = () => {
					if (closed) return;
					closed = true;
					cleanup();
					abortController.abort();
				};
				const close = () => {
					if (closed) return;
					closed = true;
					cleanup();
					abortController.abort();
					controller.close();
				};
				const enqueue = (value: string) => {
					if (closed) return;
					try {
						controller.enqueue(encoder.encode(value));
					} catch {
						abort();
					}
				};
				const emit = (event: Event) => {
					enqueue(`${JSON.stringify(event)}\n`);
				};

				request.signal.addEventListener("abort", abort, { once: true });
				abortStream = abort;
				if (request.signal.aborted) {
					abort();
					controller.close();
					return;
				}
				for (const event of initialEvents) emit(event);
				enqueue(FLUSH_PADDING);
				heartbeat = setInterval(
					() => enqueue(FLUSH_PADDING),
					HEARTBEAT_INTERVAL_MS,
				);

				startTimer = setTimeout(() => {
					if (closed) return;
					try {
						runEffectBackground(run({ signal: abortController.signal, emit }), {
							onSuccess: close,
							onFailure: (error) => {
								emit(errorEvent(error));
								close();
							},
						});
					} catch (error) {
						emit(errorEvent(error));
						close();
					}
				}, STREAM_START_DELAY_MS);
			},
		}),
		{
			headers: {
				"cache-control": "no-store, no-transform",
				"content-encoding": "identity",
				"content-type": "application/x-ndjson; charset=utf-8",
				"x-accel-buffering": "no",
			},
		},
	);
}
