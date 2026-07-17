// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	blockUserViaBird: vi.fn(),
	readBirdStatusViaBird: vi.fn(),
	unblockUserViaBird: vi.fn(),
	muteUserViaBird: vi.fn(),
	unmuteUserViaBird: vi.fn(),
	blockUserViaXurl: vi.fn(),
	unblockUserViaXurl: vi.fn(),
	muteUserViaXurl: vi.fn(),
	unmuteUserViaXurl: vi.fn(),
	lookupAuthenticatedUser: vi.fn(),
	getAuthenticatedBirdAccount: vi.fn(),
}));

vi.mock("./bird", async () => {
	const { effectFromMock: fromMock } = await import("../test/effect-mocks");
	return {
		getAuthenticatedBirdAccountEffect: fromMock(
			mocks.getAuthenticatedBirdAccount,
		),
	};
});

vi.mock("./bird-actions", async () => {
	const { effectFromMock: fromMock } = await import("../test/effect-mocks");
	return {
		blockUserViaBirdEffect: fromMock(mocks.blockUserViaBird),
		unblockUserViaBirdEffect: fromMock(mocks.unblockUserViaBird),
		muteUserViaBirdEffect: fromMock(mocks.muteUserViaBird),
		readBirdStatusViaBirdEffect: fromMock(mocks.readBirdStatusViaBird),
		unmuteUserViaBirdEffect: fromMock(mocks.unmuteUserViaBird),
	};
});

vi.mock("./xurl", async () => {
	const { effectFromMock: fromMock } = await import("../test/effect-mocks");
	return {
		blockUserViaXurlEffect: fromMock(mocks.blockUserViaXurl),
		unblockUserViaXurlEffect: fromMock(mocks.unblockUserViaXurl),
		muteUserViaXurlEffect: fromMock(mocks.muteUserViaXurl),
		unmuteUserViaXurlEffect: fromMock(mocks.unmuteUserViaXurl),
		lookupAuthenticatedUserEffect: fromMock(mocks.lookupAuthenticatedUser),
		lookupAuthenticatedUserFreshEffect: fromMock(mocks.lookupAuthenticatedUser),
	};
});

