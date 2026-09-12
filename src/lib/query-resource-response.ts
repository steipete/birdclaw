import { queryResponseSchema } from "./api-contracts";
import { isReadOnlyDeployment } from "./config";
import { getReadDb } from "./db";
import { queryResource } from "./query-resource";
import { ReadOnlyQueryCache } from "./read-only-query-cache";

const cache = new ReadOnlyQueryCache();

/** Call only after request authorization and filter parsing. HTTP policy is unchanged. */
export function queryResourceResponse(
	...args: Parameters<typeof queryResource>
) {
	const produce = () =>
		JSON.stringify(queryResponseSchema.parse(queryResource(...args)));
	const body = isReadOnlyDeployment()
		? cache.read(getReadDb(), JSON.stringify(args), produce)
		: produce();
	return new Response(body, {
		headers: { "content-type": "application/json" },
	});
}
