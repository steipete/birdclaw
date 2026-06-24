import { Effect } from "effect";
import { getBirdProfileName } from "./bird-profile";
import { lookupTweetsByIdsViaBirdEffect } from "./bird";
import { getNativeDb } from "./db";
import { runEffectPromise } from "./effect-runtime";
import type { XurlTweetsResponse } from "./types";
import { lookupTweetsByIdsEffect as lookupTweetsByIdsViaXurlEffect } from "./xurl";

export type TweetLookupMode = "auto" | "xurl" | "bird";

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function failLookupViaBird(error: unknown) {
	return Effect.fail(
		new Error(`Tweet lookup failed via bird: ${errorMessage(error)}`),
	);
}

function readBirdProfileName() {
	return getBirdProfileName(getNativeDb());
}

export function lookupTweetsByIdsEffect(
	ids: string[],
	mode: TweetLookupMode = "auto",
): Effect.Effect<XurlTweetsResponse, unknown> {
	if (mode === "bird") {
		const profileName = readBirdProfileName();
		if (!profileName) {
			return Effect.fail(
				new Error("bird_profile_name is required to use bird"),
			);
		}
		return lookupTweetsByIdsViaBirdEffect(ids, profileName);
	}
	if (mode === "xurl") {
		return lookupTweetsByIdsViaXurlEffect(ids);
	}

	const profileName = readBirdProfileName();
	if (!profileName) {
		return lookupTweetsByIdsViaXurlEffect(ids);
	}

	return lookupTweetsByIdsViaBirdEffect(ids, profileName).pipe(
		Effect.catchAll(failLookupViaBird),
	);
}

export function lookupTweetsByIds(
	ids: string[],
	mode: TweetLookupMode = "auto",
): Promise<XurlTweetsResponse> {
	return runEffectPromise(lookupTweetsByIdsEffect(ids, mode));
}
