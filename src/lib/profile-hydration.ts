import { Effect } from "effect";

import { normalizeAvatarUrl } from "./avatar-cache";
import { getAuthenticatedBirdAccountEffect } from "./bird";
import { getNativeDb } from "./db";
import { runEffectPromise } from "./effect-runtime";
import {
	getProvenSelectedAccountLegacyProfileIds,
	getProfileRawIdentityEvidence,
	markProfileIdentityConflict,
	profileIdentityHasConflict,
} from "./profile-identity";
import {
	assertLiveAccountMatches,
	resolveLiveSyncAccount,
} from "./live-sync-engine";
import {
	getTransportStatusEffect,
	lookupAuthenticatedOAuth2UserEffect,
	lookupAuthenticatedUserUnscopedEffect,
	lookupUsersByIdsEffect,
} from "./xurl";
import type { XurlMentionUser } from "./types";
import {
	canonicalizeProvenXProfileIdentity,
	upsertSparseProfileFromXUser,
	upsertProfileFromXUser,
} from "./x-profile";

export type HydrateProfilesResult = {
	ok: true;
	hydratedProfiles: number;
	hydratedAccount: boolean;
	reason?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function toInt(value: unknown) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function trySync<T>(try_: () => T) {
	return Effect.try({
		try: try_,
		catch: toError,
	});
}

const SEEDED_ACCOUNT_HANDLE = "steipete";
const SEEDED_ACCOUNT_EXTERNAL_USER_ID = "25401953";

function hydrateAccountFromBirdEffect(
	selector?: string,
): Effect.Effect<boolean, unknown> {
	return Effect.gen(function* () {
		const account = yield* getAuthenticatedBirdAccountEffect().pipe(
			Effect.catchAll(() => Effect.succeed(null)),
		);
		if (!account?.username) return false;

		const handle = account.username.replace(/^@/, "");
		const name = account.name?.trim() || null;
		const externalUserId = account.id ?? null;
		if (selector) {
			return yield* trySync(() => {
				const db = getNativeDb();
				const selected = resolveLiveSyncAccount(db, selector);
				assertLiveAccountMatches({
					source: "bird",
					account: selected,
					liveUsername: handle,
					liveExternalUserId: externalUserId ?? undefined,
				});
				return db.transaction(() => {
					const provenLegacyProfileIds =
						externalUserId && /^[0-9]+$/.test(externalUserId)
							? getProvenSelectedAccountLegacyProfileIds(
									db,
									selected,
									externalUserId,
								)
							: undefined;
					const profileId =
						externalUserId && /^[0-9]+$/.test(externalUserId)
							? (canonicalizeProvenXProfileIdentity(
									db,
									externalUserId,
									handle,
									{
										provenLegacyProfileIds,
									},
								),
								upsertSparseProfileFromXUser(
									db,
									{
										id: externalUserId,
										username: handle,
										name: name ?? undefined,
									},
									{ provenLegacyProfileIds },
								).profile.id)
							: undefined;
					db.prepare(
						`update accounts
						 set name = coalesce(?, name),
						     transport = 'bird',
						     external_user_id = coalesce(?, external_user_id)
						 where id = ?`,
					).run(name, externalUserId, selected.accountId);
					db.prepare(
						`update profiles
						 set display_name = coalesce(?, display_name)
						 where id = coalesce(?, id) and lower(handle) = lower(?)`,
					).run(name, profileId ?? null, selected.username);
					return true;
				})();
			});
		}
		const hydrated = yield* trySync(() => {
			const db = getNativeDb();
			return db.transaction(() => {
				const current = db
					.prepare(
						`select handle, external_user_id, transport from accounts where id = 'acct_primary'`,
					)
					.get() as
					| {
							handle: string | null;
							external_user_id: string | null;
							transport: string;
					  }
					| undefined;
				if (!current) return false;
				const profileMe = db
					.prepare("select raw_json from profiles where id = 'profile_me'")
					.get() as { raw_json: string } | undefined;

				const storedHandle = current?.handle?.replace(/^@/, "") ?? null;
				const handleMatches =
					storedHandle?.toLowerCase() === handle.toLowerCase();
				const identityMatches =
					externalUserId !== null && current.external_user_id !== null
						? externalUserId === current.external_user_id
						: handleMatches;
				const isSeededPlaceholder =
					storedHandle?.toLowerCase() === SEEDED_ACCOUNT_HANDLE &&
					current.external_user_id === SEEDED_ACCOUNT_EXTERNAL_USER_ID &&
					current.transport === "xurl";

				// An archive establishes account ownership for tweets, DMs, and edges.
				// Never relabel that data from whichever account Bird currently uses;
				// only the untouched demo seed may adopt a different Bird identity.
				if (!identityMatches && !isSeededPlaceholder) return false;
				const identityChanged = !identityMatches;

				// Bird whoami is sparse evidence. Resolve profile ownership entirely
				// against the pre-update account/profile state, then switch the account.
				let profileId = "profile_me";
				if (externalUserId && /^[0-9]+$/.test(externalUserId)) {
					const evidence = getProfileRawIdentityEvidence(profileMe?.raw_json);
					const rawProvesProfileMe =
						evidence.kind === "consistent" &&
						evidence.externalUserId === externalUserId;
					const preUpdateAccountProvesProfileMe = Boolean(
						profileMe &&
						evidence.kind === "none" &&
						current.external_user_id === externalUserId &&
						!profileIdentityHasConflict(profileMe.raw_json, externalUserId),
					);
					if (
						profileMe &&
						!rawProvesProfileMe &&
						!preUpdateAccountProvesProfileMe
					) {
						markProfileIdentityConflict(db, "profile_me", externalUserId);
					}
					canonicalizeProvenXProfileIdentity(db, externalUserId, handle, {
						provenLegacyProfileIds:
							rawProvesProfileMe || preUpdateAccountProvesProfileMe
								? new Set(["profile_me"])
								: undefined,
					});
					profileId = upsertSparseProfileFromXUser(db, {
						id: externalUserId,
						username: handle,
						name: name ?? undefined,
					}).profile.id;
				}
				if (!externalUserId) {
					db.prepare(
						`update profiles set handle = ?,
						 display_name = coalesce(?, display_name),
						 avatar_url = case when ? then null else avatar_url end
						 where id = ?`,
					).run(handle, name, identityChanged ? 1 : 0, profileId);
				}
				if (identityChanged) {
					db.prepare(
						`update accounts
						 set handle = ?, name = coalesce(?, name), transport = 'bird',
						     external_user_id = ?
						 where id = 'acct_primary'`,
					).run(`@${handle}`, name, externalUserId);
				} else {
					db.prepare(
						`update accounts
						 set handle = ?, name = coalesce(?, name), transport = 'bird',
						     external_user_id = coalesce(?, external_user_id)
						 where id = 'acct_primary'`,
					).run(`@${handle}`, name, externalUserId);
				}
				return true;
			})();
		});
		return hydrated;
	});
}

export function hydrateProfilesFromXEffect({
	account,
}: { account?: string } = {}): Effect.Effect<HydrateProfilesResult, unknown> {
	return Effect.gen(function* () {
		const transport = yield* getTransportStatusEffect();
		if (transport.availableTransport !== "xurl") {
			// xurl is unavailable, so the live profile backfill can't run. When the
			// bird transport is authenticated we can still correct the seeded
			// account handle (e.g. the placeholder @steipete) from `bird whoami`.
			const hydratedAccount = yield* hydrateAccountFromBirdEffect(account);
			return {
				ok: true,
				hydratedProfiles: 0,
				hydratedAccount,
				reason: transport.statusText,
			};
		}

		const {
			candidateIds,
			db,
			selectedAccount,
			updateAccount,
			updateConversationTitle,
			updateLocalProfile,
		} = yield* trySync(() => {
			const db = getNativeDb();
			const selectedAccount = account
				? resolveLiveSyncAccount(db, account)
				: undefined;
			const candidateRows = db
				.prepare(
					`
      select id
      from profiles
      where id like 'profile_user_%'
		and (followers_count = 0 or bio like 'Imported from archive user %' or handle like 'id%' or handle like 'birdclaw_stub_%')
      order by id asc
      `,
				)
				.all() as Array<{ id: string }>;

			const candidateIds = candidateRows
				.map((row) => row.id.replace(/^profile_user_/, ""))
				.filter((id) => /^\d+$/.test(id));

			const updateConversationTitle = db.prepare(`
    update dm_conversations
    set title = ?
    where participant_profile_id = ?
  `);
			const updateLocalProfile = db.prepare(`
    update profiles
    set handle = ?,
        display_name = ?,
        bio = ?,
        followers_count = ?,
        following_count = coalesce(?, following_count),
        avatar_url = coalesce(?, avatar_url),
        created_at = coalesce(?, created_at)
    where id = ?
  `);
			const updateAccount = db.prepare(`
    update accounts
    set name = ?,
        handle = ?,
		transport = 'xurl',
		external_user_id = coalesce(?, external_user_id)
	where id = ?
  `);

			return {
				candidateIds,
				db,
				selectedAccount,
				updateAccount,
				updateConversationTitle,
				updateLocalProfile,
			};
		});
		const selectedAuthenticatedUser = selectedAccount
			? yield* lookupAuthenticatedOAuth2UserEffect(selectedAccount.username)
			: undefined;
		if (selectedAccount) {
			yield* trySync(() =>
				assertLiveAccountMatches({
					source: "xurl",
					account: selectedAccount,
					liveUsername: String(selectedAuthenticatedUser?.username ?? ""),
					liveExternalUserId:
						typeof selectedAuthenticatedUser?.id === "string"
							? selectedAuthenticatedUser.id
							: undefined,
				}),
			);
		}

		let hydratedProfiles = 0;

		for (let index = 0; index < candidateIds.length; index += 100) {
			const batch = candidateIds.slice(index, index + 100);
			const users = yield* selectedAccount
				? lookupUsersByIdsEffect(batch, {
						username: selectedAccount.username,
					})
				: lookupUsersByIdsEffect(batch);

			yield* trySync(() => {
				db.transaction(() => {
					for (const user of users) {
						const profileId = `profile_user_${String(user.id ?? "")}`;
						if (profileId === "profile_user_") continue;

						const userExternalId = String(user.id ?? "");
						const provenLegacyProfileIds =
							selectedAccount &&
							userExternalId === selectedAccount.externalUserId
								? getProvenSelectedAccountLegacyProfileIds(
										db,
										selectedAccount,
										userExternalId,
									)
								: undefined;
						const resolved = upsertProfileFromXUser(db, user, {
							provenLegacyProfileIds,
						});
						updateConversationTitle.run(
							resolved.profile.displayName || resolved.profile.handle,
							resolved.profile.id,
						);
						hydratedProfiles += 1;
					}
				})();
			});
		}

		let hydratedAccount = false;
		const me = selectedAccount
			? selectedAuthenticatedUser
			: yield* lookupAuthenticatedUserUnscopedEffect().pipe(
					Effect.catchAll(() => Effect.succeed(null)),
				);
		if (me) {
			const metrics = asRecord(me.public_metrics);
			yield* trySync(() => {
				db.transaction(() => {
					const accountId = selectedAccount?.accountId ?? "acct_primary";
					const meExternalUserId =
						typeof me.id === "string" && /^[0-9]+$/.test(me.id)
							? me.id
							: undefined;
					const provenLegacyProfileIds =
						selectedAccount && meExternalUserId
							? getProvenSelectedAccountLegacyProfileIds(
									db,
									selectedAccount,
									meExternalUserId,
								)
							: undefined;
					const canonicalMe =
						meExternalUserId && typeof me.username === "string" && me.username
							? upsertProfileFromXUser(db, me as unknown as XurlMentionUser, {
									provenLegacyProfileIds,
								})
							: undefined;
					const localProfile = db
						.prepare(
							"select id from profiles where lower(handle) = lower(?) limit 1",
						)
						.get(selectedAccount?.username ?? "steipete") as
						| { id: string }
						| undefined;
					const localProfileId =
						canonicalMe?.profile.id ??
						(selectedAccount ? localProfile?.id : "profile_me");
					if (localProfileId) {
						updateLocalProfile.run(
							String(me.username ?? "steipete").replace(/^@/, ""),
							String(me.name ?? "Peter Steinberger"),
							String(me.description ?? ""),
							toInt(metrics?.followers_count),
							metrics && "following_count" in metrics
								? toInt(metrics.following_count)
								: null,
							normalizeAvatarUrl(me.profile_image_url),
							typeof me.created_at === "string" ? me.created_at : null,
							localProfileId,
						);
					}
					updateAccount.run(
						String(me.name ?? "Peter Steinberger"),
						`@${String(me.username ?? "steipete").replace(/^@/, "")}`,
						typeof me.id === "string" ? me.id : null,
						accountId,
					);
				})();
			});
			hydratedAccount = true;
		}

		return {
			ok: true,
			hydratedProfiles,
			hydratedAccount,
		};
	});
}

export function hydrateProfilesFromX(
	options: { account?: string } = {},
): Promise<HydrateProfilesResult> {
	return runEffectPromise(hydrateProfilesFromXEffect(options));
}

export const __test__ = {
	asRecord,
	toInt,
};
