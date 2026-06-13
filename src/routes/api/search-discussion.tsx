import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { maybeAutoUpdateBackupEffect } from "#/lib/backup";
import {
	parseBoundedInteger,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { createEffectNdjsonResponse } from "#/lib/ndjson-stream";
import {
	streamSearchDiscussionEffect,
	type SearchDiscussionOptions,
	type SearchDiscussionSource,
	type SearchDiscussionStreamEvent,
} from "#/lib/search-discussion";
import type { TweetSearchMode } from "#/lib/tweet-search-live";

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
						return createEffectNdjsonResponse<SearchDiscussionStreamEvent>({
							request,
							run: ({ signal, emit }) =>
								maybeAutoUpdateBackupEffect().pipe(
									Effect.flatMap(() =>
										signal.aborted
											? Effect.succeed(undefined)
											: streamSearchDiscussionEffect(
													{
														...options,
														signal,
														prefetchAvatars: true,
													},
													{ onEvent: emit },
												),
									),
								),
							errorEvent: (error) => ({
								type: "error",
								error:
									error instanceof Error ? error.message : "Discussion failed",
							}),
						});
					}),
				),
		},
	},
});
