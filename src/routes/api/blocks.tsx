import { cachedJsonResponse } from "#/lib/cached-json-response";
import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { blockListResponseSchema } from "#/lib/api-contracts";
import { getBlocksResponse } from "#/lib/blocks";
import {
	parseBoundedInteger,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";

export const Route = createFileRoute("/api/blocks")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.sync(() => {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const url = new URL(request.url);
						const query = {
							accountId: url.searchParams.get("account") ?? undefined,
							search: url.searchParams.get("search") ?? undefined,
							limit: parseBoundedInteger(url.searchParams.get("limit"), {
								defaultValue: 12,
								max: 50,
							}),
						};
						return cachedJsonResponse(["blocks", query], () =>
							blockListResponseSchema.parse(getBlocksResponse(query)),
						);
					}),
				),
		},
	},
});
