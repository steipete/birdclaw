import { getNativeDb } from "./db";
import { lookupProfileViaBird, lookupProfilesViaBird } from "./bird";
import { readSyncCache, writeSyncCache } from "./sync-cache";
import {
	hydrateProfileAffiliationOrganizations,
	type ProfileAffiliationHydrationResult,
} from "./profile-affiliation-hydration";
import type { ProfileRecord, XurlMentionUser } from "./types";
import { getExternalUserId, upsertProfileFromXUser } from "./x-profile";
import { lookupUsersByHandles, lookupUsersByIds } from "./xurl";

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

function toProfile(row: Record<string, unknown>): ProfileRecord {
	const followingCount = Number(row.following_count ?? 0);
	let entities: Record<string, unknown> | undefined;
	if (typeof row.entities_json === "string" && row.entities_json.length > 0) {
		try {
			const parsed = JSON.parse(row.entities_json) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				entities = parsed as Record<string, unknown>;
			}
		} catch {
			entities = undefined;
		}
	}
	return {
		id: String(row.id),
		handle: String(row.handle),
		displayName: String(row.display_name),
		bio: String(row.bio),
		followersCount: Number(row.followers_count),
		...(Number.isFinite(followingCount) ? { followingCount } : {}),
		avatarHue: Number(row.avatar_hue),
		avatarUrl:
			typeof row.avatar_url === "string" ? String(row.avatar_url) : undefined,
		...(typeof row.location === "string" && row.location.length > 0
			? { location: row.location }
			: {}),
		...(typeof row.url === "string" && row.url.length > 0
			? { url: row.url }
			: {}),
		...(typeof row.verified_type === "string" && row.verified_type.length > 0
			? { verifiedType: row.verified_type }
			: {}),
		...(entities ? { entities } : {}),
		createdAt: String(row.created_at),
	};
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

	return row ? toProfile(row) : null;
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

function updateConversationTitles(profile: ProfileRecord) {
	getNativeDb()
		.prepare(
			`
      update dm_conversations
      set title = ?
      where participant_profile_id = ?
      `,
		)
		.run(profile.displayName || profile.handle, profile.id);
}

async function lookupViaXurl(externalUserId: string) {
	const [user] = await lookupUsersByIds([externalUserId]);
	return user ?? null;
}

function normalizeHandle(value: string) {
	return value.trim().replace(/^@/, "").toLowerCase();
}

