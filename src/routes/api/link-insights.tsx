import { createFileRoute } from "@tanstack/react-router";
import { maybeAutoUpdateBackup } from "#/lib/backup";
import { getLinkInsights } from "#/lib/link-insights";
import type {
	LinkInsightKind,
	LinkInsightRange,
	LinkInsightSort,
	LinkInsightSource,
} from "#/lib/types";

function json(data: unknown) {
	return new Response(JSON.stringify(data), {
		headers: {
			"content-type": "application/json",
		},
	});
}

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
			GET: async ({ request }) => {
				await maybeAutoUpdateBackup();
				const url = new URL(request.url);
				return json(
					getLinkInsights({
						kind: parseKind(url.searchParams.get("kind")),
						range: parseRange(url.searchParams.get("range")),
						sort: parseSort(url.searchParams.get("sort")),
						source: parseSource(url.searchParams.get("source")),
						since: url.searchParams.get("since") ?? undefined,
						until: url.searchParams.get("until") ?? undefined,
						limit: parseNumber(url.searchParams.get("limit")),
						commentsLimit: parseNumber(url.searchParams.get("commentsLimit")),
					}),
				);
			},
		},
	},
});
