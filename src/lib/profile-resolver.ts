import { Effect } from "effect";

import { getNativeDb } from "./db";
import {
	lookupProfileViaBirdEffect,
	lookupProfilesViaBirdEffect,
} from "./bird";
import { runEffectPromise } from "./effect-runtime";
import { readSyncCache, writeSyncCache } from "./sync-cache";
import {
	hydrateProfileAffiliationOrganizationsEffect,
	type ProfileAffiliationHydrationResult,
} from "./profile-affiliation-hydration";
import { profileFromDbRow, profileHandleKey } from "./profile-row";
import type { ProfileRecord, XurlMentionUser } from "./types";
import { getExternalUserId, upsertProfileFromXUser } from "./x-profile";
import { lookupUsersByHandlesEffect, lookupUsersByIdsEffect } from "./xurl";

const PROFILE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PROFILE_NEGATIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type ProfileLookupStatus = "hit" | "miss" | "error";
type ProfileLookupSource = "local" | "cache" | "bird" | "xurl";

interface CachedProfileLookup {
	status: ProfileLookupStatus;
	source: Exclude<ProfileLookupSource, "local" | "cache">;
	user?: XurlMentionUser;
	error?: string;
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

export interface ResolveProfilesOptions {
	refresh?: boolean;
	maxAgeMs?: number;
	negativeMaxAgeMs?: number;
	xurlFallback?: boolean;
}

export interface ProfileResolveResult {
	profileId: string;
	externalUserId: string | null;
	status: ProfileLookupStatus;
	source: ProfileLookupSource | "negative-cache";
	profile?: ProfileRecord;
	affiliationHydration?: ProfileAffiliationHydrationResult;
	error?: string;
}

export interface HandleProfileResolveResult {
	handle: string;
	status: ProfileLookupStatus;
	source: Exclude<ProfileLookupSource, "local">;
	profile?: ProfileRecord;
	error?: string;
}

function getProfile(profileId: string) {
	const row = getNativeDb()
		.prepare(
			`
      select id, handle, display_name, bio, followers_count, following_count,
        avatar_hue, avatar_url, location, url, verified_type, entities_json, created_at
      from profiles
      where id = ?
      `,
		)
		.get(profileId) as Record<string, unknown> | undefined;

	return row ? profileFromDbRow(row) : null;
}

function isPlaceholderProfile(profile: ProfileRecord) {
	const externalUserId = getExternalUserId(profile.id);
	if (!externalUserId) {
		return false;
	}
	return (
		profile.handle === `id${externalUserId}` ||
		profile.handle === `user_${externalUserId}` ||
		profile.displayName === `id${externalUserId}` ||
		profile.displayName === `user_${externalUserId}` ||
		profile.bio === `Imported from archive user ${externalUserId}` ||
		(profile.followersCount === 0 &&
			profile.bio.startsWith("Imported from archive user "))
	);
}

function isFresh(updatedAt: string, maxAgeMs: number) {
	return Date.now() - new Date(updatedAt).getTime() <= maxAgeMs;
}

function cacheKeyForUserId(externalUserId: string) {
	return `profile:lookup:user-id:${externalUserId}`;
}

function writeProfileLookupCache(
	externalUserId: string,
	value: CachedProfileLookup,
) {
	writeSyncCache(cacheKeyForUserId(externalUserId), value);
}

function updateConversationTitles(profile: ProfileRecord, db = getNativeDb()) {
	db.prepare(
		`
      update dm_conversations
      set title = ?
      where participant_profile_id = ?
      `,
	).run(profile.displayName || profile.handle, profile.id);
}

function lookupViaXurlEffect(externalUserId: string) {
	return lookupUsersByIdsEffect([externalUserId]).pipe(
		Effect.map(([user]) => user ?? null),
	);
}

function fetchProfileUserEffect(
	externalUserId: string,
	xurlFallback: boolean,
): Effect.Effect<CachedProfileLookup, never> {
	return Effect.gen(function* () {
		const birdResult = yield* lookupProfileViaBirdEffect(externalUserId).pipe(
			Effect.map((user) => ({ ok: true as const, user })),
			Effect.catchAll((error) => Effect.succeed({ ok: false as const, error })),
		);
		if (birdResult.ok) {
			const birdUser = birdResult.user;
			if (birdUser) {
				return { status: "hit", source: "bird", user: birdUser };
			}
		} else if (!xurlFallback) {
			return {
				status: "error",
				source: "bird",
				error:
					birdResult.error instanceof Error
						? birdResult.error.message
						: String(birdResult.error),
			};
		}

		if (!xurlFallback) {
			return { status: "miss", source: "bird" };
		}

		const xurlResult = yield* lookupViaXurlEffect(externalUserId).pipe(
			Effect.map((user) => ({ ok: true as const, user })),
			Effect.catchAll((error) => Effect.succeed({ ok: false as const, error })),
		);
		if (xurlResult.ok) {
			const xurlUser = xurlResult.user;
			return xurlUser
				? { status: "hit", source: "xurl", user: xurlUser }
				: { status: "miss", source: "xurl" };
		}
		return {
			status: "error",
			source: "xurl",
			error:
				xurlResult.error instanceof Error
					? xurlResult.error.message
					: String(xurlResult.error),
		};
	});
}

function fetchProfileUsersEffect(
	externalUserIds: string[],
	xurlFallback: boolean,
) {
	return Effect.gen(function* () {
		const uniqueIds = Array.from(new Set(externalUserIds));
		const results = new Map<string, CachedProfileLookup>();
		let unresolved = uniqueIds;

		const birdResult = yield* lookupProfilesViaBirdEffect(uniqueIds).pipe(
			Effect.map((items) => ({ ok: true as const, items })),
			Effect.catchAll((error) => Effect.succeed({ ok: false as const, error })),
		);
		if (birdResult.ok) {
			const birdResults = birdResult.items;
			for (const result of birdResults) {
				const externalUserId = result.target;
				if (result.user) {
					results.set(externalUserId, {
						status: "hit",
						source: "bird",
						user: result.user,
					});
				} else if (result.error && !xurlFallback) {
					results.set(externalUserId, {
						status: "error",
						source: "bird",
						error: result.error,
					});
				}
			}
			unresolved = uniqueIds.filter((id) => !results.has(id));
		} else if (!xurlFallback) {
			for (const externalUserId of uniqueIds) {
				results.set(externalUserId, {
					status: "error",
					source: "bird",
					error:
						birdResult.error instanceof Error
							? birdResult.error.message
							: String(birdResult.error),
				});
			}
			return results;
		}

		if (unresolved.length === 0) {
			return results;
		}
		if (!xurlFallback) {
			for (const externalUserId of unresolved) {
				results.set(externalUserId, { status: "miss", source: "bird" });
			}
			return results;
		}

		const xurlResult = yield* lookupUsersByIdsEffect(unresolved).pipe(
			Effect.map((users) => ({ ok: true as const, users })),
			Effect.catchAll((error) => Effect.succeed({ ok: false as const, error })),
		);
		if (xurlResult.ok) {
			const xurlUsers = xurlResult.users;
			const usersById = new Map(
				xurlUsers.map((user) => [String(user.id), user]),
			);
			for (const externalUserId of unresolved) {
				const user = usersById.get(externalUserId);
				results.set(
					externalUserId,
					user
						? { status: "hit", source: "xurl", user }
						: { status: "miss", source: "xurl" },
				);
			}
		} else {
			for (const externalUserId of unresolved) {
				results.set(externalUserId, {
					status: "error",
					source: "xurl",
					error:
						xurlResult.error instanceof Error
							? xurlResult.error.message
							: String(xurlResult.error),
				});
			}
		}

		return results;
	});
}

export function resolveProfilesForIdsEffect(
	profileIds: string[],
	options: ResolveProfilesOptions = {},
): Effect.Effect<ProfileResolveResult[], unknown> {
	return Effect.gen(function* () {
		const db = yield* trySync(() => getNativeDb());
		const maxAgeMs = options.maxAgeMs ?? PROFILE_CACHE_TTL_MS;
		const negativeMaxAgeMs =
			options.negativeMaxAgeMs ?? PROFILE_NEGATIVE_CACHE_TTL_MS;
		const xurlFallback = options.xurlFallback ?? true;
		const ordered: Array<
			| { kind: "ready"; result: ProfileResolveResult }
			| { kind: "pending"; profileId: string; externalUserId: string }
		> = [];

		for (const profileId of Array.from(new Set(profileIds))) {
			const externalUserId = getExternalUserId(profileId);
			if (!externalUserId) {
				ordered.push({
					kind: "ready",
					result: {
						profileId,
						externalUserId: null,
						status: "miss",
						source: "local",
					},
				});
				continue;
			}

			const localProfile = yield* trySync(() => getProfile(profileId));
			if (
				localProfile &&
				!options.refresh &&
				!isPlaceholderProfile(localProfile)
			) {
				ordered.push({
					kind: "ready",
					result: {
						profileId,
						externalUserId,
						status: "hit",
						source: "local",
						profile: localProfile,
					},
				});
				continue;
			}

			const cached = yield* trySync(() =>
				readSyncCache<CachedProfileLookup>(cacheKeyForUserId(externalUserId)),
			);
			if (cached && !options.refresh) {
				const maxAge =
					cached.value.status === "hit" ? maxAgeMs : negativeMaxAgeMs;
				if (isFresh(cached.updatedAt, maxAge)) {
					if (cached.value.status === "hit" && cached.value.user) {
						const resolved = yield* trySync(() => {
							const resolved = upsertProfileFromXUser(db, cached.value.user!);
							updateConversationTitles(resolved.profile, db);
							return resolved;
						});
						ordered.push({
							kind: "ready",
							result: {
								profileId: resolved.profile.id,
								externalUserId,
								status: "hit",
								source: "cache",
								profile: resolved.profile,
							},
						});
						continue;
					}
					ordered.push({
						kind: "ready",
						result: {
							profileId,
							externalUserId,
							status: cached.value.status,
							source: "negative-cache",
							error: cached.value.error,
						},
					});
					continue;
				}
			}

			ordered.push({ kind: "pending", profileId, externalUserId });
		}

		const pendingExternalIds = ordered.flatMap((item) =>
			item.kind === "pending" ? [item.externalUserId] : [],
		);
		const fetchedByExternalId =
			pendingExternalIds.length > 1
				? yield* fetchProfileUsersEffect(pendingExternalIds, xurlFallback)
				: new Map<string, CachedProfileLookup>();

		const results: ProfileResolveResult[] = [];
		for (const item of ordered) {
			if (item.kind === "ready") {
				results.push(item.result);
				continue;
			}
			const fetched =
				fetchedByExternalId.get(item.externalUserId) ??
				(yield* fetchProfileUserEffect(item.externalUserId, xurlFallback));
			yield* trySync(() =>
				writeProfileLookupCache(item.externalUserId, fetched),
			);
			if (fetched.status === "hit" && fetched.user) {
				const resolved = yield* trySync(() =>
					upsertProfileFromXUser(db, fetched.user!),
				);
				const affiliationHydration =
					yield* hydrateProfileAffiliationOrganizationsEffect(
						db,
						resolved.profile.id,
					);
				yield* trySync(() => updateConversationTitles(resolved.profile, db));
				results.push({
					profileId: resolved.profile.id,
					externalUserId: item.externalUserId,
					status: "hit",
					source: fetched.source,
					profile: resolved.profile,
					...(affiliationHydration.checked > 0 ? { affiliationHydration } : {}),
				});
				continue;
			}
			results.push({
				profileId: item.profileId,
				externalUserId: item.externalUserId,
				status: fetched.status,
				source: fetched.source,
				error: fetched.error,
			});
		}

		return results;
	});
}

export function resolveProfilesForIds(
	profileIds: string[],
	options: ResolveProfilesOptions = {},
): Promise<ProfileResolveResult[]> {
	return runEffectPromise(resolveProfilesForIdsEffect(profileIds, options));
}

export function resolveProfilesForHandlesEffect(
	handles: string[],
	options: Pick<ResolveProfilesOptions, "xurlFallback"> = {},
): Effect.Effect<HandleProfileResolveResult[], unknown> {
	return Effect.gen(function* () {
		const db = yield* trySync(() => getNativeDb());
		const xurlFallback = options.xurlFallback ?? true;
		const targets = Array.from(
			new Set(
				handles.map(profileHandleKey).filter((handle) => handle.length > 0),
			),
		);
		if (targets.length === 0) {
			return [];
		}

		const results = new Map<string, HandleProfileResolveResult>();
		let unresolved = targets;

		const birdResult = yield* lookupProfilesViaBirdEffect(targets).pipe(
			Effect.map((items) => ({ ok: true as const, items })),
			Effect.catchAll((error) => Effect.succeed({ ok: false as const, error })),
		);
		if (birdResult.ok) {
			const birdResults = birdResult.items;
			for (const item of birdResults) {
				const handle = profileHandleKey(item.target);
				if (item.user) {
					const resolved = yield* trySync(() => {
						const resolved = upsertProfileFromXUser(db, item.user!);
						updateConversationTitles(resolved.profile, db);
						return resolved;
					});
					results.set(handle, {
						handle,
						status: "hit",
						source: "bird",
						profile: resolved.profile,
					});
				} else if (item.error && !xurlFallback) {
					results.set(handle, {
						handle,
						status: "error",
						source: "bird",
						error: item.error,
					});
				}
			}
			unresolved = targets.filter((handle) => !results.has(handle));
		} else if (!xurlFallback) {
			for (const handle of targets) {
				results.set(handle, {
					handle,
					status: "error",
					source: "bird",
					error:
						birdResult.error instanceof Error
							? birdResult.error.message
							: String(birdResult.error),
				});
			}
			unresolved = [];
		}

		if (unresolved.length > 0 && xurlFallback) {
			const xurlResult = yield* lookupUsersByHandlesEffect(unresolved).pipe(
				Effect.map((users) => ({ ok: true as const, users })),
				Effect.catchAll((error) =>
					Effect.succeed({ ok: false as const, error }),
				),
			);
			if (xurlResult.ok) {
				const users = xurlResult.users;
				const usersByHandle = new Map(
					users.map((user) => [
						profileHandleKey(String(user.username ?? "")),
						user,
					]),
				);
				for (const handle of unresolved) {
					const user = usersByHandle.get(handle);
					if (user) {
						const resolved = yield* trySync(() => {
							const resolved = upsertProfileFromXUser(db, user);
							updateConversationTitles(resolved.profile, db);
							return resolved;
						});
						results.set(handle, {
							handle,
							status: "hit",
							source: "xurl",
							profile: resolved.profile,
						});
					} else {
						results.set(handle, {
							handle,
							status: "miss",
							source: "xurl",
						});
					}
				}
			} else {
				for (const handle of unresolved) {
					results.set(handle, {
						handle,
						status: "error",
						source: "xurl",
						error:
							xurlResult.error instanceof Error
								? xurlResult.error.message
								: String(xurlResult.error),
					});
				}
			}
		}

		return targets.map(
			(handle) =>
				results.get(handle) ?? {
					handle,
					status: "miss",
					source: "bird",
				},
		);
	});
}

export function resolveProfilesForHandles(
	handles: string[],
	options: Pick<ResolveProfilesOptions, "xurlFallback"> = {},
): Promise<HandleProfileResolveResult[]> {
	return runEffectPromise(resolveProfilesForHandlesEffect(handles, options));
}

export function resolvePlaceholderProfilesEffect(
	options: ResolveProfilesOptions & { limit?: number } = {},
) {
	return Effect.gen(function* () {
		const db = yield* trySync(() => getNativeDb());
		const rows = yield* trySync(
			() =>
				db
					.prepare(
						`
      select id
      from profiles
      where id like 'profile_user_%'
        and (
          followers_count = 0
          or bio like 'Imported from archive user %'
          or handle like 'id%'
          or handle like 'user_%'
        )
      order by id asc
      limit ?
      `,
					)
					.all(options.limit ?? 500) as Array<{ id: string }>,
		);

		const results = yield* resolveProfilesForIdsEffect(
			rows.map((row) => row.id),
			options,
		);
		return {
			ok: true,
			requestedProfiles: rows.length,
			hydratedProfiles: results.filter((result) => result.status === "hit")
				.length,
			results,
		};
	});
}

export function resolvePlaceholderProfiles(
	options: ResolveProfilesOptions & { limit?: number } = {},
) {
	return runEffectPromise(resolvePlaceholderProfilesEffect(options));
}

export const __test__ = {
	isPlaceholderProfile,
	cacheKeyForUserId,
};
