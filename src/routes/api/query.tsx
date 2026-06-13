import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { maybeAutoUpdateBackupEffect } from "#/lib/backup";
import {
	jsonResponse,
	parseBoundedInteger,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import {
	sanitizePublicEmbeddedTweet,
	sanitizePublicTweetEntities,
} from "#/lib/public-tweet";
import { isTweetInPublicTimeline, queryResource } from "#/lib/queries";
import type {
	DmQuery,
	EmbeddedTweet,
	ReplyFilter,
	ResourceKind,
	TimelineItem,
	TimelineQualityFilter,
} from "#/lib/types";
import { isPublicReadonlyWeb } from "#/lib/web-profile";

const PUBLIC_RESOURCES = new Set<ResourceKind>(["home", "mentions"]);

function sanitizeVisibleEmbeddedTweet(
	tweet: EmbeddedTweet | null | undefined,
): EmbeddedTweet | null | undefined {
	if (!tweet || !isTweetInPublicTimeline(tweet.id)) return null;
	return sanitizePublicEmbeddedTweet(tweet);
}

function sanitizeTimelineItem(item: TimelineItem): TimelineItem {
	return {
		...item,
		accountId: "",
		accountHandle: "",
		isReplied: false,
		bookmarked: false,
		liked: false,
		qualityReason: undefined,
		entities: sanitizePublicTweetEntities(item.entities),
		replyToTweet: sanitizeVisibleEmbeddedTweet(item.replyToTweet),
		quotedTweet: sanitizeVisibleEmbeddedTweet(item.quotedTweet),
		retweetedTweet: sanitizeVisibleEmbeddedTweet(item.retweetedTweet),
	};
}

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

						const url = new URL(request.url);
						const resource = (url.searchParams.get("resource") ??
							"home") as ResourceKind;
						const publicReadonly = isPublicReadonlyWeb();
						if (publicReadonly && !PUBLIC_RESOURCES.has(resource)) {
							return jsonResponse(
								{ ok: false, message: "Resource is not available" },
								{ status: 403 },
							);
						}
						if (!publicReadonly) {
							yield* maybeAutoUpdateBackupEffect();
						}
						const baseFilters = {
							account: publicReadonly
								? undefined
								: (url.searchParams.get("account") ?? undefined),
							search: url.searchParams.get("search") ?? undefined,
							replyFilter: publicReadonly
								? ("all" as const)
								: parseReplyFilter(url.searchParams.get("replyFilter")),
							since: url.searchParams.get("since") ?? undefined,
							until: url.searchParams.get("until") ?? undefined,
							includeReplies: url.searchParams.get("originalsOnly") !== "true",
							qualityFilter: parseQualityFilter(
								url.searchParams.get("qualityFilter"),
							),
							likedOnly:
								!publicReadonly && url.searchParams.get("liked") === "true",
							bookmarkedOnly:
								!publicReadonly &&
								url.searchParams.get("bookmarked") === "true",
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

						const response = queryResource(resource, {
							...baseFilters,
							resource,
							untilId: url.searchParams.get("untilId") ?? undefined,
						});
						return jsonResponse(
							publicReadonly
								? {
										...response,
										items: (response.items as TimelineItem[]).map(
											sanitizeTimelineItem,
										),
									}
								: response,
						);
					}),
				),
		},
	},
});
