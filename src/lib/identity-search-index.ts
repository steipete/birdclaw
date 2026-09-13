import type { Database } from "./sqlite";
import { fetchProfileAffiliations } from "./profile-affiliations";
import { fetchProfileBioEntities } from "./profile-bio-entities";
import { fetchProfileSnapshots } from "./profile-history";
import { profileEntityUrls, profileFromDbRow } from "./profile-row";
import type { ProfileRecord } from "./types";

interface IdentityIndexEntry {
	profileId: string;
	kind: string;
	value: string;
	source: string;
	weight: number;
}

const KIND_WEIGHTS: Record<string, number> = {
	affiliation: 90,
	bio_handle: 75,
	bio_company: 65,
	profile_history: 55,
	profile_handle: 45,
	profile_name: 35,
	profile_bio: 35,
	profile_location: 20,
	profile_verified_type: 15,
	profile_bio_url: 12,
	profile_url: 10,
	bio_domain: 8,
};

function normalizeIndexValue(value: string) {
	return value.trim().toLowerCase();
}

function addEntry(
	entries: Map<string, IdentityIndexEntry>,
	entry: Omit<IdentityIndexEntry, "weight"> & { weight?: number },
) {
	const value = entry.value.trim();
	if (!value) {
		return;
	}
	const key = `${entry.profileId}:${entry.kind}:${entry.source}:${value.toLowerCase()}`;
	if (!entries.has(key)) {
		entries.set(key, {
			...entry,
			value,
			weight: entry.weight ?? KIND_WEIGHTS[entry.kind] ?? 10,
		});
	}
}

function collectProfileEntries(
	profile: ProfileRecord,
): Map<string, IdentityIndexEntry> {
	const entries = new Map<string, IdentityIndexEntry>();
	const fields = {
		profile_handle: profile.handle,
		profile_name: profile.displayName,
		profile_bio: profile.bio,
		profile_location: profile.location,
		profile_url: profile.url,
		profile_verified_type: profile.verifiedType,
	};
	for (const [kind, value] of Object.entries(fields)) {
		if (value)
			addEntry(entries, {
				profileId: profile.id,
				kind,
				value,
				source: "profile",
			});
	}
	for (const url of profileEntityUrls(profile, "description")) {
		addEntry(entries, {
			profileId: profile.id,
			kind: "profile_bio_url",
			value: url,
			source: "profile",
		});
	}
	return entries;
}

function addAffiliationEntries(
	entries: Map<string, IdentityIndexEntry>,
	profileId: string,
	values: Array<string | null | undefined>,
	source = "affiliation",
) {
	for (const value of values) {
		if (!value) {
			continue;
		}
		addEntry(entries, {
			profileId,
			kind: "affiliation",
			value,
			source,
		});
	}
}

export function syncIdentitySearchIndexForProfileIds(
	db: Database,
	profileIds: string[],
) {
	const uniqueProfileIds = Array.from(new Set(profileIds)).filter(Boolean);
	if (uniqueProfileIds.length === 0) {
		return { profiles: 0, entries: 0 };
	}

	const placeholders = uniqueProfileIds.map(() => "?").join(",");
	const rows = db
		.prepare(
			`
      select id, handle, display_name, bio, followers_count, following_count,
        avatar_hue, avatar_url, location, url, verified_type, entities_json, created_at
      from profiles
      where id in (${placeholders})
      `,
		)
		.all(...uniqueProfileIds) as Array<Record<string, unknown>>;
	const profiles = rows.map((row) => profileFromDbRow(row));
	const affiliationsByProfile = fetchProfileAffiliations(db, uniqueProfileIds);
	const bioEntitiesByProfile = fetchProfileBioEntities(db, uniqueProfileIds);
	const snapshotsByProfile = fetchProfileSnapshots(db, uniqueProfileIds);
	const entries = new Map<string, IdentityIndexEntry>();

	for (const profile of profiles) {
		for (const [key, entry] of collectProfileEntries(profile)) {
			entries.set(key, entry);
		}
		for (const affiliation of affiliationsByProfile.get(profile.id) ?? []) {
			addAffiliationEntries(entries, profile.id, [
				affiliation.organizationName,
				affiliation.organizationHandle,
				affiliation.label,
				affiliation.url,
				affiliation.organizationProfileId,
			]);
		}
		for (const entity of bioEntitiesByProfile.get(profile.id) ?? []) {
			addEntry(entries, {
				profileId: profile.id,
				kind:
					entity.kind === "handle"
						? "bio_handle"
						: entity.kind === "domain"
							? "bio_domain"
							: "bio_company",
				value: entity.value,
				source: "bio_entity",
			});
		}
		for (const snapshot of snapshotsByProfile.get(profile.id) ?? []) {
			for (const value of [
				snapshot.handle,
				snapshot.displayName,
				snapshot.bio,
				snapshot.location,
				snapshot.url,
			]) {
				if (!value) continue;
				addEntry(entries, {
					profileId: profile.id,
					kind: "profile_history",
					value,
					source: "history",
				});
			}
			for (const affiliation of snapshot.affiliations) {
				if (!affiliation || typeof affiliation !== "object") {
					continue;
				}
				const record = affiliation as Record<string, unknown>;
				addAffiliationEntries(
					entries,
					profile.id,
					[
						record.organizationName,
						record.organizationHandle,
						record.label,
						record.url,
					].filter((value): value is string => typeof value === "string"),
					"history",
				);
			}
		}
	}

	const now = new Date().toISOString();
	const deleteStatement = db.prepare(
		`delete from identity_search_index where profile_id = ?`,
	);
	const insertStatement = db.prepare(
		`
    insert into identity_search_index (
      profile_id, kind, value, normalized_value, source, weight, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?)
    on conflict(profile_id, kind, value, source) do update set
      normalized_value = excluded.normalized_value,
      weight = excluded.weight,
      updated_at = excluded.updated_at
    `,
	);
	db.transaction(() => {
		for (const profileId of uniqueProfileIds) {
			deleteStatement.run(profileId);
		}
		for (const entry of entries.values()) {
			insertStatement.run(
				entry.profileId,
				entry.kind,
				entry.value,
				normalizeIndexValue(entry.value),
				entry.source,
				entry.weight,
				now,
			);
		}
	})();

	return { profiles: profiles.length, entries: entries.size };
}

export function ensureIdentitySearchIndexForDmProfiles(
	db: Database,
	account?: string,
) {
	const params: string[] = [];
	let accountClause = "";
	if (account && account !== "all") {
		accountClause = "where c.account_id = ?";
		params.push(account);
	}
	const rows = db
		.prepare(
			`
      select distinct c.participant_profile_id as profile_id
      from dm_conversations c
      left join identity_search_index isi
        on isi.profile_id = c.participant_profile_id
      ${accountClause}
      group by c.participant_profile_id
      having count(isi.profile_id) = 0
      `,
		)
		.all(...params) as Array<{ profile_id: string }>;

	return syncIdentitySearchIndexForProfileIds(
		db,
		rows.map((row) => row.profile_id),
	);
}
