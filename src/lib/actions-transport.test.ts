// @vitest-environment node
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
	blockUserViaXWeb: vi.fn(),
	unblockUserViaXWeb: vi.fn(),
	lookupAuthenticatedUser: vi.fn(),
}));

vi.mock("./bird-actions", () => ({
	blockUserViaBird: mocks.blockUserViaBird,
	unblockUserViaBird: mocks.unblockUserViaBird,
	muteUserViaBird: mocks.muteUserViaBird,
	readBirdStatusViaBird: mocks.readBirdStatusViaBird,
	unmuteUserViaBird: mocks.unmuteUserViaBird,
}));

vi.mock("./xurl", () => ({
	blockUserViaXurl: mocks.blockUserViaXurl,
	unblockUserViaXurl: mocks.unblockUserViaXurl,
	muteUserViaXurl: mocks.muteUserViaXurl,
	unmuteUserViaXurl: mocks.unmuteUserViaXurl,
	lookupAuthenticatedUser: mocks.lookupAuthenticatedUser,
}));

vi.mock("./x-web", () => ({
	blockUserViaXWeb: mocks.blockUserViaXWeb,
	unblockUserViaXWeb: mocks.unblockUserViaXWeb,
}));

describe("actions transport", () => {
	beforeEach(() => {
		delete process.env.BIRDCLAW_ACTIONS_TRANSPORT;
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
		mocks.blockUserViaXWeb.mockReset();
		mocks.unblockUserViaXWeb.mockReset();
		mocks.lookupAuthenticatedUser.mockReset();
		mocks.lookupAuthenticatedUser.mockResolvedValue({ id: "1" });
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
		mocks.blockUserViaXWeb.mockResolvedValue({
			ok: true,
			output: "x-web block ok",
		});
		mocks.unblockUserViaXWeb.mockResolvedValue({
			ok: true,
			output: "x-web unblock ok",
		});
	});

	afterEach(() => {
		delete process.env.BIRDCLAW_ACTIONS_TRANSPORT;
		delete process.env.BIRDCLAW_DISABLE_LIVE_WRITES;
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

	it("falls back to x-web block when bird and xurl fail in auto mode", async () => {
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
			ok: true,
			output:
				"x-web block ok\nfalling back after bird: bird unavailable\nfalling back after xurl: xurl rejected",
			transport: "x-web",
		});
		expect(mocks.blockUserViaXWeb).toHaveBeenCalledWith("7");
	});

	it("falls back to x-web unblock when bird and xurl fail in auto mode", async () => {
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
			ok: true,
			output:
				"x-web unblock ok\nfalling back after bird: bird unavailable\nfalling back after xurl: xurl rejected",
			transport: "x-web",
		});
		expect(mocks.unblockUserViaXWeb).toHaveBeenCalledWith("7");
	});
});
