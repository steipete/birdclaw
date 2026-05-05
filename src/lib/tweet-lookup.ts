import { lookupTweetsByIdsViaBird } from "./bird";
import type { XurlTweetsResponse } from "./types";
import { lookupTweetsByIds as lookupTweetsByIdsViaXurl } from "./xurl";

export type TweetLookupMode = "auto" | "xurl" | "bird";

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export async function lookupTweetsByIds(
	ids: string[],
	mode: TweetLookupMode = "auto",
): Promise<XurlTweetsResponse> {
	if (mode === "bird") {
		return lookupTweetsByIdsViaBird(ids);
	}
	if (mode === "xurl") {
		return lookupTweetsByIdsViaXurl(ids);
	}

	try {
		return await lookupTweetsByIdsViaXurl(ids);
	} catch (xurlError) {
		try {
			return await lookupTweetsByIdsViaBird(ids);
		} catch (birdError) {
			throw new Error(
				`Tweet lookup failed via xurl and bird: xurl: ${errorMessage(
					xurlError,
				)}; bird: ${errorMessage(birdError)}`,
			);
		}
	}
}