describe("actions transport", () => {
	let birdclawHome: string | undefined;

	beforeEach(() => {
		delete process.env.BIRDCLAW_ACTIONS_TRANSPORT;
		delete process.env.BIRDCLAW_CONFIG;
		birdclawHome = mkdtempSync(
			path.join(os.tmpdir(), "birdclaw-actions-transport-"),
		);
		process.env.BIRDCLAW_HOME = birdclawHome;
		delete process.env.BIRDCLAW_DISABLE_LIVE_WRITES;
		vi.resetModules();
		mocks.blockUserViaBird.mockReset();
		mocks.readBirdStatusViaBird.mockReset();
		mocks.unblockUserViaBird.mockReset();
		mocks.muteUserViaBird.mockReset();
		mocks.unmuteUserViaBird.mockReset();
		mocks.blockUserViaXurl.mockReset();
		mocks.unblockUserViaXurl.mockReset();
		mocks.muteUserViaXurl.mockReset();
		mocks.unmuteUserViaXurl.mockReset();
		mocks.lookupAuthenticatedUser.mockReset();
		mocks.getAuthenticatedBirdAccount.mockReset();
		mocks.lookupAuthenticatedUser.mockResolvedValue({ id: "1" });
		mocks.getAuthenticatedBirdAccount.mockResolvedValue({
			id: "1",
			username: "steipete",
		});
		mocks.blockUserViaBird.mockResolvedValue({
			ok: true,
			output: "bird block ok",
		});
		mocks.readBirdStatusViaBird.mockResolvedValue({
			blocking: true,
			muting: false,
		});
		mocks.unblockUserViaBird.mockResolvedValue({
			ok: true,
			output: "bird unblock ok",
		});
		mocks.muteUserViaBird.mockResolvedValue({
			ok: true,
			output: "bird mute ok",
		});
		mocks.unmuteUserViaBird.mockResolvedValue({
			ok: true,
			output: "bird unmute ok",
		});
		mocks.blockUserViaXurl.mockResolvedValue({
			ok: true,
			output: "xurl block ok",
		});
		mocks.unblockUserViaXurl.mockResolvedValue({
			ok: true,
			output: "xurl unblock ok",
		});
		mocks.muteUserViaXurl.mockResolvedValue({
			ok: true,
			output: "xurl mute ok",
		});
		mocks.unmuteUserViaXurl.mockResolvedValue({
			ok: true,
			output: "xurl unmute ok",
		});
	});

	afterEach(() => {
		delete process.env.BIRDCLAW_ACTIONS_TRANSPORT;
		delete process.env.BIRDCLAW_CONFIG;
		delete process.env.BIRDCLAW_HOME;
		delete process.env.BIRDCLAW_DISABLE_LIVE_WRITES;
		if (birdclawHome) {
			rmSync(birdclawHome, { force: true, recursive: true });
			birdclawHome = undefined;
		}
	});

	it("builds moderation action effects lazily", async () => {
		const { runModerationActionEffect } = await import("./actions-transport");

		const effect = runModerationActionEffect({
			action: "block",
			query: "7",
			targetUserId: "7",
		});

		expect(mocks.blockUserViaBird).not.toHaveBeenCalled();
		await expect(Effect.runPromise(effect)).resolves.toEqual({
			ok: true,
			output: "bird block ok",
			transport: "bird",
		});
		expect(mocks.blockUserViaBird).toHaveBeenCalledWith("7");
	});

	it("uses bird in auto mode first", async () => {
		const { runModerationAction } = await import("./actions-transport");
		const result = await runModerationAction({
			action: "block",
			query: "7",
			targetUserId: "7",
		});

		expect(result).toEqual({
			ok: true,
			output: "bird block ok",
			transport: "bird",
		});
		expect(mocks.blockUserViaBird).toHaveBeenCalledWith("7");
		expect(mocks.blockUserViaXurl).not.toHaveBeenCalled();
	});

	it("verifies the selected bird account without consulting xurl", async () => {
		mocks.lookupAuthenticatedUser.mockResolvedValue({
			id: "2",
			username: "other",
		});
		mocks.getAuthenticatedBirdAccount.mockResolvedValue({
			id: "25401953",
			username: "steipete",
		});
		const { runModerationAction } = await import("./actions-transport");
		const result = await runModerationAction({
			action: "block",
			query: "7",
			targetUserId: "7",
			expectedAccount: {
				id: "acct_primary",
				handle: "steipete",
				externalUserId: "25401953",
			},
		});

		expect(result).toEqual({
			ok: true,
			output: "bird block ok",
			transport: "bird",
		});
		expect(mocks.blockUserViaBird).toHaveBeenCalledWith("7");
		expect(mocks.getAuthenticatedBirdAccount).toHaveBeenCalledTimes(1);
		expect(mocks.lookupAuthenticatedUser).not.toHaveBeenCalled();
		expect(mocks.blockUserViaXurl).not.toHaveBeenCalled();
	});

	it("can force xurl transport", async () => {
		mocks.readBirdStatusViaBird.mockResolvedValueOnce({
			blocking: false,
			muting: true,
		});
		const { runModerationAction } = await import("./actions-transport");
		const result = await runModerationAction({
			action: "mute",
			query: "7",
			targetUserId: "7",
			transport: "xurl",
		});

		expect(result).toEqual({
			ok: true,
			output: "xurl mute ok\nverified muting=true",
			transport: "xurl",
		});
		expect(mocks.lookupAuthenticatedUser).toHaveBeenCalled();
		expect(mocks.muteUserViaXurl).toHaveBeenCalledWith("1", "7");
		expect(mocks.muteUserViaBird).not.toHaveBeenCalled();
	});

	it("falls back to xurl when bird fails in auto mode", async () => {
		mocks.blockUserViaBird.mockResolvedValue({
			ok: false,
			output: "bird unavailable",
		});
		const { runModerationAction } = await import("./actions-transport");
		const result = await runModerationAction({
			action: "block",
			query: "7",
			targetUserId: "7",
		});

		expect(result).toEqual({
			ok: true,
			output:
				"xurl block ok\nverified blocking=true\nfalling back after bird: bird unavailable",
			transport: "xurl",
		});
		expect(mocks.blockUserViaXurl).toHaveBeenCalledWith("1", "7");
	});

	it("stops after xurl rejects a block in auto mode", async () => {
		mocks.blockUserViaBird.mockResolvedValue({
			ok: false,
			output: "bird unavailable",
		});
		mocks.blockUserViaXurl.mockResolvedValue({
			ok: false,
			output: "xurl rejected",
			transport: "xurl",
		});
		const { runModerationAction } = await import("./actions-transport");
		const result = await runModerationAction({
			action: "block",
			query: "7",
			targetUserId: "7",
		});

		expect(result).toEqual({
			ok: false,
			output: "bird: bird unavailable\nxurl: xurl rejected",
			transport: "xurl",
		});
	});

	it("stops after xurl rejects an unblock in auto mode", async () => {
		mocks.unblockUserViaBird.mockResolvedValue({
			ok: false,
			output: "bird unavailable",
		});
		mocks.unblockUserViaXurl.mockResolvedValue({
			ok: false,
			output: "xurl rejected",
			transport: "xurl",
		});
		const { runModerationAction } = await import("./actions-transport");
		const result = await runModerationAction({
			action: "unblock",
			query: "7",
			targetUserId: "7",
		});

		expect(result).toEqual({
			ok: false,
			output: "bird: bird unavailable\nxurl: xurl rejected",
			transport: "xurl",
		});
	});

	it("reports both transport failures when live writes are disabled", async () => {
		process.env.BIRDCLAW_DISABLE_LIVE_WRITES = "1";
		mocks.blockUserViaBird.mockResolvedValue({
			ok: false,
			output: "live writes disabled",
		});
		mocks.blockUserViaXurl.mockResolvedValue({
			ok: false,
			output: "live writes disabled",
			transport: "xurl",
		});
		const { runModerationAction } = await import("./actions-transport");

		const result = await runModerationAction({
			action: "block",
			query: "7",
			targetUserId: "7",
		});

		expect(result).toEqual({
			ok: false,
			output: "bird: live writes disabled\nxurl: live writes disabled",
			transport: "xurl",
		});
	});

	it("reports missing target ids for forced xurl actions", async () => {
		const { runModerationAction } = await import("./actions-transport");

		await expect(
			runModerationAction({
				action: "block",
				query: "missing",
				transport: "xurl",
			}),
		).resolves.toEqual({
			ok: false,
			output: "missing target user id for xurl transport",
			transport: "xurl",
		});
		expect(mocks.blockUserViaXurl).not.toHaveBeenCalled();
	});

	it("reports unavailable xurl authenticated users", async () => {
		mocks.lookupAuthenticatedUser.mockResolvedValue(null);
		const { runModerationAction } = await import("./actions-transport");

		await expect(
			runModerationAction({
				action: "block",
				query: "7",
				targetUserId: "7",
				transport: "xurl",
			}),
		).resolves.toEqual({
			ok: false,
			output: "xurl authenticated user unavailable",
			transport: "xurl",
		});
		expect(mocks.blockUserViaXurl).not.toHaveBeenCalled();
	});

	it("reports xurl verification gaps and mismatches", async () => {
		mocks.readBirdStatusViaBird
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({ blocking: false, muting: false });
		const { runModerationAction } = await import("./actions-transport");

		await expect(
			runModerationAction({
				action: "block",
				query: "7",
				targetUserId: "7",
				transport: "xurl",
			}),
		).resolves.toEqual({
			ok: false,
			output: "xurl block ok\nxurl verify unavailable from bird status",
			transport: "xurl",
		});
		await expect(
			runModerationAction({
				action: "block",
				query: "7",
				targetUserId: "7",
				transport: "xurl",
			}),
		).resolves.toEqual({
			ok: false,
			output: "xurl block ok\nxurl verify mismatch blocking=false",
			transport: "xurl",
		});
	});

	it("checks expected xurl account identities before live writes", async () => {
		mocks.lookupAuthenticatedUser.mockResolvedValueOnce({
			id: "2",
			username: "other",
		});
		const { runModerationAction } = await import("./actions-transport");

		await expect(
			runModerationAction({
				action: "block",
				query: "7",
				targetUserId: "7",
				transport: "xurl",
				expectedAccount: {
					id: "acct_primary",
					handle: "steipete",
					externalUserId: "1",
				},
			}),
		).resolves.toEqual({
			ok: false,
			output: "xurl is authenticated as user 2, not account acct_primary",
			transport: "xurl",
		});
		expect(mocks.blockUserViaXurl).not.toHaveBeenCalled();
	});

	it("uses expected handle matches as the verified xurl source id", async () => {
		mocks.lookupAuthenticatedUser.mockResolvedValue({
			id: "25401953",
			username: "@Steipete",
		});
		const { runModerationAction } = await import("./actions-transport");

		await expect(
			runModerationAction({
				action: "unmute",
				query: "7",
				targetUserId: "7",
				transport: "xurl",
				expectedAccount: {
					id: "acct_primary",
					handle: "steipete",
				},
			}),
		).resolves.toEqual({
			ok: true,
			output: "xurl unmute ok\nverified muting=false",
			transport: "xurl",
		});
		expect(mocks.unmuteUserViaXurl).toHaveBeenCalledWith("25401953", "7");
		expect(mocks.lookupAuthenticatedUser).toHaveBeenCalledTimes(1);
	});

	it("reports expected handle mismatches with missing source usernames", async () => {
		mocks.lookupAuthenticatedUser.mockResolvedValue({ id: "25401953" });
		const { runModerationAction } = await import("./actions-transport");

		await expect(
			runModerationAction({
				action: "unblock",
				query: "7",
				targetUserId: "7",
				transport: "xurl",
				expectedAccount: {
					id: "acct_primary",
					handle: "steipete",
				},
			}),
		).resolves.toEqual({
			ok: false,
			output: "xurl authenticated user unavailable",
			transport: "xurl",
		});
		expect(mocks.unblockUserViaXurl).not.toHaveBeenCalled();
	});

	it("combines bird and xurl account-check failures in auto mode", async () => {
		mocks.blockUserViaBird.mockResolvedValue({
			ok: false,
			output: "bird unavailable",
		});
		mocks.lookupAuthenticatedUser.mockResolvedValue({
			id: "2",
			username: "other",
		});
		const { runModerationAction } = await import("./actions-transport");

		await expect(
			runModerationAction({
				action: "block",
				query: "7",
				targetUserId: "7",
				expectedAccount: {
					id: "acct_primary",
					handle: "steipete",
					externalUserId: "1",
				},
			}),
		).resolves.toEqual({
			ok: false,
			output:
				"bird: bird unavailable\nxurl: xurl is authenticated as user 2, not account acct_primary",
			transport: "xurl",
		});
		expect(mocks.blockUserViaXurl).not.toHaveBeenCalled();
	});

	it("runs explicit bird and xurl unblock branches", async () => {
		mocks.readBirdStatusViaBird.mockResolvedValueOnce({ blocking: false });
		const { runModerationAction } = await import("./actions-transport");

		await expect(
			runModerationAction({
				action: "unblock",
				query: "7",
				targetUserId: "7",
				transport: "bird",
			}),
		).resolves.toEqual({
			ok: true,
			output: "bird unblock ok",
			transport: "bird",
		});
		await expect(
			runModerationAction({
				action: "unblock",
				query: "7",
				targetUserId: "7",
				transport: "xurl",
			}),
		).resolves.toEqual({
			ok: true,
			output: "xurl unblock ok\nverified blocking=false",
			transport: "xurl",
		});
		expect(mocks.unblockUserViaBird).toHaveBeenCalledWith("7");
		expect(mocks.unblockUserViaXurl).toHaveBeenCalledWith("1", "7");
	});
});
