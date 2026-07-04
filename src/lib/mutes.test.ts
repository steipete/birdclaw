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
	lookupAuthenticatedUser: vi.fn(),
	lookupUsersByHandles: vi.fn(),
	lookupUsersByIds: vi.fn(),
	muteUserViaBird: vi.fn(),
	readBirdStatusViaBird: vi.fn(),
	muteUserViaXurl: vi.fn(),
	unmuteUserViaBird: vi.fn(),
	unmuteUserViaXurl: vi.fn(),
}));

vi.mock("./bird-actions", () => {
	const fromMock =
		(mock: (...args: unknown[]) => PromiseLike<unknown>) =>
		(...args: unknown[]) =>
			Effect.tryPromise({
				try: () => mock(...args),
				catch: (error) => error,
			});
	return {
		lookupProfileViaBirdEffect: fromMock(mocks.lookupProfileViaBird),
		muteUserViaBirdEffect: fromMock(mocks.muteUserViaBird),
		readBirdStatusViaBirdEffect: fromMock(mocks.readBirdStatusViaBird),
		unmuteUserViaBirdEffect: fromMock(mocks.unmuteUserViaBird),
	};
});

vi.mock("./xurl", () => {
	const fromMock =
		(mock: (...args: unknown[]) => PromiseLike<unknown>) =>
		(...args: unknown[]) =>
			Effect.tryPromise({
				try: () => mock(...args),
				catch: (error) => error,
			});
	return {
		lookupAuthenticatedUserEffect: fromMock(mocks.lookupAuthenticatedUser),
		lookupAuthenticatedUserFreshEffect: fromMock(mocks.lookupAuthenticatedUser),
		lookupUsersByHandlesEffect: fromMock(mocks.lookupUsersByHandles),
		lookupUsersByIdsEffect: fromMock(mocks.lookupUsersByIds),
		muteUserViaXurlEffect: fromMock(mocks.muteUserViaXurl),
		unmuteUserViaXurlEffect: fromMock(mocks.unmuteUserViaXurl),
	};
});

const tempDirs: string[] = [];

function makeTempHome() {
	const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-mutes-"));
	tempDirs.push(tempRoot);
	process.env.BIRDCLAW_HOME = tempRoot;
	return tempRoot;
}

