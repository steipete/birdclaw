import { cachedJsonResponse } from "#/lib/cached-json-response";
import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { linkInsightResponseSchema } from "#/lib/api-contracts";
import { requestBackupAutoUpdate } from "#/lib/backup";
import {
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { getLinkInsights } from "#/lib/link-insights";
import type {
	LinkInsightQuery,
	LinkInsightKind,
	LinkInsightRange,
	LinkInsightSort,
	LinkInsightSource,
} from "#/lib/types";

function parseKind(value: string | null): LinkInsightKind {
	return value === "videos" ? "videos" : "links";
}

function parseRange(value: string | null): LinkInsightRange {
	if (
		value === "today" ||
		value === "week" ||
		value === "month" ||
		value === "year" ||
		value === "all"
	) {
		return value;
	}
	return "week";
}

function parseSource(value: string | null): LinkInsightSource {
	if (value === "tweet" || value === "dm") {
		return value;
	}
	return "all";
}

function parseSort(value: string | null): LinkInsightSort {
	if (value === "recent" || value === "comments") {
		return value;
	}
	return "rank";
}

function parseNumber(value: string | null) {
	if (!value) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export const Route = createFileRoute("/api/link-insights")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.sync(() => {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						requestBackupAutoUpdate();
						const url = new URL(request.url);
						const query = {
							kind: parseKind(url.searchParams.get("kind")),
							range: parseRange(url.searchParams.get("range")),
							sort: parseSort(url.searchParams.get("sort")),
							source: parseSource(url.searchParams.get("source")),
							since: url.searchParams.get("since") ?? undefined,
							until: url.searchParams.get("until") ?? undefined,
							limit: parseNumber(url.searchParams.get("limit")),
							commentsLimit: parseNumber(url.searchParams.get("commentsLimit")),
						} satisfies LinkInsightQuery;
						return cachedJsonResponse(
							["link-insights", query],
							() => linkInsightResponseSchema.parse(getLinkInsights(query)),
							query.range === "all" || Boolean(query.since || query.until),
						);
					}),
				),
		},
	},
});
