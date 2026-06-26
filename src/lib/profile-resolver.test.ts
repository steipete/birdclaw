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
	lookupProfilesViaBird: vi.fn(),
	lookupUsersByHandles: vi.fn(),
	lookupUsersByIds: vi.fn(),
}));

vi.mock("./bird", () => ({
	lookupProfileViaBird: mocks.lookupProfileViaBird,
	lookupProfileViaBirdEffect: (target: string, profileName: string) =>
		Effect.tryPromise({
			try: () => mocks.lookupProfileViaBird(target, profileName),
			catch: (error) => error,
		}),
	lookupProfilesViaBird: mocks.lookupProfilesViaBird,
	lookupProfilesViaBirdEffect: (targets: string[], profileName: string) =>
		Effect.tryPromise({
			try: () => mocks.lookupProfilesViaBird(targets, profileName),
			catch: (error) => error,
		}),
}));

vi.mock("./xurl", () => ({
	lookupUsersByHandles: mocks.lookupUsersByHandles,
	lookupUsersByIds: mocks.lookupUsersByIds,
}));

let homeDir = "";

function resetStore() {
	const db = getNativeDb();
	db.exec(`
    delete from ai_scores;
    delete from tweet_actions;
    delete from dm_fts;
    delete from tweets_fts;
    delete from dm_messages;
    delete from dm_conversations;
    delete from tweets;
    delete from profile_bio_entities;
    delete from profile_snapshots;
    delete from profile_affiliations;
    delete from profiles;
    delete from accounts;
    delete from sync_cache;
  `);
	db.prepare(
		"insert into accounts (id, name, handle, transport, is_default, created_at) values ('acct_primary', 'Peter', '@steipete', 'archive', 1, '2009-03-19T22:54:05.000Z')",
	).run();
	db.prepare(
		"update accounts set bird_profile_name = ? where id = ?",
	).run("profile-primary", "acct_primary");
	db.prepare(
		"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, created_at) values ('profile_user_42', 'id42', 'id42', 'Imported from archive user 42', 0, 210, '2009-03-19T22:54:05.000Z')",
	).run();
	db.prepare(
		"insert into dm_conversations (id, account_id, participant_profile_id, title, last_message_at, unread_count, needs_reply) values ('dm_1', 'acct_primary', 'profile_user_42', 'id42', '2026-05-01T00:00:00.000Z', 0, 1)",
	).run();
}

