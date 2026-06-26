// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";

const mocks = vi.hoisted(() => ({
	blockUserViaBird: vi.fn(),
	lookupProfileViaBird: vi.fn(),
	readBirdStatusViaBird: vi.fn(),
	blockUserViaXurl: vi.fn(),
	listBlockedUsers: vi.fn(),
	lookupAuthenticatedUser: vi.fn(),
	lookupUsersByHandles: vi.fn(),
	lookupUsersByIds: vi.fn(),
	unblockUserViaBird: vi.fn(),
	unblockUserViaXurl: vi.fn(),
}));

vi.mock("./bird-actions", () => ({
	blockUserViaBird: mocks.blockUserViaBird,
	lookupProfileViaBird: mocks.lookupProfileViaBird,
	readBirdStatusViaBird: mocks.readBirdStatusViaBird,
	unblockUserViaBird: mocks.unblockUserViaBird,
}));

vi.mock("./xurl", () => ({
	blockUserViaXurl: mocks.blockUserViaXurl,
	listBlockedUsers: mocks.listBlockedUsers,
	lookupAuthenticatedUser: mocks.lookupAuthenticatedUser,
	lookupAuthenticatedUserFresh: mocks.lookupAuthenticatedUser,
	lookupUsersByHandles: mocks.lookupUsersByHandles,
	lookupUsersByIds: mocks.lookupUsersByIds,
	unblockUserViaXurl: mocks.unblockUserViaXurl,
}));

const tempRoots: string[] = [];

