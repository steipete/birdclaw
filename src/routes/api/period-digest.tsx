import { createFileRoute } from "@tanstack/react-router";
import { maybeAutoUpdateBackup } from "#/lib/backup";
import {
	streamPeriodDigest,
	type PeriodDigestOptions,
	type PeriodDigestStreamEvent,
} from "#/lib/period-digest";

const encoder = new TextEncoder();

function parseBoolean(value: string | null) {
	return value === "true" || value === "1" || value === "yes";
}

function parseNumber(value: string | null) {
	if (!value) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptions(url: URL): PeriodDigestOptions {
	return {
		period: url.searchParams.get("period") ?? undefined,
		since: url.searchParams.get("since") ?? undefined,
		until: url.searchParams.get("until") ?? undefined,
		account: url.searchParams.get("account") ?? undefined,
		includeDms: parseBoolean(url.searchParams.get("includeDms")),
		refresh: parseBoolean(url.searchParams.get("refresh")),
		model: url.searchParams.get("model") ?? undefined,
		maxTweets: parseNumber(url.searchParams.get("maxTweets")),
		maxLinks: parseNumber(url.searchParams.get("maxLinks")),
	};
}

function encodeEvent(event: PeriodDigestStreamEvent) {
	return encoder.encode(`${JSON.stringify(event)}\n`);
}

export const Route = createFileRoute("/api/period-digest")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				await maybeAutoUpdateBackup();
				const url = new URL(request.url);
				const options = parseOptions(url);
				let abortDigest: (() => void) | undefined;

				return new Response(
					new ReadableStream({
						cancel() {
							abortDigest?.();
						},
						start(controller) {
							const abortController = new AbortController();
							let closed = false;
							const close = () => {
								closed = true;
								abortController.abort();
							};
							const onAbort = () => close();
							request.signal.addEventListener("abort", onAbort, { once: true });
							abortDigest = close;
							const enqueue = (event: PeriodDigestStreamEvent) => {
								if (closed) return;
								try {
									controller.enqueue(encodeEvent(event));
								} catch {
									close();
								}
							};

							streamPeriodDigest(
								{ ...options, signal: abortController.signal },
								{ onEvent: enqueue },
							)
								.catch((error: unknown) => {
									enqueue({
										type: "error",
										error:
											error instanceof Error ? error.message : "Digest failed",
									});
								})
								.finally(() => {
									request.signal.removeEventListener("abort", onAbort);
									if (!closed) {
										closed = true;
										controller.close();
									}
								});
						},
					}),
					{
						headers: {
							"cache-control": "no-store",
							"content-type": "application/x-ndjson; charset=utf-8",
						},
					},
				);
			},
		},
	},
});
