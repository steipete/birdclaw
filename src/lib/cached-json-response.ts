import { isReadOnlyDeployment } from "./config";
import { getReadDb } from "./db";
import { ReadOnlyQueryCache } from "./read-only-query-cache";

const cache = new ReadOnlyQueryCache();

/** Call after authorization; only snapshot-deterministic responses may be cached. */
export function cachedJsonResponse(
	key: unknown[],
	produce: () => unknown,
	cacheable = true,
) {
	const serialize = () => JSON.stringify(produce());
	const body =
		cacheable && isReadOnlyDeployment()
			? cache.read(getReadDb(), JSON.stringify(key), serialize)
			: serialize();
	return new Response(body, {
		headers: { "content-type": "application/json" },
	});
}
