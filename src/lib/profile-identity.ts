import { createHash } from "node:crypto";
import type { Database } from "./sqlite";
import { syncIdentitySearchIndexForProfileIds } from "./identity-search-index";
import { syncProfileBioEntitiesForProfileId } from "./profile-bio-entities";
import {
	recordProfileSnapshot,
	rekeyProfileSnapshots,
} from "./profile-history";
import { profileHandleKey } from "./profile-row";

type ProfileRow = {
	id: string;
	handle: string;
	display_name: string;
	bio: string;
	followers_count: number;
	following_count: number;
	public_metrics_json: string;
	avatar_hue: number;
	avatar_url: string | null;
	location: string | null;
	url: string | null;
	verified_type: string | null;
	entities_json: string;
	raw_json: string;
	created_at: string;
};

type ProfileIdentityCollision = Pick<ProfileRow, "id" | "handle" | "raw_json">;

type PortableProfileValue =
	| null
	| boolean
	| number
	| string
	| PortableProfileValue[]
	| { [key: string]: PortableProfileValue };
type PortableProfileRow = Record<string, PortableProfileValue>;

interface SelectedAccountIdentity {
	accountId: string;
	username: string;
	externalUserId?: string;
	isDefault: boolean;
}

export interface BackupLegacyProfileMergePlan {
	profileId: string;
	incomingHandle: string;
	incomingRawJson: string;
	existingRawJson?: string;
	incomingLastSeenAt: string | null;
	selectedAccount?: SelectedAccountIdentity;
	canonicalProfileId?: string;
	externalUserId?: string;
}

const PROFILE_MUTABLE_COLUMNS = [
	"handle",
	"display_name",
	"bio",
	"followers_count",
	"following_count",
	"public_metrics_json",
	"avatar_hue",
	"avatar_url",
	"location",
	"url",
	"verified_type",
	"entities_json",
	"raw_json",
] as const satisfies readonly (keyof ProfileRow)[];

let observeProfileIdentityCandidateCountForTests:
	| ((count: number) => void)
	| undefined;

