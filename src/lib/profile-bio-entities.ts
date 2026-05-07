import type Database from "better-sqlite3";
import { fetchProfileAffiliations } from "./profile-affiliations";
import type { ProfileBioEntity, ProfileRecord } from "./types";

interface ExtractedBioEntity {
	kind: ProfileBioEntity["kind"];
	value: string;
	source: string;
	raw: Record<string, unknown>;
}

const HANDLE_RE = /(^|[^\w])@([A-Za-z0-9_]{1,15})\b/g;
const DOMAIN_RE =
	/\b(?:https?:\/\/)?(?:www\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)\b/gi;
const COMPANY_RE =
	/\b(?:at|with|for|building|founder at|cofounder at|co-founder at|working on)\s+(@[A-Za-z0-9_]{1,15}|[A-Z][A-Za-z0-9&.+ -]{2,48})/g;

function normalizeDomain(value: string) {
	try {
		const url = value.startsWith("http")
			? new URL(value)
			: new URL(`https://${value}`);
		return url.hostname.replace(/^www\./, "").toLowerCase();
	} catch {
		return value.replace(/^www\./, "").toLowerCase();
	}
}

function addEntity(
	entities: Map<string, ExtractedBioEntity>,
	entity: ExtractedBioEntity,
) {
	const key = `${entity.kind}:${entity.value.toLowerCase()}`;
	if (!entities.has(key)) {
		entities.set(key, entity);
	}
}

function addHandleDerivedCompany(
	entities: Map<string, ExtractedBioEntity>,
	handle: string,
	source: string,
) {
	const cleaned = handle.replace(/^@/, "").trim();
	if (cleaned.length < 3) {
		return;
	}
	addEntity(entities, {
		kind: "company_phrase",
		value: cleaned,
		source,
		raw: { handle },
	});
}

function getUrlEntityExpandedUrls(profile: ProfileRecord) {
	const urls: string[] = [];
	for (const key of ["url", "description"] as const) {
		const block = profile.entities?.[key];
		if (!block || typeof block !== "object") {
			continue;
		}
		const entries = (block as { urls?: unknown }).urls;
		if (!Array.isArray(entries)) {
			continue;
		}
		for (const entry of entries) {
			if (!entry || typeof entry !== "object") {
				continue;
			}
			const record = entry as Record<string, unknown>;
			const expanded = record.expandedUrl ?? record.expanded_url ?? record.url;
			if (typeof expanded === "string" && expanded.length > 0) {
				urls.push(expanded);
			}
		}
	}
	return urls;
}

export function extractProfileBioEntities(profile: ProfileRecord) {
	const entities = new Map<string, ExtractedBioEntity>();
	const bio = profile.bio ?? "";

	for (const match of bio.matchAll(HANDLE_RE)) {
		const handle = `@${match[2]}`;
		addEntity(entities, {
			kind: "handle",
			value: handle,
			source: "bio",
			raw: { match: match[0].trim() },
		});
		addHandleDerivedCompany(entities, handle, "bio_handle");
	}

	for (const match of bio.matchAll(DOMAIN_RE)) {
		addEntity(entities, {
			kind: "domain",
			value: normalizeDomain(match[1] ?? match[0]),
			source: "bio",
			raw: { match: match[0] },
		});
	}

	for (const match of bio.matchAll(COMPANY_RE)) {
		const phrase = match[1]?.trim();
		if (!phrase) {
			continue;
		}
		addEntity(entities, {
			kind: phrase.startsWith("@") ? "handle" : "company_phrase",
			value: phrase,
			source: "bio_phrase",
			raw: { match: match[0] },
		});
		if (phrase.startsWith("@")) {
			addHandleDerivedCompany(entities, phrase, "bio_phrase");
		}
	}

	for (const url of [profile.url, ...getUrlEntityExpandedUrls(profile)]) {
		if (!url) {
			continue;
		}
		addEntity(entities, {
			kind: "domain",
			value: normalizeDomain(url),
			source: "profile_url",
			raw: { url },
		});
	}

	for (const affiliation of profile.affiliations ?? []) {
		if (affiliation.organizationName) {
			addEntity(entities, {
				kind: "company_phrase",
				value: affiliation.organizationName,
				source: "affiliation",
				raw: { organizationProfileId: affiliation.organizationProfileId },
			});
		}
		if (affiliation.organizationHandle) {
			const handle = `@${affiliation.organizationHandle.replace(/^@/, "")}`;
			addEntity(entities, {
				kind: "handle",
				value: handle,
				source: "affiliation",
				raw: { organizationProfileId: affiliation.organizationProfileId },
			});
			addHandleDerivedCompany(entities, handle, "affiliation");
		}
		if (affiliation.url) {
			addEntity(entities, {
				kind: "domain",
				value: normalizeDomain(affiliation.url),
				source: "affiliation",
				raw: { organizationProfileId: affiliation.organizationProfileId },
			});
		}
	}

	return [...entities.values()];
}

