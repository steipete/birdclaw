import type Database from "better-sqlite3";
import { normalizeAvatarUrl } from "./avatar-cache";
import { syncProfileBioEntitiesForProfileId } from "./profile-bio-entities";
import { syncProfileAffiliationsFromUser } from "./profile-affiliations";
import { recordProfileSnapshot } from "./profile-history";
import type { ProfileRecord, XurlMentionUser } from "./types";

export interface ResolvedXProfile {
	profile: ProfileRecord;
	externalUserId: string;
}

export function buildExternalProfileId(externalUserId: string) {
	return `profile_user_${externalUserId}`;
}

export function getExternalUserId(profileId: string) {
	if (profileId.startsWith("profile_user_")) {
		return profileId.replace(/^profile_user_/, "");
	}
	return null;
}

export function randomAvatarHue(input: string) {
	return (
		input
			.split("")
			.reduce((sum, character) => sum + character.charCodeAt(0), 0) % 360
	);
}

function toProfile(row: Record<string, unknown>): ProfileRecord {
	const followingCount = Number(row.following_count ?? 0);
	const entities = parseJsonRecord(row.entities_json);
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

function parseJsonRecord(value: unknown) {
	if (typeof value !== "string" || value.length === 0) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function getString(value: unknown) {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function getExpandedUrlFromEntities(
	entities: Record<string, unknown> | undefined,
	key: "url" | "description",
) {
	const block = entities?.[key];
	if (!block || typeof block !== "object") {
		return undefined;
	}
	const urls = (block as { urls?: unknown }).urls;
	if (!Array.isArray(urls)) {
		return undefined;
	}
	for (const entry of urls) {
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const record = entry as Record<string, unknown>;
		const expanded =
			getString(record.expandedUrl) ?? getString(record.expanded_url);
		if (expanded) {
			return expanded;
		}
	}
	return undefined;
}

function normalizeVerifiedType(user: XurlMentionUser) {
	const verifiedType = getString(user.verified_type);
	if (verifiedType) {
		return verifiedType.toLowerCase();
	}
	return user.verified ? "verified" : null;
}

function buildProfileMetadata(user: XurlMentionUser) {
	const entities = user.entities;
	const url =
		getExpandedUrlFromEntities(entities, "url") ?? getString(user.url);
	return {
		location: getString(user.location) ?? null,
		url: url ?? null,
		verifiedType: normalizeVerifiedType(user),
		entitiesJson: JSON.stringify(entities ?? {}),
		rawJson: JSON.stringify(user),
	};
}

function updateExistingProfileFromUser(
	db: Database.Database,
	profileId: string,
	user: XurlMentionUser,
): ResolvedXProfile {
	const username = String(user.username ?? "").replace(/^@/, "");
	const displayName = String(user.name ?? "").trim() || username;
	const followersCount = Number(user.public_metrics?.followers_count ?? 0);
	const hasFollowingCount =
		typeof user.public_metrics?.following_count === "number";
	const followingCount = hasFollowingCount
		? (user.public_metrics?.following_count ?? null)
		: null;
	const bio = String(user.description ?? "");
	const avatarUrl = normalizeAvatarUrl(user.profile_image_url);
	const metadata = buildProfileMetadata(user);

	recordProfileSnapshot(db, profileId, "pre_update");
	db.prepare(
		`
    update profiles
    set handle = ?,
        display_name = ?,
        bio = ?,
        followers_count = ?,
        following_count = coalesce(?, following_count),
        avatar_url = coalesce(?, avatar_url),
        location = coalesce(?, location),
        url = coalesce(?, url),
        verified_type = coalesce(?, verified_type),
        entities_json = case
          when ? not in ('', '{}', 'null') then ?
          else profiles.entities_json
        end,
        raw_json = ?
    where id = ?
    `,
	).run(
		username,
		displayName,
		bio,
		followersCount,
		followingCount,
		avatarUrl,
		metadata.location,
		metadata.url,
		metadata.verifiedType,
		metadata.entitiesJson,
		metadata.entitiesJson,
		metadata.rawJson,
		profileId,
	);
	syncProfileAffiliationsFromUser(db, profileId, user);
	recordProfileSnapshot(db, profileId, "x_profile");
	syncProfileBioEntitiesForProfileId(db, profileId);

	const row = db
		.prepare(
			`
      select id, handle, display_name, bio, followers_count, following_count, avatar_hue, avatar_url,
        location, url, verified_type, entities_json, created_at
      from profiles
      where id = ?
      `,
		)
		.get(profileId) as Record<string, unknown>;

	return {
		profile: toProfile(row),
		externalUserId: String(user.id),
	};
}

export function upsertProfileFromXUser(
	db: Database.Database,
	user: XurlMentionUser,
): ResolvedXProfile {
	const externalUserId = String(user.id ?? "");
	if (!externalUserId) {
		throw new Error("Resolved user is missing an id");
	}

	const username = String(user.username ?? "").replace(/^@/, "");
	if (!username) {
		throw new Error("Resolved user is missing a username");
	}

	const profileId = buildExternalProfileId(externalUserId);
	const existingRow = db
		.prepare(
			`
      select id
      from profiles
      where id = ? or handle = ?
      limit 1
      `,
		)
		.get(profileId, username) as { id: string } | undefined;

	if (existingRow) {
		return updateExistingProfileFromUser(db, existingRow.id, user);
	}

	const displayName = String(user.name ?? "").trim() || username;
	const followersCount = Number(user.public_metrics?.followers_count ?? 0);
	const hasFollowingCount =
		typeof user.public_metrics?.following_count === "number";
	const followingCount = hasFollowingCount
		? (user.public_metrics?.following_count ?? null)
		: null;
	const bio = String(user.description ?? "");
	const avatarUrl = normalizeAvatarUrl(user.profile_image_url);
	const metadata = buildProfileMetadata(user);
	const createdAt = new Date().toISOString();
	const avatarHue = randomAvatarHue(username);

	db.prepare(
		`
    insert into profiles (
      id, handle, display_name, bio, followers_count, following_count, avatar_hue,
      avatar_url, location, url, verified_type, entities_json, raw_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set
	      handle = excluded.handle,
	      display_name = excluded.display_name,
	      bio = excluded.bio,
	      followers_count = excluded.followers_count,
	      following_count = case
	        when ? then excluded.following_count
	        else profiles.following_count
	      end,
	      avatar_url = coalesce(excluded.avatar_url, profiles.avatar_url),
	      location = coalesce(excluded.location, profiles.location),
	      url = coalesce(excluded.url, profiles.url),
	      verified_type = coalesce(excluded.verified_type, profiles.verified_type),
	      entities_json = case
	        when excluded.entities_json not in ('', '{}', 'null') then excluded.entities_json
	        else profiles.entities_json
	      end,
	      raw_json = excluded.raw_json
    `,
	).run(
		profileId,
		username,
		displayName,
		bio,
		followersCount,
		followingCount ?? 0,
		avatarHue,
		avatarUrl,
		metadata.location,
		metadata.url,
		metadata.verifiedType,
		metadata.entitiesJson,
		metadata.rawJson,
		createdAt,
		hasFollowingCount ? 1 : 0,
	);
	syncProfileAffiliationsFromUser(db, profileId, user);
	recordProfileSnapshot(db, profileId, "x_profile");
	syncProfileBioEntitiesForProfileId(db, profileId);

	return {
		profile: {
			id: profileId,
			handle: username,
			displayName,
			bio,
			followersCount,
			followingCount: followingCount ?? 0,
			avatarHue,
			avatarUrl: avatarUrl ?? undefined,
			...(metadata.location ? { location: metadata.location } : {}),
			...(metadata.url ? { url: metadata.url } : {}),
			...(metadata.verifiedType ? { verifiedType: metadata.verifiedType } : {}),
			...(user.entities ? { entities: user.entities } : {}),
			createdAt,
		},
		externalUserId,
	};
}

export function ensureStubProfileForXUser(
	db: Database.Database,
	externalUserId: string,
): ResolvedXProfile {
	const profileId = buildExternalProfileId(externalUserId);
	const existingRow = db
		.prepare(
			`
      select id, handle, display_name, bio, followers_count, following_count, avatar_hue, avatar_url,
        location, url, verified_type, entities_json, created_at
      from profiles
      where id = ?
      limit 1
      `,
		)
		.get(profileId) as Record<string, unknown> | undefined;

	if (existingRow) {
		return {
			profile: toProfile(existingRow),
			externalUserId,
		};
	}

	const handle = `user_${externalUserId}`;
	const createdAt = new Date().toISOString();
	const avatarHue = randomAvatarHue(handle);
	db.prepare(
		`
    insert into profiles (
      id, handle, display_name, bio, followers_count, following_count, avatar_hue,
      avatar_url, location, url, verified_type, entities_json, raw_json, created_at
    ) values (?, ?, ?, '', 0, 0, ?, null, null, null, null, '{}', '{}', ?)
    `,
	).run(profileId, handle, handle, avatarHue, createdAt);

	return {
		profile: {
			id: profileId,
			handle,
			displayName: handle,
			bio: "",
			followersCount: 0,
			followingCount: 0,
			avatarHue,
			createdAt,
		},
		externalUserId,
	};
}
