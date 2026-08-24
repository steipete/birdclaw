import { Effect } from "effect";
import { getAuthenticatedBirdAccountEffect } from "./bird";
import { toError } from "./effect-runtime";
import {
	assertLiveAccountMatches,
	type LiveAccountIdentity,
} from "./live-sync-engine";

export function verifyBirdAccountMatchesEffect(account: LiveAccountIdentity) {
	return getAuthenticatedBirdAccountEffect().pipe(
		Effect.flatMap((authenticated) =>
			Effect.try({
				try: () => {
					assertLiveAccountMatches({
						source: "bird",
						account,
						liveUsername: authenticated.username,
						liveExternalUserId: authenticated.id,
					});
					return authenticated;
				},
				catch: toError,
			}),
		),
	);
}
