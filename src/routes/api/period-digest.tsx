import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { maybeAutoUpdateBackupEffect } from "#/lib/backup";
import { runEffectBackground } from "#/lib/effect-runtime";
import {
	jsonResponse,
	parseBoundedInteger,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import {
	normalizeDigestLanguage,
	streamPeriodDigestEffect,
	type PeriodDigestOptions,
	type PeriodDigestStreamEvent,
} from "#/lib/period-digest";

const encoder = new TextEncoder();

function parseBoolean(value: string | null) {
	return value === "true" || value === "1" || value === "yes";
}

function parseOptions(url: URL): PeriodDigestOptions {
	return {
		period: url.searchParams.get("period") ?? undefined,
		since: url.searchParams.get("since") ?? undefined,
		until: url.searchParams.get("until") ?? undefined,
		account: url.searchParams.get("account") ?? undefined,
		includeDms: parseBoolean(url.searchParams.get("includeDms")),
		refresh: parseBoolean(url.searchParams.get("refresh")),
		model: url.searchParams.get("model") === "gpt-5.5" ? "gpt-5.5" : undefined,
		language: normalizeDigestLanguage(
			url.searchParams.get("language") ?? undefined,
		),
		maxTweets: parseBoundedInteger(url.searchParams.get("maxTweets"), {
			max: 5_000,
		}),
		maxLinks: parseBoundedInteger(url.searchParams.get("maxLinks"), {
			max: 25,
		}),
		liveSync: url.searchParams.get("liveSync") !== "false",
		liveSyncMode: "xurl",
		liveTimelineLimit: parseBoundedInteger(
			url.searchParams.get("liveTimelineLimit"),
			{ max: 100_000 },
		),
		liveTimelineMaxPages: parseBoundedInteger(
			url.searchParams.get("liveTimelineMaxPages"),
			{ max: 1_000 },
		),
	};
}

function encodeEvent(event: PeriodDigestStreamEvent) {
	return encoder.encode(`${JSON.stringify(event)}\n`);
}

export const Route = createFileRoute("/api/period-digest")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const url = new URL(request.url);
						let options: PeriodDigestOptions;
						try {
							options = parseOptions(url);
						} catch (error) {
							return jsonResponse(
								{
									ok: false,
									error: error instanceof Error ? error.message : String(error),
								},
								{ status: 400 },
							);
						}
						yield* maybeAutoUpdateBackupEffect();
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
									const closeController = () => {
										request.signal.removeEventListener("abort", onAbort);
										if (!closed) {
											closed = true;
											controller.close();
										}
									};
									const onAbort = () => close();
									request.signal.addEventListener("abort", onAbort, {
										once: true,
									});
									abortDigest = close;
									const enqueue = (event: PeriodDigestStreamEvent) => {
										if (closed) return;
										try {
											controller.enqueue(encodeEvent(event));
										} catch {
											close();
										}
									};

									runEffectBackground(
										streamPeriodDigestEffect(
											{ ...options, signal: abortController.signal },
											{ onEvent: enqueue },
										),
										{
											onSuccess: closeController,
											onFailure: (error) => {
												enqueue({
													type: "error",
													error:
														error instanceof Error
															? error.message
															: "Digest failed",
												});
												closeController();
											},
										},
									);
								},
							}),
							{
								headers: {
									"cache-control": "no-store",
									"content-type": "application/x-ndjson; charset=utf-8",
								},
							},
						);
					}),
				),
		},
	},
});