function setupTempHome() {
	const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-blocks-"));
	tempRoots.push(tempRoot);
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
	const db = getNativeDb();
	db.prepare(
		"update accounts set bird_profile_name = ? where id = ?",
	).run("profile-primary", "acct_primary");
	db.prepare(
		"update accounts set bird_profile_name = ? where id = ?",
	).run("profile-studio", "acct_studio");
}

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	delete process.env.BIRDCLAW_DISABLE_LIVE_WRITES;
	mocks.blockUserViaBird.mockReset();
	mocks.lookupProfileViaBird.mockReset();
	mocks.readBirdStatusViaBird.mockReset();
	mocks.blockUserViaXurl.mockReset();
	mocks.listBlockedUsers.mockReset();
	mocks.lookupAuthenticatedUser.mockReset();
	mocks.lookupUsersByHandles.mockReset();
	mocks.lookupUsersByIds.mockReset();
	mocks.unblockUserViaBird.mockReset();
	mocks.unblockUserViaXurl.mockReset();

	for (const tempRoot of tempRoots.splice(0)) {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

describe("blocklist", () => {
	beforeEach(() => {
		delete process.env.BIRDCLAW_DISABLE_LIVE_WRITES;
		mocks.lookupProfileViaBird.mockResolvedValue(null);
		mocks.lookupAuthenticatedUser.mockResolvedValue({
			id: "25401953",
			username: "steipete",
		});
		mocks.listBlockedUsers.mockResolvedValue({ items: [], nextToken: null });
		mocks.readBirdStatusViaBird.mockResolvedValue({
			blocking: true,
			muting: false,
		});
		mocks.blockUserViaBird.mockResolvedValue({
			ok: true,
			output: "blocked via bird; verified blocking=true",
		});
		mocks.blockUserViaXurl.mockResolvedValue({
			ok: true,
			output: "blocked via xurl",
		});
		mocks.unblockUserViaBird.mockResolvedValue({
			ok: true,
			output: "unblocked via bird; verified blocking=false",
		});
		mocks.unblockUserViaXurl.mockResolvedValue({
			ok: true,
			output: "unblocked via xurl",
		});
		mocks.lookupUsersByHandles.mockResolvedValue([
			{
				id: "7",
				username: "amelia",
				name: "Amelia N",
				description: "Design systems",
				profile_image_url:
					"https://pbs.twimg.com/profile_images/7/avatar_normal.jpg",
				public_metrics: { followers_count: 4200 },
			},
		]);
		mocks.lookupUsersByIds.mockResolvedValue([
			{
				id: "8",
				username: "avawires",
				name: "Ava Wires",
				description: "Infra reporter",
				profile_image_url:
					"https://pbs.twimg.com/profile_images/8/avatar_bigger.jpg",
				public_metrics: { followers_count: 632000 },
			},
		]);
	});

	it("builds block write effects lazily", async () => {
		setupTempHome();
		const { addBlockEffect } = await import("./blocks");

		const effect = addBlockEffect("acct_primary", "@amelia");

		expect(mocks.lookupUsersByHandles).not.toHaveBeenCalled();
		expect(mocks.blockUserViaBird).not.toHaveBeenCalled();
		await expect(Effect.runPromise(effect)).resolves.toMatchObject({
			ok: true,
			action: "block",
			accountId: "acct_primary",
		});
		expect(mocks.lookupUsersByHandles).toHaveBeenCalledWith(["amelia"]);
		expect(mocks.blockUserViaBird).toHaveBeenCalledWith("7", "profile-primary");
	});

	it("blocks, lists, searches, and unblocks profiles", async () => {
		setupTempHome();
		const { addBlock, getBlocksResponse, listBlocks, removeBlock } =
			await import("./blocks");

		const addResult = await addBlock("acct_primary", "@amelia");
		expect(addResult.transport).toEqual({
			ok: true,
			output: "blocked via bird; verified blocking=true",
			transport: "bird",
		});
		expect(mocks.lookupUsersByHandles).toHaveBeenCalledWith(["amelia"]);
		expect(mocks.blockUserViaBird).toHaveBeenCalledWith("7", "profile-primary");

		const listed = listBlocks({ account: "acct_primary" });
		expect(listed).toHaveLength(1);
		expect(listed[0]?.profile.handle).toBe("amelia");
		expect(listed[0]?.profile.avatarUrl).toBe(
			"https://pbs.twimg.com/profile_images/7/avatar.jpg",
		);

		const response = getBlocksResponse({
			accountId: "acct_primary",
			search: "amelia",
			limit: 10,
		});
		expect(response.items).toHaveLength(1);
		expect(response.matches[0]?.isBlocked).toBe(true);

		const removeResult = await removeBlock("acct_primary", "amelia");
		expect(removeResult.transport).toEqual({
			ok: true,
			output: "unblocked via bird; verified blocking=false",
			transport: "bird",
		});
		expect(mocks.unblockUserViaBird).toHaveBeenCalledWith("7", "profile-primary");
		expect(listBlocks({ account: "acct_primary" })).toHaveLength(0);
	});

	it("resolves numeric ids and blocks only the selected account", async () => {
		setupTempHome();
		const { addBlock, listBlocks } = await import("./blocks");
		mocks.lookupAuthenticatedUser.mockResolvedValue({
			id: "42",
			username: "birdclaw_lab",
		});

		await addBlock("acct_studio", "8");

		expect(mocks.lookupUsersByIds).toHaveBeenCalledWith(["8"]);
		expect(listBlocks({ account: "acct_studio" })[0]?.profile.handle).toBe(
			"avawires",
		);
		expect(listBlocks({ account: "acct_primary" })).toHaveLength(0);
	});

	it("does not persist local blocks when bird transport fails", async () => {
		setupTempHome();
		mocks.blockUserViaBird.mockResolvedValue({
			ok: false,
			output: "bird block failed",
		});
		const { addBlock, listBlocks } = await import("./blocks");

		const result = await addBlock("acct_primary", "amelia", {
			transport: "bird",
		});

		expect(result.ok).toBe(false);
		expect(result.transport).toEqual({
			ok: false,
			output: "bird block failed",
			transport: "bird",
		});
		expect(listBlocks({ account: "acct_primary" })).toHaveLength(0);
	});

	it("rejects blocking the current account", async () => {
		setupTempHome();
		const { addBlock } = await import("./blocks");

		await expect(addBlock("acct_primary", "@steipete")).rejects.toThrow(
			"Cannot block the current account",
		);
	});

	it("returns empty matches for blank search", async () => {
		setupTempHome();
		const { getBlocksResponse } = await import("./blocks");

		expect(
			getBlocksResponse({ accountId: "acct_primary", search: "   " }).matches,
		).toEqual([]);
	});

	it("uses the default account id when omitted", async () => {
		setupTempHome();
		const { addBlock, listBlocks } = await import("./blocks");

		const result = await addBlock("", "amelia");

		expect(result.accountId).toBe("acct_primary");
		expect(listBlocks({ account: "acct_primary" })).toHaveLength(1);
	});

	it("can force xurl transport for block and unblock", async () => {
		setupTempHome();
		const { addBlock, listBlocks, removeBlock } = await import("./blocks");
		mocks.readBirdStatusViaBird
			.mockResolvedValueOnce({
				blocking: true,
				muting: false,
			})
			.mockResolvedValueOnce({
				blocking: false,
				muting: false,
			});

		const addResult = await addBlock("acct_primary", "@amelia", {
			transport: "xurl",
		});
		const removeResult = await removeBlock("acct_primary", "@amelia", {
			transport: "xurl",
		});

		expect(addResult.transport).toEqual({
			ok: true,
			output: "blocked via xurl\nverified blocking=true",
			transport: "xurl",
		});
		expect(removeResult.transport).toEqual({
			ok: true,
			output: "unblocked via xurl\nverified blocking=false",
			transport: "xurl",
		});
		expect(mocks.blockUserViaXurl).toHaveBeenCalledWith("25401953", "7");
		expect(mocks.unblockUserViaXurl).toHaveBeenCalledWith("25401953", "7");
		expect(mocks.blockUserViaBird).not.toHaveBeenCalled();
		expect(mocks.unblockUserViaBird).not.toHaveBeenCalled();
		expect(listBlocks({ account: "acct_primary" })).toHaveLength(0);
	});

	it("syncs remote blocks, prunes stale remote rows, and preserves manual rows", async () => {
		setupTempHome();
		const { addBlock, listBlocks, syncBlocks } = await import("./blocks");

		await addBlock("acct_primary", "amelia");
		const db = getNativeDb();
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, created_at) values ('profile_user_99', 'stale', 'Stale', '', 0, 20, '2026-03-08T12:00:00.000Z')",
		).run();
		db.prepare(
			"insert into blocks (account_id, profile_id, source, created_at) values ('acct_primary', 'profile_user_99', 'remote', '2026-03-08T12:00:00.000Z')",
		).run();
		mocks.listBlockedUsers
			.mockResolvedValueOnce({
				items: [
					{
						id: "8",
						username: "avawires",
						name: "Ava Wires",
						description: "Infra reporter",
						profile_image_url:
							"https://pbs.twimg.com/profile_images/8/avatar_bigger.jpg",
						public_metrics: { followers_count: 632000 },
					},
				],
				nextToken: "next",
			})
			.mockResolvedValueOnce({
				items: [
					{
						id: "9",
						username: "fortune",
						name: "Fortune",
						description: "source: trust me bro",
						profile_image_url:
							"https://pbs.twimg.com/profile_images/9/avatar_mini.jpg",
						public_metrics: { followers_count: 9 },
					},
				],
				nextToken: null,
			});

		const result = await syncBlocks("acct_primary");
		const listed = listBlocks({ account: "acct_primary" });

		expect(result.transport).toEqual({
			ok: true,
			output: "synced 2 remote blocks",
		});
		expect(mocks.listBlockedUsers).toHaveBeenNthCalledWith(
			1,
			"25401953",
			undefined,
		);
		expect(mocks.listBlockedUsers).toHaveBeenNthCalledWith(
			2,
			"25401953",
			"next",
		);
		expect(listed.map((item) => item.profile.handle).sort()).toEqual([
			"amelia",
			"avawires",
			"fortune",
		]);
		expect(listed.some((item) => item.profile.handle === "stale")).toBe(false);
		expect(
			listed.find((item) => item.profile.handle === "amelia")?.source,
		).toBe("manual");
	});

	it("exposes remote block sync as an Effect program", async () => {
		setupTempHome();
		mocks.listBlockedUsers.mockResolvedValueOnce({
			items: [
				{
					id: "8",
					username: "avawires",
					name: "Ava Wires",
					description: "Infra reporter",
					profile_image_url:
						"https://pbs.twimg.com/profile_images/8/avatar_bigger.jpg",
					public_metrics: { followers_count: 632000 },
				},
			],
			nextToken: null,
		});
		const { syncBlocksEffect } = await import("./blocks");

		await expect(
			Effect.runPromise(syncBlocksEffect("acct_primary")),
		).resolves.toMatchObject({
			ok: true,
			synced: true,
			syncedCount: 1,
		});
	});

	it("skips remote sync when the authenticated xurl account does not match", async () => {
		setupTempHome();
		mocks.lookupAuthenticatedUser.mockResolvedValue({
			id: "2",
			username: "someoneelse",
		});
		const { syncBlocks, listBlocks } = await import("./blocks");

		const result = await syncBlocks("acct_primary");

		expect(result.transport).toEqual({
			ok: false,
			output: "xurl is authenticated as user 2, not account acct_primary",
		});
		expect(listBlocks({ account: "acct_primary" })).toHaveLength(0);
		expect(mocks.listBlockedUsers).not.toHaveBeenCalled();
	});

	it("skips remote sync when only the authenticated user id mismatches", async () => {
		setupTempHome();
		mocks.lookupAuthenticatedUser.mockResolvedValue({ id: "2" });
		const { syncBlocks, listBlocks } = await import("./blocks");

		const result = await syncBlocks("acct_primary");

		expect(result.transport).toEqual({
			ok: false,
			output: "xurl is authenticated as user 2, not account acct_primary",
		});
		expect(listBlocks({ account: "acct_primary" })).toHaveLength(0);
		expect(mocks.listBlockedUsers).not.toHaveBeenCalled();
	});

	it("returns a structured sync failure when xurl paging fails", async () => {
		setupTempHome();
		mocks.listBlockedUsers.mockRejectedValue(new Error("rate limited"));
		const { syncBlocks, listBlocks } = await import("./blocks");

		const result = await syncBlocks("acct_primary");

		expect(result.transport).toEqual({
			ok: false,
			output: "rate limited",
		});
		expect(result.synced).toBe(false);
		expect(listBlocks({ account: "acct_primary" })).toHaveLength(0);
	});

	it("keeps earlier pages when a later block sync page fails", async () => {
		setupTempHome();
		mocks.listBlockedUsers
			.mockResolvedValueOnce({
				items: [
					{
						id: "8",
						username: "avawires",
						name: "Ava Wires",
						description: "Infra reporter",
						profile_image_url:
							"https://pbs.twimg.com/profile_images/8/avatar_bigger.jpg",
						public_metrics: { followers_count: 632000 },
					},
				],
				nextToken: "next",
			})
			.mockRejectedValueOnce(new Error("rate limited"));
		const { listBlocks, syncBlocks } = await import("./blocks");

		const result = await syncBlocks("acct_primary");

		expect(result.synced).toBe(true);
		expect(result.syncedCount).toBe(1);
		expect(result.transport).toEqual({
			ok: false,
			output: "partial block sync after 1 profiles: rate limited",
		});
		expect(
			listBlocks({ account: "acct_primary" }).map(
				(item) => item.profile.handle,
			),
		).toEqual(["avawires"]);
	});

	it("keeps local rows when bird unblock fails", async () => {
		setupTempHome();
		mocks.unblockUserViaBird.mockResolvedValue({
			ok: false,
			output: "bird unblock failed",
		});
		const { addBlock, listBlocks, removeBlock } = await import("./blocks");

		await addBlock("acct_primary", "amelia");
		const result = await removeBlock("acct_primary", "amelia", {
			transport: "bird",
		});

		expect(result.ok).toBe(false);
		expect(result.transport).toEqual({
			ok: false,
			output: "bird unblock failed",
			transport: "bird",
		});
		expect(listBlocks({ account: "acct_primary" })).toHaveLength(1);
	});

	it("throws for blank or unknown profiles", async () => {
		setupTempHome();
		mocks.lookupUsersByHandles.mockResolvedValue([]);
		const { addBlock } = await import("./blocks");

		await expect(addBlock("acct_primary", "   ")).rejects.toThrow(
			"Missing profile handle or id",
		);
		await expect(addBlock("acct_primary", "@nobody")).rejects.toThrow(
			"Profile not found: @nobody",
		);
	});

	it("skips remote lookup for profile ids that already encode external ids", async () => {
		setupTempHome();
		const db = getNativeDb();
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, created_at) values ('profile_user_99', 'newuser', 'New User', '', 0, 20, '2026-03-08T12:00:00.000Z')",
		).run();

		const { addBlock } = await import("./blocks");
		await addBlock("acct_primary", "profile_user_99");

		expect(mocks.lookupUsersByHandles).not.toHaveBeenCalled();
		expect(mocks.lookupUsersByIds).not.toHaveBeenCalled();
		expect(mocks.blockUserViaBird).toHaveBeenCalledWith("99", "profile-primary");
	});

	it("persists block rows in sqlite", async () => {
		setupTempHome();
		const { addBlock } = await import("./blocks");
		const db = getNativeDb();

		await addBlock("acct_primary", "@amelia");

		const row = db
			.prepare("select account_id, profile_id, source from blocks")
			.get() as
			| { account_id: string; profile_id: string; source: string }
			| undefined;

		expect(row).toEqual({
			account_id: "acct_primary",
			profile_id: "profile_amelia",
			source: "manual",
		});
	});
});