describe("profile resolver", () => {
	beforeEach(() => {
		homeDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-profile-resolver-"));
		process.env.BIRDCLAW_HOME = homeDir;
		resetBirdclawPathsForTests();
		resetDatabaseForTests();
		mocks.lookupProfileViaBird.mockReset();
		mocks.lookupProfilesViaBird.mockReset();
		mocks.lookupUsersByHandles.mockReset();
		mocks.lookupUsersByIds.mockReset();
		mocks.lookupProfilesViaBird.mockImplementation(async (targets: string[], profileName: string) =>
			Promise.all(
				targets.map(async (target) => ({
					target,
					user: await mocks.lookupProfileViaBird(target, profileName),
				})),
			),
		);
		resetStore();
	});

	afterEach(() => {
		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		delete process.env.BIRDCLAW_HOME;
		rmSync(homeDir, { recursive: true, force: true });
	});

	it("builds profile resolver effects lazily", async () => {
		mocks.lookupProfileViaBird.mockResolvedValueOnce({
			id: "42",
			username: "sam",
			name: "Sam Altman",
			public_metrics: { followers_count: 123, following_count: 45 },
		});
		const { resolveProfilesForIdsEffect } = await import("./profile-resolver");

		const effect = resolveProfilesForIdsEffect(["profile_user_42"]);

		expect(mocks.lookupProfileViaBird).not.toHaveBeenCalled();
		expect(mocks.lookupUsersByIds).not.toHaveBeenCalled();
		await expect(Effect.runPromise(effect)).resolves.toEqual([
			expect.objectContaining({
				status: "hit",
				source: "bird",
				profile: expect.objectContaining({ handle: "sam" }),
			}),
		]);
		expect(mocks.lookupProfileViaBird).toHaveBeenCalledWith(
			"42",
			"profile-primary",
		);
	});

	it("builds handle resolver effects lazily", async () => {
		mocks.lookupProfilesViaBird.mockResolvedValueOnce([
			{
				target: "sam",
				user: {
					id: "42",
					username: "sam",
					name: "Sam Altman",
					public_metrics: { followers_count: 123, following_count: 45 },
				},
			},
		]);
		const { resolveProfilesForHandlesEffect } =
			await import("./profile-resolver");

		const effect = resolveProfilesForHandlesEffect(["@sam"]);

		expect(mocks.lookupProfilesViaBird).not.toHaveBeenCalled();
		await expect(Effect.runPromise(effect)).resolves.toEqual([
			expect.objectContaining({
				handle: "sam",
				status: "hit",
				source: "bird",
			}),
		]);
		expect(mocks.lookupProfilesViaBird).toHaveBeenCalledWith(
			["sam"],
			"profile-primary",
		);
	});

	it("resolves placeholder profiles through bird and reuses persistent cache", async () => {
		mocks.lookupProfileViaBird.mockResolvedValueOnce({
			id: "42",
			username: "sam",
			name: "Sam Altman",
			description: "Working on AGI",
			location: "San Francisco",
			url: "https://openai.com",
			verified: true,
			verified_type: "blue",
			entities: {
				url: {
					urls: [
						{
							url: "https://t.co/openai",
							expanded_url: "https://openai.com",
						},
					],
				},
			},
			affiliation: {
				organizationIds: ["profile_org_openai"],
				description: "OpenAI",
				url: "https://x.com/OpenAI",
				badgeUrl: "https://cdn.example/openai.png",
			},
			profile_image_url:
				"https://pbs.twimg.com/profile_images/42/avatar_normal.jpg",
			public_metrics: { followers_count: 123, following_count: 45 },
		});
		const { resolveProfilesForIds } = await import("./profile-resolver");

		await expect(resolveProfilesForIds(["profile_user_42"])).resolves.toEqual([
			expect.objectContaining({
				status: "hit",
				source: "bird",
				profile: expect.objectContaining({
					handle: "sam",
					location: "San Francisco",
					url: "https://openai.com",
					verifiedType: "blue",
				}),
			}),
		]);
		expect(mocks.lookupUsersByIds).not.toHaveBeenCalled();

		const db = getNativeDb();
		db.prepare(
			"update profiles set handle = 'id42', display_name = 'id42', bio = 'Imported from archive user 42', followers_count = 0 where id = 'profile_user_42'",
		).run();
		await expect(resolveProfilesForIds(["profile_user_42"])).resolves.toEqual([
			expect.objectContaining({
				status: "hit",
				source: "cache",
				profile: expect.objectContaining({ handle: "sam" }),
			}),
		]);
		expect(mocks.lookupProfileViaBird).toHaveBeenCalledTimes(1);
		expect(
			db
				.prepare(
					"select organization_profile_id, organization_name, organization_handle, url from profile_affiliations where subject_profile_id = 'profile_user_42'",
				)
				.get(),
		).toEqual({
			organization_profile_id: "profile_org_openai",
			organization_name: "OpenAI",
			organization_handle: "OpenAI",
			url: "https://x.com/OpenAI",
		});
	});

	it("negative-caches failed lookups", async () => {
		mocks.lookupProfileViaBird.mockRejectedValueOnce(new Error("bird down"));
		mocks.lookupUsersByIds.mockRejectedValueOnce(new Error("xurl down"));
		const { resolveProfilesForIds } = await import("./profile-resolver");

		await expect(resolveProfilesForIds(["profile_user_42"])).resolves.toEqual([
			expect.objectContaining({
				status: "error",
				source: "xurl",
				error: "xurl down",
			}),
		]);
		await expect(resolveProfilesForIds(["profile_user_42"])).resolves.toEqual([
			expect.objectContaining({
				status: "error",
				source: "negative-cache",
				error: "xurl down",
			}),
		]);
		expect(mocks.lookupProfileViaBird).toHaveBeenCalledTimes(1);
		expect(mocks.lookupUsersByIds).toHaveBeenCalledTimes(1);
	});

	it("resolves handle-only profiles through bird and xurl fallback", async () => {
		const db = getNativeDb();
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, created_at) values ('profile_local_fcoury', 'fcoury', 'Felipe Coury', '', 0, 42, '2026-05-01T00:00:00.000Z')",
		).run();
		mocks.lookupProfilesViaBird.mockResolvedValueOnce([
			{
				target: "fcoury",
				user: null,
			},
		]);
		mocks.lookupUsersByHandles.mockResolvedValueOnce([
			{
				id: "123",
				username: "fcoury",
				name: "Felipe Coury",
				description: "Ruby and Rails",
				profile_image_url:
					"https://pbs.twimg.com/profile_images/123/avatar_normal.jpg",
				public_metrics: { followers_count: 456, following_count: 7 },
			},
		]);
		const { resolveProfilesForHandles } = await import("./profile-resolver");

		await expect(resolveProfilesForHandles(["@fcoury"])).resolves.toEqual([
			expect.objectContaining({
				handle: "fcoury",
				status: "hit",
				source: "xurl",
				profile: expect.objectContaining({
					id: "profile_local_fcoury",
					handle: "fcoury",
					avatarUrl: "https://pbs.twimg.com/profile_images/123/avatar.jpg",
					followersCount: 456,
				}),
			}),
		]);
		expect(mocks.lookupUsersByHandles).toHaveBeenCalledWith(["fcoury"]);
	});

	it("hydrates synthetic highlighted-label affiliations into real org profiles", async () => {
		const db = getNativeDb();
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, created_at) values ('profile_user_43', 'id43', 'id43', 'Imported from archive user 43', 0, 211, '2009-03-19T22:54:05.000Z')",
		).run();
		mocks.lookupProfilesViaBird.mockResolvedValueOnce([
			{
				target: "42",
				user: {
					id: "42",
					username: "rauchg",
					name: "Guillermo Rauch",
					description: "CEO at Vercel",
					affiliation: {
						description: "Vercel",
						url: "https://x.com/vercel",
						badgeUrl: "https://cdn.example/vercel.png",
					},
					public_metrics: { followers_count: 999, following_count: 50 },
				},
			},
			{
				target: "43",
				user: {
					id: "43",
					username: "othervercel",
					name: "Other Vercel",
					description: "Also at Vercel",
					affiliation: {
						description: "Vercel",
						url: "https://x.com/vercel",
						badgeUrl: "https://cdn.example/vercel.png",
					},
					public_metrics: { followers_count: 100, following_count: 50 },
				},
			},
		]);
		mocks.lookupProfileViaBird.mockResolvedValueOnce({
			id: "999",
			username: "vercel",
			name: "Vercel",
			description: "The frontend cloud",
			public_metrics: { followers_count: 1000, following_count: 10 },
		});
		const { resolveProfilesForIds } = await import("./profile-resolver");

		await expect(
			resolveProfilesForIds(["profile_user_42", "profile_user_43"]),
		).resolves.toEqual([
			expect.objectContaining({
				status: "hit",
				source: "bird",
				affiliationHydration: expect.objectContaining({
					checked: 1,
					hydrated: 1,
				}),
			}),
			expect.objectContaining({
				status: "hit",
				source: "bird",
				affiliationHydration: expect.objectContaining({
					checked: 1,
					hydrated: 1,
				}),
			}),
		]);

		expect(mocks.lookupProfileViaBird).toHaveBeenCalledWith(
			"vercel",
			"profile-primary",
		);
		expect(mocks.lookupProfilesViaBird).toHaveBeenCalledWith(
			["42", "43"],
			"profile-primary",
		);
		expect(
			mocks.lookupProfileViaBird.mock.calls.filter(
				([target]) => target === "vercel",
			),
		).toHaveLength(1);
		expect(
			db
				.prepare(
					`
          select organization_profile_id, organization_name, organization_handle
          from profile_affiliations
          where subject_profile_id = 'profile_user_42'
          `,
				)
				.get(),
		).toEqual({
			organization_profile_id: "profile_user_999",
			organization_name: "Vercel",
			organization_handle: "vercel",
		});
		expect(
			db
				.prepare(
					`
          select organization_profile_id, organization_name, organization_handle
          from profile_affiliations
          where subject_profile_id = 'profile_user_43'
          `,
				)
				.get(),
		).toEqual({
			organization_profile_id: "profile_user_999",
			organization_name: "Vercel",
			organization_handle: "vercel",
		});
		expect(
			db
				.prepare(
					`
          select affiliations_json
          from profile_snapshots
          where profile_id = 'profile_user_42'
            and source = 'affiliation_hydration'
          `,
				)
				.get(),
		).toEqual({
			affiliations_json: expect.stringContaining("profile_user_999"),
		});
	});

	it("returns local non-placeholder profiles without live lookup", async () => {
		const db = getNativeDb();
		db.prepare(
			"update profiles set handle = 'sam', display_name = 'Sam Altman', bio = 'Working on AGI', followers_count = 123 where id = 'profile_user_42'",
		).run();
		const { resolveProfilesForIds } = await import("./profile-resolver");

		await expect(
			resolveProfilesForIds(["profile_user_42", "profile_me"]),
		).resolves.toEqual([
			expect.objectContaining({
				status: "hit",
				source: "local",
				profile: expect.objectContaining({ handle: "sam" }),
			}),
			expect.objectContaining({
				profileId: "profile_me",
				externalUserId: null,
				status: "miss",
				source: "local",
			}),
		]);
		expect(mocks.lookupProfileViaBird).not.toHaveBeenCalled();
		expect(mocks.lookupUsersByIds).not.toHaveBeenCalled();
	});

	it("can skip xurl fallback and can use xurl after a bird miss", async () => {
		mocks.lookupProfileViaBird.mockRejectedValueOnce(new Error("bird down"));
		const { resolveProfilesForIds } = await import("./profile-resolver");

		await expect(
			resolveProfilesForIds(["profile_user_42"], { xurlFallback: false }),
		).resolves.toEqual([
			expect.objectContaining({
				status: "error",
				source: "bird",
				error: "bird down",
			}),
		]);
		expect(mocks.lookupUsersByIds).not.toHaveBeenCalled();

		mocks.lookupProfileViaBird.mockResolvedValueOnce(null);
		mocks.lookupUsersByIds.mockResolvedValueOnce([
			{
				id: "42",
				username: "sam",
				name: "Sam Altman",
				description: "Working on AGI",
				public_metrics: { followers_count: 123, following_count: 45 },
			},
		]);
		await expect(
			resolveProfilesForIds(["profile_user_42"], { refresh: true }),
		).resolves.toEqual([
			expect.objectContaining({
				status: "hit",
				source: "xurl",
				profile: expect.objectContaining({ handle: "sam" }),
			}),
		]);
		expect(mocks.lookupUsersByIds).toHaveBeenCalledWith(["42"]);

		mocks.lookupProfileViaBird.mockResolvedValueOnce(null);
		await expect(
			resolveProfilesForIds(["profile_user_42"], {
				xurlFallback: false,
				refresh: true,
			}),
		).resolves.toEqual([
			expect.objectContaining({
				status: "miss",
				source: "bird",
			}),
		]);
	});

	it("handles batch bird errors and unresolved users", async () => {
		const db = getNativeDb();
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, created_at) values ('profile_user_43', 'id43', 'id43', 'Imported from archive user 43', 0, 211, '2009-03-19T22:54:05.000Z')",
		).run();
		const { resolveProfilesForIds } = await import("./profile-resolver");

		mocks.lookupProfilesViaBird.mockRejectedValueOnce(new Error("bird down"));
		await expect(
			resolveProfilesForIds(["profile_user_42", "profile_user_43"], {
				xurlFallback: false,
				refresh: true,
			}),
		).resolves.toEqual([
			expect.objectContaining({
				status: "error",
				source: "bird",
				error: "bird down",
			}),
			expect.objectContaining({
				status: "error",
				source: "bird",
				error: "bird down",
			}),
		]);

		mocks.lookupProfilesViaBird.mockResolvedValueOnce([
			{ target: "42", error: "not found" },
			{ target: "43" },
		]);
		await expect(
			resolveProfilesForIds(["profile_user_42", "profile_user_43"], {
				xurlFallback: false,
				refresh: true,
			}),
		).resolves.toEqual([
			expect.objectContaining({
				status: "error",
				source: "bird",
				error: "not found",
			}),
			expect.objectContaining({
				status: "miss",
				source: "bird",
			}),
		]);

		mocks.lookupProfilesViaBird.mockResolvedValueOnce([{ target: "42" }]);
		mocks.lookupUsersByIds.mockRejectedValueOnce(new Error("xurl down"));
		await expect(
			resolveProfilesForIds(["profile_user_42", "profile_user_43"], {
				refresh: true,
			}),
		).resolves.toEqual([
			expect.objectContaining({
				status: "error",
				source: "xurl",
				error: "xurl down",
			}),
			expect.objectContaining({
				status: "error",
				source: "xurl",
				error: "xurl down",
			}),
		]);

		mocks.lookupProfilesViaBird.mockResolvedValueOnce([{ target: "42" }]);
		mocks.lookupUsersByIds.mockResolvedValueOnce([]);
		await expect(
			resolveProfilesForIds(["profile_user_42", "profile_user_43"], {
				refresh: true,
			}),
		).resolves.toEqual([
			expect.objectContaining({
				status: "miss",
				source: "xurl",
			}),
			expect.objectContaining({
				status: "miss",
				source: "xurl",
			}),
		]);
	});

	it("summarizes placeholder hydration batches", async () => {
		mocks.lookupProfileViaBird.mockResolvedValueOnce({
			id: "42",
			username: "sam",
			name: "Sam Altman",
			public_metrics: { followers_count: 123, following_count: 45 },
		});
		const { resolvePlaceholderProfiles } = await import("./profile-resolver");

		await expect(resolvePlaceholderProfiles({ limit: 10 })).resolves.toEqual(
			expect.objectContaining({
				ok: true,
				requestedProfiles: 1,
				hydratedProfiles: 1,
			}),
		);
	});

	it("classifies placeholder profile variants", async () => {
		const { __test__ } = await import("./profile-resolver");
		const baseProfile = {
			id: "profile_user_55",
			handle: "real",
			displayName: "Real",
			bio: "Real bio",
			followersCount: 1,
			followingCount: 0,
			avatarHue: 10,
			createdAt: "2026-05-01T00:00:00.000Z",
		};

		expect(__test__.isPlaceholderProfile(baseProfile)).toBe(false);
		expect(
			__test__.isPlaceholderProfile({
				...baseProfile,
				handle: "id55",
			}),
		).toBe(true);
		expect(
			__test__.isPlaceholderProfile({
				...baseProfile,
				handle: "user_55",
			}),
		).toBe(true);
		expect(
			__test__.isPlaceholderProfile({
				...baseProfile,
				displayName: "id55",
			}),
		).toBe(true);
		expect(
			__test__.isPlaceholderProfile({
				...baseProfile,
				displayName: "user_55",
			}),
		).toBe(true);
		expect(
			__test__.isPlaceholderProfile({
				...baseProfile,
				bio: "Imported from archive user 55",
			}),
		).toBe(true);
		expect(
			__test__.isPlaceholderProfile({
				...baseProfile,
				bio: "Imported from archive user 55 with extras",
				followersCount: 0,
			}),
		).toBe(true);
		expect(
			__test__.isPlaceholderProfile({
				...baseProfile,
				id: "profile_me",
			}),
		).toBe(false);
		expect(__test__.cacheKeyForUserId("55")).toBe("profile:lookup:user-id:55");
	});
});