describe("mutes", () => {
	beforeEach(() => {
		mocks.lookupProfileViaBird.mockReset();
		mocks.lookupUsersByHandles.mockReset();
		mocks.lookupUsersByIds.mockReset();
		mocks.lookupAuthenticatedUser.mockReset();
		mocks.muteUserViaBird.mockReset();
		mocks.readBirdStatusViaBird.mockReset();
		mocks.muteUserViaXurl.mockReset();
		mocks.unmuteUserViaBird.mockReset();
		mocks.unmuteUserViaXurl.mockReset();
		mocks.lookupAuthenticatedUser.mockResolvedValue({
			id: "25401953",
			username: "steipete",
		});
		mocks.lookupProfileViaBird.mockResolvedValue({
			id: "7",
			username: "amelia",
			name: "Amelia",
		});
		mocks.readBirdStatusViaBird.mockResolvedValue({
			blocking: false,
			muting: true,
		});
		mocks.lookupUsersByHandles.mockResolvedValue([
			{
				id: "7",
				username: "amelia",
				name: "Amelia",
			},
		]);
		mocks.lookupUsersByIds.mockResolvedValue([
			{
				id: "7",
				username: "amelia",
				name: "Amelia",
			},
		]);
		mocks.muteUserViaBird.mockResolvedValue({
			ok: true,
			output: "muted via bird; verified muting=true",
		});
		mocks.muteUserViaXurl.mockResolvedValue({
			ok: true,
			output: "muted via xurl",
		});
		mocks.unmuteUserViaBird.mockResolvedValue({
			ok: true,
			output: "unmuted via bird; verified muting=false",
		});
		mocks.unmuteUserViaXurl.mockResolvedValue({
			ok: true,
			output: "unmuted via xurl",
		});
	});

	afterEach(() => {
		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		delete process.env.BIRDCLAW_HOME;

		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("builds mute write effects lazily", async () => {
		makeTempHome();
		const { addMuteEffect } = await import("./mutes");

		const effect = addMuteEffect("acct_primary", "@amelia");

		expect(mocks.lookupUsersByHandles).not.toHaveBeenCalled();
		expect(mocks.muteUserViaBird).not.toHaveBeenCalled();
		await expect(Effect.runPromise(effect)).resolves.toMatchObject({
			ok: true,
			action: "mute",
			accountId: "acct_primary",
		});
		expect(mocks.muteUserViaBird).toHaveBeenCalledWith("7");
	});

	it("mutes, lists, and unmutes profiles", async () => {
		makeTempHome();
		const { addMute, listMutes, removeMute } = await import("./mutes");

		const addResult = await addMute("acct_primary", "@amelia");
		expect(addResult.transport).toEqual({
			ok: true,
			output: "muted via bird; verified muting=true",
			transport: "bird",
		});
		expect(mocks.muteUserViaBird).toHaveBeenCalledWith("7");

		expect(listMutes({ account: "acct_primary" })).toEqual([
			expect.objectContaining({
				accountId: "acct_primary",
				profile: expect.objectContaining({
					handle: "amelia",
				}),
			}),
		]);

		const removeResult = await removeMute("acct_primary", "@amelia");
		expect(removeResult.transport).toEqual({
			ok: true,
			output: "unmuted via bird; verified muting=false",
			transport: "bird",
		});
		expect(mocks.unmuteUserViaBird).toHaveBeenCalledWith("7");
		expect(listMutes({ account: "acct_primary" })).toEqual([]);
	});

	it("does not persist local mutes when bird transport fails", async () => {
		makeTempHome();
		mocks.muteUserViaBird.mockResolvedValue({
			ok: false,
			output: "bird mute failed",
		});
		const { addMute, listMutes } = await import("./mutes");

		await expect(
			addMute("acct_primary", "@amelia", { transport: "bird" }),
		).resolves.toMatchObject({
			ok: false,
			transport: {
				ok: false,
				output: "bird mute failed",
				transport: "bird",
			},
		});
		expect(listMutes({ account: "acct_primary" })).toEqual([]);
	});

	it("rejects muting the current account and supports numeric lookups", async () => {
		makeTempHome();
		const { addMute } = await import("./mutes");

		await expect(addMute("acct_primary", "@steipete")).rejects.toThrow(
			"Cannot mute the current account",
		);

		await expect(addMute("acct_primary", "7")).resolves.toMatchObject({
			profile: expect.objectContaining({
				handle: "amelia",
			}),
		});
	});

	it("persists mute rows in sqlite", async () => {
		makeTempHome();
		const { addMute } = await import("./mutes");

		await addMute("acct_primary", "@amelia");

		expect(
			getNativeDb()
				.prepare("select account_id, profile_id, source from mutes")
				.all(),
		).toEqual([
			{
				account_id: "acct_primary",
				profile_id: "profile_amelia",
				source: "manual",
			},
		]);
	});

	it("can force xurl transport for mute and unmute", async () => {
		makeTempHome();
		const { addMute, listMutes, removeMute } = await import("./mutes");
		mocks.readBirdStatusViaBird
			.mockResolvedValueOnce({
				blocking: false,
				muting: true,
			})
			.mockResolvedValueOnce({
				blocking: false,
				muting: false,
			});

		const addResult = await addMute("acct_primary", "@amelia", {
			transport: "xurl",
		});
		const removeResult = await removeMute("acct_primary", "@amelia", {
			transport: "xurl",
		});

		expect(addResult.transport).toEqual({
			ok: true,
			output: "muted via xurl\nverified muting=true",
			transport: "xurl",
		});
		expect(removeResult.transport).toEqual({
			ok: true,
			output: "unmuted via xurl\nverified muting=false",
			transport: "xurl",
		});
		expect(mocks.muteUserViaXurl).toHaveBeenCalledWith("25401953", "7");
		expect(mocks.unmuteUserViaXurl).toHaveBeenCalledWith("25401953", "7");
		expect(mocks.muteUserViaBird).not.toHaveBeenCalled();
		expect(mocks.unmuteUserViaBird).not.toHaveBeenCalled();
		expect(listMutes({ account: "acct_primary" })).toHaveLength(0);
	});

	it("keeps local rows when bird unmute fails", async () => {
		makeTempHome();
		mocks.unmuteUserViaBird.mockResolvedValue({
			ok: false,
			output: "bird unmute failed",
		});
		const { addMute, listMutes, removeMute } = await import("./mutes");

		await addMute("acct_primary", "@amelia");
		await expect(
			removeMute("acct_primary", "@amelia", { transport: "bird" }),
		).resolves.toMatchObject({
			ok: false,
			transport: {
				ok: false,
				output: "bird unmute failed",
				transport: "bird",
			},
		});
		expect(listMutes({ account: "acct_primary" })).toHaveLength(1);
	});
});
