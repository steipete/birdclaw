import { Effect } from "effect";
import { runEffectBackground } from "./effect-runtime";

const encoder = new TextEncoder();
const HEARTBEAT_INTERVAL_MS = 15_000;

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

				const cleanup = () => {
					request.signal.removeEventListener("abort", abort);
					if (heartbeat !== undefined) clearInterval(heartbeat);
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
				heartbeat = setInterval(() => enqueue("\n"), HEARTBEAT_INTERVAL_MS);

				runEffectBackground(run({ signal: abortController.signal, emit }), {
					onSuccess: close,
					onFailure: (error) => {
						emit(errorEvent(error));
						close();
					},
				});
			},
		}),
		{
			headers: {
				"cache-control": "no-store",
				"content-type": "application/x-ndjson; charset=utf-8",
				"x-accel-buffering": "no",
			},
		},
	);
}
