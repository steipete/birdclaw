import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { linkPreviewResponseSchema } from "#/lib/api-contracts";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { getOrFetchLinkPreviewEffect } from "#/lib/link-preview-metadata";
import { readPreviewImageEffect } from "#/lib/preview-image-cache";

function parseUrl(value: string | null) {
	if (!value) return null;
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return null;
		}
		return parsed.toString();
	} catch {
		return null;
	}
}

export const Route = createFileRoute("/api/link-preview")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const url = new URL(request.url);
						if (url.searchParams.has("imageUrl")) {
							const imageUrl = parseUrl(url.searchParams.get("imageUrl"));
							if (!imageUrl)
								return jsonResponse(
									{ ok: false, message: "Invalid image URL" },
									{ status: 400 },
								);
							const image = yield* readPreviewImageEffect(imageUrl).pipe(
								Effect.catchAll(() => Effect.succeed(null)),
							);
							if (!image)
								return jsonResponse(
									{ ok: false, message: "Preview image not found" },
									{ status: 404, headers: { "cache-control": "no-store" } },
								);
							return new Response(new Uint8Array(image.buffer), {
								headers: {
									"content-type": image.contentType,
									"cache-control": "private, max-age=86400",
									"x-content-type-options": "nosniff",
								},
							});
						}
						const previewUrl = parseUrl(url.searchParams.get("url"));
						if (!previewUrl) {
							return jsonResponse(
								{ ok: false, message: "Missing url" },
								{ status: 400 },
							);
						}

						const preview = yield* getOrFetchLinkPreviewEffect(previewUrl);
						return jsonResponse(
							linkPreviewResponseSchema.parse({ ok: true, preview }),
						);
					}),
				),
		},
	},
});
