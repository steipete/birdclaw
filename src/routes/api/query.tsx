import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { maybeAutoUpdateBackupEffect } from "#/lib/backup";
import {
	jsonResponse,
	parseBoundedInteger,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { queryResource } from "#/lib/queries";
import type {
	DmQuery,
	ReplyFilter,
	ResourceKind,
	TimelineQualityFilter,
} from "#/lib/types";

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
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						yield* maybeAutoUpdateBackupEffect();
						const url = new URL(request.url);
						const resource = (url.searchParams.get("resource") ??
							"home") as ResourceKind;
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
								queryResource("dms", {
									...baseFilters,
									participant: url.searchParams.get("participant") ?? undefined,
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
							);
						}

						return jsonResponse(
							queryResource(resource, {
								...baseFilters,
								resource,
							}),
						);
					}),
				),
		},
	},
});
