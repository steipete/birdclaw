// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { syncIdentitySearchIndexForProfileIds } from "./identity-search-index";
import { recordProfileSnapshot } from "./profile-history";
import {
	canonicalizeProvenXProfileIdentity,
	upsertProfileFromXUser,
} from "./x-profile";

const mocks = vi.hoisted(() => ({
	getTransportStatus: vi.fn(),
	lookupAuthenticatedUser: vi.fn(),
	lookupUsersByIds: vi.fn(),
	getAuthenticatedBirdAccount: vi.fn(),
}));

vi.mock("./xurl", async () => {
	const { effectFromMock: fromMock } = await import("../test/effect-mocks");
	return {
		getTransportStatusEffect: fromMock(mocks.getTransportStatus),
		lookupAuthenticatedUserEffect: fromMock(mocks.lookupAuthenticatedUser),
		lookupAuthenticatedUserUnscopedEffect: fromMock(
			mocks.lookupAuthenticatedUser,
		),
		lookupAuthenticatedOAuth2UserEffect: fromMock(
			mocks.lookupAuthenticatedUser,
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
			username: "steipete",
			name: "Peter Steinberger",
			description: "Bio",
			profile_image_url:
				"https://pbs.twimg.com/profile_images/7/avatar_bigger.jpg",
			created_at: "2009-03-19T22:54:05.000Z",
			public_metrics: { followers_count: 421507, following_count: 1234 },
		});

		const { hydrateProfilesFromX } = await import("./profile-hydration");
		const result = await hydrateProfilesFromX({ account: "steipete" });
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
		expect(mocks.lookupAuthenticatedUser).toHaveBeenCalledWith("steipete");
		expect(mocks.lookupUsersByIds).toHaveBeenCalledWith(["42"], {
			username: "steipete",
		});
	});

	it("verifies a selected credential before bulk profile writes", async () => {
		mocks.getTransportStatus.mockResolvedValue({
			availableTransport: "xurl",
			installed: true,
			statusText: "xurl available",
		});
		mocks.lookupAuthenticatedUser.mockResolvedValue({
			id: "999",
			username: "different_user",
		});
		const { hydrateProfilesFromX } = await import("./profile-hydration");

		await expect(hydrateProfilesFromX({ account: "steipete" })).rejects.toThrow(
			"refusing to sync",
		);
		expect(mocks.lookupUsersByIds).not.toHaveBeenCalled();
	});

	it("Bird selector canonicalizes a proven rawless profile_me with references", async () => {
		const db = getNativeDb();
		db.exec(
			"delete from profile_snapshots; delete from tweets; delete from profiles; delete from accounts;",
		);
		db.prepare(
			"insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at) values ('acct_primary', 'Selected Bird', '@selectedbird', '8101', 'bird', 1, '2025-01-01T00:00:00.000Z')",
		).run();
		db.prepare(
			`insert into profiles (id, handle, display_name, bio, followers_count,
			 avatar_hue, avatar_url, raw_json, created_at) values
			 ('profile_me', 'selectedbird', 'Selected Bird Rich', 'rich bird bio', 81,
			  81, 'https://img.example/8101.jpg', '{}', '2025-01-01T00:00:00.000Z')`,
		).run();
		db.prepare(
			"insert into tweets (id, author_profile_id, text, created_at) values ('selected-bird-tweet', 'profile_me', 'proof', '2025-01-01T00:00:00.000Z')",
		).run();
		recordProfileSnapshot(db, "profile_me", "selected_bird_proof");
		mocks.getTransportStatus.mockResolvedValue({
			availableTransport: "local",
			installed: true,
			statusText: "bird only",
		});
		mocks.getAuthenticatedBirdAccount.mockResolvedValue({
			id: "8101",
			username: "selectedbird",
			name: "Selected Bird Live",
		});
		const { hydrateProfilesFromX } = await import("./profile-hydration");

		await hydrateProfilesFromX({ account: "acct_primary" });

		expect(
			db.prepare("select 1 from profiles where id = 'profile_me'").get(),
		).toBeUndefined();
		expect(
			db
				.prepare(
					"select handle, bio, followers_count, avatar_url from profiles where id = 'profile_user_8101'",
				)
				.get(),
		).toEqual({
			handle: "selectedbird",
			bio: "rich bird bio",
			followers_count: 81,
			avatar_url: "https://img.example/8101.jpg",
		});
		expect(
			db
				.prepare(
					"select author_profile_id from tweets where id = 'selected-bird-tweet'",
				)
				.get(),
		).toEqual({ author_profile_id: "profile_user_8101" });
		expect(
			db
				.prepare(
					"select count(*) as count from profile_snapshots where profile_id = 'profile_user_8101'",
				)
				.get(),
		).toMatchObject({ count: expect.any(Number) });
	});

	it("selected Xurl hydration canonicalizes a proven rawless profile_me", async () => {
		const db = getNativeDb();
		db.exec(
			"delete from profile_snapshots; delete from tweets; delete from profiles; delete from accounts;",
		);
		db.prepare(
			"insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at) values ('acct_primary', 'Selected Xurl', '@selectedxurl', '8102', 'xurl', 1, '2025-01-01T00:00:00.000Z')",
		).run();
		db.prepare(
			`insert into profiles (id, handle, display_name, bio, followers_count,
			 avatar_hue, raw_json, created_at) values
			 ('profile_me', 'selectedxurl', 'Selected Xurl Rich', 'rich xurl bio', 82,
			  82, '{}', '2025-01-01T00:00:00.000Z')`,
		).run();
		db.prepare(
			"insert into tweets (id, author_profile_id, text, created_at) values ('selected-xurl-tweet', 'profile_me', 'proof', '2025-01-01T00:00:00.000Z')",
		).run();
		recordProfileSnapshot(db, "profile_me", "selected_xurl_proof");
		mocks.getTransportStatus.mockResolvedValue({
			availableTransport: "xurl",
			installed: true,
			statusText: "xurl available",
		});
		mocks.lookupUsersByIds.mockResolvedValue([]);
		mocks.lookupAuthenticatedUser.mockResolvedValue({
			id: "8102",
			username: "selectedxurl",
			name: "Selected Xurl Live",
			description: "live xurl bio",
			public_metrics: { followers_count: 820, following_count: 28 },
		});
		const { hydrateProfilesFromX } = await import("./profile-hydration");

		await hydrateProfilesFromX({ account: "acct_primary" });

		expect(
			db.prepare("select 1 from profiles where id = 'profile_me'").get(),
		).toBeUndefined();
		expect(
			db
				.prepare(
					"select handle, bio, followers_count from profiles where id = 'profile_user_8102'",
				)
				.get(),
		).toEqual({
			handle: "selectedxurl",
			bio: "live xurl bio",
			followers_count: 820,
		});
		expect(
			db
				.prepare(
					"select author_profile_id from tweets where id = 'selected-xurl-tweet'",
				)
				.get(),
		).toEqual({ author_profile_id: "profile_user_8102" });
		expect(
			db
				.prepare(
					"select count(*) as count from profile_snapshots where profile_id = 'profile_user_8102'",
				)
				.get(),
		).toMatchObject({ count: expect.any(Number) });
	});

	it("does not overwrite the primary profile for a selected secondary account", async () => {
		const db = getNativeDb();
		db.prepare(
			`insert into accounts
			 (id, name, handle, external_user_id, transport, is_default, created_at)
			 values ('acct_secondary', 'Secondary', '@secondary', '999', 'xurl', 0, '2026-01-01T00:00:00.000Z')`,
		).run();
		const before = db
			.prepare(
				"select handle, display_name, avatar_url from profiles where id = 'profile_me'",
			)
			.get();
		mocks.getTransportStatus.mockResolvedValue({
			availableTransport: "xurl",
			installed: true,
			statusText: "xurl available",
		});
		mocks.lookupAuthenticatedUser.mockResolvedValue({
			id: "999",
			username: "secondary",
			name: "Secondary Updated",
			public_metrics: { followers_count: 10 },
		});
		mocks.lookupUsersByIds.mockResolvedValue([]);
		const { hydrateProfilesFromX } = await import("./profile-hydration");

		await expect(
			hydrateProfilesFromX({ account: "acct_secondary" }),
		).resolves.toMatchObject({ hydratedAccount: true });
		expect(
			db
				.prepare(
					"select handle, display_name, avatar_url from profiles where id = 'profile_me'",
				)
				.get(),
		).toEqual(before);
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
				"xurl installed but not authenticated. local/archive mode active.",
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
				"select handle, display_name, avatar_url from profiles where id = 'profile_user_987654321'",
			)
			.get() as {
			handle: string;
			display_name: string;
			avatar_url: string | null;
		};
		expect(profile.handle).toBe("realuser");
		expect(profile.display_name).toBe("Real User");
		expect(profile.avatar_url).toBeNull();
		expect(
			db
				.prepare(
					"select handle, avatar_url from profiles where id = 'profile_me'",
				)
				.get(),
		).toEqual({
			handle: "steipete",
			avatar_url: "https://example.com/steipete.png",
		});
		expect(mocks.lookupUsersByIds).not.toHaveBeenCalled();
	});

	it("preserves a rich same-account display name when Bird omits name", async () => {
		const db = getNativeDb();
		db.exec("delete from profiles; delete from accounts;");
		db.prepare(
			"insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at) values ('acct_primary', 'Rich Account Name', '@oldname', '7001', 'bird', 1, '2025-01-01T00:00:00.000Z')",
		).run();
		db.prepare(
			`insert into profiles (id, handle, display_name, bio, followers_count,
			 avatar_hue, raw_json, created_at) values
			 ('profile_user_7001', 'oldname', 'Rich Profile Name', 'rich bio', 70, 7,
			 '{"id":"7001","username":"oldname"}', '2025-01-01T00:00:00.000Z')`,
		).run();
		mocks.getTransportStatus.mockResolvedValue({
			availableTransport: "local",
			installed: true,
			statusText: "local mode",
		});
		mocks.getAuthenticatedBirdAccount.mockResolvedValue({
			id: "7001",
			username: "renamed7001",
		});
		const { hydrateProfilesFromX } = await import("./profile-hydration");

		await hydrateProfilesFromX();

		expect(
			db
				.prepare(
					"select handle, display_name, bio from profiles where id = 'profile_user_7001'",
				)
				.get(),
		).toEqual({
			handle: "renamed7001",
			display_name: "Rich Profile Name",
			bio: "rich bio",
		});
	});

	it("preserves a rich target display name when Bird switches accounts without name", async () => {
		const db = getNativeDb();
		db.exec("delete from profiles; delete from accounts;");
		db.prepare(
			"insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at) values ('acct_primary', 'Seed Account', '@steipete', '25401953', 'xurl', 1, '2025-01-01T00:00:00.000Z')",
		).run();
		db.prepare(
			`insert into profiles (id, handle, display_name, bio, followers_count,
			 avatar_hue, raw_json, created_at) values
			 ('profile_user_7003', 'targetold', 'Rich Target Name', 'target bio', 73, 8,
			 '{"id":"7003","username":"targetold"}', '2025-01-01T00:00:00.000Z')`,
		).run();
		mocks.getTransportStatus.mockResolvedValue({
			availableTransport: "local",
			installed: true,
			statusText: "local mode",
		});
		mocks.getAuthenticatedBirdAccount.mockResolvedValue({
			id: "7003",
			username: "targetnew",
		});
		const { hydrateProfilesFromX } = await import("./profile-hydration");

		await hydrateProfilesFromX();

		expect(
			db
				.prepare(
					"select handle, display_name, bio from profiles where id = 'profile_user_7003'",
				)
				.get(),
		).toEqual({
			handle: "targetnew",
			display_name: "Rich Target Name",
			bio: "target bio",
		});
		expect(
			db
				.prepare(
					"select external_user_id, handle from accounts where id = 'acct_primary'",
				)
				.get(),
		).toEqual({ external_user_id: "7003", handle: "@targetnew" });
	});

	it("proves Bird identity from pre-update state and preserves rich profile_me on switch", async () => {
		const db = getNativeDb();
		db.exec(`
			delete from identity_search_index;
			delete from profile_snapshots;
			delete from tweets;
			delete from profiles;
			delete from accounts;
		`);
		db.prepare(
			"insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at) values ('acct_primary', 'Previous', '@steipete', '25401953', 'xurl', 1, '2009-03-19T22:54:05.000Z')",
		).run();
		db.prepare(
			`insert into profiles (
			 id, handle, display_name, bio, followers_count, following_count,
			 public_metrics_json, avatar_hue, avatar_url, location, url,
			 verified_type, entities_json, raw_json, created_at
			) values (
			 'profile_me', 'steipete', 'Previous Person', 'rich previous bio',
			 1000, 500, '{"followers_count":1000,"following_count":500}', 18,
			 'https://example.com/previous.png', 'Previous City',
			 'https://previous.example', 'blue',
			 '{"description":{"urls":[{"expanded_url":"https://previous.example"}]}}',
			 '{"id":"25401953","username":"steipete","previous":true}',
			 '2009-03-19T22:54:05.000Z'
			)`,
		).run();
		db.prepare(
			"insert into tweets (id, author_profile_id, text, created_at) values ('previous-tweet', 'profile_me', 'previous reference', '2025-01-01T00:00:00.000Z')",
		).run();
		const snapshotHash = recordProfileSnapshot(db, "profile_me", "pre_upgrade");
		syncIdentitySearchIndexForProfileIds(db, ["profile_me"]);
		const previousIndex = db
			.prepare(
				"select kind, value, source from identity_search_index where profile_id = 'profile_me' order by kind, value, source",
			)
			.all();
		mocks.getTransportStatus.mockResolvedValue({
			availableTransport: "local",
			installed: true,
			statusText: "local/archive mode active.",
		});
		mocks.getAuthenticatedBirdAccount.mockResolvedValue({
			username: "brandnewproof",
			id: "987654323",
			name: "Brand New Proof",
		});
		const { hydrateProfilesFromX } = await import("./profile-hydration");

		await expect(hydrateProfilesFromX()).resolves.toMatchObject({
			hydratedProfiles: 0,
			hydratedAccount: true,
		});
		upsertProfileFromXUser(db, {
			id: "987654323",
			username: "brandnewproof",
			name: "Brand New Proof Live",
			description: "new account live bio",
			public_metrics: { followers_count: 23, following_count: 7 },
		});

		expect(
			db.prepare("select * from profiles where id = 'profile_me'").get(),
		).toMatchObject({
			handle: "steipete",
			display_name: "Previous Person",
			bio: "rich previous bio",
			followers_count: 1000,
			following_count: 500,
			public_metrics_json: '{"followers_count":1000,"following_count":500}',
			avatar_url: "https://example.com/previous.png",
			location: "Previous City",
			url: "https://previous.example",
			verified_type: "blue",
			entities_json:
				'{"description":{"urls":[{"expanded_url":"https://previous.example"}]}}',
			raw_json:
				'{"id":"25401953","username":"steipete","previous":true,"birdclaw_identity_conflicts":["987654323"]}',
		});
		expect(
			db
				.prepare(
					"select handle, display_name, bio, followers_count, raw_json from profiles where id = 'profile_user_987654323'",
				)
				.get(),
		).toEqual({
			handle: "brandnewproof",
			display_name: "Brand New Proof Live",
			bio: "new account live bio",
			followers_count: 23,
			raw_json: expect.stringContaining('"id":"987654323"'),
		});
		expect(
			db
				.prepare(
					"select author_profile_id from tweets where id = 'previous-tweet'",
				)
				.get(),
		).toEqual({ author_profile_id: "profile_me" });
		expect(
			db
				.prepare(
					"select snapshot_hash from profile_snapshots where profile_id = 'profile_me'",
				)
				.all(),
		).toEqual([{ snapshot_hash: snapshotHash }]);
		expect(
			db
				.prepare(
					"select kind, value, source from identity_search_index where profile_id = 'profile_me' order by kind, value, source",
				)
				.all(),
		).toEqual(previousIndex);
		expect(
			db
				.prepare(
					"select value from identity_search_index where profile_id = 'profile_user_987654323' and kind = 'profile_handle'",
				)
				.all(),
		).toContainEqual({ value: "brandnewproof" });
		expect(
			db
				.prepare(
					"select handle, external_user_id from accounts where id = 'acct_primary'",
				)
				.get(),
		).toEqual({ handle: "@brandnewproof", external_user_id: "987654323" });
	});

	it("preserves historical profile_me on a same-handle numeric account switch", async () => {
		const db = getNativeDb();
		db.exec(`
			delete from identity_search_index;
			delete from profiles;
			delete from accounts;
		`);
		db.prepare(
			"insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at) values ('acct_primary', 'Previous', '@steipete', '25401953', 'xurl', 1, '2009-03-19T22:54:05.000Z')",
		).run();
		db.prepare(
			`insert into profiles (
			 id, handle, display_name, bio, followers_count, following_count,
			 public_metrics_json, avatar_hue, avatar_url, entities_json, raw_json,
			 created_at
			) values (
			 'profile_me', 'steipete', 'Previous', 'same-handle history', 500, 50,
			 '{"followers_count":500}', 18, 'https://example.com/previous.png',
			 '{"description":{"previous":true}}',
			 '{"id":"25401953","username":"steipete","previous":true}',
			 '2009-03-19T22:54:05.000Z'
			)`,
		).run();
		syncIdentitySearchIndexForProfileIds(db, ["profile_me"]);
		const previousIndex = db
			.prepare(
				"select kind, value from identity_search_index where profile_id = 'profile_me' order by kind, value",
			)
			.all();
		mocks.getTransportStatus.mockResolvedValue({
			availableTransport: "local",
			installed: true,
			statusText: "local/archive mode active.",
		});
		mocks.getAuthenticatedBirdAccount.mockResolvedValue({
			username: "steipete",
			id: "987654324",
			name: "New Same Handle",
		});
		const { hydrateProfilesFromX } = await import("./profile-hydration");

		await expect(hydrateProfilesFromX()).resolves.toMatchObject({
			hydratedAccount: true,
		});
		const firstCanonical = db
			.prepare(
				"select handle, raw_json from profiles where id = 'profile_user_987654324'",
			)
			.get() as { handle: string; raw_json: string };
		expect(firstCanonical.handle).toMatch(/^birdclaw_stub_/);
		expect(JSON.parse(firstCanonical.raw_json)).toMatchObject({
			id: "987654324",
			username: "steipete",
		});
		upsertProfileFromXUser(db, {
			id: "987654324",
			username: "steipete",
			name: "New Same Handle Live",
			description: "new live account",
			public_metrics: { followers_count: 24 },
		});

		expect(
			db
				.prepare(
					"select handle, bio, followers_count, raw_json from profiles where id = 'profile_me'",
				)
				.get(),
		).toEqual({
			handle: "steipete",
			bio: "same-handle history",
			followers_count: 500,
			raw_json:
				'{"id":"25401953","username":"steipete","previous":true,"birdclaw_identity_conflicts":["987654324"]}',
		});
		expect(
			db
				.prepare(
					"select handle, bio from profiles where id = 'profile_user_987654324'",
				)
				.get(),
		).toEqual({ handle: firstCanonical.handle, bio: "new live account" });
		expect(
			db
				.prepare(
					"select kind, value from identity_search_index where profile_id = 'profile_me' order by kind, value",
				)
				.all(),
		).toEqual(previousIndex);
		expect(
			db
				.prepare(
					"select count(*) as count from profiles where lower(handle) = 'steipete'",
				)
				.get(),
		).toEqual({ count: 1 });
	});

	it("durably blocks later adoption of unproven profile_me without raw numeric identity", async () => {
		const db = getNativeDb();
		db.exec(`
			delete from profiles;
			delete from accounts;
		`);
		db.prepare(
			"insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at) values ('acct_primary', 'Previous', '@steipete', '25401953', 'xurl', 1, '2009-03-19T22:54:05.000Z')",
		).run();
		db.prepare(
			`insert into profiles (id, handle, display_name, bio, followers_count,
			 avatar_hue, raw_json, created_at) values
			 ('profile_me', 'steipete', 'Previous', 'rawless history', 55, 18, '{}',
			  '2009-03-19T22:54:05.000Z')`,
		).run();
		mocks.getTransportStatus.mockResolvedValue({
			availableTransport: "local",
			installed: true,
			statusText: "local/archive mode active.",
		});
		mocks.getAuthenticatedBirdAccount.mockResolvedValue({
			username: "brandnewrawless",
			id: "987654325",
			name: "Brand New Rawless",
		});
		const { hydrateProfilesFromX } = await import("./profile-hydration");
		await hydrateProfilesFromX();

		canonicalizeProvenXProfileIdentity(db, "987654325", "brandnewrawless");
		upsertProfileFromXUser(db, {
			id: "987654325",
			username: "brandnewrawless",
			name: "Brand New Rawless Live",
		});

		const preserved = db
			.prepare(
				"select handle, bio, followers_count, raw_json from profiles where id = 'profile_me'",
			)
			.get() as Record<string, unknown>;
		expect(preserved).toMatchObject({
			handle: "steipete",
			bio: "rawless history",
			followers_count: 55,
		});
		expect(JSON.parse(String(preserved.raw_json))).toMatchObject({
			birdclaw_identity_conflicts: ["987654325"],
		});
		expect(
			db
				.prepare("select id from profiles where id = 'profile_user_987654325'")
				.get(),
		).toEqual({ id: "profile_user_987654325" });
	});

	it("canonicalizes profile_me when pre-update account identity proves the same id", async () => {
		const db = getNativeDb();
		db.exec(`
			delete from tweets;
			delete from profiles;
			delete from accounts;
		`);
		db.prepare(
			"insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at) values ('acct_primary', 'Same', '@sameaccount', '424242', 'bird', 1, '2020-01-01T00:00:00.000Z')",
		).run();
		db.prepare(
			`insert into profiles (id, handle, display_name, bio, followers_count,
			 avatar_hue, raw_json, created_at) values
			 ('profile_me', 'sameaccount', 'Same Account', 'same identity history', 42,
			  18, '{}', '2020-01-01T00:00:00.000Z')`,
		).run();
		db.prepare(
			"insert into tweets (id, author_profile_id, text, created_at) values ('same-tweet', 'profile_me', 'same reference', '2025-01-01T00:00:00.000Z')",
		).run();
		mocks.getTransportStatus.mockResolvedValue({
			availableTransport: "local",
			installed: true,
			statusText: "local/archive mode active.",
		});
		mocks.getAuthenticatedBirdAccount.mockResolvedValue({
			username: "sameaccount",
			id: "424242",
			name: "Same Account Updated",
		});
		const { hydrateProfilesFromX } = await import("./profile-hydration");

		await expect(hydrateProfilesFromX()).resolves.toMatchObject({
			hydratedAccount: true,
		});

		expect(
			db.prepare("select id from profiles where id = 'profile_me'").get(),
		).toBeUndefined();
		expect(
			db
				.prepare(
					"select handle, bio, followers_count from profiles where id = 'profile_user_424242'",
				)
				.get(),
		).toEqual({
			handle: "sameaccount",
			bio: "same identity history",
			followers_count: 42,
		});
		expect(
			db
				.prepare("select author_profile_id from tweets where id = 'same-tweet'")
				.get(),
		).toEqual({ author_profile_id: "profile_user_424242" });
	});

	it("creates a new canonical profile when Bird switches after profile_me was rekeyed", async () => {
		const db = getNativeDb();
		db.exec(`
			delete from profiles;
			delete from accounts;
		`);
		db.prepare(
			"insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at) values ('acct_primary', 'Peter', '@steipete', '25401953', 'xurl', 1, '2009-03-19T22:54:05.000Z')",
		).run();
		db.prepare(
			`insert into profiles (
			 id, handle, display_name, bio, followers_count, avatar_hue, avatar_url,
			 raw_json, created_at
			) values (
			 'profile_user_25401953', 'steipete', 'Peter', 'existing rich account',
			 1000, 18, 'https://example.com/old.png',
			 '{"id":"25401953","username":"steipete"}',
			 '2009-03-19T22:54:05.000Z'
			)`,
		).run();
		mocks.getTransportStatus.mockResolvedValue({
			availableTransport: "local",
			installed: true,
			statusText: "local/archive mode active.",
		});
		mocks.getAuthenticatedBirdAccount.mockResolvedValue({
			username: "brandnew",
			id: "987654322",
			name: "Brand New",
		});
		const { hydrateProfilesFromX } = await import("./profile-hydration");

		await expect(hydrateProfilesFromX()).resolves.toMatchObject({
			hydratedProfiles: 0,
			hydratedAccount: true,
		});

		expect(
			db
				.prepare(
					"select handle, display_name, bio, followers_count from profiles where id = 'profile_user_987654322'",
				)
				.get(),
		).toEqual({
			handle: "brandnew",
			display_name: "Brand New",
			bio: "",
			followers_count: 0,
		});
		expect(
			db
				.prepare(
					"select handle, bio, followers_count, avatar_url from profiles where id = 'profile_user_25401953'",
				)
				.get(),
		).toEqual({
			handle: "steipete",
			bio: "existing rich account",
			followers_count: 1000,
			avatar_url: "https://example.com/old.png",
		});
		expect(
			db
				.prepare(
					"select handle, external_user_id from accounts where id = 'acct_primary'",
				)
				.get(),
		).toEqual({ handle: "@brandnew", external_user_id: "987654322" });
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
				"xurl installed but not authenticated. local/archive mode active.",
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
				"xurl installed but not authenticated. local/archive mode active.",
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
				"xurl installed but not authenticated. local/archive mode active.",
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
