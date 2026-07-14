// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";

const mocks = vi.hoisted(() => ({
	getTransportStatus: vi.fn(),
	lookupAuthenticatedUser: vi.fn(),
	lookupAuthenticatedOAuth2User: vi.fn(),
	lookupUsersByIds: vi.fn(),
	getAuthenticatedBirdAccount: vi.fn(),
}));

vi.mock("./xurl", async () => {
	const { effectFromMock: fromMock } = await import("../test/effect-mocks");
	return {
		getTransportStatusEffect: fromMock(mocks.getTransportStatus),
		lookupAuthenticatedUserEffect: fromMock(mocks.lookupAuthenticatedUser),
		lookupAuthenticatedOAuth2UserEffect: fromMock(
			mocks.lookupAuthenticatedOAuth2User,
		),
		lookupUsersByIdsEffect: fromMock(mocks.lookupUsersByIds),
	};
});

vi.mock("./bird", async () => {
	const { effectFromMock: fromMock } = await import("../test/effect-mocks");
	return {
		getAuthenticatedBirdAccountEffect: fromMock(
			mocks.getAuthenticatedBirdAccount,
		),
	};
});

describe("profile hydration", () => {
	let homeDir = "";

	beforeEach(() => {
		homeDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-hydrate-"));
		process.env.BIRDCLAW_HOME = homeDir;
		resetBirdclawPathsForTests();
		resetDatabaseForTests();
		mocks.getTransportStatus.mockReset();
		mocks.lookupAuthenticatedUser.mockReset();
		mocks.lookupAuthenticatedOAuth2User.mockReset();
		mocks.lookupUsersByIds.mockReset();
		mocks.getAuthenticatedBirdAccount.mockReset();
		mocks.getAuthenticatedBirdAccount.mockRejectedValue(
			new Error("bird unavailable"),
		);
	});

	afterEach(() => {
		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		delete process.env.BIRDCLAW_HOME;
		rmSync(homeDir, { recursive: true, force: true });
	});

	it("builds profile hydration effects lazily", async () => {
		mocks.getTransportStatus.mockResolvedValue({
			availableTransport: "local",
			installed: false,
			statusText: "xurl missing",
		});
		const { hydrateProfilesFromXEffect } = await import("./profile-hydration");

		const effect = hydrateProfilesFromXEffect();

		expect(mocks.getTransportStatus).not.toHaveBeenCalled();
		await expect(Effect.runPromise(effect)).resolves.toMatchObject({
			hydratedProfiles: 0,
			hydratedAccount: false,
			reason: "xurl missing",
		});
		expect(mocks.lookupUsersByIds).not.toHaveBeenCalled();
	});

	it("hydrates imported placeholder profiles from xurl", async () => {
		const db = getNativeDb();
		db.exec(`
      delete from ai_scores;
      delete from tweet_actions;
      delete from dm_fts;
      delete from tweets_fts;
      delete from dm_messages;
      delete from dm_conversations;
      delete from tweets;
      delete from profiles;
      delete from accounts;
    `);
		db.prepare(
			"insert into accounts (id, name, handle, transport, is_default, created_at) values ('acct_primary', 'Peter', '@steipete', 'archive', 1, '2009-03-19T22:54:05.000Z')",
		).run();
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, created_at) values ('profile_me', 'steipete', 'Peter', '', 0, 18, '2009-03-19T22:54:05.000Z')",
		).run();
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, created_at) values ('profile_user_42', 'id42', 'id42', 'Imported from archive user 42', 0, 210, '2009-03-19T22:54:05.000Z')",
		).run();
		db.prepare(
			"insert into dm_conversations (id, account_id, participant_profile_id, title, last_message_at, unread_count, needs_reply) values ('dm_1', 'acct_primary', 'profile_user_42', 'id42', '2025-06-03T20:00:00.000Z', 0, 1)",
		).run();

		mocks.getTransportStatus.mockResolvedValue({
			availableTransport: "xurl",
			installed: true,
			statusText: "xurl available",
		});
		mocks.lookupUsersByIds.mockResolvedValue([
			{
				id: "42",
				username: "sam",
				name: "Sam Altman",
				description: "Working on AGI",
				profile_image_url:
					"https://pbs.twimg.com/profile_images/42/avatar_normal.jpg",
				created_at: "2020-01-01T00:00:00.000Z",
				public_metrics: { followers_count: 123, following_count: 45 },
			},
		]);
		mocks.lookupAuthenticatedUser.mockResolvedValue({
			id: "25401953",
			username: "steipete",
			name: "Peter Steinberger",
			description: "Bio",
			profile_image_url:
				"https://pbs.twimg.com/profile_images/7/avatar_bigger.jpg",
			created_at: "2009-03-19T22:54:05.000Z",
			public_metrics: { followers_count: 421507, following_count: 1234 },
		});

		const { hydrateProfilesFromX } = await import("./profile-hydration");
		const result = await hydrateProfilesFromX();
		const hydrated = db
			.prepare(
				"select handle, display_name, bio, followers_count, following_count, avatar_url from profiles where id = 'profile_user_42'",
			)
			.get() as {
			handle: string;
			display_name: string;
			bio: string;
			followers_count: number;
			following_count: number;
			avatar_url: string;
		};
		const title = db
			.prepare("select title from dm_conversations where id = 'dm_1'")
			.get() as {
			title: string;
		};

		expect(result).toMatchObject({
			hydratedProfiles: 1,
			hydratedAccount: true,
		});
		expect(hydrated).toEqual({
			handle: "sam",
			display_name: "Sam Altman",
			bio: "Working on AGI",
			followers_count: 123,
			following_count: 45,
			avatar_url: "https://pbs.twimg.com/profile_images/42/avatar.jpg",
		});
		expect(title.title).toBe("Sam Altman");
		expect(
			db
				.prepare(
					"select handle, external_user_id from accounts where id = 'acct_primary'",
				)
				.get(),
		).toEqual({ handle: "@steipete", external_user_id: "25401953" });
	});

	it("selects an explicit authenticated xurl account", async () => {
		const db = getNativeDb();
		mocks.getTransportStatus.mockResolvedValue({
			availableTransport: "xurl",
			installed: true,
			statusText: "xurl available",
		});
		mocks.lookupUsersByIds.mockResolvedValue([]);
		mocks.lookupAuthenticatedOAuth2User.mockResolvedValue({
			id: "1493511301808721921",
			username: "ikuznetsov_com",
			name: "Ivan Kuznetsov",
			description: "Builder",
			public_metrics: { followers_count: 218, following_count: 299 },
		});

		const { hydrateProfilesFromX } = await import("./profile-hydration");
		await expect(
			hydrateProfilesFromX({ account: "ikuznetsov_com" }),
		).resolves.toMatchObject({
			hydratedAccount: true,
			account: {
				handle: "@ikuznetsov_com",
				externalUserId: "1493511301808721921",
			},
		});

		expect(mocks.lookupAuthenticatedOAuth2User).toHaveBeenCalledWith(
			"ikuznetsov_com",
		);
		expect(
			db
				.prepare(
					"select name, handle, external_user_id, transport from accounts where id = 'acct_primary'",
				)
				.get(),
		).toEqual({
			name: "Ivan Kuznetsov",
			handle: "@ikuznetsov_com",
			external_user_id: "1493511301808721921",
			transport: "xurl",
		});
	});

	it("does not replace an imported primary account during init", async () => {
		const db = getNativeDb();
		db.prepare(
			"update accounts set name = ?, handle = ?, external_user_id = ? where id = 'acct_primary'",
		).run("Archive Owner", "@archive_owner", "42");
		mocks.getTransportStatus.mockResolvedValue({
			availableTransport: "xurl",
			installed: true,
			statusText: "xurl available",
		});
		mocks.lookupUsersByIds.mockResolvedValue([]);
		mocks.lookupAuthenticatedOAuth2User.mockResolvedValue({
			id: "1493511301808721921",
			username: "ikuznetsov_com",
			name: "Ivan Kuznetsov",
		});

		const { hydrateProfilesFromX } = await import("./profile-hydration");
		await expect(
			hydrateProfilesFromX({
				account: "ikuznetsov_com",
				seededAccountOnly: true,
			}),
		).resolves.toMatchObject({
			hydratedAccount: false,
			reason: "Primary account is not the untouched demo seed",
		});

		expect(
			db
				.prepare(
					"select name, handle, external_user_id from accounts where id = 'acct_primary'",
				)
				.get(),
		).toEqual({
			name: "Archive Owner",
			handle: "@archive_owner",
			external_user_id: "42",
		});
	});

	it("skips non-numeric archive placeholder ids before calling X", async () => {
		const db = getNativeDb();
		db.exec(`
      delete from ai_scores;
      delete from tweet_actions;
      delete from dm_fts;
      delete from tweets_fts;
      delete from dm_messages;
      delete from dm_conversations;
      delete from tweets;
      delete from profiles;
      delete from accounts;
    `);
		db.prepare(
			"insert into accounts (id, name, handle, transport, is_default, created_at) values ('acct_primary', 'Peter', '@steipete', 'archive', 1, '2009-03-19T22:54:05.000Z')",
		).run();
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, created_at) values ('profile_me', 'steipete', 'Peter', '', 0, 18, '2009-03-19T22:54:05.000Z')",
		).run();
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, created_at) values ('profile_user_42', 'id42', 'id42', 'Imported from archive user 42', 0, 210, '2009-03-19T22:54:05.000Z')",
		).run();
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, created_at) values ('profile_user_9388262-9388262', 'id9388262-9388262', 'id9388262-9388262', 'Imported from archive user 9388262-9388262', 0, 210, '2009-03-19T22:54:05.000Z')",
		).run();
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, created_at) values ('profile_user_not-a-user', 'idnot-a-user', 'idnot-a-user', 'Imported from archive user not-a-user', 0, 210, '2009-03-19T22:54:05.000Z')",
		).run();

		mocks.getTransportStatus.mockResolvedValue({
			availableTransport: "xurl",
			installed: true,
			statusText: "xurl available",
		});
		mocks.lookupUsersByIds.mockResolvedValue([
			{
				id: "42",
				username: "sam",
				name: "Sam Altman",
			},
		]);
		mocks.lookupAuthenticatedUser.mockResolvedValue(null);

		const { hydrateProfilesFromX } = await import("./profile-hydration");
		const result = await hydrateProfilesFromX();

		expect(mocks.lookupUsersByIds).toHaveBeenCalledTimes(1);
		expect(mocks.lookupUsersByIds).toHaveBeenCalledWith(["42"]);
		expect(result).toMatchObject({
			hydratedProfiles: 1,
			hydratedAccount: false,
		});
	});

	it("covers hydration helper guards", async () => {
		const { __test__ } = await import("./profile-hydration");

		expect(__test__.asRecord(null)).toBeNull();
		expect(__test__.asRecord([])).toBeNull();
		expect(__test__.asRecord({ ok: true })).toEqual({ ok: true });
		expect(__test__.toInt(12.8)).toBe(12);
		expect(__test__.toInt("oops")).toBe(0);
		expect(__test__.toInt("12")).toBe(12);
	});

	it("returns early when live transport is unavailable", async () => {
		mocks.getTransportStatus.mockResolvedValue({
			availableTransport: "local",
			installed: false,
			statusText: "xurl missing",
		});

		const { hydrateProfilesFromX } = await import("./profile-hydration");
		await expect(hydrateProfilesFromX()).resolves.toMatchObject({
			hydratedProfiles: 0,
			hydratedAccount: false,
			reason: "xurl missing",
		});
		expect(mocks.lookupUsersByIds).not.toHaveBeenCalled();
	});

	it("hydrates the account handle from bird when xurl is unavailable", async () => {
		const db = getNativeDb();
		db.exec(`
      delete from profiles;
      delete from accounts;
    `);
		db.prepare(
			"insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at) values ('acct_primary', 'Peter', '@steipete', '25401953', 'xurl', 1, '2009-03-19T22:54:05.000Z')",
		).run();
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, avatar_url, created_at) values ('profile_me', 'steipete', 'Peter', '', 0, 18, 'https://example.com/steipete.png', '2009-03-19T22:54:05.000Z')",
		).run();

		mocks.getTransportStatus.mockResolvedValue({
			availableTransport: "local",
			installed: true,
			statusText:
				"xurl installed but not authenticated. local (bird) mode active.",
		});
		mocks.getAuthenticatedBirdAccount.mockResolvedValue({
			username: "realuser",
			id: "987654321",
			name: "Real User",
		});

		const { hydrateProfilesFromX } = await import("./profile-hydration");
		await expect(hydrateProfilesFromX()).resolves.toMatchObject({
			hydratedProfiles: 0,
			hydratedAccount: true,
		});

		const account = db
			.prepare(
				"select handle, name, transport, external_user_id from accounts where id = 'acct_primary'",
			)
			.get() as {
			handle: string;
			name: string;
			transport: string;
			external_user_id: string | null;
		};
		expect(account.handle).toBe("@realuser");
		expect(account.name).toBe("Real User");
		expect(account.transport).toBe("bird");
		expect(account.external_user_id).toBe("987654321");
		const profile = db
			.prepare(
				"select handle, display_name, avatar_url from profiles where id = 'profile_me'",
			)
			.get() as {
			handle: string;
			display_name: string;
			avatar_url: string | null;
		};
		expect(profile.handle).toBe("realuser");
		expect(profile.display_name).toBe("Real User");
		expect(profile.avatar_url).toBeNull();
		expect(mocks.lookupUsersByIds).not.toHaveBeenCalled();
	});

	it("clears stale id and avatar when bird returns a changed handle without an id", async () => {
		const db = getNativeDb();
		db.exec(`
      delete from profiles;
      delete from accounts;
    `);
		db.prepare(
			"insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at) values ('acct_primary', 'Peter', '@steipete', '25401953', 'xurl', 1, '2009-03-19T22:54:05.000Z')",
		).run();
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, avatar_url, created_at) values ('profile_me', 'steipete', 'Peter', '', 0, 18, 'https://example.com/steipete.png', '2009-03-19T22:54:05.000Z')",
		).run();

		mocks.getTransportStatus.mockResolvedValue({
			availableTransport: "local",
			installed: true,
			statusText:
				"xurl installed but not authenticated. local (bird) mode active.",
		});
		// bird whoami reports a different handle but no numeric id.
		mocks.getAuthenticatedBirdAccount.mockResolvedValue({
			username: "someoneelse",
			name: "Someone Else",
		});

		const { hydrateProfilesFromX } = await import("./profile-hydration");
		await expect(hydrateProfilesFromX()).resolves.toMatchObject({
			hydratedProfiles: 0,
			hydratedAccount: true,
		});

		const account = db
			.prepare(
				"select handle, name, external_user_id from accounts where id = 'acct_primary'",
			)
			.get() as {
			handle: string;
			name: string;
			external_user_id: string | null;
		};
		expect(account.handle).toBe("@someoneelse");
		expect(account.name).toBe("Someone Else");
		// The previous account's id must not linger on a changed handle.
		expect(account.external_user_id).toBeNull();
		const profile = db
			.prepare(
				"select handle, avatar_url from profiles where id = 'profile_me'",
			)
			.get() as { handle: string; avatar_url: string | null };
		expect(profile.handle).toBe("someoneelse");
		expect(profile.avatar_url).toBeNull();
	});

	it("refuses to relabel an archive-verified account from a different bird identity", async () => {
		const db = getNativeDb();
		db.exec(`
      delete from profiles;
      delete from accounts;
    `);
		db.prepare(
			"insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at) values ('acct_primary', 'Archive User', '@archiveuser', '111111111', 'archive', 1, '2009-03-19T22:54:05.000Z')",
		).run();
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, avatar_url, created_at) values ('profile_me', 'archiveuser', 'Archive User', '', 0, 18, 'https://example.com/archive.png', '2009-03-19T22:54:05.000Z')",
		).run();

		mocks.getTransportStatus.mockResolvedValue({
			availableTransport: "local",
			installed: true,
			statusText:
				"xurl installed but not authenticated. local (bird) mode active.",
		});
		mocks.getAuthenticatedBirdAccount.mockResolvedValue({
			username: "differentuser",
			id: "222222222",
			name: "Different User",
		});

		const { hydrateProfilesFromX } = await import("./profile-hydration");
		await expect(hydrateProfilesFromX()).resolves.toMatchObject({
			hydratedProfiles: 0,
			hydratedAccount: false,
		});

		const account = db
			.prepare(
				"select handle, name, external_user_id, transport from accounts where id = 'acct_primary'",
			)
			.get();
		expect(account).toEqual({
			handle: "@archiveuser",
			name: "Archive User",
			external_user_id: "111111111",
			transport: "archive",
		});
		const profile = db
			.prepare(
				"select handle, display_name, avatar_url from profiles where id = 'profile_me'",
			)
			.get();
		expect(profile).toEqual({
			handle: "archiveuser",
			display_name: "Archive User",
			avatar_url: "https://example.com/archive.png",
		});
	});

	it("preserves the stored id and avatar when the handle is unchanged", async () => {
		const db = getNativeDb();
		db.exec(`
      delete from profiles;
      delete from accounts;
    `);
		db.prepare(
			"insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at) values ('acct_primary', 'Real User', '@realuser', '987654321', 'bird', 1, '2009-03-19T22:54:05.000Z')",
		).run();
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, avatar_url, created_at) values ('profile_me', 'realuser', 'Real User', '', 0, 18, 'https://example.com/realuser.png', '2009-03-19T22:54:05.000Z')",
		).run();

		mocks.getTransportStatus.mockResolvedValue({
			availableTransport: "local",
			installed: true,
			statusText:
				"xurl installed but not authenticated. local (bird) mode active.",
		});
		// Same handle, no id this run: existing id and avatar should survive.
		mocks.getAuthenticatedBirdAccount.mockResolvedValue({
			username: "realuser",
			name: "Real User",
		});

		const { hydrateProfilesFromX } = await import("./profile-hydration");
		await expect(hydrateProfilesFromX()).resolves.toMatchObject({
			hydratedAccount: true,
		});

		const account = db
			.prepare(
				"select handle, external_user_id from accounts where id = 'acct_primary'",
			)
			.get() as { handle: string; external_user_id: string | null };
		expect(account.handle).toBe("@realuser");
		expect(account.external_user_id).toBe("987654321");
		const profile = db
			.prepare("select avatar_url from profiles where id = 'profile_me'")
			.get() as { avatar_url: string | null };
		expect(profile.avatar_url).toBe("https://example.com/realuser.png");
	});

	it("handles empty user batches and missing authenticated user", async () => {
		const db = getNativeDb();
		db.exec(`
      delete from ai_scores;
      delete from tweet_actions;
      delete from dm_fts;
      delete from tweets_fts;
      delete from dm_messages;
      delete from dm_conversations;
      delete from tweets;
      delete from profiles;
      delete from accounts;
    `);
		db.prepare(
			"insert into accounts (id, name, handle, transport, is_default, created_at) values ('acct_primary', 'Peter', '@steipete', 'archive', 1, '2009-03-19T22:54:05.000Z')",
		).run();
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, created_at) values ('profile_me', 'steipete', 'Peter', '', 0, 18, '2009-03-19T22:54:05.000Z')",
		).run();

		mocks.getTransportStatus.mockResolvedValue({
			availableTransport: "xurl",
			installed: true,
			statusText: "xurl available",
		});
		mocks.lookupAuthenticatedUser.mockResolvedValue(null);

		const { hydrateProfilesFromX } = await import("./profile-hydration");
		await expect(hydrateProfilesFromX()).resolves.toMatchObject({
			hydratedProfiles: 0,
			hydratedAccount: false,
		});
		expect(mocks.lookupUsersByIds).not.toHaveBeenCalled();
	});

	it("keeps default account fields when authenticated payload is sparse", async () => {
		mocks.getTransportStatus.mockResolvedValue({
			availableTransport: "xurl",
			installed: true,
			statusText: "xurl available",
		});
		mocks.lookupUsersByIds.mockResolvedValue([
			{
				id: "",
				username: "skip",
				name: "Skip",
			},
		]);
		mocks.lookupAuthenticatedUser.mockResolvedValue({
			public_metrics: "not metrics",
		});

		const { hydrateProfilesFromX } = await import("./profile-hydration");
		const result = await hydrateProfilesFromX();
		const db = getNativeDb();
		const me = db
			.prepare(
				"select handle, display_name, bio, followers_count, following_count from profiles where id = 'profile_me'",
			)
			.get() as Record<string, unknown>;
		const account = db
			.prepare(
				"select name, handle, transport from accounts where id = 'acct_primary'",
			)
			.get() as Record<string, unknown>;

		expect(result).toMatchObject({
			hydratedAccount: true,
		});
		expect(me).toEqual({
			handle: "steipete",
			display_name: "Peter Steinberger",
			bio: "",
			followers_count: 0,
			following_count: 0,
		});
		expect(account).toEqual({
			name: "Peter Steinberger",
			handle: "@steipete",
			transport: "xurl",
		});
	});
});
