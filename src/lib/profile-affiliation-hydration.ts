import type { Database } from "./sqlite";
import { Effect } from "effect";
import { getBirdProfileName } from "./bird-profile";
import { lookupProfileViaBirdEffect } from "./bird";
import { runEffectPromise } from "./effect-runtime";
import { syncIdentitySearchIndexForProfileIds } from "./identity-search-index";
import { syncProfileBioEntitiesForProfileId } from "./profile-bio-entities";
import { recordProfileSnapshot } from "./profile-history";
import { normalizeProfileHandle } from "./profile-row";
import { upsertProfileFromXUser } from "./x-profile";

export interface ProfileAffiliationHydrationResult {
	checked: number;
	hydrated: number;
	skipped: number;
	errors: Array<{ handle: string; error: string }>;
}

interface SyntheticAffiliationRow {
	subject_profile_id: string;
	organization_profile_id: string;
	organization_name: string | null;
	organization_handle: string | null;
	badge_url: string | null;
	url: string | null;
	label: string | null;
	source: string;
	raw_json: string;
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

function replaceSyntheticAffiliation(
	db: Database,
	row: SyntheticAffiliationRow,
	realProfileId: string,
) {
	const existing = db
		.prepare(
			`
      select 1
      from profile_affiliations
      where subject_profile_id = ?
        and organization_profile_id = ?
      limit 1
      `,
		)
		.get(row.subject_profile_id, realProfileId);

	if (existing) {
		db.prepare(
			`
      update profile_affiliations
      set organization_name = coalesce(organization_name, ?),
          organization_handle = coalesce(organization_handle, ?),
          badge_url = coalesce(badge_url, ?),
          url = coalesce(url, ?),
          label = coalesce(label, ?),
          is_active = 1,
          last_seen_at = ?,
          updated_at = ?
      where subject_profile_id = ?
        and organization_profile_id = ?
      `,
		).run(
			row.organization_name,
			row.organization_handle,
			row.badge_url,
			row.url,
			row.label,
			new Date().toISOString(),
			new Date().toISOString(),
			row.subject_profile_id,
			realProfileId,
		);
		db.prepare(
			`
      delete from profile_affiliations
      where subject_profile_id = ?
        and organization_profile_id = ?
      `,
		).run(row.subject_profile_id, row.organization_profile_id);
		return;
	}

	db.prepare(
		`
    update profile_affiliations
    set organization_profile_id = ?,
        updated_at = ?
    where subject_profile_id = ?
      and organization_profile_id = ?
    `,
	).run(
		realProfileId,
		new Date().toISOString(),
		row.subject_profile_id,
		row.organization_profile_id,
	);
}

function findLocalOrganizationProfileId(db: Database, handle: string) {
	const row = db
		.prepare(
			`
      select id
      from profiles
      where lower(handle) = lower(?)
      limit 1
      `,
		)
		.get(handle) as { id: string } | undefined;
	return row?.id ?? null;
}

export function hydrateProfileAffiliationOrganizationsEffect(
	db: Database,
	subjectProfileId: string,
): Effect.Effect<ProfileAffiliationHydrationResult, unknown> {
	return Effect.gen(function* () {
		const rows = yield* trySync(
			() =>
				db
					.prepare(
						`
      select subject_profile_id, organization_profile_id, organization_name,
        organization_handle, badge_url, url, label, source, raw_json
      from profile_affiliations
      where subject_profile_id = ?
        and is_active = 1
        and organization_profile_id like 'profile_affiliation_%'
        and organization_handle is not null
      order by last_seen_at desc
      `,
					)
					.all(subjectProfileId) as SyntheticAffiliationRow[],
		);

		const result: ProfileAffiliationHydrationResult = {
			checked: rows.length,
			hydrated: 0,
			skipped: 0,
			errors: [],
		};

		for (const row of rows) {
			const handle = normalizeProfileHandle(row.organization_handle) || null;
			if (!handle) {
				result.skipped += 1;
				continue;
			}
			const hydrated = yield* Effect.gen(function* () {
				const localOrganizationProfileId = yield* trySync(() =>
					findLocalOrganizationProfileId(db, handle),
				);
				if (localOrganizationProfileId) {
					yield* trySync(() =>
						db.transaction(() => {
							replaceSyntheticAffiliation(db, row, localOrganizationProfileId);
						})(),
					);
					result.hydrated += 1;
					return true;
				}

				const profileName = getBirdProfileName(db);
				if (!profileName) {
					result.skipped += 1;
					return true;
				}
				const user = yield* lookupProfileViaBirdEffect(handle, profileName);
				if (!user) {
					result.skipped += 1;
					return true;
				}
				const resolved = yield* trySync(() => upsertProfileFromXUser(db, user));
				if (resolved.profile.id === row.organization_profile_id) {
					result.skipped += 1;
					return true;
				}
				yield* trySync(() =>
					db.transaction(() => {
						replaceSyntheticAffiliation(db, row, resolved.profile.id);
					})(),
				);
				result.hydrated += 1;
				return true;
			}).pipe(
				Effect.catchAll((error) => {
					result.errors.push({
						handle,
						error: error instanceof Error ? error.message : String(error),
					});
					return Effect.succeed(false);
				}),
			);
			if (!hydrated) {
				continue;
			}
		}

		if (result.hydrated > 0) {
			yield* trySync(() => {
				recordProfileSnapshot(db, subjectProfileId, "affiliation_hydration");
				syncProfileBioEntitiesForProfileId(db, subjectProfileId);
				syncIdentitySearchIndexForProfileIds(db, [subjectProfileId]);
			});
		}

		return result;
	});
}

export function hydrateProfileAffiliationOrganizations(
	db: Database,
	subjectProfileId: string,
): Promise<ProfileAffiliationHydrationResult> {
	return runEffectPromise(
		hydrateProfileAffiliationOrganizationsEffect(db, subjectProfileId),
	);
}