function getProfileRecord(
	db: Database.Database,
	profileId: string,
): ProfileRecord | null {
	const row = db
		.prepare(
			`
      select id, handle, display_name, bio, followers_count, following_count,
        avatar_hue, avatar_url, location, url, verified_type, entities_json, created_at
      from profiles
      where id = ?
      `,
		)
		.get(profileId) as Record<string, unknown> | undefined;
	if (!row) {
		return null;
	}
	let parsedEntities: Record<string, unknown> | undefined;
	if (typeof row.entities_json === "string" && row.entities_json.length > 0) {
		try {
			const parsed = JSON.parse(row.entities_json) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				parsedEntities = parsed as Record<string, unknown>;
			}
		} catch {
			parsedEntities = undefined;
		}
	}
	const profile: ProfileRecord = {
		id: String(row.id),
		handle: String(row.handle),
		displayName: String(row.display_name),
		bio: String(row.bio),
		followersCount: Number(row.followers_count ?? 0),
		followingCount: Number(row.following_count ?? 0),
		avatarHue: Number(row.avatar_hue ?? 0),
		...(typeof row.avatar_url === "string"
			? { avatarUrl: String(row.avatar_url) }
			: {}),
		...(typeof row.location === "string" && row.location.length > 0
			? { location: row.location }
			: {}),
		...(typeof row.url === "string" && row.url.length > 0
			? { url: row.url }
			: {}),
		...(typeof row.verified_type === "string" && row.verified_type.length > 0
			? { verifiedType: row.verified_type }
			: {}),
		...(parsedEntities ? { entities: parsedEntities } : {}),
		createdAt: String(row.created_at),
	};
	const affiliations = fetchProfileAffiliations(db, [profileId]).get(profileId);
	return affiliations && affiliations.length > 0
		? { ...profile, affiliations, primaryAffiliation: affiliations[0] }
		: profile;
}

export function syncProfileBioEntitiesForProfileId(
	db: Database.Database,
	profileId: string,
) {
	const profile = getProfileRecord(db, profileId);
	if (!profile) {
		return [];
	}
	const entities = extractProfileBioEntities(profile);
	const now = new Date().toISOString();
	const seen = new Set(
		entities.map((entity) => `${entity.kind}:${entity.value}`),
	);
	const insert = db.prepare(
		`
    insert into profile_bio_entities (
      profile_id, kind, value, source, is_active, first_seen_at, last_seen_at, raw_json
    ) values (?, ?, ?, ?, 1, ?, ?, ?)
    on conflict(profile_id, kind, value) do update set
      source = excluded.source,
      is_active = 1,
      last_seen_at = excluded.last_seen_at,
      raw_json = excluded.raw_json
    `,
	);

	for (const entity of entities) {
		insert.run(
			profileId,
			entity.kind,
			entity.value,
			entity.source,
			now,
			now,
			JSON.stringify(entity.raw),
		);
	}

	const existingRows = db
		.prepare(
			`
      select kind, value
      from profile_bio_entities
      where profile_id = ?
      `,
		)
		.all(profileId) as Array<{ kind: string; value: string }>;
	const deactivate = db.prepare(
		`
    update profile_bio_entities
    set is_active = 0, last_seen_at = ?
    where profile_id = ? and kind = ? and value = ?
    `,
	);
	for (const row of existingRows) {
		if (!seen.has(`${row.kind}:${row.value}`)) {
			deactivate.run(now, profileId, row.kind, row.value);
		}
	}

	return entities;
}

export function fetchProfileBioEntities(
	db: Database.Database,
	profileIds: string[],
) {
	if (profileIds.length === 0) {
		return new Map<string, ProfileBioEntity[]>();
	}
	const placeholders = profileIds.map(() => "?").join(",");
	const rows = db
		.prepare(
			`
      select profile_id, kind, value, source, is_active, first_seen_at, last_seen_at
      from profile_bio_entities
      where profile_id in (${placeholders})
        and is_active = 1
      order by profile_id, kind, value
      `,
		)
		.all(...profileIds) as Array<Record<string, unknown>>;
	const result = new Map<string, ProfileBioEntity[]>();
	for (const row of rows) {
		const profileId = String(row.profile_id);
		const entity: ProfileBioEntity = {
			profileId,
			kind: row.kind as ProfileBioEntity["kind"],
			value: String(row.value),
			source: String(row.source),
			firstSeenAt: String(row.first_seen_at),
			lastSeenAt: String(row.last_seen_at),
			isActive: Boolean(row.is_active),
		};
		const existing = result.get(profileId) ?? [];
		existing.push(entity);
		result.set(profileId, existing);
	}
	return result;
}
