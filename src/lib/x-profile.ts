import type Database from "better-sqlite3";
import { normalizeAvatarUrl } from "./avatar-cache";
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
	return {
		id: String(row.id),
		handle: String(row.handle),
		displayName: String(row.display_name),
		bio: String(row.bio),
		followersCount: Number(row.followers_count),
		avatarHue: Number(row.avatar_hue),
		avatarUrl:
			typeof row.avatar_url === "string" ? String(row.avatar_url) : undefined,
		createdAt: String(row.created_at),
	};
}

function updateExistingProfileFromUser(
	db: Database.Database,
	profileId: string,
	user: XurlMentionUser,
): ResolvedXProfile {
	const username = String(user.username ?? "").replace(/^@/, "");
	const displayName = String(user.name ?? username);
	const followersCount = Number(user.public_metrics?.followers_count ?? 0);
	const bio = String(user.description ?? "");
	const avatarUrl = normalizeAvatarUrl(user.profile_image_url);

	db.prepare(
		`
    update profiles
    set handle = ?,
        display_name = ?,
        bio = ?,
        followers_count = ?,
        avatar_url = coalesce(?, avatar_url)
    where id = ?
    `,
	).run(username, displayName, bio, followersCount, avatarUrl, profileId);

	const row = db
		.prepare(
			`
      select id, handle, display_name, bio, followers_count, avatar_hue, avatar_url, created_at
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

	const displayName = String(user.name ?? username);
	const followersCount = Number(user.public_metrics?.followers_count ?? 0);
	const bio = String(user.description ?? "");
	const avatarUrl = normalizeAvatarUrl(user.profile_image_url);
	const createdAt = new Date().toISOString();
	const avatarHue = randomAvatarHue(username);

	db.prepare(
		`
    insert into profiles (
      id, handle, display_name, bio, followers_count, avatar_hue, avatar_url, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set
      handle = excluded.handle,
      display_name = excluded.display_name,
      bio = excluded.bio,
      followers_count = excluded.followers_count,
      avatar_url = coalesce(excluded.avatar_url, profiles.avatar_url)
    `,
	).run(
		profileId,
		username,
		displayName,
		bio,
		followersCount,
		avatarHue,
		avatarUrl,
		createdAt,
	);

	return {
		profile: {
			id: profileId,
			handle: username,
			displayName,
			bio,
			followersCount,
			avatarHue,
			avatarUrl: avatarUrl ?? undefined,
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
      select id, handle, display_name, bio, followers_count, avatar_hue, avatar_url, created_at
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
      id, handle, display_name, bio, followers_count, avatar_hue, avatar_url, created_at
    ) values (?, ?, ?, '', 0, ?, null, ?)
    `,
	).run(profileId, handle, handle, avatarHue, createdAt);

	return {
		profile: {
			id: profileId,
			handle,
			displayName: handle,
			bio: "",
			followersCount: 0,
			avatarHue,
			createdAt,
		},
		externalUserId,
	};
}
