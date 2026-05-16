// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileAsyncMock = vi.fn();
const accessMock = vi.fn();

vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
}));

vi.mock("node:util", () => ({
	promisify: vi.fn(() => execFileAsyncMock),
}));

vi.mock("node:fs/promises", () => ({
	access: accessMock,
}));

describe("bird command Effect boundary", () => {
	afterEach(() => {
		vi.resetModules();
		execFileAsyncMock.mockReset();
		accessMock.mockReset();
		delete process.env.BIRDCLAW_BIRD_COMMAND;
		delete process.env.BIRDCLAW_CONFIG;
	});

	it("returns a rejected promise instead of throwing synchronously on config parse failures", async () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-command-"));
		const configPath = path.join(tempDir, "config.json");
		writeFileSync(configPath, "{bad json", "utf8");
		process.env.BIRDCLAW_CONFIG = configPath;
		const { runBirdCommand } = await import("./bird-command");
		let promise: Promise<unknown> | undefined;

		expect(() => {
			promise = runBirdCommand(["version"]);
		}).not.toThrow();
		await expect(promise).rejects.toThrow(/JSON/);
		expect(execFileAsyncMock).not.toHaveBeenCalled();

		rmSync(tempDir, { recursive: true, force: true });
	});
});
