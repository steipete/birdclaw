import type { Database } from "./sqlite";
import { normalizeAvatarUrl } from "./avatar-cache";
import { syncIdentitySearchIndexForProfileIds } from "./identity-search-index";
import { syncProfileBioEntitiesForProfileId } from "./profile-bio-entities";
import { syncProfileAffiliationsFromUser } from "./profile-affiliations";
import { recordProfileSnapshot } from "./profile-history";
import {
	allocateReservedProfileHandle,
	reconcileCanonicalXProfileIdentity,
	repairCanonicalProfileRawIdentity,
} from "./profile-identity";
import { normalizeProfileHandle, profileFromDbRow } from "./profile-row";
import type { ProfileRecord, XurlMentionUser } from "./types";

export interface ResolvedXProfile {
	profile: ProfileRecord;
	externalUserId: string;
}

export interface XProfileIdentityOptions {
	provenLegacyProfileIds?: ReadonlySet<string>;
}

export function buildExternalProfileId(externalUserId: string) {
	if (!/^[0-9]+$/.test(externalUserId)) {
		throw new Error("X user id must be numeric");
	}
	return `profile_user_${externalUserId}`;
}

export function getExternalUserId(profileId: string) {
	const externalUserId = profileId.replace(/^profile_user_/, "");
	if (
		profileId.startsWith("profile_user_") &&
		/^[0-9]+$/.test(externalUserId)
	) {
		return externalUserId;
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
	db: Database,
	profileId: string,
	user: XurlMentionUser,
	storedHandle?: string,
): ResolvedXProfile {
	const username = normalizeProfileHandle(String(user.username ?? ""));
	const profileHandle = storedHandle ?? username;
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
        public_metrics_json = ?,
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
		profileHandle,
		displayName,
		bio,
		followersCount,
		followingCount,
		JSON.stringify(user.public_metrics ?? {}),
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
	syncIdentitySearchIndexForProfileIds(db, [profileId]);

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
		profile: profileFromDbRow(row),
		externalUserId: String(user.id),
	};
}