async function fetchProfileUser(
	externalUserId: string,
	xurlFallback: boolean,
): Promise<CachedProfileLookup> {
	try {
		const birdUser = await lookupProfileViaBird(externalUserId);
		if (birdUser) {
			return { status: "hit", source: "bird", user: birdUser };
		}
	} catch (error) {
		if (!xurlFallback) {
			return {
				status: "error",
				source: "bird",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	if (!xurlFallback) {
		return { status: "miss", source: "bird" };
	}

	try {
		const xurlUser = await lookupViaXurl(externalUserId);
		return xurlUser
			? { status: "hit", source: "xurl", user: xurlUser }
			: { status: "miss", source: "xurl" };
	} catch (error) {
		return {
			status: "error",
			source: "xurl",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function fetchProfileUsers(
	externalUserIds: string[],
	xurlFallback: boolean,
) {
	const uniqueIds = Array.from(new Set(externalUserIds));
	const results = new Map<string, CachedProfileLookup>();
	let unresolved = uniqueIds;

	try {
		const birdResults = await lookupProfilesViaBird(uniqueIds);
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
	} catch (error) {
		if (!xurlFallback) {
			for (const externalUserId of uniqueIds) {
				results.set(externalUserId, {
					status: "error",
					source: "bird",
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return results;
		}
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

	try {
		const xurlUsers = await lookupUsersByIds(unresolved);
		const usersById = new Map(xurlUsers.map((user) => [String(user.id), user]));
		for (const externalUserId of unresolved) {
			const user = usersById.get(externalUserId);
			results.set(
				externalUserId,
				user
					? { status: "hit", source: "xurl", user }
					: { status: "miss", source: "xurl" },
			);
		}
	} catch (error) {
		for (const externalUserId of unresolved) {
			results.set(externalUserId, {
				status: "error",
				source: "xurl",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return results;
}

export async function resolveProfilesForIds(
	profileIds: string[],
	options: ResolveProfilesOptions = {},
): Promise<ProfileResolveResult[]> {
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

		const localProfile = getProfile(profileId);
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

		const cached = readSyncCache<CachedProfileLookup>(
			cacheKeyForUserId(externalUserId),
		);
		if (cached && !options.refresh) {
			const maxAge =
				cached.value.status === "hit" ? maxAgeMs : negativeMaxAgeMs;
			if (isFresh(cached.updatedAt, maxAge)) {
				if (cached.value.status === "hit" && cached.value.user) {
					const resolved = upsertProfileFromXUser(
						getNativeDb(),
						cached.value.user,
					);
					updateConversationTitles(resolved.profile);
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
			? await fetchProfileUsers(pendingExternalIds, xurlFallback)
			: new Map<string, CachedProfileLookup>();

	const results: ProfileResolveResult[] = [];
	for (const item of ordered) {
		if (item.kind === "ready") {
			results.push(item.result);
			continue;
		}
		const fetched =
			fetchedByExternalId.get(item.externalUserId) ??
			(await fetchProfileUser(item.externalUserId, xurlFallback));
		writeProfileLookupCache(item.externalUserId, fetched);
		if (fetched.status === "hit" && fetched.user) {
			const resolved = upsertProfileFromXUser(getNativeDb(), fetched.user);
			const affiliationHydration = await hydrateProfileAffiliationOrganizations(
				getNativeDb(),
				resolved.profile.id,
			);
			updateConversationTitles(resolved.profile);
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
}

export async function resolveProfilesForHandles(
	handles: string[],
	options: Pick<ResolveProfilesOptions, "xurlFallback"> = {},
): Promise<HandleProfileResolveResult[]> {
	const xurlFallback = options.xurlFallback ?? true;
	const targets = Array.from(
		new Set(handles.map(normalizeHandle).filter((handle) => handle.length > 0)),
	);
	if (targets.length === 0) {
		return [];
	}

	const results = new Map<string, HandleProfileResolveResult>();
	let unresolved = targets;

	try {
		const birdResults = await lookupProfilesViaBird(targets);
		for (const item of birdResults) {
			const handle = normalizeHandle(item.target);
			if (item.user) {
				const resolved = upsertProfileFromXUser(getNativeDb(), item.user);
				updateConversationTitles(resolved.profile);
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
	} catch (error) {
		if (!xurlFallback) {
			for (const handle of targets) {
				results.set(handle, {
					handle,
					status: "error",
					source: "bird",
					error: error instanceof Error ? error.message : String(error),
				});
			}
			unresolved = [];
		}
	}

	if (unresolved.length > 0 && xurlFallback) {
		try {
			const users = await lookupUsersByHandles(unresolved);
			const usersByHandle = new Map(
				users.map((user) => [
					normalizeHandle(String(user.username ?? "")),
					user,
				]),
			);
			for (const handle of unresolved) {
				const user = usersByHandle.get(handle);
				if (user) {
					const resolved = upsertProfileFromXUser(getNativeDb(), user);
					updateConversationTitles(resolved.profile);
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
		} catch (error) {
			for (const handle of unresolved) {
				results.set(handle, {
					handle,
					status: "error",
					source: "xurl",
					error: error instanceof Error ? error.message : String(error),
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
}

export async function resolvePlaceholderProfiles(
	options: ResolveProfilesOptions & { limit?: number } = {},
) {
	const db = getNativeDb();
	const rows = db
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
		.all(options.limit ?? 500) as Array<{ id: string }>;

	const results = await resolveProfilesForIds(
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
}

export const __test__ = {
	isPlaceholderProfile,
	cacheKeyForUserId,
};
