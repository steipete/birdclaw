import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { z } from "zod";
import {
	networkMapResponseSchema,
	networkMapViewResponseSchema,
} from "#/lib/api-contracts";
import { getNetworkMapViewEffect } from "#/lib/network-map-view";
import { WORLD_VIEWPORT } from "#/lib/network-map-geometry";
import { requestBackupAutoUpdate } from "#/lib/backup";
import {
	jsonResponse,
	parseBoundedInteger,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { getNetworkMap, type NetworkMapKind } from "#/lib/network-map";

function parseType(value: string | null): NetworkMapKind {
	if (
		value === "followers" ||
		value === "following" ||
		value === "mutual" ||
		value === "all"
	) {
		return value;
	}
	return "all";
}

const viewportSchema = z.object({
	bounds: z
		.tuple([
			z.number(),
			z.number().min(-90).max(90),
			z.number(),
			z.number().min(-90).max(90),
		])
		.refine((bounds) => bounds[1] <= bounds[3]),
	zoom: z.number().min(0).max(22),
});

export const Route = createFileRoute("/api/network-map")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						requestBackupAutoUpdate();
						const url = new URL(request.url);
						if (url.searchParams.get("format") === "view") {
							const bounds = url.searchParams.get("bounds");
							const viewport = viewportSchema.safeParse({
								bounds:
									bounds === null
										? WORLD_VIEWPORT.bounds
										: bounds
												.split(",")
												.map((value) => (value.trim() ? Number(value) : NaN)),
								zoom: url.searchParams.has("zoom")
									? Number(url.searchParams.get("zoom"))
									: WORLD_VIEWPORT.zoom,
							});
							if (!viewport.success)
								return jsonResponse(
									{ message: "Invalid map viewport" },
									{ status: 400 },
								);
							const response = yield* getNetworkMapViewEffect({
								account: url.searchParams.get("account") ?? undefined,
								type: parseType(url.searchParams.get("type")),
								viewport: viewport.data,
								search: url.searchParams.get("q") ?? "",
								offset: parseBoundedInteger(url.searchParams.get("offset"), {
									min: 0,
									max: Number.MAX_SAFE_INTEGER,
									defaultValue: 0,
								}),
								refresh: url.searchParams.get("refresh") === "true",
								geocodeLimit: parseBoundedInteger(
									url.searchParams.get("geocodeLimit"),
									{ min: 0, max: 500, defaultValue: 80 },
								),
								signal: request.signal,
							});
							return jsonResponse(networkMapViewResponseSchema.parse(response));
						}
						const response = yield* Effect.promise(() =>
							getNetworkMap({
								account: url.searchParams.get("account") ?? undefined,
								type: parseType(url.searchParams.get("type")),
								limit: parseBoundedInteger(url.searchParams.get("limit"), {
									max: 50_000,
								}),
								geocodeLimit: parseBoundedInteger(
									url.searchParams.get("geocodeLimit"),
									{ max: 500, min: 0 },
								),
								refresh: url.searchParams.get("refresh") === "true",
								signal: request.signal,
							}),
						);
						return jsonResponse(networkMapResponseSchema.parse(response));
					}),
				),
		},
	},
});
