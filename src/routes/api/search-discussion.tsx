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
	streamSearchDiscussionEffect,
	type SearchDiscussionOptions,
	type SearchDiscussionSource,
	type SearchDiscussionStreamEvent,
} from "#/lib/search-discussion";
import type { TweetSearchMode } from "#/lib/tweet-search-live";

const encoder = new TextEncoder();
const MAX_DISCUSSION_SEARCH_LIMIT = 20_000;
const MAX_DISCUSSION_SEARCH_PAGES = 200;

function parseBoolean(value: string | null) {
	return value === "true" || value === "1" || value === "yes";
}

function parseSource(value: string | null): SearchDiscussionSource {
	if (
		value === "all" ||
		value === "home" ||
		value === "mentions" ||
		value === "authored" ||
		value === "search" ||
		value === "likes" ||
		value === "bookmarks"
	) {
		return value;
	}
	return "search";
}

function parseMode(value: string | null): TweetSearchMode {
	if (
		value === "auto" ||
		value === "bird" ||
		value === "xurl" ||
		value === "local"
	) {
		return value;
	}
	return "auto";
}

function parseOptions(url: URL): SearchDiscussionOptions {
	return {
		query: url.searchParams.get("query") ?? "",
		account: url.searchParams.get("account") ?? undefined,
		source: parseSource(url.searchParams.get("source")),
		mode: parseMode(url.searchParams.get("mode")),
		includeDms: parseBoolean(url.searchParams.get("includeDms")),
		since: url.searchParams.get("since") ?? undefined,
		until: url.searchParams.get("until") ?? undefined,
		question: url.searchParams.get("question") ?? undefined,
		originalsOnly: parseBoolean(url.searchParams.get("originalsOnly")),
		hideLowQuality: parseBoolean(url.searchParams.get("hideLowQuality")),
		refresh: parseBoolean(url.searchParams.get("refresh")),
		model: url.searchParams.get("model") === "gpt-5.5" ? "gpt-5.5" : undefined,
		limit: parseBoundedInteger(url.searchParams.get("limit"), {
			max: MAX_DISCUSSION_SEARCH_LIMIT,
		}),
		maxPages: parseBoundedInteger(url.searchParams.get("maxPages"), {
			max: MAX_DISCUSSION_SEARCH_PAGES,
		}),
	};
}

function encodeEvent(event: SearchDiscussionStreamEvent) {
	return encoder.encode(`${JSON.stringify(event)}\n`);
}

export const Route = createFileRoute("/api/search-discussion")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.sync(() => {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const url = new URL(request.url);
						const options = parseOptions(url);
						let abortDiscussion: (() => void) | undefined;

						return new Response(
							new ReadableStream({
								cancel() {
									abortDiscussion?.();
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
									abortDiscussion = close;
									const enqueue = (event: SearchDiscussionStreamEvent) => {
										if (closed) return;
										try {
											controller.enqueue(encodeEvent(event));
										} catch {
											close();
										}
									};

									runEffectBackground(
										maybeAutoUpdateBackupEffect().pipe(
											Effect.flatMap(() => {
												if (closed || abortController.signal.aborted) {
													return Effect.succeed(undefined);
												}
												return streamSearchDiscussionEffect(
													{
														...options,
														signal: abortController.signal,
														prefetchAvatars: true,
													},
													{ onEvent: enqueue },
												);
											}),
										),
										{
											onSuccess: closeController,
											onFailure: (error) => {
												enqueue({
													type: "error",
													error:
														error instanceof Error
															? error.message
															: "Discussion failed",
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
