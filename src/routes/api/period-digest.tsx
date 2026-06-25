import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { periodDigestStreamEventSchema } from "#/lib/client-stream-contracts";
import { maybeAutoUpdateBackupEffect } from "#/lib/backup";
import {
	jsonResponse,
	parseBoundedInteger,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { createEffectNdjsonResponse } from "#/lib/ndjson-stream";
import {
	normalizeDigestLanguage,
	streamPeriodDigestEffect,
	type PeriodDigestOptions,
	type PeriodDigestStreamEvent,
} from "#/lib/period-digest";

function parseBoolean(value: string | null) {
	return value === "true" || value === "1" || value === "yes";
}

function parseLiveMode(
	value: string | null,
): PeriodDigestOptions["liveSyncMode"] {
	const normalized = (value ?? "xurl").trim().toLowerCase();
	if (normalized === "auto" || normalized === "bird" || normalized === "xurl") {
		return normalized;
	}
	throw new Error("liveMode must be auto, bird, or xurl");
}

function parseOptions(url: URL): PeriodDigestOptions {
	return {
		period: url.searchParams.get("period") ?? undefined,
		since: url.searchParams.get("since") ?? undefined,
		until: url.searchParams.get("until") ?? undefined,
		account: url.searchParams.get("account") ?? undefined,
		includeDms: parseBoolean(url.searchParams.get("includeDms")),
		refresh: parseBoolean(url.searchParams.get("refresh")),
		model: url.searchParams.get("model")?.trim() || undefined,
		language: normalizeDigestLanguage(
			url.searchParams.get("language") ?? undefined,
		),
		maxTweets: parseBoundedInteger(url.searchParams.get("maxTweets"), {
			max: 5_000,
		}),
		maxLinks: parseBoundedInteger(url.searchParams.get("maxLinks"), {
			max: 25,
		}),
		liveSync: parseBoolean(url.searchParams.get("liveSync")),
		liveSyncMode: parseLiveMode(url.searchParams.get("liveMode")),
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

export const Route = createFileRoute("/api/period-digest")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.sync(() => {
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
						return createEffectNdjsonResponse<PeriodDigestStreamEvent>({
							request,
							schema: periodDigestStreamEventSchema,
							initialEvents: [
								{
									type: "status",
									label: "Preparing local archive",
									detail: "Checking for backup updates.",
								},
							],
							run: ({ signal, emit }) =>
								Effect.gen(function* () {
									yield* maybeAutoUpdateBackupEffect();
									return yield* streamPeriodDigestEffect(
										{ ...options, signal },
										{ onEvent: emit },
									);
								}),
							errorEvent: (error) => ({
								type: "error",
								error: error instanceof Error ? error.message : "Digest failed",
							}),
						});
					}),
				),
		},
	},
});
