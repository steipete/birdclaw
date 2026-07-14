import { Effect } from "effect";

import { normalizeAvatarUrl } from "./avatar-cache";
import { getAuthenticatedBirdAccountEffect } from "./bird";
import { getNativeDb } from "./db";
import {
	DEMO_PRIMARY_ACCOUNT_MARKER_KEY,
	hasUntouchedDemoPrimaryAccountState,
	type StoredPrimaryAccount,
} from "./demo-account";
import { runEffectPromise } from "./effect-runtime";
import {
	getTransportStatusEffect,
	lookupSelectedAuthenticatedOAuth2UserEffect,
	lookupAuthenticatedUserEffect,
	lookupUsersByIdsEffect,
} from "./xurl";
import { upsertProfileFromXUser } from "./x-profile";

export type HydrateProfilesResult = {
	ok: true;
	hydratedProfiles: number;
	hydratedAccount: boolean;
	account?: {
		handle: string;
		externalUserId: string | null;
	};
	reason?: string;
};

export type HydrateProfilesOptions = {
	account?: string;
	accountOnly?: boolean;
	seededAccountOnly?: boolean;
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

function normalizeSelectedAccount(value: string) {
	const username = value.trim().replace(/^@/, "");
	return username.length > 0 ? username : null;
}

const SEEDED_ACCOUNT_HANDLE = "steipete";
const SEEDED_ACCOUNT_EXTERNAL_USER_ID = "25401953";

function hydrateAccountFromBirdEffect(): Effect.Effect<boolean, unknown> {
	return Effect.gen(function* () {
		const account = yield* getAuthenticatedBirdAccountEffect().pipe(
			Effect.catchAll(() => Effect.succeed(null)),
		);
		if (!account?.username) return false;

		const handle = account.username.replace(/^@/, "");
		const name = account.name?.trim() || null;
		const externalUserId = account.id ?? null;
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

				// On an identity change the seeded avatar belongs to a different
				// person, and bird whoami can't supply a replacement, so clear it and
				// let the UI fall back to initials rather than showing the previous
				// user's photo. Likewise clear a stale external_user_id when the new
				// identity has no id of its own.
				if (identityChanged) {
					db.prepare(
						`update profiles
						 set handle = ?,
						     display_name = coalesce(?, display_name),
						     avatar_url = null
						 where id = 'profile_me'`,
					).run(handle, name);
					db.prepare(
						`update accounts
						 set handle = ?,
						     name = coalesce(?, name),
						     transport = 'bird',
						     external_user_id = ?
						 where id = 'acct_primary'`,
					).run(`@${handle}`, name, externalUserId);
				} else {
					db.prepare(
						`update profiles
						 set handle = ?,
						     display_name = coalesce(?, display_name)
						 where id = 'profile_me'`,
					).run(handle, name);
					db.prepare(
						`update accounts
						 set handle = ?,
						     name = coalesce(?, name),
						     transport = 'bird',
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

export function hydrateProfilesFromXEffect(
	options: HydrateProfilesOptions = {},
): Effect.Effect<HydrateProfilesResult, unknown> {
	return Effect.gen(function* () {
		const selectedAccount =
			options.account === undefined
				? undefined
				: normalizeSelectedAccount(options.account);
		if (selectedAccount === null) {
			return yield* Effect.fail(
				new Error("Explicit account selection requires a non-empty username"),
			);
		}
		const transport = yield* getTransportStatusEffect();
		if (transport.availableTransport !== "xurl") {
			if (selectedAccount !== undefined) {
				return {
					ok: true,
					hydratedProfiles: 0,
					hydratedAccount: false,
					reason: `Cannot select xurl account @${selectedAccount}: ${transport.statusText}`,
				};
			}
			// xurl is unavailable, so the live profile backfill can't run. When the
			// bird transport is authenticated we can still correct the seeded
			// account handle (e.g. the placeholder @steipete) from `bird whoami`.
			const hydratedAccount = yield* hydrateAccountFromBirdEffect();
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
			deleteDemoPrimaryAccountMarker,
			renameSeedAccountHandle,
			renameSeedProfileHandle,
			updateAccount,
			updateConversationTitle,
			updateLocalProfile,
		} = yield* trySync(() => {
			const db = getNativeDb();
			const candidateRows = options.accountOnly
				? []
				: (db
						.prepare(
							`
      select id
      from profiles
      where id like 'profile_user_%'
        and (followers_count = 0 or bio like 'Imported from archive user %' or handle like 'id%')
      order by id asc
      `,
						)
						.all() as Array<{ id: string }>);

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
    where id = 'profile_me'
  `);
			const updateAccount = db.prepare(`
    update accounts
    set name = ?,
        handle = ?,
		external_user_id = coalesce(?, external_user_id),
        transport = 'xurl'
    where id = 'acct_primary'
  `);
			const renameSeedProfileHandle = db.prepare(`
    update profiles
    set handle = 'seeded_' || id
    where id <> 'profile_me'
      and lower(handle) = lower(?)
  `);
			const renameSeedAccountHandle = db.prepare(`
    update accounts
    set handle = '@seeded_' || id
    where id <> 'acct_primary'
      and lower(ltrim(handle, '@')) = lower(?)
  `);
			const deleteDemoPrimaryAccountMarker = db.prepare(`
    delete from sync_cache
    where cache_key = ?
  `);

			return {
				candidateIds,
				db,
				deleteDemoPrimaryAccountMarker,
				renameSeedAccountHandle,
				renameSeedProfileHandle,
				updateAccount,
				updateConversationTitle,
				updateLocalProfile,
			};
		});

		let hydratedProfiles = 0;

		for (let index = 0; index < candidateIds.length; index += 100) {
			const batch = candidateIds.slice(index, index + 100);
			const users = yield* lookupUsersByIdsEffect(batch);

			yield* trySync(() => {
				db.transaction(() => {
					for (const user of users) {
						const profileId = `profile_user_${String(user.id ?? "")}`;
						if (profileId === "profile_user_") continue;

						const resolved = upsertProfileFromXUser(db, user);
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
		let account: HydrateProfilesResult["account"];
		const me =
			selectedAccount !== undefined
				? yield* lookupSelectedAuthenticatedOAuth2UserEffect(selectedAccount)
				: yield* lookupAuthenticatedUserEffect().pipe(
						Effect.catchAll(() => Effect.succeed(null)),
					);
		if (selectedAccount !== undefined && !me) {
			return yield* Effect.fail(
				new Error(
					`Could not resolve authenticated xurl account @${selectedAccount}`,
				),
			);
		}
		if (me) {
			const username = String(me.username ?? "")
				.trim()
				.replace(/^@/, "");
			if (
				selectedAccount !== undefined &&
				(username.length === 0 ||
					username.toLowerCase() !== selectedAccount.toLowerCase())
			) {
				return yield* Effect.fail(
					new Error(
						`Authenticated xurl identity does not match requested account @${selectedAccount}`,
					),
				);
			}
			const externalUserId =
				typeof me.id === "string" && me.id.trim().length > 0
					? me.id.trim()
					: null;
			if (selectedAccount !== undefined && externalUserId === null) {
				return yield* Effect.fail(
					new Error(
						`Authenticated xurl response for @${selectedAccount} did not include a user ID`,
					),
				);
			}
			const metrics = asRecord(me.public_metrics);
			const selected = yield* trySync(() =>
				db.transaction(() => {
					const currentAccount = db
						.prepare(
							"select name, handle, external_user_id, transport, is_default, created_at from accounts where id = 'acct_primary'",
						)
						.get() as StoredPrimaryAccount | undefined;
					const currentHandle = currentAccount?.handle
						.replace(/^@/, "")
						.toLowerCase();
					const identityMatches =
						currentAccount !== undefined &&
						externalUserId !== null &&
						currentAccount.external_user_id !== null
							? externalUserId === currentAccount.external_user_id
							: username.length > 0 && currentHandle === username.toLowerCase();
					const isSeededPlaceholder =
						options.seededAccountOnly && !identityMatches
							? hasUntouchedDemoPrimaryAccountState(db, currentAccount)
							: false;
					if (
						options.seededAccountOnly &&
						!identityMatches &&
						!isSeededPlaceholder
					) {
						return false;
					}
					if (isSeededPlaceholder) {
						renameSeedProfileHandle.run(username);
						renameSeedAccountHandle.run(username);
					}
					updateLocalProfile.run(
						username || SEEDED_ACCOUNT_HANDLE,
						String(me.name ?? "Peter Steinberger"),
						String(me.description ?? ""),
						toInt(metrics?.followers_count),
						metrics && "following_count" in metrics
							? toInt(metrics.following_count)
							: null,
						normalizeAvatarUrl(me.profile_image_url),
						typeof me.created_at === "string" ? me.created_at : null,
					);
					updateAccount.run(
						String(me.name ?? "Peter Steinberger"),
						`@${username || SEEDED_ACCOUNT_HANDLE}`,
						externalUserId,
					);
					deleteDemoPrimaryAccountMarker.run(DEMO_PRIMARY_ACCOUNT_MARKER_KEY);
					return true;
				})(),
			);
			if (!selected) {
				return {
					ok: true,
					hydratedProfiles,
					hydratedAccount: false,
					reason: "Primary account is not the untouched demo seed",
				};
			}
			hydratedAccount = true;
			account = {
				handle: `@${username || SEEDED_ACCOUNT_HANDLE}`,
				externalUserId,
			};
		}

		return {
			ok: true,
			hydratedProfiles,
			hydratedAccount,
			account,
		};
	});
}

export function hydrateProfilesFromX(
	options?: HydrateProfilesOptions,
): Promise<HydrateProfilesResult> {
	return runEffectPromise(hydrateProfilesFromXEffect(options));
}

export const __test__ = {
	asRecord,
	toInt,
};
