// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";

const mocks = vi.hoisted(() => ({
	blockUserViaXurl: vi.fn(),
	blockUserViaXWeb: vi.fn(),
	listBlockedUsers: vi.fn(),
	lookupAuthenticatedUser: vi.fn(),
	lookupUsersByHandles: vi.fn(),
	lookupUsersByIds: vi.fn(),
	unblockUserViaXurl: vi.fn(),
	unblockUserViaXWeb: vi.fn(),
}));

vi.mock("./xurl", () => ({
	blockUserViaXurl: mocks.blockUserViaXurl,
	listBlockedUsers: mocks.listBlockedUsers,
	lookupAuthenticatedUser: mocks.lookupAuthenticatedUser,
	lookupUsersByHandles: mocks.lookupUsersByHandles,
	lookupUsersByIds: mocks.lookupUsersByIds,
	unblockUserViaXurl: mocks.unblockUserViaXurl,
}));

vi.mock("./x-web", () => ({
	blockUserViaXWeb: mocks.blockUserViaXWeb,
	unblockUserViaXWeb: mocks.unblockUserViaXWeb,
}));

const tempRoots: string[] = [];

function setupTempHome() {
	const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-blocks-"));
	tempRoots.push(tempRoot);
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
}

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	process.env.BIRDCLAW_DISABLE_LIVE_WRITES = "1";
	mocks.blockUserViaXurl.mockReset();
	mocks.blockUserViaXWeb.mockReset();
	mocks.listBlockedUsers.mockReset();
	mocks.lookupAuthenticatedUser.mockReset();
	mocks.lookupUsersByHandles.mockReset();
	mocks.lookupUsersByIds.mockReset();
	mocks.unblockUserViaXurl.mockReset();
	mocks.unblockUserViaXWeb.mockReset();

	for (const tempRoot of tempRoots.splice(0)) {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

describe("blocklist", () => {
	beforeEach(() => {
		delete process.env.BIRDCLAW_DISABLE_LIVE_WRITES;
		mocks.lookupAuthenticatedUser.mockResolvedValue({ id: "1" });
		mocks.listBlockedUsers.mockResolvedValue({ items: [], nextToken: null });
		mocks.blockUserViaXurl.mockResolvedValue({ ok: true, output: "blocked" });
		mocks.blockUserViaXWeb.mockResolvedValue({
			ok: true,
			output: "x-web block ok via browser",
		});
		mocks.unblockUserViaXurl.mockResolvedValue({
			ok: true,
			output: "unblocked",
		});
		mocks.unblockUserViaXWeb.mockResolvedValue({
			ok: true,
			output: "x-web unblock ok via browser",
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

	it("blocks, lists, searches, and unblocks profiles", async () => {
		setupTempHome();
		const { addBlock, getBlocksResponse, listBlocks, removeBlock } =
			await import("./blocks");

		const addResult = await addBlock("acct_primary", "@amelia");
		expect(addResult.transport).toEqual({ ok: true, output: "blocked" });
		expect(mocks.lookupUsersByHandles).toHaveBeenCalledWith(["amelia"]);
		expect(mocks.blockUserViaXurl).toHaveBeenCalledWith("1", "7");

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
		expect(removeResult.transport).toEqual({ ok: true, output: "unblocked" });
		expect(mocks.unblockUserViaXurl).toHaveBeenCalledWith("1", "7");
		expect(listBlocks({ account: "acct_primary" })).toHaveLength(0);
	});

	it("resolves numeric ids and blocks only the selected account", async () => {
		setupTempHome();
		const { addBlock, listBlocks } = await import("./blocks");

		await addBlock("acct_studio", "8");

		expect(mocks.lookupUsersByIds).toHaveBeenCalledWith(["8"]);
		expect(listBlocks({ account: "acct_studio" })[0]?.profile.handle).toBe(
			"avawires",
		);
		expect(listBlocks({ account: "acct_primary" })).toHaveLength(0);
	});

	it("stores local blocks even when transport fails", async () => {
		setupTempHome();
		mocks.blockUserViaXurl.mockResolvedValue({
			ok: false,
			output: "remote blocks unavailable",
		});
		const { addBlock, listBlocks } = await import("./blocks");

		const result = await addBlock("acct_primary", "amelia");

		expect(result.transport).toEqual({
			ok: false,
			output: "remote blocks unavailable",
		});
		expect(listBlocks({ account: "acct_primary" })).toHaveLength(1);
	});

	it("falls back to x-web when xurl rejects block writes for oauth2", async () => {
		setupTempHome();
		mocks.blockUserViaXurl.mockResolvedValue({
			ok: false,
			output:
				"Command failed: xurl ... You are not permitted to use OAuth2 on this endpoint",
		});
		const { addBlock } = await import("./blocks");

		const result = await addBlock("acct_primary", "amelia");

		expect(mocks.blockUserViaXWeb).toHaveBeenCalledWith("7");
		expect(result.transport).toEqual({
			ok: true,
			output: "x-web block ok via browser; xurl OAuth2 write rejected",
		});
	});

	it("falls back to x-web when xurl rejects unblock writes for oauth2", async () => {
		setupTempHome();
		mocks.unblockUserViaXurl.mockResolvedValue({
			ok: false,
			output:
				"Command failed: xurl ... You are not permitted to use OAuth2 on this endpoint",
		});
		const { addBlock, removeBlock } = await import("./blocks");

		await addBlock("acct_primary", "amelia");
		const result = await removeBlock("acct_primary", "amelia");

		expect(mocks.unblockUserViaXWeb).toHaveBeenCalledWith("7");
		expect(result.transport).toEqual({
			ok: true,
			output: "x-web unblock ok via browser; xurl OAuth2 write rejected",
		});
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

	it("falls back to local-only blocking when xurl lookup is unavailable", async () => {
		setupTempHome();
		mocks.lookupUsersByHandles.mockRejectedValue(new Error("xurl missing"));
		const { addBlock, listBlocks } = await import("./blocks");

		const result = await addBlock("acct_primary", "amelia");

		expect(result.transport).toEqual({
			ok: false,
			output: "xurl block transport unavailable for this profile",
		});
		expect(listBlocks({ account: "acct_primary" })[0]?.profile.handle).toBe(
			"amelia",
		);
	});

	it("uses the default account id and local-only transport when auth is missing", async () => {
		setupTempHome();
		mocks.lookupAuthenticatedUser.mockResolvedValue(null);
		const { addBlock, listBlocks } = await import("./blocks");

		const result = await addBlock("", "amelia");

		expect(result.accountId).toBe("acct_primary");
		expect(result.transport).toEqual({
			ok: false,
			output: "xurl block transport unavailable for this profile",
		});
		expect(listBlocks({ account: "acct_primary" })).toHaveLength(1);
	});

	it("degrades to local-only blocking when xurl auth lookup throws", async () => {
		setupTempHome();
		mocks.lookupAuthenticatedUser.mockRejectedValue(
			new Error("spawn xurl ENOENT"),
		);
		const { addBlock, listBlocks } = await import("./blocks");

		const result = await addBlock("acct_primary", "amelia");

		expect(result.ok).toBe(true);
		expect(result.transport).toEqual({
			ok: false,
			output: "xurl block transport unavailable for this profile",
		});
		expect(listBlocks({ account: "acct_primary" })).toHaveLength(1);
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
		expect(mocks.listBlockedUsers).toHaveBeenNthCalledWith(1, "1", undefined);
		expect(mocks.listBlockedUsers).toHaveBeenNthCalledWith(2, "1", "next");
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
			output: "xurl is authenticated as @someoneelse, not @steipete",
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

	it("removes blocks locally when transport cannot run", async () => {
		setupTempHome();
		mocks.lookupAuthenticatedUser.mockResolvedValue(null);
		const { addBlock, listBlocks, removeBlock } = await import("./blocks");

		await addBlock("acct_primary", "amelia");
		const result = await removeBlock("acct_primary", "amelia");

		expect(result.transport).toEqual({
			ok: false,
			output: "xurl unblock transport unavailable for this profile",
		});
		expect(listBlocks({ account: "acct_primary" })).toHaveLength(0);
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
		expect(mocks.blockUserViaXurl).toHaveBeenCalledWith("1", "99");
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
