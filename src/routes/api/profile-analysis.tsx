import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { maybeAutoUpdateBackupEffect } from "#/lib/backup";
import { runEffectBackground } from "#/lib/effect-runtime";
import {
	parseBoundedInteger,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import {
	streamProfileAnalysisEffect,
	type ProfileAnalysisOptions,
	type ProfileAnalysisStreamEvent,
} from "#/lib/profile-analysis";

const encoder = new TextEncoder();

function parseBoolean(value: string | null) {
	return value === "true" || value === "1" || value === "yes";
}

function parseOptions(url: URL): ProfileAnalysisOptions {
	const conversationDelayMs = parseBoundedInteger(
		url.searchParams.get("conversationDelayMs"),
		{ min: 0, max: 60_000 },
	);
	const rateLimitRetryMs = parseBoundedInteger(
		url.searchParams.get("rateLimitRetryMs"),
		{ min: 0, max: 900_000 },
	);
	const rateLimitMaxRetries = parseBoundedInteger(
		url.searchParams.get("rateLimitRetries"),
		{ min: 0, max: 10 },
	);
	return {
		handle: url.searchParams.get("handle") ?? "",
		account: url.searchParams.get("account") ?? undefined,
		refresh: parseBoolean(url.searchParams.get("refresh")),
		model: url.searchParams.get("model") === "gpt-5.5" ? "gpt-5.5" : undefined,
		maxTweets: parseBoundedInteger(url.searchParams.get("maxTweets"), {
			max: 20_000,
		}),
		maxPages: parseBoundedInteger(url.searchParams.get("maxPages"), {
			max: 500,
		}),
		maxConversations: parseBoundedInteger(
			url.searchParams.get("maxConversations"),
			{ max: 500 },
		),
		maxConversationPages: parseBoundedInteger(
			url.searchParams.get("maxConversationPages"),
			{ max: 50 },
		),
		...(conversationDelayMs !== undefined ? { conversationDelayMs } : {}),
		...(rateLimitRetryMs !== undefined ? { rateLimitRetryMs } : {}),
		...(rateLimitMaxRetries !== undefined ? { rateLimitMaxRetries } : {}),
	};
}

function encodeEvent(event: ProfileAnalysisStreamEvent) {
	return encoder.encode(`${JSON.stringify(event)}\n`);
}

export const Route = createFileRoute("/api/profile-analysis")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						yield* maybeAutoUpdateBackupEffect();
						const url = new URL(request.url);
						const options = parseOptions(url);
						let abortAnalysis: (() => void) | undefined;

						return new Response(
							new ReadableStream({
								cancel() {
									abortAnalysis?.();
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
									abortAnalysis = close;
									const enqueue = (event: ProfileAnalysisStreamEvent) => {
										if (closed) return;
										try {
											controller.enqueue(encodeEvent(event));
										} catch {
											close();
										}
									};

									runEffectBackground(
										streamProfileAnalysisEffect(
											{
												...options,
												signal: abortController.signal,
											},
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
															: "Profile analysis failed",
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
