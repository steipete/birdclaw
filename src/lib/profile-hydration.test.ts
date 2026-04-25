// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";

const mocks = vi.hoisted(() => ({
	getTransportStatus: vi.fn(),
	lookupAuthenticatedUser: vi.fn(),
	lookupUsersByIds: vi.fn(),
}));

vi.mock("./xurl", () => ({
	getTransportStatus: mocks.getTransportStatus,
	lookupAuthenticatedUser: mocks.lookupAuthenticatedUser,
	lookupUsersByIds: mocks.lookupUsersByIds,
}));

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
	});

	afterEach(() => {
		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		delete process.env.BIRDCLAW_HOME;
		rmSync(homeDir, { recursive: true, force: true });
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
				public_metrics: { followers_count: 123 },
			},
		]);
		mocks.lookupAuthenticatedUser.mockResolvedValue({
			username: "steipete",
			name: "Peter Steinberger",
			description: "Bio",
			profile_image_url:
				"https://pbs.twimg.com/profile_images/7/avatar_bigger.jpg",
			created_at: "2009-03-19T22:54:05.000Z",
			public_metrics: { followers_count: 421507 },
		});

		const { hydrateProfilesFromX } = await import("./profile-hydration");
		const result = await hydrateProfilesFromX();
		const hydrated = db
			.prepare(
				"select handle, display_name, bio, followers_count, avatar_url from profiles where id = 'profile_user_42'",
			)
			.get() as {
			handle: string;
			display_name: string;
			bio: string;
			followers_count: number;
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
			avatar_url: "https://pbs.twimg.com/profile_images/42/avatar.jpg",
		});
		expect(title.title).toBe("Sam Altman");
	});

	it("covers hydration helper guards", async () => {
		const { __test__ } = await import("./profile-hydration");

		expect(__test__.asRecord(null)).toBeNull();
		expect(__test__.asRecord([])).toBeNull();
		expect(__test__.asRecord({ ok: true })).toEqual({ ok: true });
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
});