function parseJsonObject(value: unknown) {
	if (typeof value !== "string" || value.length === 0) return null;
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

export type ProfileRawIdentityEvidence =
	| { kind: "none" }
	| { kind: "consistent"; externalUserId: string }
	| { kind: "contradictory" };

export function getProfileRawIdentityEvidence(
	rawJson: unknown,
): ProfileRawIdentityEvidence {
	const raw = parseJsonObject(rawJson);
	if (!raw) return { kind: "none" };
	const legacy =
		raw.legacy && typeof raw.legacy === "object"
			? (raw.legacy as Record<string, unknown>)
			: null;
	const values = [raw.id, raw.id_str, raw.rest_id, legacy?.id_str]
		.map((value) => {
			if (typeof value === "string" && /^[0-9]+$/.test(value)) {
				return BigInt(value).toString();
			}
			if (
				typeof value === "number" &&
				Number.isSafeInteger(value) &&
				value >= 0
			) {
				return String(value);
			}
			return null;
		})
		.filter((value): value is string => value !== null);
	if (values.length === 0) return { kind: "none" };
	return values.every((value) => value === values[0])
		? { kind: "consistent", externalUserId: values[0]! }
		: { kind: "contradictory" };
}

function provenExternalUserId(rawJson: unknown) {
	const evidence = getProfileRawIdentityEvidence(rawJson);
	return evidence.kind === "consistent" ? evidence.externalUserId : null;
}

function identityConflictIds(rawJson: unknown) {
	const raw = parseJsonObject(rawJson);
	const value = raw?.birdclaw_identity_conflicts;
	return Array.isArray(value)
		? value.filter(
				(item): item is string =>
					typeof item === "string" && /^[0-9]+$/.test(item),
			)
		: [];
}

export function profileIdentityHasConflict(
	rawJson: unknown,
	externalUserId: string,
) {
	return identityConflictIds(rawJson).includes(externalUserId);
}

export function getProvenSelectedAccountLegacyProfileIds(
	db: Database,
	account: SelectedAccountIdentity,
	incomingExternalUserId: string,
) {
	const proven = new Set<string>();
	if (
		account.externalUserId !== incomingExternalUserId ||
		!/^[0-9]+$/u.test(incomingExternalUserId)
	) {
		return proven;
	}
	const rows = db
		.prepare(
			`select id, raw_json from profiles
			 where lower(handle) = lower(?)
			    or (? = 1 and id = 'profile_me')
			 order by case when id = 'profile_me' then 0 else 1 end, id`,
		)
		.all(account.username, account.isDefault ? 1 : 0) as Array<{
		id: string;
		raw_json: string;
	}>;
	for (const row of rows) {
		const canonicalId = canonicalExternalUserId(row.id);
		if (canonicalId) continue;
		const evidence = getProfileRawIdentityEvidence(row.raw_json);
		if (
			evidence.kind === "contradictory" ||
			(evidence.kind === "consistent" &&
				evidence.externalUserId !== incomingExternalUserId) ||
			profileIdentityHasConflict(row.raw_json, incomingExternalUserId)
		) {
			continue;
		}
		proven.add(row.id);
	}
	return proven;
}

export function markProfileIdentityConflict(
	db: Database,
	profileId: string,
	externalUserId: string,
) {
	const row = db
		.prepare("select raw_json from profiles where id = ?")
		.get(profileId) as { raw_json: string } | undefined;
	if (!row) return false;
	const raw = parseJsonObject(row.raw_json) ?? {};
	const conflicts = new Set(identityConflictIds(row.raw_json));
	conflicts.add(externalUserId);
	raw.birdclaw_identity_conflicts = [...conflicts].sort();
	db.prepare("update profiles set raw_json = ? where id = ?").run(
		JSON.stringify(raw),
		profileId,
	);
	return true;
}

function canonicalExternalUserId(profileId: string) {
	return /^profile_user_([0-9]+)$/.exec(profileId)?.[1] ?? null;
}

function meaningfulJson(value: string) {
	return !["", "{}", "[]", "null"].includes(value.trim());
}

function meaningfulProfileRaw(value: string) {
	const raw = parseJsonObject(value);
	if (!raw) return false;
	const copy = { ...raw };
	for (const key of ["id", "id_str", "rest_id", "username"]) delete copy[key];
	if (copy.legacy && typeof copy.legacy === "object") {
		const legacy = { ...(copy.legacy as Record<string, unknown>) };
		delete legacy.id_str;
		if (Object.keys(legacy).length === 0) delete copy.legacy;
		else copy.legacy = legacy;
	}
	return Object.keys(copy).length > 0;
}

function isReservedPlaceholderHandle(handle: string, externalUserId: string) {
	return (
		handle.startsWith("birdclaw_stub_") ||
		handle === `user_${externalUserId}` ||
		handle === `id${externalUserId}`
	);
}

function isReservedBackupMergeHandle(handle: string, externalUserId: string) {
	return (
		isReservedPlaceholderHandle(handle, externalUserId) ||
		handle.startsWith("birdclaw_stale_")
	);
}

function normalizeProfileSnapshotState(row: Record<string, unknown>) {
	return {
		handle: String(row.handle ?? ""),
		displayName: String(row.display_name ?? ""),
		bio: String(row.bio ?? ""),
		location: row.location ?? null,
		url: row.url ?? null,
		verifiedType: row.verified_type ?? null,
		followersCount: Number(row.followers_count ?? 0),
		followingCount: Number(row.following_count ?? 0),
	};
}

function profileSnapshotStateKey(row: Record<string, unknown>) {
	return JSON.stringify(normalizeProfileSnapshotState(row));
}

function liveProfileStateLastSeenAt(
	db: Database,
	profileId: string,
	row: Record<string, unknown>,
) {
	const state = normalizeProfileSnapshotState(row);
	const match = db
		.prepare(
			`select max(last_seen_at) as last_seen_at
			 from profile_snapshots
			 where profile_id = ?
			   and handle = ?
			   and display_name = ?
			   and bio = ?
			   and location is ?
			   and url is ?
			   and verified_type is ?
			   and followers_count = ?
			   and following_count = ?`,
		)
		.get(
			profileId,
			state.handle,
			state.displayName,
			state.bio,
			state.location,
			state.url,
			state.verifiedType,
			state.followersCount,
			state.followingCount,
		) as { last_seen_at: string | null } | undefined;
	return match?.last_seen_at ?? null;
}

function indexImportedProfileSnapshotRecency(
	rows: readonly Record<string, unknown>[],
) {
	const recency = new Map<string, string>();
	for (const row of rows) {
		if (
			typeof row.profile_id !== "string" ||
			typeof row.last_seen_at !== "string"
		) {
			continue;
		}
		const key = `${row.profile_id}\0${profileSnapshotStateKey(row)}`;
		const current = recency.get(key);
		if (!current || row.last_seen_at > current) {
			recency.set(key, row.last_seen_at);
		}
	}
	return recency;
}

function currentProfileRow(db: Database, profileId: string) {
	return db.prepare("select * from profiles where id = ?").get(profileId) as
		| ProfileRow
		| undefined;
}

function preserveCurrentProfileState(
	incoming: PortableProfileRow,
	current: ProfileRow,
): PortableProfileRow {
	const preserved = { ...incoming };
	for (const column of PROFILE_MUTABLE_COLUMNS) {
		preserved[column] = current[column];
	}
	return preserved;
}

export function reconcileBackupProfileRows({
	db,
	profileRows,
	profileSnapshotRows,
	selectedAccount,
}: {
	db: Database;
	profileRows: readonly PortableProfileRow[];
	profileSnapshotRows: readonly PortableProfileRow[];
	selectedAccount?: SelectedAccountIdentity;
}) {
	const importedSnapshotRecency =
		indexImportedProfileSnapshotRecency(profileSnapshotRows);
	const unavailableHandleKeys = new Set(
		profileRows
			.filter((row) => row.id !== "profile_me")
			.map((row) =>
				typeof row.handle === "string" ? profileHandleKey(row.handle) : "",
			)
			.filter(Boolean),
	);
	const legacyProfileMergePlans: BackupLegacyProfileMergePlan[] = [];
	const rows = profileRows.map((input) => {
		const incoming = { ...input };
		const profileId = typeof incoming.id === "string" ? incoming.id : "";
		const incomingHandle =
			typeof incoming.handle === "string" ? incoming.handle : "";
		if (profileId === "profile_me" && incomingHandle) {
			const existingLegacyProfile = currentProfileRow(db, profileId);
			const externalUserId = selectedAccount?.externalUserId;
			const canonicalProfileId = externalUserId
				? `profile_user_${externalUserId}`
				: undefined;
			const canonicalProfileExists = Boolean(
				canonicalProfileId &&
				(profileRows.some((row) => row.id === canonicalProfileId) ||
					db
						.prepare("select 1 from profiles where id = ?")
						.get(canonicalProfileId)),
			);
			const canProveSelectedAccount = Boolean(
				selectedAccount?.isDefault &&
				externalUserId &&
				/^[0-9]+$/u.test(externalUserId) &&
				canonicalProfileExists &&
				profileHandleKey(selectedAccount.username) ===
					profileHandleKey(incomingHandle),
			);
			legacyProfileMergePlans.push({
				profileId,
				incomingHandle,
				incomingRawJson:
					typeof incoming.raw_json === "string" ? incoming.raw_json : "{}",
				...(existingLegacyProfile
					? { existingRawJson: existingLegacyProfile.raw_json }
					: {}),
				incomingLastSeenAt:
					importedSnapshotRecency.get(
						`${profileId}\0${profileSnapshotStateKey(incoming)}`,
					) ?? null,
				...(canProveSelectedAccount &&
				selectedAccount &&
				externalUserId &&
				canonicalProfileId
					? {
							selectedAccount,
							externalUserId,
							canonicalProfileId,
						}
					: {}),
			});

			const handleCollision = Boolean(
				unavailableHandleKeys.has(profileHandleKey(incomingHandle)) ||
				db
					.prepare(
						"select 1 from profiles where lower(handle) = lower(?) and id <> ?",
					)
					.get(incomingHandle, profileId),
			);
			if (handleCollision) {
				incoming["handle"] = allocateReservedProfileHandle(
					db,
					profileId,
					"stale",
					unavailableHandleKeys,
				);
			}
			unavailableHandleKeys.add(profileHandleKey(String(incoming["handle"])));
			return incoming;
		}

		const externalUserId = canonicalExternalUserId(profileId);
		if (!externalUserId || !incomingHandle) return incoming;

		const current = currentProfileRow(db, profileId);
		const incomingLastSeenAt = importedSnapshotRecency.get(
			`${profileId}\0${profileSnapshotStateKey(incoming)}`,
		);
		const currentLastSeenAt = current
			? liveProfileStateLastSeenAt(db, profileId, current)
			: null;
		const currentIsPlaceholder = Boolean(
			current && isReservedBackupMergeHandle(current.handle, externalUserId),
		);
		const incomingIsNewer = Boolean(
			!current ||
			currentIsPlaceholder ||
			(incomingLastSeenAt &&
				(!currentLastSeenAt || incomingLastSeenAt > currentLastSeenAt)),
		);
		if (!incomingIsNewer && current) {
			return preserveCurrentProfileState(incoming, current);
		}

		const reconciliation = reconcileCanonicalXProfileIdentity({
			db,
			externalUserId,
			canonicalProfileId: profileId,
			incomingHandle,
			canReassignHandleCollision: (collision) => {
				const collisionRow = currentProfileRow(db, collision.id);
				const collisionLastSeenAt = collisionRow
					? liveProfileStateLastSeenAt(db, collision.id, collisionRow)
					: null;
				return Boolean(
					incomingLastSeenAt &&
					(!collisionLastSeenAt || incomingLastSeenAt > collisionLastSeenAt),
				);
			},
		});
		const handle =
			reconciliation.blockedHandleProfileIds.length === 0
				? incomingHandle
				: (current?.handle ?? allocateReservedProfileHandle(db, profileId));
		incoming["handle"] = handle;
		incoming["raw_json"] = repairRawIdentity(
			typeof incoming.raw_json === "string" ? incoming.raw_json : "{}",
			externalUserId,
			handle,
		);
		return incoming;
	});
	return { rows, legacyProfileMergePlans };
}

export function finalizeBackupProfileRows({
	db,
	legacyProfileMergePlans,
}: {
	db: Database;
	legacyProfileMergePlans: readonly BackupLegacyProfileMergePlan[];
}) {
	for (const plan of legacyProfileMergePlans) {
		const { selectedAccount, externalUserId, canonicalProfileId, profileId } =
			plan;
		const proven = Boolean(
			selectedAccount &&
			externalUserId &&
			canonicalProfileId &&
			!profileRawIdentityVetoesExternalUserId(
				plan.incomingRawJson,
				externalUserId,
			) &&
			(!plan.existingRawJson ||
				!profileRawIdentityVetoesExternalUserId(
					plan.existingRawJson,
					externalUserId,
				)) &&
			getProvenSelectedAccountLegacyProfileIds(
				db,
				selectedAccount,
				externalUserId,
			).has(profileId),
		);
		if (!proven || !selectedAccount || !externalUserId || !canonicalProfileId) {
			if (db.prepare("select 1 from profiles where id = ?").get(profileId)) {
				syncIdentitySearchIndexForProfileIds(db, [profileId]);
			}
			continue;
		}

		const current = currentProfileRow(db, canonicalProfileId);
		const currentLastSeenAt = current
			? liveProfileStateLastSeenAt(db, canonicalProfileId, current)
			: null;
		const preserveCanonicalMutableState = Boolean(
			current &&
			!isReservedBackupMergeHandle(current.handle, externalUserId) &&
			plan.incomingLastSeenAt &&
			currentLastSeenAt &&
			plan.incomingLastSeenAt <= currentLastSeenAt,
		);
		reconcileCanonicalXProfileIdentity({
			db,
			externalUserId,
			canonicalProfileId,
			incomingHandle: selectedAccount.username,
			provenLegacyProfileIds: new Set([profileId]),
			preserveCanonicalMutableStateForLegacyProfileIds:
				preserveCanonicalMutableState ? new Set([profileId]) : undefined,
			skipIdentityMergeSnapshotForLegacyProfileIds: plan.incomingLastSeenAt
				? new Set([profileId])
				: undefined,
		});
	}
}

function repairRawIdentity(
	rawJson: string,
	externalUserId: string,
	username: string,
) {
	const raw = parseJsonObject(rawJson) ?? {};
	raw.id = externalUserId;
	if ("id_str" in raw) raw.id_str = externalUserId;
	if ("rest_id" in raw) raw.rest_id = externalUserId;
	if (raw.legacy && typeof raw.legacy === "object") {
		const legacy = { ...(raw.legacy as Record<string, unknown>) };
		if ("id_str" in legacy) legacy.id_str = externalUserId;
		raw.legacy = legacy;
	}
	if (username) raw.username = username;
	return JSON.stringify(raw);
}

export function repairCanonicalProfileRawIdentity(
	db: Database,
	profileId: string,
	externalUserId: string,
	authoritativeUsername: string,
) {
	const row = db
		.prepare("select raw_json from profiles where id = ?")
		.get(profileId) as { raw_json: string } | undefined;
	if (!row) return false;
	db.prepare("update profiles set raw_json = ? where id = ?").run(
		repairRawIdentity(row.raw_json, externalUserId, authoritativeUsername),
		profileId,
	);
	return true;
}

function collisionHandle(
	db: Database,
	profileId: string,
	prefix: string,
	unavailableHandleKeys: ReadonlySet<string> = new Set(),
) {
	const digest = createHash("sha1")
		.update(profileId)
		.digest("hex")
		.slice(0, 12);
	const base = `${prefix}_${digest}`;
	let candidate = base;
	let suffix = 1;
	while (
		unavailableHandleKeys.has(profileHandleKey(candidate)) ||
		db
			.prepare(
				"select 1 from profiles where lower(handle) = lower(?) and id <> ?",
			)
			.get(candidate, profileId)
	) {
		candidate = `${base}_${suffix++}`;
	}
	return candidate;
}

export function allocateReservedProfileHandle(
	db: Database,
	profileId: string,
	kind: "stub" | "stale" = "stub",
	unavailableHandleKeys: ReadonlySet<string> = new Set(),
) {
	return collisionHandle(
		db,
		profileId,
		`birdclaw_${kind}`,
		unavailableHandleKeys,
	);
}

function mergeCurrentProfile(
	db: Database,
	oldProfileId: string,
	newProfileId: string,
	externalUserId: string,
	incomingHandle: string,
	preserveTargetMutableState: boolean,
	skipSourceSnapshot: boolean,
) {
	const source = db
		.prepare("select * from profiles where id = ?")
		.get(oldProfileId) as ProfileRow | undefined;
	const target = db
		.prepare("select * from profiles where id = ?")
		.get(newProfileId) as ProfileRow | undefined;
	if (!source) return;
	if (!target) {
		recordProfileSnapshot(db, oldProfileId, "identity_merge");
		const sourceHandle = source.handle;
		db.prepare("update profiles set handle = ? where id = ?").run(
			allocateReservedProfileHandle(db, oldProfileId, "stale"),
			oldProfileId,
		);
		db.prepare(
			`insert into profiles (
			 id, handle, display_name, bio, followers_count, following_count,
			 public_metrics_json, avatar_hue, avatar_url, location, url,
			 verified_type, entities_json, raw_json, created_at
			) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			newProfileId,
			sourceHandle,
			source.display_name,
			source.bio,
			source.followers_count,
			source.following_count,
			source.public_metrics_json,
			source.avatar_hue,
			source.avatar_url,
			source.location,
			source.url,
			source.verified_type,
			source.entities_json,
			repairRawIdentity(
				source.raw_json,
				externalUserId,
				incomingHandle || sourceHandle,
			),
			source.created_at,
		);
		return;
	}

	recordProfileSnapshot(db, newProfileId, "pre_identity_merge");
	if (!skipSourceSnapshot) {
		recordProfileSnapshot(db, oldProfileId, "identity_merge");
	}
	if (preserveTargetMutableState) {
		db.prepare(
			"update profiles set created_at = min(created_at, ?) where id = ?",
		).run(source.created_at, newProfileId);
		return;
	}
	const targetHandleIsPlaceholder =
		isReservedPlaceholderHandle(target.handle, externalUserId) ||
		(target.display_name === target.handle &&
			!target.bio &&
			target.followers_count === 0 &&
			target.following_count === 0 &&
			!meaningfulJson(target.public_metrics_json) &&
			!target.avatar_url &&
			!target.location &&
			!target.url &&
			!target.verified_type &&
			!meaningfulJson(target.entities_json) &&
			!meaningfulProfileRaw(target.raw_json));
	const mergedHandle =
		!target.handle || targetHandleIsPlaceholder ? source.handle : target.handle;
	const targetDisplayIsPlaceholder =
		!target.display_name ||
		target.display_name === target.handle ||
		targetHandleIsPlaceholder;
	const targetBioIsPlaceholder =
		!target.bio || target.bio.startsWith("Imported from archive user ");
	const rawJson = repairRawIdentity(
		meaningfulProfileRaw(target.raw_json) ? target.raw_json : source.raw_json,
		externalUserId,
		mergedHandle,
	);
	if (profileHandleKey(mergedHandle) === profileHandleKey(source.handle)) {
		db.prepare("update profiles set handle = ? where id = ?").run(
			allocateReservedProfileHandle(db, oldProfileId, "stale"),
			oldProfileId,
		);
	}
	db.prepare(
		`update profiles set
			handle = ?, display_name = ?, bio = ?, followers_count = ?,
			following_count = ?, public_metrics_json = ?, avatar_hue = ?,
			avatar_url = ?, location = ?, url = ?, verified_type = ?,
			entities_json = ?, raw_json = ?, created_at = ?
		 where id = ?`,
	).run(
		mergedHandle,
		targetDisplayIsPlaceholder && source.display_name
			? source.display_name
			: target.display_name,
		targetBioIsPlaceholder && source.bio ? source.bio : target.bio,
		Math.max(source.followers_count, target.followers_count),
		Math.max(source.following_count, target.following_count),
		meaningfulJson(target.public_metrics_json)
			? target.public_metrics_json
			: source.public_metrics_json,
		target.avatar_hue !== 0 ? target.avatar_hue : source.avatar_hue,
		target.avatar_url ?? source.avatar_url,
		target.location || source.location,
		target.url || source.url,
		target.verified_type || source.verified_type,
		meaningfulJson(target.entities_json)
			? target.entities_json
			: source.entities_json,
		rawJson,
		target.created_at <= source.created_at
			? target.created_at
			: source.created_at,
		newProfileId,
	);
}

function mergeProfileAffiliations(
	db: Database,
	oldProfileId: string,
	newProfileId: string,
) {
	const rows = db
		.prepare(
			`select * from profile_affiliations
			 where subject_profile_id = ? or organization_profile_id = ?`,
		)
		.all(oldProfileId, oldProfileId) as Array<Record<string, unknown>>;
	const affectedSubjects = new Set<string>();
	for (const row of rows) {
		affectedSubjects.add(
			row.subject_profile_id === oldProfileId
				? newProfileId
				: String(row.subject_profile_id),
		);
	}
	db.prepare(
		"delete from profile_affiliations where subject_profile_id = ? or organization_profile_id = ?",
	).run(oldProfileId, oldProfileId);
	const insert = db.prepare(`
		insert into profile_affiliations (
			subject_profile_id, organization_profile_id, organization_name,
			organization_handle, badge_url, url, label, source, is_active,
			first_seen_at, last_seen_at, raw_json, updated_at
		) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		on conflict(subject_profile_id, organization_profile_id) do update set
			organization_name = coalesce(nullif(case when excluded.updated_at > profile_affiliations.updated_at then excluded.organization_name else profile_affiliations.organization_name end, ''), profile_affiliations.organization_name, excluded.organization_name),
			organization_handle = coalesce(nullif(case when excluded.updated_at > profile_affiliations.updated_at then excluded.organization_handle else profile_affiliations.organization_handle end, ''), profile_affiliations.organization_handle, excluded.organization_handle),
			badge_url = coalesce(nullif(case when excluded.updated_at > profile_affiliations.updated_at then excluded.badge_url else profile_affiliations.badge_url end, ''), profile_affiliations.badge_url, excluded.badge_url),
			url = coalesce(nullif(case when excluded.updated_at > profile_affiliations.updated_at then excluded.url else profile_affiliations.url end, ''), profile_affiliations.url, excluded.url),
			label = coalesce(nullif(case when excluded.updated_at > profile_affiliations.updated_at then excluded.label else profile_affiliations.label end, ''), profile_affiliations.label, excluded.label),
			source = coalesce(nullif(case when excluded.updated_at > profile_affiliations.updated_at then excluded.source else profile_affiliations.source end, ''), profile_affiliations.source, excluded.source),
			is_active = case when excluded.updated_at > profile_affiliations.updated_at then excluded.is_active else profile_affiliations.is_active end,
			first_seen_at = min(profile_affiliations.first_seen_at, excluded.first_seen_at),
			last_seen_at = max(profile_affiliations.last_seen_at, excluded.last_seen_at),
			raw_json = coalesce(nullif(case when excluded.updated_at > profile_affiliations.updated_at then excluded.raw_json else profile_affiliations.raw_json end, '{}'), nullif(profile_affiliations.raw_json, '{}'), nullif(excluded.raw_json, '{}'), '{}'),
			updated_at = max(profile_affiliations.updated_at, excluded.updated_at)
	`);
	for (const row of rows) {
		insert.run(
			row.subject_profile_id === oldProfileId
				? newProfileId
				: row.subject_profile_id,
			row.organization_profile_id === oldProfileId
				? newProfileId
				: row.organization_profile_id,
			row.organization_name,
			row.organization_handle,
			row.badge_url,
			row.url,
			row.label,
			row.source,
			row.is_active,
			row.first_seen_at,
			row.last_seen_at,
			row.raw_json,
			row.updated_at,
		);
	}
	return affectedSubjects;
}

function normalizeCanonicalProfileExternalIds(
	db: Database,
	profileId: string,
	externalUserId: string,
) {
	for (const [table, profileColumn, externalColumn] of [
		["follow_snapshot_members", "profile_id", "external_user_id"],
		["follow_edges", "profile_id", "external_user_id"],
		["follow_events", "profile_id", "external_user_id"],
		["x_lists", "owner_profile_id", "owner_external_user_id"],
		["x_list_members", "profile_id", "external_user_id"],
	] as const) {
		db.prepare(
			`update ${table} set ${externalColumn} = ? where ${profileColumn} = ?`,
		).run(externalUserId, profileId);
	}
}

function mergeProfileReferences(
	db: Database,
	oldProfileId: string,
	newProfileId: string,
	externalUserId: string,
) {
	const affectedSubjects = mergeProfileAffiliations(
		db,
		oldProfileId,
		newProfileId,
	);
	rekeyProfileSnapshots(db, oldProfileId, newProfileId);

	db.prepare(`
		insert into profile_bio_entities select ?, kind, value, source, is_active,
			first_seen_at, last_seen_at, raw_json
		from profile_bio_entities where profile_id = ?
		on conflict(profile_id, kind, value) do update set
			is_active = case when excluded.last_seen_at > profile_bio_entities.last_seen_at then excluded.is_active else profile_bio_entities.is_active end,
			first_seen_at = min(profile_bio_entities.first_seen_at, excluded.first_seen_at),
			last_seen_at = max(profile_bio_entities.last_seen_at, excluded.last_seen_at),
			source = coalesce(nullif(case when excluded.last_seen_at > profile_bio_entities.last_seen_at then excluded.source else profile_bio_entities.source end, ''), profile_bio_entities.source, excluded.source),
			raw_json = coalesce(nullif(case when excluded.last_seen_at > profile_bio_entities.last_seen_at then excluded.raw_json else profile_bio_entities.raw_json end, '{}'), nullif(profile_bio_entities.raw_json, '{}'), nullif(excluded.raw_json, '{}'), '{}')
	`).run(newProfileId, oldProfileId);
	db.prepare("delete from profile_bio_entities where profile_id = ?").run(
		oldProfileId,
	);
	db.prepare(
		"delete from identity_search_index where profile_id in (?, ?)",
	).run(oldProfileId, newProfileId);

	for (const [table, column] of [
		["tweets", "author_profile_id"],
		["dm_conversations", "participant_profile_id"],
		["dm_messages", "sender_profile_id"],
		["follow_events", "profile_id"],
		["x_lists", "owner_profile_id"],
	] as const) {
		db.prepare(`update ${table} set ${column} = ? where ${column} = ?`).run(
			newProfileId,
			oldProfileId,
		);
	}
	db.prepare(
		"update follow_events set external_user_id = ? where profile_id = ?",
	).run(externalUserId, newProfileId);
	db.prepare(
		"update x_lists set owner_external_user_id = ? where owner_profile_id = ?",
	).run(externalUserId, newProfileId);

	for (const table of ["blocks", "mutes"] as const) {
		db.prepare(`
			insert into ${table} (account_id, profile_id, source, created_at)
			select account_id, ?, source, created_at from ${table} where profile_id = ?
			on conflict(account_id, profile_id) do update set
				created_at = min(${table}.created_at, excluded.created_at),
				source = case when excluded.created_at > ${table}.created_at then excluded.source else ${table}.source end
		`).run(newProfileId, oldProfileId);
		db.prepare(`delete from ${table} where profile_id = ?`).run(oldProfileId);
	}

	db.prepare(`
		insert into follow_snapshot_members (snapshot_id, profile_id, external_user_id, position)
		select snapshot_id, ?, ?, position from follow_snapshot_members where profile_id = ?
		on conflict(snapshot_id, profile_id) do update set
			external_user_id = excluded.external_user_id,
			position = min(follow_snapshot_members.position, excluded.position)
	`).run(newProfileId, externalUserId, oldProfileId);
	db.prepare("delete from follow_snapshot_members where profile_id = ?").run(
		oldProfileId,
	);

	db.prepare(`
		insert into follow_edges (
			account_id, direction, profile_id, external_user_id, source, current,
			first_seen_at, last_seen_at, ended_at, updated_at
		)
		select account_id, direction, ?, ?, source, current,
			first_seen_at, last_seen_at, ended_at, updated_at
		from follow_edges where profile_id = ?
		on conflict(account_id, direction, profile_id) do update set
			external_user_id = excluded.external_user_id,
			current = case when excluded.updated_at > follow_edges.updated_at then excluded.current else follow_edges.current end,
			first_seen_at = min(follow_edges.first_seen_at, excluded.first_seen_at),
			last_seen_at = max(follow_edges.last_seen_at, excluded.last_seen_at),
			ended_at = case when excluded.updated_at > follow_edges.updated_at then excluded.ended_at else follow_edges.ended_at end,
			source = coalesce(nullif(case when excluded.updated_at > follow_edges.updated_at then excluded.source else follow_edges.source end, ''), follow_edges.source, excluded.source),
			updated_at = max(follow_edges.updated_at, excluded.updated_at)
	`).run(newProfileId, externalUserId, oldProfileId);
	db.prepare("delete from follow_edges where profile_id = ?").run(oldProfileId);

	db.prepare(`
		insert into x_list_members (
			account_id, list_id, profile_id, external_user_id, source, current,
			first_seen_at, last_seen_at, ended_at, raw_json, updated_at
		)
		select account_id, list_id, ?, ?, source, current,
			first_seen_at, last_seen_at, ended_at, raw_json, updated_at
		from x_list_members where profile_id = ?
		on conflict(account_id, list_id, profile_id) do update set
			external_user_id = excluded.external_user_id,
			current = case when excluded.updated_at > x_list_members.updated_at then excluded.current else x_list_members.current end,
			first_seen_at = min(x_list_members.first_seen_at, excluded.first_seen_at),
			last_seen_at = max(x_list_members.last_seen_at, excluded.last_seen_at),
			ended_at = case when excluded.updated_at > x_list_members.updated_at then excluded.ended_at else x_list_members.ended_at end,
			source = coalesce(nullif(case when excluded.updated_at > x_list_members.updated_at then excluded.source else x_list_members.source end, ''), x_list_members.source, excluded.source),
			raw_json = coalesce(nullif(case when excluded.updated_at > x_list_members.updated_at then excluded.raw_json else x_list_members.raw_json end, '{}'), nullif(x_list_members.raw_json, '{}'), nullif(excluded.raw_json, '{}'), '{}'),
			updated_at = max(x_list_members.updated_at, excluded.updated_at)
	`).run(newProfileId, externalUserId, oldProfileId);
	db.prepare("delete from x_list_members where profile_id = ?").run(
		oldProfileId,
	);
	affectedSubjects.add(newProfileId);
	return affectedSubjects;
}

function mergeOrRekeyProfile(
	db: Database,
	oldProfileId: string,
	newProfileId: string,
	externalUserId: string,
	incomingHandle: string,
	preserveTargetMutableState = false,
	skipSourceSnapshot = false,
) {
	if (oldProfileId === newProfileId) return new Set([newProfileId]);
	mergeCurrentProfile(
		db,
		oldProfileId,
		newProfileId,
		externalUserId,
		incomingHandle,
		preserveTargetMutableState,
		skipSourceSnapshot,
	);
	const affectedSubjects = mergeProfileReferences(
		db,
		oldProfileId,
		newProfileId,
		externalUserId,
	);
	db.prepare("delete from profiles where id = ?").run(oldProfileId);
	return affectedSubjects;
}

export function profileRawIdentityVetoesExternalUserId(
	rawJson: string,
	externalUserId: string,
) {
	const evidence = getProfileRawIdentityEvidence(rawJson);
	return (
		evidence.kind === "contradictory" ||
		(evidence.kind === "consistent" &&
			evidence.externalUserId !== externalUserId) ||
		identityConflictIds(rawJson).includes(externalUserId)
	);
}

export function reconcileCanonicalXProfileIdentity({
	db,
	externalUserId,
	canonicalProfileId,
	incomingHandle,
	provenLegacyProfileIds = new Set<string>(),
	preserveCanonicalMutableStateForLegacyProfileIds = new Set<string>(),
	skipIdentityMergeSnapshotForLegacyProfileIds = new Set<string>(),
	canReassignHandleCollision,
}: {
	db: Database;
	externalUserId: string;
	canonicalProfileId: string;
	incomingHandle: string;
	provenLegacyProfileIds?: ReadonlySet<string>;
	preserveCanonicalMutableStateForLegacyProfileIds?: ReadonlySet<string>;
	skipIdentityMergeSnapshotForLegacyProfileIds?: ReadonlySet<string>;
	canReassignHandleCollision?: (collision: ProfileIdentityCollision) => boolean;
}) {
	const explicitLegacyIds = [...provenLegacyProfileIds];
	const explicitClause =
		explicitLegacyIds.length > 0
			? ` or id in (${explicitLegacyIds.map(() => "?").join(",")})`
			: "";
	const profiles = db
		.prepare(
			`select id, handle, raw_json from profiles
			 where id = ? or id = 'profile_me' or lower(handle) = lower(?)
			    or (case when json_valid(raw_json) then cast(json_extract(raw_json, '$.id') as text) end) = ?
			    or (case when json_valid(raw_json) then cast(json_extract(raw_json, '$.id_str') as text) end) = ?
			    or (case when json_valid(raw_json) then cast(json_extract(raw_json, '$.rest_id') as text) end) = ?
			    or (case when json_valid(raw_json) then cast(json_extract(raw_json, '$.legacy.id_str') as text) end) = ?
			    ${explicitClause}
			 order by id`,
		)
		.all(
			canonicalProfileId,
			incomingHandle,
			externalUserId,
			externalUserId,
			externalUserId,
			externalUserId,
			...explicitLegacyIds,
		) as Array<{
		id: string;
		handle: string;
		raw_json: string;
	}>;
	observeProfileIdentityCandidateCountForTests?.(profiles.length);
	const provenLegacyIds = profiles
		.filter((profile) => {
			if (profile.id === canonicalProfileId) return false;
			const canonicalId = canonicalExternalUserId(profile.id);
			if (canonicalId) return false;
			if (
				profileRawIdentityVetoesExternalUserId(profile.raw_json, externalUserId)
			) {
				return false;
			}
			return (
				provenExternalUserId(profile.raw_json) === externalUserId ||
				provenLegacyProfileIds.has(profile.id)
			);
		})
		.map((profile) => profile.id);
	const affectedSubjects = new Set<string>([canonicalProfileId]);
	for (const profileId of provenLegacyIds) {
		for (const subjectId of mergeOrRekeyProfile(
			db,
			profileId,
			canonicalProfileId,
			externalUserId,
			incomingHandle,
			preserveCanonicalMutableStateForLegacyProfileIds.has(profileId),
			skipIdentityMergeSnapshotForLegacyProfileIds.has(profileId),
		)) {
			affectedSubjects.add(subjectId);
		}
	}
	normalizeCanonicalProfileExternalIds(db, canonicalProfileId, externalUserId);

	const canonical = db
		.prepare("select raw_json, handle from profiles where id = ?")
		.get(canonicalProfileId) as
		| { raw_json: string; handle: string }
		| undefined;
	if (canonical) {
		db.prepare("update profiles set raw_json = ? where id = ?").run(
			repairRawIdentity(canonical.raw_json, externalUserId, ""),
			canonicalProfileId,
		);
	}

	const collisions = db
		.prepare(
			`select id, handle, raw_json from profiles
			 where lower(handle) = lower(?) and id <> ? order by id`,
		)
		.all(incomingHandle, canonicalProfileId) as Array<{
		id: string;
		handle: string;
		raw_json: string;
	}>;
	const blockedHandleProfileIds: string[] = [];
	for (const collision of collisions) {
		if (
			(collision.id === "profile_me" &&
				(profileRawIdentityVetoesExternalUserId(
					collision.raw_json,
					externalUserId,
				) ||
					profileIdentityHasConflict(collision.raw_json, externalUserId))) ||
			(canReassignHandleCollision && !canReassignHandleCollision(collision))
		) {
			blockedHandleProfileIds.push(collision.id);
			continue;
		}
		recordProfileSnapshot(db, collision.id, "handle_collision");
		db.prepare("update profiles set handle = ? where id = ?").run(
			allocateReservedProfileHandle(db, collision.id, "stale"),
			collision.id,
		);
		affectedSubjects.add(collision.id);
	}

	for (const profileId of affectedSubjects) {
		if (!db.prepare("select 1 from profiles where id = ?").get(profileId))
			continue;
		syncProfileBioEntitiesForProfileId(db, profileId);
	}
	syncIdentitySearchIndexForProfileIds(db, [...affectedSubjects]);

	return {
		profileId: canonicalProfileId,
		provenLegacyIds,
		freedProfileIds: collisions
			.filter((collision) => !blockedHandleProfileIds.includes(collision.id))
			.map((collision) => collision.id),
		blockedHandleProfileIds,
		handleKey: profileHandleKey(incomingHandle),
	};
}

export const __test__ = {
	setCandidateCountObserver(observer: ((count: number) => void) | undefined) {
		observeProfileIdentityCandidateCountForTests = observer;
	},
};
