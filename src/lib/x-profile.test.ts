// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import {
	__test__ as profileIdentityTest,
	getProfileRawIdentityEvidence,
	getProvenSelectedAccountLegacyProfileIds,
	markProfileIdentityConflict,
	profileIdentityHasConflict,
	repairCanonicalProfileRawIdentity,
} from "./profile-identity";
import {
	buildExternalProfileId,
	canonicalizeProvenXProfileIdentity,
	ensureStubProfileForXUser,
	getExternalUserId,
	upsertProfileFromXUser,
	upsertSparseProfileFromXUser,
} from "./x-profile";

const tempDirs: string[] = [];

afterEach(() => {
	profileIdentityTest.setCandidateCountObserver(undefined);
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;

	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempHome() {
	const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-x-profile-"));
	tempDirs.push(tempDir);
	process.env.BIRDCLAW_HOME = tempDir;
	return getNativeDb();
}

describe("x profile sync helpers", () => {
	it("creates external profile ids and resolves them back", () => {
		expect(buildExternalProfileId("42")).toBe("profile_user_42");
		expect(getExternalUserId("profile_user_42")).toBe("42");
		expect(getExternalUserId("profile_me")).toBeNull();
	});

	it("classifies numeric profile identity evidence conservatively", () => {
		expect(getProfileRawIdentityEvidence(undefined)).toEqual({ kind: "none" });
		expect(getProfileRawIdentityEvidence("not json")).toEqual({ kind: "none" });
		expect(getProfileRawIdentityEvidence("[]")).toEqual({ kind: "none" });
		expect(
			getProfileRawIdentityEvidence(
				'{"id":"00042","id_str":42,"legacy":{"id_str":"42"}}',
			),
		).toEqual({ kind: "consistent", externalUserId: "42" });
		expect(
			getProfileRawIdentityEvidence('{"id":-1,"id_str":"nope","rest_id":1.5}'),
		).toEqual({ kind: "none" });
		expect(getProfileRawIdentityEvidence('{"id":"42","rest_id":"43"}')).toEqual(
			{ kind: "contradictory" },
		);
	});

	it("persists sorted identity conflicts and handles missing profiles", () => {
		const db = makeTempHome();
		expect(markProfileIdentityConflict(db, "profile_missing", "99")).toBe(
			false,
		);
		expect(
			repairCanonicalProfileRawIdentity(db, "profile_missing", "99", "missing"),
		).toBe(false);
		db.prepare("update profiles set raw_json = ? where id = ?").run(
			'{"birdclaw_identity_conflicts":["bad",7,"100"]}',
			"profile_me",
		);
		expect(markProfileIdentityConflict(db, "profile_me", "42")).toBe(true);
		expect(markProfileIdentityConflict(db, "profile_me", "42")).toBe(true);
		const row = db
			.prepare("select raw_json from profiles where id = ?")
			.get("profile_me") as { raw_json: string };
		expect(JSON.parse(row.raw_json).birdclaw_identity_conflicts).toEqual([
			"100",
			"42",
		]);
		expect(profileIdentityHasConflict(row.raw_json, "42")).toBe(true);
		expect(profileIdentityHasConflict(row.raw_json, "7")).toBe(false);
		expect(profileIdentityHasConflict("{}", "42")).toBe(false);
	});

	it("repairs malformed and nested legacy raw identity metadata", () => {
		const db = makeTempHome();
		db.prepare("update profiles set raw_json = ? where id = ?").run(
			"not json",
			"profile_me",
		);
		expect(markProfileIdentityConflict(db, "profile_me", "77")).toBe(true);
		let row = db
			.prepare("select raw_json from profiles where id = ?")
			.get("profile_me") as { raw_json: string };
		expect(JSON.parse(row.raw_json)).toEqual({
			birdclaw_identity_conflicts: ["77"],
		});

		db.prepare("update profiles set raw_json = ? where id = ?").run(
			'{"id":"1","id_str":"1","rest_id":"1","username":"old","legacy":{"id_str":"1","screen_name":"old"}}',
			"profile_me",
		);
		expect(
			repairCanonicalProfileRawIdentity(db, "profile_me", "88", "current"),
		).toBe(true);
		row = db
			.prepare("select raw_json from profiles where id = ?")
			.get("profile_me") as { raw_json: string };
		expect(JSON.parse(row.raw_json)).toEqual({
			id: "88",
			id_str: "88",
			rest_id: "88",
			username: "current",
			legacy: { id_str: "88", screen_name: "old" },
		});
	});

	it("upserts new x users and updates existing local handles in place", () => {
		const db = makeTempHome();

		const inserted = upsertProfileFromXUser(db, {
			id: "42",
			username: "sam",
			name: "Sam Altman",
			description: "builder",
			profile_image_url:
				"https://pbs.twimg.com/profile_images/42/demo_normal.jpg",
			public_metrics: {
				followers_count: 321,
				following_count: 123,
			},
		});
		expect(inserted.profile).toEqual(
			expect.objectContaining({
				id: "profile_user_42",
				handle: "sam",
				displayName: "Sam Altman",
				followersCount: 321,
				followingCount: 123,
			}),
		);
		expect(inserted.profile.avatarUrl).toContain("demo.jpg");

		const updated = upsertProfileFromXUser(db, {
			id: "7",
			username: "amelia",
			name: "Amelia New",
			description: "new bio",
			public_metrics: {
				followers_count: 88,
				following_count: 44,
			},
		});
		expect(updated.profile).toEqual(
			expect.objectContaining({
				id: "profile_user_7",
				handle: "amelia",
				displayName: "Amelia New",
				bio: "new bio",
				followersCount: 88,
				followingCount: 44,
			}),
		);
	});

	it("preserves an existing avatar when a later payload omits one", () => {
		const db = makeTempHome();

		const first = upsertProfileFromXUser(db, {
			id: "42",
			username: "sam",
			name: "Sam Altman",
			profile_image_url:
				"https://pbs.twimg.com/profile_images/42/demo_normal.jpg",
		});
		const second = upsertProfileFromXUser(db, {
			id: "42",
			username: "sam",
			name: "Sam Updated",
		});

		expect(first.profile.avatarUrl).toContain("demo.jpg");
		expect(second.profile).toEqual(
			expect.objectContaining({
				id: "profile_user_42",
				displayName: "Sam Updated",
				avatarUrl: first.profile.avatarUrl,
			}),
		);
	});

	it("preserves existing following count when later x user payload omits metrics", () => {
		const db = makeTempHome();

		upsertProfileFromXUser(db, {
			id: "42",
			username: "sam",
			name: "Sam Altman",
			public_metrics: {
				followers_count: 321,
				following_count: 123,
			},
		});
		const updated = upsertProfileFromXUser(db, {
			id: "42",
			username: "sam",
			name: "Sam Updated",
			public_metrics: {
				followers_count: 999,
			},
		});

		expect(updated.profile).toEqual(
			expect.objectContaining({
				followersCount: 999,
				followingCount: 123,
			}),
		);
		expect(
			db
				.prepare(
					"select followers_count, following_count from profiles where id = ?",
				)
				.get("profile_user_42"),
		).toEqual({ followers_count: 999, following_count: 123 });
	});

	it("persists rich profile metadata from x user payloads", () => {
		const db = makeTempHome();

		const inserted = upsertProfileFromXUser(db, {
			id: "888",
			username: "@rich",
			name: "Rich Profile",
			description: "Bio with https://t.co/site",
			location: " Vienna ",
			verified: true,
			entities: {
				url: {
					urls: [
						null,
						{
							expanded_url: "https://rich.example",
						},
					],
				},
				description: {
					urls: [
						{
							expandedUrl: "https://bio.example",
						},
					],
				},
			},
			public_metrics: {
				followers_count: 5,
			},
		});

		expect(inserted.profile).toEqual(
			expect.objectContaining({
				id: "profile_user_888",
				handle: "rich",
				location: "Vienna",
				url: "https://rich.example",
				verifiedType: "verified",
				followingCount: 0,
				entities: expect.objectContaining({
					url: expect.any(Object),
				}),
			}),
		);

		const updated = upsertProfileFromXUser(db, {
			id: "888",
			username: "rich",
			name: "Rich Updated",
			location: "",
			url: "https://fallback.example",
			verified_type: "Business",
			entities: {
				url: {
					urls: [
						{
							expandedUrl: "https://entity.example",
						},
					],
				},
			},
			public_metrics: {
				followers_count: 9,
			},
		});

		expect(updated.profile).toEqual(
			expect.objectContaining({
				displayName: "Rich Updated",
				location: "Vienna",
				url: "https://entity.example",
				verifiedType: "business",
				followingCount: 0,
			}),
		);
	});

	it("records profile snapshots and bio entities during upserts", () => {
		const db = makeTempHome();

		upsertProfileFromXUser(db, {
			id: "4242",
			username: "blacksmith_guy",
			name: "Blacksmith Guy",
			description: "Co-founder at @useblacksmith",
			url: "https://blacksmith.sh",
			public_metrics: {
				followers_count: 10,
				following_count: 5,
			},
		});
		upsertProfileFromXUser(db, {
			id: "4242",
			username: "blacksmith_guy",
			name: "Blacksmith Guy",
			description: "Now at @newco",
			url: "https://newco.dev",
			public_metrics: {
				followers_count: 20,
				following_count: 5,
			},
		});

		expect(
			db
				.prepare(
					"select bio from profile_snapshots where profile_id = ? order by observed_at asc",
				)
				.all("profile_user_4242"),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ bio: "Co-founder at @useblacksmith" }),
				expect.objectContaining({ bio: "Now at @newco" }),
			]),
		);
		expect(
			db
				.prepare(
					"select kind, value, is_active from profile_bio_entities where profile_id = ? order by value",
				)
				.all("profile_user_4242"),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "handle",
					value: "@newco",
					is_active: 1,
				}),
				expect.objectContaining({
					kind: "handle",
					value: "@useblacksmith",
					is_active: 0,
				}),
			]),
		);
		const candidatePlan = db
			.prepare(
				`explain query plan select id from profiles
				 where id = ? or id = 'profile_me' or lower(handle) = lower(?)
				    or (case when json_valid(raw_json) then cast(json_extract(raw_json, '$.id') as text) end) = ?
				    or (case when json_valid(raw_json) then cast(json_extract(raw_json, '$.id_str') as text) end) = ?
				    or (case when json_valid(raw_json) then cast(json_extract(raw_json, '$.rest_id') as text) end) = ?
				    or (case when json_valid(raw_json) then cast(json_extract(raw_json, '$.legacy.id_str') as text) end) = ?`,
			)
			.all(
				"profile_user_555",
				"canonical555",
				"555",
				"555",
				"555",
				"555",
			) as Array<{ detail: string }>;
		expect(
			candidatePlan.some(({ detail }) => /scan profiles/iu.test(detail)),
		).toBe(false);
		expect(candidatePlan.map(({ detail }) => detail).join("\n")).toContain(
			"idx_profiles_handle_lower",
		);
	});

	it("falls back to username when x user payload omits a display name", () => {
		const db = makeTempHome();

		const profile = upsertProfileFromXUser(db, {
			id: "1234",
			username: "nameless",
			name: "",
		});

		expect(profile.profile).toEqual(
			expect.objectContaining({
				id: "profile_user_1234",
				handle: "nameless",
				displayName: "nameless",
			}),
		);
	});

	it("creates stub profiles once and reuses them", () => {
		const db = makeTempHome();

		const first = ensureStubProfileForXUser(db, "999");
		const second = ensureStubProfileForXUser(db, "999");

		expect(first.profile).toEqual(
			expect.objectContaining({
				id: "profile_user_999",
				handle: expect.stringMatching(/^birdclaw_stub_/),
			}),
		);
		expect(second.profile.id).toBe("profile_user_999");
		expect(
			db
				.prepare("select count(*) as count from profiles where id = ?")
				.get("profile_user_999"),
		).toEqual({ count: 1 });
	});

	it("allocates reserved stubs without taking a legitimate user_<id> handle", () => {
		const db = makeTempHome();
		db.prepare(
			`insert into profiles (id, handle, display_name, bio, followers_count,
			 avatar_hue, raw_json, created_at) values
			 ('profile_user_500', 'user_999', 'Legitimate User', 'real profile', 5,
			  1, '{"id":"500","username":"user_999"}',
			  '2025-01-01T00:00:00.000Z')`,
		).run();

		const stub = ensureStubProfileForXUser(db, "999");

		expect(stub.profile.handle).toMatch(/^birdclaw_stub_/);
		expect(
			db
				.prepare("select handle from profiles where id = 'profile_user_500'")
				.get(),
		).toEqual({ handle: "user_999" });
	});

	it("never trusts or rewrites contradictory raw ids on another canonical row", () => {
		const db = makeTempHome();
		db.prepare(
			`insert into profiles (id, handle, display_name, bio, followers_count,
			 avatar_hue, raw_json, created_at) values
			 ('profile_user_88', 'canonical88', 'Canonical 88', 'must survive', 88,
			  1, '{"id":"77","username":"corrupt"}',
			  '2025-01-01T00:00:00.000Z')`,
		).run();

		upsertProfileFromXUser(db, {
			id: "77",
			username: "canonical77",
			name: "Canonical 77",
		});

		expect(
			db
				.prepare(
					"select id, bio, raw_json from profiles where id in (?, ?) order by id",
				)
				.all("profile_user_77", "profile_user_88"),
		).toEqual([
			{
				id: "profile_user_77",
				bio: "",
				raw_json: expect.stringContaining('"id":"77"'),
			},
			{
				id: "profile_user_88",
				bio: "must survive",
				raw_json: '{"id":"77","username":"corrupt"}',
			},
		]);
	});

	it("does not treat contradictory numeric legacy metadata as identity proof", () => {
		const db = makeTempHome();
		db.prepare(
			`insert into profiles (id, handle, display_name, bio, followers_count,
			 avatar_hue, raw_json, created_at) values
			 ('profile_legacy_conflict', 'conflict77', 'Conflict', 'must stay separate',
			  7, 1, '{"id":"77","rest_id":"88"}',
			  '2025-01-01T00:00:00.000Z')`,
		).run();

		upsertProfileFromXUser(db, {
			id: "77",
			username: "canonical77_conflict",
			name: "Canonical 77",
		});

		expect(
			db
				.prepare(
					"select bio, raw_json from profiles where id = 'profile_legacy_conflict'",
				)
				.get(),
		).toEqual({
			bio: "must stay separate",
			raw_json: '{"id":"77","rest_id":"88"}',
		});
		expect(
			db.prepare("select id from profiles where id = 'profile_user_77'").get(),
		).toEqual({ id: "profile_user_77" });
	});

	it("canonicalization alone preserves the richer proven profile", () => {
		const db = makeTempHome();
		db.prepare(
			`insert into profiles (
			 id, handle, display_name, bio, followers_count, following_count,
			 public_metrics_json, avatar_hue, avatar_url, location, url,
			 verified_type, entities_json, raw_json, created_at
			) values
			 ('profile_legacy_600', 'rich600', 'Rich 600', 'rich bio', 600, 60,
			  '{"followers_count":600}', 222, 'https://img.example/600.jpg',
			  'Vienna', 'https://example.com/600', 'blue', '{"url":{"urls":[]}}',
			  '{"id":"600","username":"rich600"}', '2024-01-01T00:00:00.000Z'),
			 ('profile_user_600', 'stub600', 'stub600', '', 0, 0, '{}', 0, null,
			  null, null, null, '{}', '{}', '2025-01-01T00:00:00.000Z')`,
		).run();

		canonicalizeProvenXProfileIdentity(db, "600", "rich600");

		const row = db
			.prepare("select * from profiles where id = 'profile_user_600'")
			.get() as Record<string, unknown>;
		expect(row).toMatchObject({
			handle: "rich600",
			display_name: "Rich 600",
			bio: "rich bio",
			followers_count: 600,
			following_count: 60,
			public_metrics_json: '{"followers_count":600}',
			avatar_hue: 222,
			avatar_url: "https://img.example/600.jpg",
			location: "Vienna",
			url: "https://example.com/600",
			verified_type: "blue",
			entities_json: '{"url":{"urls":[]}}',
		});
		expect(JSON.parse(String(row.raw_json))).toMatchObject({
			id: "600",
			username: "rich600",
		});
		expect(
			db
				.prepare(
					"select count(*) as count from identity_search_index where profile_id = 'profile_user_600'",
				)
				.get(),
		).toEqual({ count: expect.any(Number) });
	});

	it("merges follower counts independently from otherwise richer legacy fields", () => {
		const db = makeTempHome();
		db.prepare(
			`insert into profiles (
			 id, handle, display_name, bio, followers_count, following_count,
			 public_metrics_json, avatar_hue, raw_json, created_at
			) values
			 ('profile_legacy_601', 'rich601', 'Rich 601', 'rich bio', 0, 0,
			  '{}', 200, '{"id":"601"}', '2024-01-01T00:00:00.000Z'),
			 ('profile_user_601', 'canonical601', 'Canonical 601', '', 123, 45,
			  '{"followers_count":123,"following_count":45}', 10, '{}',
			  '2025-01-01T00:00:00.000Z')`,
		).run();

		canonicalizeProvenXProfileIdentity(db, "601", "rich601");

		expect(
			db
				.prepare(
					"select bio, followers_count, following_count from profiles where id = 'profile_user_601'",
				)
				.get(),
		).toEqual({
			bio: "rich bio",
			followers_count: 123,
			following_count: 45,
		});
	});

	it("preserves populated canonical fields when both identity rows are rich", () => {
		const db = makeTempHome();
		db.prepare(
			`insert into profiles (
			 id, handle, display_name, bio, followers_count, following_count,
			 public_metrics_json, avatar_hue, avatar_url, location, url,
			 verified_type, entities_json, raw_json, created_at
			) values
			 ('profile_legacy_602', 'legacy602', 'Legacy Name', 'legacy richer biography',
			  900, 90, '{"followers_count":900}', 202,
			  'https://img.example/legacy.jpg', 'Legacy City', 'https://legacy.example',
			  'legacy', '{"description":{"legacy":true}}',
			  '{"id":"602","username":"legacy602","legacyOnly":true}',
			  '2024-01-01T00:00:00.000Z'),
			 ('profile_user_602', 'canonical602', 'Canonical Name', 'canonical biography',
			  600, 60, '{"followers_count":600}', 62,
			  'https://img.example/canonical.jpg', 'Canonical City',
			  'https://canonical.example', 'blue',
			  '{"description":{"canonical":true}}',
			  '{"id":"602","username":"canonical602","canonicalOnly":true}',
			  '2025-01-01T00:00:00.000Z')`,
		).run();

		canonicalizeProvenXProfileIdentity(db, "602", "legacy602");

		const current = db
			.prepare("select * from profiles where id = 'profile_user_602'")
			.get() as Record<string, unknown>;
		expect(current).toMatchObject({
			handle: "canonical602",
			display_name: "Canonical Name",
			bio: "canonical biography",
			followers_count: 900,
			following_count: 90,
			public_metrics_json: '{"followers_count":600}',
			avatar_hue: 62,
			avatar_url: "https://img.example/canonical.jpg",
			location: "Canonical City",
			url: "https://canonical.example",
			verified_type: "blue",
			entities_json: '{"description":{"canonical":true}}',
		});
		expect(JSON.parse(String(current.raw_json))).toMatchObject({
			id: "602",
			username: "canonical602",
			canonicalOnly: true,
		});
		expect(
			db
				.prepare(
					"select handle, bio from profile_snapshots where profile_id = 'profile_user_602'",
				)
				.all(),
		).toEqual(
			expect.arrayContaining([
				{ handle: "canonical602", bio: "canonical biography" },
				{ handle: "legacy602", bio: "legacy richer biography" },
			]),
		);
	});

	it("reads sparse existing stub rows without optional profile fields", () => {
		const db = makeTempHome();
		db.prepare(
			`
      insert into profiles (
        id, handle, display_name, bio, followers_count, following_count,
        avatar_hue, avatar_url, location, url, verified_type, entities_json,
        created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
		).run(
			"profile_user_777",
			"user_777",
			"user_777",
			"",
			0,
			"oops",
			10,
			null,
			"",
			"",
			"",
			"[]",
			"2026-05-01T00:00:00.000Z",
		);

		expect(ensureStubProfileForXUser(db, "777").profile).toEqual({
			id: "profile_user_777",
			handle: "user_777",
			displayName: "user_777",
			bio: "",
			followersCount: 0,
			avatarHue: 10,
			createdAt: "2026-05-01T00:00:00.000Z",
		});
	});

	it("enriches a handle-less numeric stub without inventing a public handle", () => {
		const db = makeTempHome();
		const resolved = upsertSparseProfileFromXUser(db, {
			id: "778",
			name: "Handle-less Person",
			profile_image_url:
				"https://pbs.twimg.com/profile_images/778/avatar_normal.jpg",
		});

		expect(resolved.profile.handle).toMatch(/^birdclaw_stub_/);
		expect(resolved.profile).toMatchObject({
			displayName: "Handle-less Person",
			avatarUrl: "https://pbs.twimg.com/profile_images/778/avatar.jpg",
		});
		const row = db
			.prepare(
				"select handle, display_name, avatar_url, raw_json from profiles where id = 'profile_user_778'",
			)
			.get() as Record<string, unknown>;
		expect(String(row.handle)).toMatch(/^birdclaw_stub_/);
		expect(JSON.parse(String(row.raw_json))).toEqual({ id: "778" });
		expect(
			db
				.prepare(
					"select count(*) as count from profile_snapshots where profile_id = 'profile_user_778'",
				)
				.get(),
		).toEqual({ count: 2 });
	});

	it("resolves case-only collisions when a numeric account renames", () => {
		const db = makeTempHome();
		db.prepare(
			`insert into profiles (id, handle, display_name, bio, followers_count,
			 avatar_hue, raw_json, created_at) values (?, ?, ?, '', 0, 1, ?, ?)`,
		).run(
			"profile_user_1001",
			"raulinvests",
			"Raul A",
			JSON.stringify({ id: "1001", username: "raulinvests" }),
			"2026-01-01T00:00:00.000Z",
		);
		db.prepare(
			`insert into profiles (id, handle, display_name, bio, followers_count,
			 avatar_hue, raw_json, created_at) values (?, ?, ?, '', 0, 2, ?, ?)`,
		).run(
			"profile_user_1002",
			"Raulinvests",
			"Raul B",
			JSON.stringify({ id: "1002", username: "Raulinvests" }),
			"2026-01-02T00:00:00.000Z",
		);

		upsertProfileFromXUser(db, {
			id: "1001",
			username: "raulinvests_old",
			name: "Raul A",
		});

		expect(
			db
				.prepare(
					"select id, handle from profiles where id in (?, ?) order by id",
				)
				.all("profile_user_1001", "profile_user_1002"),
		).toEqual([
			{ id: "profile_user_1001", handle: "raulinvests_old" },
			{ id: "profile_user_1002", handle: "Raulinvests" },
		]);
		expect(
			db
				.prepare(
					"select lower(handle) as handle_key, count(*) as count from profiles group by lower(handle) having count(*) > 1",
				)
				.all(),
		).toEqual([]);
		expect(
			db
				.prepare(
					"select handle from profile_snapshots where profile_id = ? order by observed_at",
				)
				.all("profile_user_1001"),
		).toContainEqual({ handle: "raulinvests" });
	});

	it("converges a two-step handle handoff without merging numeric identities", () => {
		const db = makeTempHome();
		const insert = db.prepare(
			`insert into profiles (id, handle, display_name, bio, followers_count,
			 avatar_hue, raw_json, created_at) values (?, ?, ?, '', 0, 1, ?, ?)`,
		);
		insert.run(
			"profile_user_2001",
			"Shadowfetch",
			"Shadowfetch",
			JSON.stringify({ id: "2001", username: "Shadowfetch" }),
			"2026-01-01T00:00:00.000Z",
		);
		insert.run(
			"profile_user_2002",
			"ShadowfetchNews",
			"Shadowfetch News",
			JSON.stringify({ id: "2002", username: "ShadowfetchNews" }),
			"2026-01-02T00:00:00.000Z",
		);

		db.transaction(() => {
			upsertProfileFromXUser(db, {
				id: "2001",
				username: "AgentOasisAI",
				name: "Agent Oasis",
			});
			upsertProfileFromXUser(db, {
				id: "2002",
				username: "Shadowfetch",
				name: "Shadowfetch News",
			});
		})();

		const rows = db
			.prepare(
				"select id, handle, raw_json from profiles where id in (?, ?) order by id",
			)
			.all("profile_user_2001", "profile_user_2002") as Array<{
			id: string;
			handle: string;
			raw_json: string;
		}>;
		expect(rows.map(({ id, handle }) => ({ id, handle }))).toEqual([
			{ id: "profile_user_2001", handle: "AgentOasisAI" },
			{ id: "profile_user_2002", handle: "Shadowfetch" },
		]);
		expect(rows.map((row) => JSON.parse(row.raw_json))).toEqual([
			expect.objectContaining({ id: "2001", username: "AgentOasisAI" }),
			expect.objectContaining({ id: "2002", username: "Shadowfetch" }),
		]);
		expect(
			db
				.prepare(
					"select profile_id, handle from profile_snapshots where handle in (?, ?) order by profile_id",
				)
				.all("Shadowfetch", "ShadowfetchNews"),
		).toEqual(
			expect.arrayContaining([
				{ profile_id: "profile_user_2001", handle: "Shadowfetch" },
				{ profile_id: "profile_user_2002", handle: "ShadowfetchNews" },
			]),
		);
	});

	it("converges a direct two-way handle swap inside one outer transaction", () => {
		const db = makeTempHome();
		const insert = db.prepare(
			`insert into profiles (id, handle, display_name, bio, followers_count,
			 avatar_hue, raw_json, created_at) values (?, ?, ?, '', 0, 1, ?, ?)`,
		);
		insert.run(
			"profile_user_3001",
			"alpha",
			"Alpha",
			'{"id":"3001"}',
			"2026-01-01T00:00:00.000Z",
		);
		insert.run(
			"profile_user_3002",
			"beta",
			"Beta",
			'{"id":"3002"}',
			"2026-01-02T00:00:00.000Z",
		);

		db.transaction(() => {
			upsertProfileFromXUser(db, {
				id: "3001",
				username: "beta",
				name: "Alpha",
			});
			upsertProfileFromXUser(db, {
				id: "3002",
				username: "alpha",
				name: "Beta",
			});
		})();

		expect(
			db
				.prepare(
					"select id, handle from profiles where id in (?, ?) order by id",
				)
				.all("profile_user_3001", "profile_user_3002"),
		).toEqual([
			{ id: "profile_user_3001", handle: "beta" },
			{ id: "profile_user_3002", handle: "alpha" },
		]);
		expect(
			db
				.prepare(
					"select profile_id, handle from profile_snapshots where handle in ('alpha', 'beta') order by profile_id, handle",
				)
				.all(),
		).toEqual(
			expect.arrayContaining([
				{ profile_id: "profile_user_3001", handle: "alpha" },
				{ profile_id: "profile_user_3002", handle: "beta" },
			]),
		);
	});

	it("canonicalizes a proven legacy row and preserves every profile reference", () => {
		const db = makeTempHome();
		const oldId = "profile_legacy_77";
		const newId = "profile_user_77";
		db.exec(
			"delete from x_list_members; delete from x_lists; delete from follow_events; delete from follow_edges; delete from follow_snapshot_members; delete from follow_snapshots; delete from blocks; delete from mutes; delete from dm_messages; delete from dm_conversations; delete from tweets; delete from profile_bio_entities; delete from profile_snapshots; delete from profile_affiliations; delete from identity_search_index;",
		);
		const insert = db.prepare(
			`insert into profiles (id, handle, display_name, bio, followers_count,
			 avatar_hue, raw_json, created_at) values (?, ?, ?, '', 0, 1, ?, ?)`,
		);
		insert.run(
			oldId,
			"legacy77",
			"Legacy 77",
			'{"id":"77","username":"legacy77"}',
			"2025-01-01T00:00:00.000Z",
		);
		db.prepare(
			`update profiles
			 set following_count = 77, avatar_url = 'https://img.example/legacy.jpg',
			     location = 'Legacy City', entities_json = '{"description":{"urls":[]}}'
			 where id = ?`,
		).run(oldId);
		insert.run(newId, "stub77", "Stub 77", "{}", "2026-01-01T00:00:00.000Z");
		insert.run(
			"profile_user_900",
			"subject900",
			"Subject 900",
			'{"id":"900"}',
			"2026-01-01T00:00:00.000Z",
		);
		db.prepare(
			"insert into profile_snapshots (profile_id, snapshot_hash, observed_at, last_seen_at, source, handle, display_name, bio, followers_count, following_count) values (?, 'legacy-hash', ?, ?, 'test', 'legacy77', 'Legacy 77', '', 0, 0)",
		).run(oldId, "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
		db.prepare(
			"insert into profile_bio_entities (profile_id, kind, value, source, first_seen_at, last_seen_at) values (?, 'handle', '@legacyco', 'test', ?, ?)",
		).run(oldId, "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
		db.prepare(
			"insert into profile_affiliations (subject_profile_id, organization_profile_id, source, first_seen_at, last_seen_at, updated_at) values (?, ?, 'test', ?, ?, ?)",
		).run(
			oldId,
			oldId,
			"2025-01-01T00:00:00.000Z",
			"2025-01-01T00:00:00.000Z",
			"2025-01-01T00:00:00.000Z",
		);
		db.prepare(
			"insert into profile_affiliations (subject_profile_id, organization_profile_id, source, first_seen_at, last_seen_at, updated_at) values ('profile_user_900', ?, 'test', ?, ?, ?)",
		).run(
			oldId,
			"2025-01-01T00:00:00.000Z",
			"2025-01-01T00:00:00.000Z",
			"2025-01-01T00:00:00.000Z",
		);
		db.prepare(
			"insert into tweets (id, author_profile_id, text, created_at) values ('legacy-tweet', ?, 'legacy', ?)",
		).run(oldId, "2025-01-01T00:00:00.000Z");
		db.prepare(
			"insert into dm_conversations (id, account_id, participant_profile_id, title, last_message_at) values ('legacy-dm', 'acct_primary', ?, 'Legacy', ?)",
		).run(oldId, "2025-01-01T00:00:00.000Z");
		db.prepare(
			"insert into dm_messages (id, conversation_id, sender_profile_id, text, created_at, direction) values ('legacy-msg', 'legacy-dm', ?, 'hello', ?, 'inbound')",
		).run(oldId, "2025-01-01T00:00:00.000Z");
		for (const table of ["blocks", "mutes"])
			db.prepare(
				`insert into ${table} (account_id, profile_id, source, created_at) values ('acct_primary', ?, 'test', ?)`,
			).run(oldId, "2025-01-01T00:00:00.000Z");
		db.prepare(
			"insert into follow_snapshots (id, account_id, direction, source, status, started_at, completed_at) values ('snap-77', 'acct_primary', 'following', 'test', 'complete', ?, ?)",
		).run("2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
		db.prepare(
			"insert into follow_snapshot_members (snapshot_id, profile_id, external_user_id, position) values ('snap-77', ?, 'stale-legacy', 1)",
		).run(oldId);
		db.prepare(
			"insert into follow_edges (account_id, direction, profile_id, external_user_id, source, first_seen_at, last_seen_at, updated_at) values ('acct_primary', 'following', ?, 'stale-legacy', 'test', ?, ?, ?)",
		).run(
			oldId,
			"2025-01-01T00:00:00.000Z",
			"2025-01-01T00:00:00.000Z",
			"2025-01-01T00:00:00.000Z",
		);
		db.prepare(
			"insert into follow_events (id, account_id, direction, profile_id, external_user_id, kind, event_at, snapshot_id) values ('event-77', 'acct_primary', 'following', ?, 'stale-legacy', 'followed', ?, 'snap-77')",
		).run(oldId, "2025-01-01T00:00:00.000Z");
		db.prepare(
			"insert into x_lists (account_id, list_id, name, owner_profile_id, owner_external_user_id, source, lists_synced_at, updated_at) values ('acct_primary', 'list-77', 'Legacy', ?, 'stale-legacy', 'test', ?, ?)",
		).run(oldId, "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
		db.prepare(
			"insert into x_list_members (account_id, list_id, profile_id, external_user_id, source, first_seen_at, last_seen_at, updated_at) values ('acct_primary', 'list-77', ?, 'stale-legacy', 'test', ?, ?, ?)",
		).run(
			oldId,
			"2025-01-01T00:00:00.000Z",
			"2025-01-01T00:00:00.000Z",
			"2025-01-01T00:00:00.000Z",
		);

		upsertProfileFromXUser(db, {
			id: "77",
			username: "canonical77",
			name: "Canonical 77",
		});

		expect(
			db.prepare("select id from profiles where id = ?").get(oldId),
		).toBeUndefined();
		for (const [table, column] of [
			["tweets", "author_profile_id"],
			["dm_conversations", "participant_profile_id"],
			["dm_messages", "sender_profile_id"],
			["blocks", "profile_id"],
			["mutes", "profile_id"],
			["follow_snapshot_members", "profile_id"],
			["follow_edges", "profile_id"],
			["follow_events", "profile_id"],
			["x_lists", "owner_profile_id"],
			["x_list_members", "profile_id"],
		] as const) {
			expect(
				db
					.prepare(`select count(*) as count from ${table} where ${column} = ?`)
					.get(newId),
			).toEqual({ count: 1 });
		}
		for (const [table, column] of [
			["follow_snapshot_members", "external_user_id"],
			["follow_edges", "external_user_id"],
			["follow_events", "external_user_id"],
			["x_lists", "owner_external_user_id"],
			["x_list_members", "external_user_id"],
		] as const) {
			expect(
				db.prepare(`select ${column} as external_user_id from ${table}`).get(),
			).toEqual({ external_user_id: "77" });
		}
		expect(
			db
				.prepare(
					"select count(*) as count from profile_snapshots where profile_id = ?",
				)
				.get(newId),
		).toEqual({ count: 5 });
		expect(
			db
				.prepare(
					"select subject_profile_id, organization_profile_id from profile_affiliations",
				)
				.all(),
		).toEqual(
			expect.arrayContaining([
				{ subject_profile_id: newId, organization_profile_id: newId },
				{
					subject_profile_id: "profile_user_900",
					organization_profile_id: newId,
				},
			]),
		);
		expect(
			db
				.prepare(
					"select profile_id from profile_bio_entities where value = '@legacyco'",
				)
				.get(),
		).toEqual({ profile_id: newId });
		expect(
			db
				.prepare(
					"select following_count, avatar_url, location, entities_json from profiles where id = ?",
				)
				.get(newId),
		).toEqual({
			following_count: 77,
			avatar_url: "https://img.example/legacy.jpg",
			location: "Legacy City",
			entities_json: '{"description":{"urls":[]}}',
		});
		expect(
			db.prepare("select distinct profile_id from identity_search_index").all(),
		).toEqual(
			expect.arrayContaining([
				{ profile_id: newId },
				{ profile_id: "profile_user_900" },
			]),
		);
		expect(
			db
				.prepare(
					"select value from identity_search_index where profile_id = 'profile_user_900' and kind = 'affiliation'",
				)
				.all(),
		).toContainEqual({ value: newId });
	});

	it("normalizes target-absent profile references and shadow external ids", () => {
		const db = makeTempHome();
		const oldId = "profile_me";
		const newId = "profile_user_78";
		db.exec(
			"delete from x_list_members; delete from x_lists; delete from follow_events; delete from follow_edges; delete from follow_snapshot_members; delete from follow_snapshots; delete from profile_bio_entities; delete from profile_snapshots; delete from identity_search_index; delete from profiles where id = 'profile_user_78';",
		);
		db.prepare(
			`update profiles set handle = 'legacy78', display_name = 'Legacy Rich 78',
			 bio = 'complete legacy bio', followers_count = 780, following_count = 78,
			 public_metrics_json = '{"followers_count":780,"following_count":78}',
			 avatar_hue = 78, avatar_url = 'https://img.example/78.jpg',
			 location = 'Legacy City', url = 'https://legacy78.example',
			 verified_type = 'blue', entities_json = '{"description":{"urls":[]}}',
			 raw_json = '{"id":"78","username":"legacy78","rich":true}'
			 where id = ?`,
		).run(oldId);
		db.prepare(
			"insert into profile_snapshots (profile_id, snapshot_hash, observed_at, last_seen_at, source, handle, display_name, bio, followers_count, following_count) values (?, 'target-absent-78', ?, ?, 'test', 'legacy78', 'Legacy Rich 78', 'complete legacy bio', 780, 78)",
		).run(oldId, "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
		db.prepare(
			"insert into profile_bio_entities (profile_id, kind, value, source, first_seen_at, last_seen_at) values (?, 'domain', 'legacy78.example', 'test', ?, ?)",
		).run(oldId, "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
		db.prepare(
			"insert into follow_snapshots (id, account_id, direction, source, status, started_at, completed_at) values ('snap-78', 'acct_primary', 'following', 'test', 'complete', ?, ?)",
		).run("2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
		db.prepare(
			"insert into follow_snapshot_members (snapshot_id, profile_id, external_user_id, position) values ('snap-78', ?, 'stale-78', 1)",
		).run(oldId);
		db.prepare(
			"insert into follow_edges (account_id, direction, profile_id, external_user_id, source, first_seen_at, last_seen_at, updated_at) values ('acct_primary', 'following', ?, 'stale-78', 'test', ?, ?, ?)",
		).run(
			oldId,
			"2025-01-01T00:00:00.000Z",
			"2025-01-01T00:00:00.000Z",
			"2025-01-01T00:00:00.000Z",
		);
		db.prepare(
			"insert into follow_events (id, account_id, direction, profile_id, external_user_id, kind, event_at, snapshot_id) values ('event-78', 'acct_primary', 'following', ?, 'stale-78', 'followed', ?, 'snap-78')",
		).run(oldId, "2025-01-01T00:00:00.000Z");
		db.prepare(
			"insert into x_lists (account_id, list_id, name, owner_profile_id, owner_external_user_id, source, lists_synced_at, updated_at) values ('acct_primary', 'list-78', 'Legacy 78', ?, 'stale-78', 'test', ?, ?)",
		).run(oldId, "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
		db.prepare(
			"insert into x_list_members (account_id, list_id, profile_id, external_user_id, source, first_seen_at, last_seen_at, updated_at) values ('acct_primary', 'list-78', ?, 'stale-78', 'test', ?, ?, ?)",
		).run(
			oldId,
			"2025-01-01T00:00:00.000Z",
			"2025-01-01T00:00:00.000Z",
			"2025-01-01T00:00:00.000Z",
		);

		canonicalizeProvenXProfileIdentity(db, "78", "canonical78", {
			provenLegacyProfileIds: new Set([oldId]),
		});

		expect(
			db.prepare("select 1 from profiles where id = ?").get(oldId),
		).toBeUndefined();
		expect(
			db
				.prepare(
					`select handle, bio, followers_count, following_count, avatar_url,
					 location, url, verified_type, entities_json, raw_json
					 from profiles where id = ?`,
				)
				.get(newId),
		).toMatchObject({
			handle: "legacy78",
			bio: "complete legacy bio",
			followers_count: 780,
			following_count: 78,
			avatar_url: "https://img.example/78.jpg",
			location: "Legacy City",
			url: "https://legacy78.example",
			verified_type: "blue",
			entities_json: '{"description":{"urls":[]}}',
			raw_json: expect.stringContaining('"id":"78"'),
		});
		for (const [table, profileColumn, externalColumn] of [
			["follow_snapshot_members", "profile_id", "external_user_id"],
			["follow_edges", "profile_id", "external_user_id"],
			["follow_events", "profile_id", "external_user_id"],
			["x_lists", "owner_profile_id", "owner_external_user_id"],
			["x_list_members", "profile_id", "external_user_id"],
		] as const) {
			expect(
				db
					.prepare(
						`select ${profileColumn} as profile_id, ${externalColumn} as external_user_id from ${table} where ${profileColumn} = ?`,
					)
					.get(newId),
			).toEqual({ profile_id: newId, external_user_id: "78" });
		}
		const snapshotCount = db
			.prepare(
				"select count(*) as count from profile_snapshots where profile_id = ? and handle = 'legacy78'",
			)
			.get(newId) as { count: number };
		expect(snapshotCount.count).toBeGreaterThan(0);
		expect(
			db
				.prepare(
					"select profile_id from profile_bio_entities where value = 'legacy78.example'",
				)
				.get(),
		).toEqual({ profile_id: newId });
	});

	it("normalizes stale shadow ids already keyed to the canonical profile", () => {
		const db = makeTempHome();
		const profileId = "profile_user_79";
		db.exec(
			"delete from x_list_members; delete from x_lists; delete from follow_events; delete from follow_edges; delete from follow_snapshot_members; delete from follow_snapshots; delete from profiles where id = 'profile_user_79';",
		);
		db.prepare(
			`insert into profiles (id, handle, display_name, bio, followers_count,
			 avatar_hue, raw_json, created_at) values
			 (?, 'canonical79', 'Canonical 79', '', 0, 79, '{"id":"79"}', ?)`,
		).run(profileId, "2025-01-01T00:00:00.000Z");
		db.prepare(
			"insert into follow_snapshots (id, account_id, direction, source, status, started_at, completed_at) values ('snap-79', 'acct_primary', 'following', 'test', 'complete', ?, ?)",
		).run("2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
		db.prepare(
			"insert into follow_snapshot_members (snapshot_id, profile_id, external_user_id, position) values ('snap-79', ?, 'stale-canonical', 1)",
		).run(profileId);
		db.prepare(
			"insert into follow_edges (account_id, direction, profile_id, external_user_id, source, first_seen_at, last_seen_at, updated_at) values ('acct_primary', 'following', ?, 'stale-canonical', 'test', ?, ?, ?)",
		).run(
			profileId,
			"2025-01-01T00:00:00.000Z",
			"2025-01-01T00:00:00.000Z",
			"2025-01-01T00:00:00.000Z",
		);
		db.prepare(
			"insert into follow_events (id, account_id, direction, profile_id, external_user_id, kind, event_at, snapshot_id) values ('event-79', 'acct_primary', 'following', ?, 'stale-canonical', 'followed', ?, 'snap-79')",
		).run(profileId, "2025-01-01T00:00:00.000Z");
		db.prepare(
			"insert into x_lists (account_id, list_id, name, owner_profile_id, owner_external_user_id, source, lists_synced_at, updated_at) values ('acct_primary', 'list-79', 'Canonical 79', ?, 'stale-canonical', 'test', ?, ?)",
		).run(profileId, "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
		db.prepare(
			"insert into x_list_members (account_id, list_id, profile_id, external_user_id, source, first_seen_at, last_seen_at, updated_at) values ('acct_primary', 'list-79', ?, 'stale-canonical', 'test', ?, ?, ?)",
		).run(
			profileId,
			"2025-01-01T00:00:00.000Z",
			"2025-01-01T00:00:00.000Z",
			"2025-01-01T00:00:00.000Z",
		);

		canonicalizeProvenXProfileIdentity(db, "79", "canonical79");

		for (const [table, profileColumn, externalColumn] of [
			["follow_snapshot_members", "profile_id", "external_user_id"],
			["follow_edges", "profile_id", "external_user_id"],
			["follow_events", "profile_id", "external_user_id"],
			["x_lists", "owner_profile_id", "owner_external_user_id"],
			["x_list_members", "profile_id", "external_user_id"],
		] as const) {
			expect(
				db
					.prepare(
						`select ${externalColumn} as external_user_id from ${table} where ${profileColumn} = ?`,
					)
					.get(profileId),
			).toEqual({ external_user_id: "79" });
		}
	});

	it("bounds reconciliation candidates with indexed raw identity lookup", () => {
		const db = makeTempHome();
		const insert = db.prepare(
			`insert into profiles (id, handle, display_name, bio, followers_count,
			 avatar_hue, raw_json, created_at) values (?, ?, ?, '', 0, 1, ?, ?)`,
		);
		db.transaction(() => {
			for (let index = 10_000; index < 13_000; index += 1) {
				insert.run(
					`profile_user_${index}`,
					`unrelated_${index}`,
					`Unrelated ${index}`,
					JSON.stringify({ id: String(index) }),
					"2025-01-01T00:00:00.000Z",
				);
			}
			insert.run(
				"profile_legacy_555",
				"different_handle_555",
				"Legacy 555",
				'{"rest_id":"555"}',
				"2025-01-01T00:00:00.000Z",
			);
		})();
		const candidateCounts: number[] = [];
		profileIdentityTest.setCandidateCountObserver((count) =>
			candidateCounts.push(count),
		);

		upsertProfileFromXUser(db, {
			id: "555",
			username: "canonical555",
			name: "Canonical 555",
		});

		expect(Math.max(...candidateCounts)).toBeLessThanOrEqual(3);
		expect(
			db.prepare("select id from profiles where id = 'profile_user_555'").get(),
		).toEqual({ id: "profile_user_555" });
		expect(
			db
				.prepare(
					`explain query plan select id from profiles
					 where (case when json_valid(raw_json) then cast(json_extract(raw_json, '$.rest_id') as text) end) = ?`,
				)
				.all("555") as Array<{ detail: string }>,
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					detail: expect.stringContaining("idx_profiles_raw_rest_id"),
				}),
			]),
		);
	});

	it("does not repair an unrelated canonical row during another user upsert", () => {
		const db = makeTempHome();
		db.prepare(
			`insert into profiles (id, handle, display_name, bio, followers_count,
			 avatar_hue, raw_json, created_at) values
			 ('profile_user_9900', 'unrelated9900', 'Unrelated', '', 0, 1,
			  '{"id":"123","corrupted":true}', '2025-01-01T00:00:00.000Z')`,
		).run();

		upsertProfileFromXUser(db, {
			id: "556",
			username: "canonical556",
			name: "Canonical 556",
		});

		expect(
			db
				.prepare("select raw_json from profiles where id = 'profile_user_9900'")
				.get(),
		).toEqual({ raw_json: '{"id":"123","corrupted":true}' });
	});

	it("vetoes selected-account proof for conflicts and contradictory raw identity", () => {
		const db = makeTempHome();
		const account = {
			accountId: "acct_primary",
			username: "selectedproof",
			externalUserId: "8801",
			isDefault: true,
		};
		db.prepare(
			"update profiles set handle = ?, raw_json = ? where id = 'profile_me'",
		).run("selectedproof", '{"birdclaw_identity_conflicts":["8801"]}');
		expect(
			getProvenSelectedAccountLegacyProfileIds(db, account, "8801").size,
		).toBe(0);
		db.prepare("update profiles set raw_json = ? where id = 'profile_me'").run(
			'{"id":"9901"}',
		);
		expect(
			getProvenSelectedAccountLegacyProfileIds(db, account, "8801").size,
		).toBe(0);
		db.prepare(
			"update profiles set raw_json = '{}' where id = 'profile_me'",
		).run();
		expect(
			getProvenSelectedAccountLegacyProfileIds(db, account, "8801"),
		).toEqual(new Set(["profile_me"]));
	});

	it("keeps newer ended relationship state while merging legacy identity rows", () => {
		const db = makeTempHome();
		const oldId = "profile_legacy_701";
		const newId = "profile_user_701";
		db.prepare(
			`insert into profiles (id, handle, display_name, bio, followers_count,
			 avatar_hue, raw_json, created_at) values
			 (?, 'legacy701', 'Legacy 701', '', 0, 1, '{"id":"701"}', ?),
			 (?, 'stub701', 'Stub 701', '', 0, 1, '{}', ?)`,
		).run(oldId, "2025-01-01T00:00:00.000Z", newId, "2026-01-01T00:00:00.000Z");
		db.prepare(
			`insert into profile_affiliations (
			 subject_profile_id, organization_profile_id, source, is_active,
			 first_seen_at, last_seen_at, raw_json, updated_at
			) values
			 (?, 'profile_org_701', 'legacy', 1, ?, ?, '{"legacy":true}', ?),
			 (?, 'profile_org_701', 'canonical', 0, ?, ?, '{"canonical":true}', ?)`,
		).run(
			oldId,
			"2025-01-01T00:00:00.000Z",
			"2025-02-01T00:00:00.000Z",
			"2025-02-01T00:00:00.000Z",
			newId,
			"2025-01-15T00:00:00.000Z",
			"2026-02-01T00:00:00.000Z",
			"2026-02-01T00:00:00.000Z",
		);
		db.prepare(
			`insert into profile_bio_entities (
			 profile_id, kind, value, source, is_active, first_seen_at, last_seen_at, raw_json
			) values
			 (?, 'domain', 'state.example', 'legacy', 1, ?, ?, '{"legacy":true}'),
			 (?, 'domain', 'state.example', 'canonical', 0, ?, ?, '{"canonical":true}')`,
		).run(
			oldId,
			"2025-01-01T00:00:00.000Z",
			"2025-02-01T00:00:00.000Z",
			newId,
			"2025-01-15T00:00:00.000Z",
			"2026-02-01T00:00:00.000Z",
		);
		db.prepare(
			`insert into follow_edges (
			 account_id, direction, profile_id, external_user_id, source, current,
			 first_seen_at, last_seen_at, ended_at, updated_at
			) values
			 ('acct_primary', 'following', ?, '701', 'legacy', 1, ?, ?, null, ?),
			 ('acct_primary', 'following', ?, '701', 'canonical', 0, ?, ?, ?, ?)`,
		).run(
			oldId,
			"2025-01-01T00:00:00.000Z",
			"2025-02-01T00:00:00.000Z",
			"2025-02-01T00:00:00.000Z",
			newId,
			"2025-01-15T00:00:00.000Z",
			"2026-02-01T00:00:00.000Z",
			"2026-02-01T00:00:00.000Z",
			"2026-02-01T00:00:00.000Z",
		);
		db.prepare(
			`insert into x_list_members (
			 account_id, list_id, profile_id, external_user_id, source, current,
			 first_seen_at, last_seen_at, ended_at, raw_json, updated_at
			) values
			 ('acct_primary', 'list701', ?, '701', 'legacy', 1, ?, ?, null, '{"legacy":true}', ?),
			 ('acct_primary', 'list701', ?, '701', 'canonical', 0, ?, ?, ?, '{"canonical":true}', ?)`,
		).run(
			oldId,
			"2025-01-01T00:00:00.000Z",
			"2025-02-01T00:00:00.000Z",
			"2025-02-01T00:00:00.000Z",
			newId,
			"2025-01-15T00:00:00.000Z",
			"2026-02-01T00:00:00.000Z",
			"2026-02-01T00:00:00.000Z",
			"2026-02-01T00:00:00.000Z",
		);

		canonicalizeProvenXProfileIdentity(db, "701", "canonical701");

		expect(
			db
				.prepare(
					"select is_active, source, raw_json from profile_affiliations where subject_profile_id = ?",
				)
				.get(newId),
		).toEqual({
			is_active: 0,
			source: "canonical",
			raw_json: '{"canonical":true}',
		});
		expect(
			db
				.prepare(
					"select is_active, source, raw_json from profile_bio_entities where profile_id = ? and value = 'state.example'",
				)
				.get(newId),
		).toEqual({
			is_active: 0,
			source: "canonical",
			raw_json: '{"canonical":true}',
		});
		expect(
			db
				.prepare(
					"select current, ended_at, source from follow_edges where profile_id = ?",
				)
				.get(newId),
		).toEqual({
			current: 0,
			ended_at: "2026-02-01T00:00:00.000Z",
			source: "canonical",
		});
		expect(
			db
				.prepare(
					"select current, ended_at, source, raw_json from x_list_members where profile_id = ?",
				)
				.get(newId),
		).toEqual({
			current: 0,
			ended_at: "2026-02-01T00:00:00.000Z",
			source: "canonical",
			raw_json: '{"canonical":true}',
		});
	});

	it("does not adopt an unproven same-handle legacy row", () => {
		const db = makeTempHome();
		db.prepare(
			`insert into profiles (id, handle, display_name, bio, followers_count,
			 avatar_hue, raw_json, created_at) values ('profile_legacy_handoff',
			 'handoff', 'Legacy', '', 0, 1, '{}', '2025-01-01T00:00:00.000Z')`,
		).run();

		upsertProfileFromXUser(db, { id: "88", username: "handoff", name: "Live" });

		expect(
			db
				.prepare("select handle from profiles where id = 'profile_user_88'")
				.get(),
		).toEqual({ handle: "handoff" });
		expect(
			db
				.prepare(
					"select handle from profiles where id = 'profile_legacy_handoff'",
				)
				.get(),
		).toEqual({ handle: expect.stringMatching(/^birdclaw_stale_/) });
		expect(
			db
				.prepare(
					"select handle from profile_snapshots where profile_id = 'profile_legacy_handoff'",
				)
				.all(),
		).toContainEqual({ handle: "handoff" });
	});

	it("rejects malformed x user payloads", () => {
		const db = makeTempHome();

		expect(() =>
			upsertProfileFromXUser(db, {
				id: "",
				username: "sam",
				name: "Sam",
			}),
		).toThrow("Resolved user is missing an id");
		expect(() =>
			upsertProfileFromXUser(db, {
				id: "42",
				username: "",
				name: "Sam",
			}),
		).toThrow("Resolved user is missing a username");
		expect(() =>
			upsertProfileFromXUser(db, {
				id: "not-numeric",
				username: "sam",
				name: "Sam",
			}),
		).toThrow("Resolved user id must be numeric");
	});
});
