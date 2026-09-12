import { Effect } from "effect";
import { queryEnvelopeSchema } from "./api-contracts";
import { isReadOnlyDeployment } from "./config";
import { getReadDb } from "./db";
import { runEffectPromise, trySync } from "./effect-runtime";
import { sensitiveRequestErrorResponse } from "./http-effect";
import { getQueryEnvelopeEffect } from "./query-status";

/** Optional HTML bootstrap must have the same authority as the status API. */
export function readStatusBootstrap(request: Request) {
	if (!isReadOnlyDeployment()) return Promise.resolve(null);
	const statusUrl = new URL(request.url);
	statusUrl.pathname = "/api/status";
	statusUrl.search = "";
	const statusRequest = new Request(statusUrl, {
		method: request.method,
		headers: request.headers,
	});
	if (sensitiveRequestErrorResponse(statusRequest))
		return Promise.resolve(null);
	return runEffectPromise(
		trySync(
			() => getReadDb().prepare("select id from accounts limit 2").all().length,
		).pipe(
			Effect.flatMap((count) =>
				count === 1
					? getQueryEnvelopeEffect({ includeArchives: false })
					: Effect.succeed(null),
			),
			Effect.flatMap((envelope) =>
				trySync(() => (envelope ? queryEnvelopeSchema.parse(envelope) : null)),
			),
			// Multi-account selection lives in browser storage and cannot be inferred here.
			Effect.map((envelope) =>
				envelope?.readOnly && envelope.accounts.length === 1 ? envelope : null,
			),
			Effect.catchAll(() => Effect.succeed(null)),
		),
	);
}
