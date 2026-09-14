import { queryResponseSchema } from "./api-contracts";
import { cachedJsonResponse } from "./cached-json-response";
import { queryResource } from "./query-resource";

/** Call only after request authorization and filter parsing. HTTP policy is unchanged. */
export function queryResourceResponse(
	...args: Parameters<typeof queryResource>
) {
	return cachedJsonResponse(["query", ...args], () =>
		queryResponseSchema.parse(queryResource(...args)),
	);
}