function upsertProfileFromXUserInTransaction(
	db: Database,
	user: XurlMentionUser,
	options: XProfileIdentityOptions = {},
): ResolvedXProfile {
	const externalUserId = String(user.id ?? "");
	if (!/^[0-9]+$/.test(externalUserId)) {
		throw new Error(
			externalUserId
				? "Resolved user id must be numeric"
				: "Resolved user is missing an id",
		);
	}

	const username = normalizeProfileHandle(String(user.username ?? ""));
	if (!username) {
		throw new Error("Resolved user is missing a username");
	}

	const profileId = buildExternalProfileId(externalUserId);
	const reconciliation = reconcileCanonicalXProfileIdentity({
		db,
		externalUserId,
		canonicalProfileId: profileId,
		incomingHandle: username,
		provenLegacyProfileIds: options.provenLegacyProfileIds,
	});
	const storedHandle =
		reconciliation.blockedHandleProfileIds.length > 0
			? allocateReservedProfileHandle(db, profileId)
			: username;
	const existingRow = db
		.prepare(
			`
      select id
      from profiles
      where id = ?
      limit 1
      `,
		)
		.get(profileId) as { id: string } | undefined;

	if (existingRow) {
		return updateExistingProfileFromUser(
			db,
			existingRow.id,
			user,
			storedHandle,
		);
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
      public_metrics_json, avatar_url, location, url, verified_type, entities_json,
      raw_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set
	      handle = excluded.handle,
	      display_name = excluded.display_name,
	      bio = excluded.bio,
	      followers_count = excluded.followers_count,
	      public_metrics_json = excluded.public_metrics_json,
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
		storedHandle,
		displayName,
		bio,
		followersCount,
		followingCount ?? 0,
		avatarHue,
		JSON.stringify(user.public_metrics ?? {}),
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
	syncIdentitySearchIndexForProfileIds(db, [profileId]);

	return {
		profile: {
			id: profileId,
			handle: storedHandle,
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

export function upsertProfileFromXUser(
	db: Database,
	user: XurlMentionUser,
	options: XProfileIdentityOptions = {},
): ResolvedXProfile {
	return db.transaction(() =>
		upsertProfileFromXUserInTransaction(db, user, options),
	)();
}

export function canonicalizeProvenXProfileIdentity(
	db: Database,
	externalUserId: string,
	username: string,
	options: { provenLegacyProfileIds?: ReadonlySet<string> } = {},
) {
	const canonicalProfileId = buildExternalProfileId(externalUserId);
	return reconcileCanonicalXProfileIdentity({
		db,
		externalUserId,
		canonicalProfileId,
		incomingHandle: normalizeProfileHandle(username),
		provenLegacyProfileIds: options.provenLegacyProfileIds,
	});
}

export function upsertSparseProfileFromXUser(
	db: Database,
	user: Pick<XurlMentionUser, "id"> &
		Partial<Pick<XurlMentionUser, "username" | "name" | "profile_image_url">>,
	options: XProfileIdentityOptions = {},
): ResolvedXProfile {
	return db.transaction(() => {
		const externalUserId = String(user.id ?? "");
		if (!/^[0-9]+$/.test(externalUserId)) {
			throw new Error("Sparse X user id must be numeric");
		}
		const username = normalizeProfileHandle(String(user.username ?? ""));
		const profileId = buildExternalProfileId(externalUserId);
		const avatarUrl = normalizeAvatarUrl(user.profile_image_url);
		const reconciliation = reconcileCanonicalXProfileIdentity({
			db,
			externalUserId,
			canonicalProfileId: profileId,
			incomingHandle: username,
			provenLegacyProfileIds: options.provenLegacyProfileIds,
		});
		const storedHandle =
			reconciliation.blockedHandleProfileIds.length > 0
				? allocateReservedProfileHandle(db, profileId)
				: username;
		let resolved = canonicalizeOrCreateStubProfileInTransaction(
			db,
			externalUserId,
		);
		const current = db
			.prepare(
				`select handle, display_name, avatar_url
				 from profiles where id = ?`,
			)
			.get(profileId) as {
			handle: string;
			display_name: string;
			avatar_url: string | null;
		};
		const incomingName = String(user.name ?? "").trim();
		const placeholderDisplayName =
			!current.display_name ||
			current.display_name === current.handle ||
			current.display_name.startsWith("birdclaw_stub_");
		const displayName =
			incomingName && (username || placeholderDisplayName)
				? incomingName
				: username && placeholderDisplayName
					? username
					: undefined;
		const handleChanged = Boolean(username && current.handle !== storedHandle);
		const nameChanged = Boolean(
			displayName && current.display_name !== displayName,
		);
		const avatarChanged = Boolean(
			avatarUrl && current.avatar_url !== avatarUrl,
		);
		const profileChanged = handleChanged || nameChanged || avatarChanged;
		if (profileChanged) {
			recordProfileSnapshot(db, profileId, "pre_sparse_update");
			db.prepare(
				`update profiles set
				 handle = case when ? <> '' then ? else handle end,
				 display_name = case when ? = 1 then ? else display_name end,
				 avatar_url = coalesce(?, avatar_url)
				 where id = ?`,
			).run(
				username,
				storedHandle,
				nameChanged ? 1 : 0,
				displayName ?? "",
				avatarUrl,
				profileId,
			);
		}
		if (username) {
			reconcileCanonicalXProfileIdentity({
				db,
				externalUserId,
				canonicalProfileId: profileId,
				incomingHandle: username,
			});
		}
		repairCanonicalProfileRawIdentity(db, profileId, externalUserId, username);
		if (profileChanged) {
			recordProfileSnapshot(db, profileId, "sparse_profile");
			syncIdentitySearchIndexForProfileIds(db, [profileId]);
			const row = db
				.prepare(
					`select id, handle, display_name, bio, followers_count, following_count,
					 avatar_hue, avatar_url, location, url, verified_type, entities_json,
					 created_at from profiles where id = ?`,
				)
				.get(profileId) as Record<string, unknown>;
			resolved = { profile: profileFromDbRow(row), externalUserId };
		}
		return resolved;
	})();
}

export function ensureStubProfileForXUser(
	db: Database,
	externalUserId: string,
): ResolvedXProfile {
	return db.transaction(() =>
		canonicalizeOrCreateStubProfileInTransaction(db, externalUserId),
	)();
}

function canonicalizeOrCreateStubProfileInTransaction(
	db: Database,
	externalUserId: string,
): ResolvedXProfile {
	const profileId = buildExternalProfileId(externalUserId);
	reconcileCanonicalXProfileIdentity({
		db,
		externalUserId,
		canonicalProfileId: profileId,
		incomingHandle: "",
	});
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
			profile: profileFromDbRow(existingRow),
			externalUserId,
		};
	}

	const handle = allocateReservedProfileHandle(db, profileId);
	const createdAt = new Date().toISOString();
	const avatarHue = randomAvatarHue(handle);
	db.prepare(
		`
    insert into profiles (
      id, handle, display_name, bio, followers_count, following_count, avatar_hue,
		avatar_url, location, url, verified_type, entities_json, raw_json, created_at
	) values (?, ?, ?, '', 0, 0, ?, null, null, null, null, '{}', ?, ?)
    `,
	).run(
		profileId,
		handle,
		handle,
		avatarHue,
		JSON.stringify({ id: externalUserId }),
		createdAt,
	);

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
