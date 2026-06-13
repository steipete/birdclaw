import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { maybeAutoUpdateBackupEffect } from "#/lib/backup";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import {
	getPublicQueryEnvelopeEffect,
	getQueryEnvelopeEffect,
} from "#/lib/queries";
import { isPublicReadonlyWeb } from "#/lib/web-profile";

export const Route = createFileRoute("/api/status")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						if (isPublicReadonlyWeb()) {
							return jsonResponse(yield* getPublicQueryEnvelopeEffect());
						}
						yield* maybeAutoUpdateBackupEffect();
						return jsonResponse(yield* getQueryEnvelopeEffect());
					}),
				),
		},
	},
});
