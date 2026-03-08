// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";

const mocks = vi.hoisted(() => ({
	blockUserViaXurl: vi.fn(),
	lookupAuthenticatedUser: vi.fn(),
	lookupUsersByHandles: vi.fn(),
	lookupUsersByIds: vi.fn(),
	unblockUserViaXurl: vi.fn(),
}));

vi.mock("./xurl", () => ({
	blockUserViaXurl: mocks.blockUserViaXurl,
	lookupAuthenticatedUser: mocks.lookupAuthenticatedUser,
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
}

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	mocks.blockUserViaXurl.mockReset();
	mocks.lookupAuthenticatedUser.mockReset();
	mocks.lookupUsersByHandles.mockReset();
	mocks.lookupUsersByIds.mockReset();
	mocks.unblockUserViaXurl.mockReset();

	for (const tempRoot of tempRoots.splice(0)) {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

describe("blocklist", () => {
	beforeEach(() => {
		mocks.lookupAuthenticatedUser.mockResolvedValue({ id: "1" });
		mocks.blockUserViaXurl.mockResolvedValue({ ok: true, output: "blocked" });
		mocks.unblockUserViaXurl.mockResolvedValue({
			ok: true,
			output: "unblocked",
		});
		mocks.lookupUsersByHandles.mockResolvedValue([
			{
				id: "7",
				username: "amelia",
				name: "Amelia N",
				description: "Design systems",
				public_metrics: { followers_count: 4200 },
			},
		]);
		mocks.lookupUsersByIds.mockResolvedValue([
			{
				id: "8",
				username: "avawires",
				name: "Ava Wires",
				description: "Infra reporter",
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
