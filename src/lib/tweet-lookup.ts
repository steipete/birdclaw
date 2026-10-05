import { getAutoTransportOrder } from "./config";
import { Effect } from "effect";
import { lookupTweetsByIdsViaBirdEffect } from "./bird";
import { runEffectPromise } from "./effect-runtime";
import type { XurlTweetsResponse } from "./types";
import { lookupTweetsByIdsEffect as lookupTweetsByIdsViaXurlEffect } from "./xurl";

export type TweetLookupMode = "auto" | "xurl" | "bird";

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export function lookupTweetsByIdsEffect(
	ids: string[],
	mode: TweetLookupMode = "auto",
): Effect.Effect<XurlTweetsResponse, unknown> {
	if (mode === "bird") {
		return lookupTweetsByIdsViaBirdEffect(ids);
	}
	if (mode === "xurl") {
		return lookupTweetsByIdsViaXurlEffect(ids);
	}

	return Effect.suspend(() => {
		const [first, second] = getAutoTransportOrder();
		const fetch = (source: string) =>
			source === "bird"
				? lookupTweetsByIdsViaBirdEffect(ids)
				: lookupTweetsByIdsViaXurlEffect(ids);
		return fetch(first).pipe(
			Effect.catchAll((firstError) =>
				fetch(second).pipe(
					Effect.mapError(
						(secondError) =>
							new Error(
								`Tweet lookup failed via xurl and bird: ${first}: ${errorMessage(firstError)}; ${second}: ${errorMessage(secondError)}`,
							),
					),
				),
			),
		);
	});
}

export function lookupTweetsByIds(
	ids: string[],
	mode: TweetLookupMode = "auto",
): Promise<XurlTweetsResponse> {
	return runEffectPromise(lookupTweetsByIdsEffect(ids, mode));
}
