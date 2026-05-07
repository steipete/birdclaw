import { getNativeDb } from "./db";
import { lookupProfileViaBird } from "./bird";
import { readSyncCache, writeSyncCache } from "./sync-cache";
import {
	hydrateProfileAffiliationOrganizations,
	type ProfileAffiliationHydrationResult,
} from "./profile-affiliation-hydration";
import type { ProfileRecord, XurlMentionUser } from "./types";
import { getExternalUserId, upsertProfileFromXUser } from "./x-profile";
import { lookupUsersByIds } from "./xurl";

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

export async function resolveProfilesForIds(
	profileIds: string[],
	options: ResolveProfilesOptions = {},
): Promise<ProfileResolveResult[]> {
	const maxAgeMs = options.maxAgeMs ?? PROFILE_CACHE_TTL_MS;
	const negativeMaxAgeMs =
		options.negativeMaxAgeMs ?? PROFILE_NEGATIVE_CACHE_TTL_MS;
	const xurlFallback = options.xurlFallback ?? true;
	const results: ProfileResolveResult[] = [];

	for (const profileId of Array.from(new Set(profileIds))) {
		const externalUserId = getExternalUserId(profileId);
		if (!externalUserId) {
			results.push({
				profileId,
				externalUserId: null,
				status: "miss",
				source: "local",
			});
			continue;
		}

		const localProfile = getProfile(profileId);
		if (
			localProfile &&
			!options.refresh &&
			!isPlaceholderProfile(localProfile)
		) {
			results.push({
				profileId,
				externalUserId,
				status: "hit",
				source: "local",
				profile: localProfile,
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
					results.push({
						profileId: resolved.profile.id,
						externalUserId,
						status: "hit",
						source: "cache",
						profile: resolved.profile,
					});
					continue;
				}
				results.push({
					profileId,
					externalUserId,
					status: cached.value.status,
					source: "negative-cache",
					error: cached.value.error,
				});
				continue;
			}
		}

		const fetched = await fetchProfileUser(externalUserId, xurlFallback);
		writeProfileLookupCache(externalUserId, fetched);
		if (fetched.status === "hit" && fetched.user) {
			const resolved = upsertProfileFromXUser(getNativeDb(), fetched.user);
			const affiliationHydration = await hydrateProfileAffiliationOrganizations(
				getNativeDb(),
				resolved.profile.id,
			);
			updateConversationTitles(resolved.profile);
			results.push({
				profileId: resolved.profile.id,
				externalUserId,
				status: "hit",
				source: fetched.source,
				profile: resolved.profile,
				...(affiliationHydration.checked > 0 ? { affiliationHydration } : {}),
			});
			continue;
		}
		results.push({
			profileId,
			externalUserId,
			status: fetched.status,
			source: fetched.source,
			error: fetched.error,
		});
	}

	return results;
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
