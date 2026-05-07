import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { fetchProfileAffiliations } from "./profile-affiliations";
import type { ProfileSnapshot } from "./types";

function stableJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableJson).join(",")}]`;
	}
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function snapshotHash(value: unknown) {
	return createHash("sha1").update(stableJson(value)).digest("hex");
}

function parseJsonArray(value: unknown) {
	if (typeof value !== "string" || value.length === 0) {
		return [];
	}
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function toSnapshot(row: Record<string, unknown>): ProfileSnapshot {
	return {
		profileId: String(row.profile_id),
		snapshotHash: String(row.snapshot_hash),
		observedAt: String(row.observed_at),
		lastSeenAt: String(row.last_seen_at),
		source: String(row.source),
		handle: String(row.handle),
		displayName: String(row.display_name),
		bio: String(row.bio),
		location:
			typeof row.location === "string" && row.location.length > 0
				? row.location
				: null,
		url: typeof row.url === "string" && row.url.length > 0 ? row.url : null,
		verifiedType:
			typeof row.verified_type === "string" && row.verified_type.length > 0
				? row.verified_type
				: null,
		followersCount: Number(row.followers_count ?? 0),
		followingCount: Number(row.following_count ?? 0),
		affiliations: parseJsonArray(row.affiliations_json),
	};
}

export function recordProfileSnapshot(
	db: Database.Database,
	profileId: string,
	source = "x_profile",
) {
	const profile = db
		.prepare(
			`
      select id, handle, display_name, bio, location, url, verified_type,
        followers_count, following_count, raw_json
      from profiles
      where id = ?
      `,
		)
		.get(profileId) as Record<string, unknown> | undefined;
	if (!profile) {
		return null;
	}

	const affiliations =
		fetchProfileAffiliations(db, [profileId]).get(profileId) ?? [];
	const snapshot = {
		handle: String(profile.handle),
		displayName: String(profile.display_name),
		bio: String(profile.bio),
		location: profile.location ?? null,
		url: profile.url ?? null,
		verifiedType: profile.verified_type ?? null,
		followersCount: Number(profile.followers_count ?? 0),
		followingCount: Number(profile.following_count ?? 0),
		affiliations: affiliations.map((affiliation) => ({
			organizationProfileId: affiliation.organizationProfileId,
			organizationName: affiliation.organizationName ?? null,
			organizationHandle: affiliation.organizationHandle ?? null,
			url: affiliation.url ?? null,
			label: affiliation.label ?? null,
		})),
	};
	const hash = snapshotHash(snapshot);
	const now = new Date().toISOString();

	db.prepare(
		`
    insert into profile_snapshots (
      profile_id, snapshot_hash, observed_at, last_seen_at, source, handle,
      display_name, bio, location, url, verified_type, followers_count,
      following_count, affiliations_json, raw_json
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(profile_id, snapshot_hash) do update set
      last_seen_at = excluded.last_seen_at,
      source = excluded.source,
      raw_json = excluded.raw_json
    `,
	).run(
		profileId,
		hash,
		now,
		now,
		source,
		snapshot.handle,
		snapshot.displayName,
		snapshot.bio,
		snapshot.location,
		snapshot.url,
		snapshot.verifiedType,
		snapshot.followersCount,
		snapshot.followingCount,
		JSON.stringify(snapshot.affiliations),
		typeof profile.raw_json === "string" ? profile.raw_json : "{}",
	);

	return hash;
}

export function fetchProfileSnapshots(
	db: Database.Database,
	profileIds: string[],
	limitPerProfile = 5,
) {
	if (profileIds.length === 0) {
		return new Map<string, ProfileSnapshot[]>();
	}
	const placeholders = profileIds.map(() => "?").join(",");
	const rows = db
		.prepare(
			`
      select *
      from profile_snapshots
      where profile_id in (${placeholders})
      order by profile_id, last_seen_at desc
      `,
		)
		.all(...profileIds) as Array<Record<string, unknown>>;
	const result = new Map<string, ProfileSnapshot[]>();
	for (const row of rows) {
		const snapshot = toSnapshot(row);
		const existing = result.get(snapshot.profileId) ?? [];
		if (existing.length < limitPerProfile) {
			existing.push(snapshot);
			result.set(snapshot.profileId, existing);
		}
	}
	return result;
}
