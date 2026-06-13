import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import {
	readCachedAvatarEffect,
	readCachedAvatarOnlyEffect,
} from "#/lib/avatar-cache";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { isProfileInPublicTimeline } from "#/lib/queries";
import { isPublicReadonlyWeb } from "#/lib/web-profile";

export const Route = createFileRoute("/api/avatar")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const sensitiveError = sensitiveRequestErrorResponse(request);
						if (sensitiveError) return sensitiveError;

						const url = new URL(request.url);
						const profileId = url.searchParams.get("profileId")?.trim();

						if (!profileId) {
							return jsonResponse(
								{ ok: false, message: "Missing profileId" },
								{ status: 400 },
							);
						}

						const publicReadonly = isPublicReadonlyWeb();
						if (publicReadonly && !isProfileInPublicTimeline(profileId)) {
							return jsonResponse(
								{ ok: false, message: "Avatar not found" },
								{ status: 404 },
							);
						}
						const avatar = yield* (
							publicReadonly
								? readCachedAvatarOnlyEffect(profileId)
								: readCachedAvatarEffect(profileId)
						).pipe(Effect.catchAll(() => Effect.succeed(null)));
						if (!avatar) {
							return jsonResponse(
								{ ok: false, message: "Avatar not found" },
								{ status: 404 },
							);
						}

						return new Response(new Uint8Array(avatar.buffer), {
							headers: {
								"cache-control": "public, max-age=86400, immutable",
								"content-type": avatar.contentType,
								"x-content-type-options": "nosniff",
							},
						});
					}),
				),
		},
	},
});
