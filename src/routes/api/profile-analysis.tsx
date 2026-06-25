import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { profileAnalysisStreamEventSchema } from "#/lib/client-stream-contracts";
import { maybeAutoUpdateBackupEffect } from "#/lib/backup";
import {
	parseBoundedInteger,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { createEffectNdjsonResponse } from "#/lib/ndjson-stream";
import {
	streamProfileAnalysisEffect,
	type ProfileAnalysisOptions,
	type ProfileAnalysisStreamEvent,
} from "#/lib/profile-analysis";

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
		model: url.searchParams.get("model")?.trim() || undefined,
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

export const Route = createFileRoute("/api/profile-analysis")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.sync(() => {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const url = new URL(request.url);
						const options = parseOptions(url);
						return createEffectNdjsonResponse<ProfileAnalysisStreamEvent>({
							request,
							schema: profileAnalysisStreamEventSchema,
							initialEvents: [
								{
									type: "status",
									label: "Starting profile analysis",
								},
							],
							run: ({ signal, emit }) =>
								Effect.gen(function* () {
									yield* maybeAutoUpdateBackupEffect();
									return yield* streamProfileAnalysisEffect(
										{ ...options, signal },
										{ onEvent: emit },
									);
								}),
							errorEvent: (error) => ({
								type: "error",
								error:
									error instanceof Error
										? error.message
										: "Profile analysis failed",
							}),
						});
					}),
				),
		},
	},
});
