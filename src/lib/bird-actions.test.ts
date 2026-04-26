// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileAsyncMock = vi.fn();

vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
}));

vi.mock("node:util", () => ({
	promisify: vi.fn(() => execFileAsyncMock),
}));

describe("bird action transport wrapper", () => {
	afterEach(() => {
		vi.resetModules();
		execFileAsyncMock.mockReset();
		delete process.env.BIRDCLAW_BIRD_COMMAND;
		delete process.env.BIRDCLAW_DISABLE_LIVE_WRITES;
	});

	it("blocks via bird and verifies with status", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		delete process.env.BIRDCLAW_DISABLE_LIVE_WRITES;
		execFileAsyncMock
			.mockResolvedValueOnce({ stdout: "✅ Blocked @sam\n" })
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ blocking: true, muting: false }),
			});

		const { blockUserViaBird } = await import("./bird-actions");
		const result = await blockUserViaBird("42");

		expect(execFileAsyncMock).toHaveBeenNthCalledWith(1, "/tmp/bird", [
			"block",
			"42",
		]);
		expect(execFileAsyncMock).toHaveBeenNthCalledWith(2, "/tmp/bird", [
			"status",
			"42",
			"--json",
		]);
		expect(result).toEqual({
			ok: true,
			output: "✅ Blocked @sam; verified blocking=true",
		});
	});

	it("fails when verify state mismatches", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		delete process.env.BIRDCLAW_DISABLE_LIVE_WRITES;
		execFileAsyncMock
			.mockResolvedValueOnce({ stdout: "✅ Unblocked @sam\n" })
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ blocking: true, muting: false }),
			});

		const { unblockUserViaBird } = await import("./bird-actions");
		const result = await unblockUserViaBird("42");

		expect(result).toEqual({
			ok: false,
			output: "✅ Unblocked @sam; bird status verify blocking=true",
		});
	});

	it("returns command failures", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		delete process.env.BIRDCLAW_DISABLE_LIVE_WRITES;
		execFileAsyncMock.mockRejectedValue(new Error("bird down"));

		const { muteUserViaBird } = await import("./bird-actions");
		const result = await muteUserViaBird("42");

		expect(result).toEqual({
			ok: false,
			output: "bird down",
		});
	});

	it("skips live mutations when writes are disabled", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		process.env.BIRDCLAW_DISABLE_LIVE_WRITES = "1";

		const { muteUserViaBird } = await import("./bird-actions");
		const result = await muteUserViaBird("42");

		expect(result).toEqual({
			ok: true,
			output: "live writes disabled",
		});
		expect(execFileAsyncMock).not.toHaveBeenCalled();
	});

	it("includes stripped stdout and stderr when command failures expose them", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		const error = Object.assign(new Error("bird failed"), {
			stdout: "\u001b[31mstdout detail\u001b[0m\n",
			stderr: "\u001b[33mstderr detail\u001b[0m\n",
		});
		execFileAsyncMock.mockRejectedValue(error);

		const { blockUserViaBird } = await import("./bird-actions");
		const result = await blockUserViaBird("42");

		expect(result).toEqual({
			ok: false,
			output: "bird failed\nstdout detail\nstderr detail",
		});
	});

	it("uses fallback failure text for non-error command failures", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		execFileAsyncMock.mockRejectedValue("boom");

		const { unmuteUserViaBird } = await import("./bird-actions");
		const result = await unmuteUserViaBird("42");

		expect(result).toEqual({
			ok: false,
			output: "bird unmute failed",
		});
	});

	it("reports unavailable verification when status is missing or malformed", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		execFileAsyncMock
			.mockResolvedValueOnce({ stderr: "\u001b[32mok via stderr\u001b[0m\n" })
			.mockResolvedValueOnce({ stdout: JSON.stringify({ blocking: "yes" }) });

		const { blockUserViaBird } = await import("./bird-actions");
		const result = await blockUserViaBird("42");

		expect(result).toEqual({
			ok: false,
			output: "ok via stderr; bird status verify unavailable",
		});
	});

	it("verifies mute and unmute mutations", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		execFileAsyncMock
			.mockResolvedValueOnce({ stdout: "Muted\n" })
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ blocking: false, muting: true }),
			})
			.mockResolvedValueOnce({ stdout: "" })
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ blocking: false, muting: false }),
			});

		const { muteUserViaBird, unmuteUserViaBird } =
			await import("./bird-actions");

		await expect(muteUserViaBird("42")).resolves.toEqual({
			ok: true,
			output: "Muted; verified muting=true",
		});
		await expect(unmuteUserViaBird("42")).resolves.toEqual({
			ok: true,
			output: "ok; verified muting=false",
		});
	});

	it("reads status json and returns null when bird cannot provide it", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		execFileAsyncMock
			.mockResolvedValueOnce({
				stdout: "\u001b[32m" + JSON.stringify({ blocking: true }) + "\u001b[0m",
			})
			.mockRejectedValueOnce(new Error("missing"));

		const { readBirdStatusViaBird } = await import("./bird-actions");

		await expect(readBirdStatusViaBird("42")).resolves.toEqual({
			blocking: true,
		});
		await expect(readBirdStatusViaBird("42")).resolves.toBeNull();
	});

	it("looks up profiles and normalizes bird user payloads", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		execFileAsyncMock.mockResolvedValueOnce({
			stdout: JSON.stringify({
				user: {
					id: "42",
					username: "@sam",
					name: "",
					description: "profile",
					profileImageUrl: "https://example.com/avatar.jpg",
					followersCount: "not-a-number",
					createdAt: "2025-01-02T03:04:05.000Z",
				},
			}),
		});

		const { lookupProfileViaBird } = await import("./bird-actions");
		const result = await lookupProfileViaBird("@sam");

		expect(execFileAsyncMock).toHaveBeenCalledWith("/tmp/bird", [
			"user",
			"@sam",
			"-n",
			"1",
			"--json",
		]);
		expect(result).toEqual({
			id: "42",
			username: "sam",
			name: "sam",
			description: "profile",
			profile_image_url: "https://example.com/avatar.jpg",
			public_metrics: {
				followers_count: 0,
			},
			created_at: "2025-01-02T03:04:05.000Z",
		});
	});

	it("returns null for malformed profile payloads", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		execFileAsyncMock
			.mockResolvedValueOnce({ stdout: JSON.stringify({}) })
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ user: { id: "42", username: "" } }),
			});

		const { lookupProfileViaBird } = await import("./bird-actions");

		await expect(lookupProfileViaBird("@missing")).resolves.toBeNull();
		await expect(lookupProfileViaBird("@missing")).resolves.toBeNull();
	});
});
