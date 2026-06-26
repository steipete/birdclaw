// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";

const mocks = vi.hoisted(() => ({
	lookupProfileViaBird: vi.fn(),
}));

vi.mock("./bird", () => ({
	lookupProfileViaBird: mocks.lookupProfileViaBird,
	lookupProfileViaBirdEffect: (handle: string, profileName: string) =>
		Effect.tryPromise({
			try: () => mocks.lookupProfileViaBird(handle, profileName),
			catch: (error) => error,
		}),
}));

let homeDir = "";

function seedProfile(id: string, handle: string) {
	getNativeDb()
		.prepare(
			`
      insert into profiles (
        id, handle, display_name, bio, followers_count, avatar_hue, created_at
      ) values (?, ?, ?, ?, 10, 42, '2026-05-01T00:00:00.000Z')
      `,
		)
		.run(id, handle, handle, `Building ${handle}`);
}

function seedSyntheticAffiliation(
	subjectProfileId: string,
	organizationProfileId: string,
	handle: string,
) {
	getNativeDb()
		.prepare(
			`
      insert into profile_affiliations (
        subject_profile_id, organization_profile_id, organization_name,
        organization_handle, badge_url, url, label, source, is_active,
        first_seen_at, last_seen_at, raw_json, updated_at
      ) values (?, ?, 'Blacksmith', ?, null, 'https://x.com/useblacksmith',
        'Blacksmith', 'bird', 1, '2026-05-01T00:00:00.000Z',
        '2026-05-01T00:00:00.000Z', '{}', '2026-05-01T00:00:00.000Z')
      `,
		)
		.run(subjectProfileId, organizationProfileId, handle);
}

describe("profile affiliation hydration", () => {
	beforeEach(() => {
		homeDir = mkdtempSync(
			path.join(os.tmpdir(), "birdclaw-affiliation-hydration-"),
		);
		process.env.BIRDCLAW_HOME = homeDir;
		resetBirdclawPathsForTests();
		resetDatabaseForTests();
		const db = getNativeDb();
		db.prepare(
			"update accounts set bird_profile_name = ? where id = ?",
		).run("profile-primary", "acct_primary");
		mocks.lookupProfileViaBird.mockReset();
	});

	afterEach(() => {
		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		delete process.env.BIRDCLAW_HOME;
		rmSync(homeDir, { recursive: true, force: true });
	});

	it("reuses an existing local org edge and removes the synthetic edge", async () => {
		seedProfile("profile_user_42", "aditya");
		seedProfile("profile_user_999", "useblacksmith");
		seedSyntheticAffiliation(
			"profile_user_42",
			"profile_affiliation_blacksmith",
			"@useblacksmith",
		);
		getNativeDb()
			.prepare(
				`
        insert into profile_affiliations (
          subject_profile_id, organization_profile_id, organization_name,
          organization_handle, badge_url, url, label, source, is_active,
          first_seen_at, last_seen_at, raw_json, updated_at
        ) values (
          'profile_user_42', 'profile_user_999', null, null, null, null, null,
          'bird', 0, '2026-04-01T00:00:00.000Z',
          '2026-04-01T00:00:00.000Z', '{}', '2026-04-01T00:00:00.000Z'
        )
        `,
			)
			.run();
		const { hydrateProfileAffiliationOrganizations } =
			await import("./profile-affiliation-hydration");

		await expect(
			hydrateProfileAffiliationOrganizations(getNativeDb(), "profile_user_42"),
		).resolves.toEqual({
			checked: 1,
			hydrated: 1,
			skipped: 0,
			errors: [],
		});

		expect(mocks.lookupProfileViaBird).not.toHaveBeenCalled();
		expect(
			getNativeDb()
				.prepare(
					`
          select organization_profile_id, organization_name, organization_handle, is_active
          from profile_affiliations
          where subject_profile_id = 'profile_user_42'
          order by organization_profile_id
          `,
				)
				.all(),
		).toEqual([
			{
				organization_profile_id: "profile_user_999",
				organization_name: "Blacksmith",
				organization_handle: "@useblacksmith",
				is_active: 1,
			},
		]);
	});

	it("exposes affiliation hydration as a lazy Effect program", async () => {
		seedProfile("profile_user_42", "aditya");
		seedProfile("profile_user_999", "useblacksmith");
		seedSyntheticAffiliation(
			"profile_user_42",
			"profile_affiliation_blacksmith",
			"@useblacksmith",
		);
		const { hydrateProfileAffiliationOrganizationsEffect } =
			await import("./profile-affiliation-hydration");

		const effect = hydrateProfileAffiliationOrganizationsEffect(
			getNativeDb(),
			"profile_user_42",
		);
		expect(mocks.lookupProfileViaBird).not.toHaveBeenCalled();
		await expect(Effect.runPromise(effect)).resolves.toMatchObject({
			checked: 1,
			hydrated: 1,
		});
	});

	it("skips empty handles, bird misses, and records lookup errors", async () => {
		seedProfile("profile_user_42", "aditya");
		seedSyntheticAffiliation(
			"profile_user_42",
			"profile_affiliation_empty",
			"   ",
		);
		seedSyntheticAffiliation(
			"profile_user_42",
			"profile_affiliation_missing",
			"missingco",
		);
		seedSyntheticAffiliation(
			"profile_user_42",
			"profile_affiliation_error",
			"errorco",
		);
		getNativeDb()
			.prepare(
				`
        update profile_affiliations
        set last_seen_at = case organization_profile_id
          when 'profile_affiliation_empty' then '2026-05-03T00:00:00.000Z'
          when 'profile_affiliation_missing' then '2026-05-02T00:00:00.000Z'
          else '2026-05-01T00:00:00.000Z'
        end
        where subject_profile_id = 'profile_user_42'
        `,
			)
			.run();
		mocks.lookupProfileViaBird
			.mockResolvedValueOnce(null)
			.mockRejectedValueOnce(new Error("bird down"));
		const { hydrateProfileAffiliationOrganizations } =
			await import("./profile-affiliation-hydration");

		await expect(
			hydrateProfileAffiliationOrganizations(getNativeDb(), "profile_user_42"),
		).resolves.toEqual({
			checked: 3,
			hydrated: 0,
			skipped: 2,
			errors: [{ handle: "errorco", error: "bird down" }],
		});
		expect(mocks.lookupProfileViaBird).toHaveBeenCalledWith(
			"missingco",
			"profile-primary",
		);
		expect(mocks.lookupProfileViaBird).toHaveBeenCalledWith(
			"errorco",
			"profile-primary",
		);
	});
});
