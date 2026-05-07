// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import {
	extractProfileBioEntities,
	fetchProfileBioEntities,
	syncProfileBioEntitiesForProfileId,
} from "./profile-bio-entities";

let homeDir = "";

describe("profile bio entities", () => {
	beforeEach(() => {
		homeDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-bio-entities-"));
		process.env.BIRDCLAW_HOME = homeDir;
		resetBirdclawPathsForTests();
		resetDatabaseForTests();
	});

	afterEach(() => {
		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		delete process.env.BIRDCLAW_HOME;
		rmSync(homeDir, { recursive: true, force: true });
	});

	it("extracts handles, domains, and company phrases from profile bios", () => {
		expect(
			extractProfileBioEntities({
				id: "profile_user_42",
				handle: "aditya",
				displayName: "Aditya",
				bio: "Co-founder at @useblacksmith. Building https://blacksmith.sh",
				followersCount: 100,
				avatarHue: 10,
				url: "https://www.blacksmith.sh/team",
				createdAt: "2026-05-01T00:00:00.000Z",
			}),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "handle", value: "@useblacksmith" }),
				expect.objectContaining({
					kind: "company_phrase",
					value: "useblacksmith",
				}),
				expect.objectContaining({ kind: "domain", value: "blacksmith.sh" }),
			]),
		);
	});

	it("syncs current entities and preserves inactive history", () => {
		const db = getNativeDb();
		db.prepare(
			`
      insert into profiles (
        id, handle, display_name, bio, followers_count, avatar_hue, url,
        entities_json, created_at
      ) values (
        'profile_user_42', 'aditya', 'Aditya',
        'Co-founder at @useblacksmith', 100, 10, 'https://blacksmith.sh',
        '{}', '2026-05-01T00:00:00.000Z'
      )
      `,
		).run();

		expect(syncProfileBioEntitiesForProfileId(db, "profile_user_42")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "handle", value: "@useblacksmith" }),
				expect.objectContaining({ kind: "domain", value: "blacksmith.sh" }),
			]),
		);
		db.prepare(
			"update profiles set bio = 'Now building @newco', url = 'https://newco.dev' where id = 'profile_user_42'",
		).run();
		syncProfileBioEntitiesForProfileId(db, "profile_user_42");

		expect(fetchProfileBioEntities(db, ["profile_user_42"])).toEqual(
			new Map([
				[
					"profile_user_42",
					expect.arrayContaining([
						expect.objectContaining({ value: "@newco", isActive: true }),
						expect.objectContaining({ value: "newco.dev", isActive: true }),
					]),
				],
			]),
		);
		expect(
			db
				.prepare(
					"select is_active from profile_bio_entities where profile_id = ? and value = ?",
				)
				.get("profile_user_42", "@useblacksmith"),
		).toEqual({ is_active: 0 });
	});
});
