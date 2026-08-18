import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { queryResponseSchema } from "#/lib/api-contracts";
import { resourceKindSchema } from "#/lib/api-enums";
import { requestBackupAutoUpdate } from "#/lib/backup";
import {
	jsonResponse,
	parseBoundedInteger,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { queryResource } from "#/lib/query-resource";
import type { DmQuery, ReplyFilter, TimelineQualityFilter } from "#/lib/types";

function parseReplyFilter(value: string | null): ReplyFilter {
	if (value === "replied" || value === "unreplied") {
		return value;
	}
	return "all";
}

function parseOptionalNumber(value: string | null) {
	if (!value) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseDmSort(value: string | null) {
	if (value === "followers" || value === "influence") {
		return "followers";
	}
	return "recent";
}

function parseQualityFilter(value: string | null): TimelineQualityFilter {
	return value === "summary" ? "summary" : "all";
}

function parseDmInbox(value: string | null): NonNullable<DmQuery["inbox"]> {
	if (value === "accepted" || value === "requests") return value;
	return "all";
}

export const Route = createFileRoute("/api/query")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.sync(() => {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const url = new URL(request.url);
						const parsedResource = resourceKindSchema.safeParse(
							url.searchParams.get("resource") ?? "home",
						);
						if (!parsedResource.success) {
							return jsonResponse(
								{ ok: false, message: "Invalid query resource" },
								{ status: 400 },
							);
						}
						const resource = parsedResource.data;
						requestBackupAutoUpdate();
						const baseFilters = {
							account: url.searchParams.get("account") ?? undefined,
							search: url.searchParams.get("search") ?? undefined,
							replyFilter: parseReplyFilter(
								url.searchParams.get("replyFilter"),
							),
							since: url.searchParams.get("since") ?? undefined,
							until: url.searchParams.get("until") ?? undefined,
							includeReplies: url.searchParams.get("originalsOnly") !== "true",
							qualityFilter: parseQualityFilter(
								url.searchParams.get("qualityFilter"),
							),
							likedOnly: url.searchParams.get("liked") === "true",
							bookmarkedOnly: url.searchParams.get("bookmarked") === "true",
							limit: parseBoundedInteger(url.searchParams.get("limit"), {
								max: 200,
							}),
						};

						if (resource === "dms") {
							return jsonResponse(
								queryResponseSchema.parse(
									queryResource("dms", {
										...baseFilters,
										participant:
											url.searchParams.get("participant") ?? undefined,
										minFollowers: parseOptionalNumber(
											url.searchParams.get("minFollowers"),
										),
										maxFollowers: parseOptionalNumber(
											url.searchParams.get("maxFollowers"),
										),
										minInfluenceScore: parseOptionalNumber(
											url.searchParams.get("minInfluenceScore"),
										),
										maxInfluenceScore: parseOptionalNumber(
											url.searchParams.get("maxInfluenceScore"),
										),
										sort: parseDmSort(url.searchParams.get("sort")),
										inbox: parseDmInbox(url.searchParams.get("inbox")),
										conversationId:
											url.searchParams.get("conversationId") ?? undefined,
									}),
								),
							);
						}

						return jsonResponse(
							queryResponseSchema.parse(
								queryResource(resource, {
									...baseFilters,
									resource,
									untilId: url.searchParams.get("untilId") ?? undefined,
								}),
							),
						);
					}),
				),
		},
	},
});
