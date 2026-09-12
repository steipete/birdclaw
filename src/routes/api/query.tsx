import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { resourceKindSchema } from "#/lib/api-enums";
import { requestBackupAutoUpdate } from "#/lib/backup";
import {
	jsonResponse,
	parseBoundedInteger,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { queryResourceResponse } from "#/lib/query-resource-response";
import {
	decodeDmMessageCursor,
	type DmMessageCursor,
} from "#/lib/dm-read-model";
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
							const view = url.searchParams.get("view");
							if (view !== null && view !== "list" && view !== "conversation")
								return jsonResponse(
									{ ok: false, message: "Invalid DM view" },
									{ status: 400 },
								);
							if (
								view === "conversation" &&
								!url.searchParams.get("conversationId")?.trim()
							)
								return jsonResponse(
									{ ok: false, message: "Missing conversationId" },
									{ status: 400 },
								);
							const rawLimit = url.searchParams.get("messageLimit");
							if (
								rawLimit !== null &&
								(!/^\d+$/.test(rawLimit) ||
									!Number.isSafeInteger(Number(rawLimit)) ||
									Number(rawLimit) < 1)
							)
								return jsonResponse(
									{ ok: false, message: "Invalid messageLimit" },
									{ status: 400 },
								);
							const messageLimit =
								rawLimit === null ? undefined : Math.min(200, Number(rawLimit));
							let before: DmMessageCursor | undefined;
							if (url.searchParams.has("before")) {
								if (view !== "conversation" || messageLimit === undefined)
									return jsonResponse(
										{
											ok: false,
											message:
												"Message cursor requires a bounded conversation view",
										},
										{ status: 400 },
									);
								try {
									before = decodeDmMessageCursor(
										url.searchParams.get("before")!,
										url.searchParams.get("conversationId")!,
									);
								} catch {
									return jsonResponse(
										{ ok: false, message: "Invalid message cursor" },
										{ status: 400 },
									);
								}
							}
							return queryResourceResponse("dms", {
								...baseFilters,
								...(view ? { view } : {}),
								...(messageLimit === undefined ? {} : { messageLimit }),
								...(before ? { before } : {}),
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
							});
						}

						return queryResourceResponse(resource, {
							...baseFilters,
							resource,
							untilId: url.searchParams.get("untilId") ?? undefined,
						});
					}),
				),
		},
	},
});
