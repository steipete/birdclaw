import { createFileRoute } from "@tanstack/react-router";
import { queryResource } from "#/lib/queries";
import type {
	ReplyFilter,
	ResourceKind,
	TimelineQualityFilter,
} from "#/lib/types";

function json(data: unknown) {
	return new Response(JSON.stringify(data), {
		headers: {
			"content-type": "application/json",
		},
	});
}

function parseReplyFilter(value: string | null): ReplyFilter {
	if (value === "replied" || value === "unreplied") {
		return value;
	}
	return "all";
}

function parseNumber(value: string | null) {
	if (!value) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseQualityFilter(value: string | null): TimelineQualityFilter {
	return value === "summary" ? "summary" : "all";
}

export const Route = createFileRoute("/api/query")({
	server: {
		handlers: {
			GET: ({ request }) => {
				const url = new URL(request.url);
				const resource = (url.searchParams.get("resource") ??
					"home") as ResourceKind;
				const baseFilters = {
					account: url.searchParams.get("account") ?? undefined,
					search: url.searchParams.get("search") ?? undefined,
					replyFilter: parseReplyFilter(url.searchParams.get("replyFilter")),
					since: url.searchParams.get("since") ?? undefined,
					until: url.searchParams.get("until") ?? undefined,
					includeReplies: url.searchParams.get("originalsOnly") !== "true",
					qualityFilter: parseQualityFilter(
						url.searchParams.get("qualityFilter"),
					),
					likedOnly: url.searchParams.get("liked") === "true",
					bookmarkedOnly: url.searchParams.get("bookmarked") === "true",
					limit: parseNumber(url.searchParams.get("limit")) ?? undefined,
				};

				if (resource === "dms") {
					return json(
						queryResource("dms", {
							...baseFilters,
							participant: url.searchParams.get("participant") ?? undefined,
							minFollowers: parseNumber(url.searchParams.get("minFollowers")),
							maxFollowers: parseNumber(url.searchParams.get("maxFollowers")),
							minInfluenceScore: parseNumber(
								url.searchParams.get("minInfluenceScore"),
							),
							maxInfluenceScore: parseNumber(
								url.searchParams.get("maxInfluenceScore"),
							),
							sort:
								url.searchParams.get("sort") === "influence"
									? "influence"
									: "recent",
							conversationId:
								url.searchParams.get("conversationId") ?? undefined,
						}),
					);
				}

				return json(
					queryResource(resource, {
						...baseFilters,
						resource,
					}),
				);
			},
		},
	},
});
