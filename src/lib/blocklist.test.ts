// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const addBlockMock = vi.fn();
const tempRoots: string[] = [];

vi.mock("./blocks", () => ({
	addBlock: (...args: unknown[]) => addBlockMock(...args),
}));

describe("blocklist import", () => {
	beforeEach(() => {
		addBlockMock.mockReset();
	});

	afterEach(() => {
		for (const tempRoot of tempRoots.splice(0)) {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	it("parses simple blocklist text, bullets, and inline code", async () => {
		const { parseBlocklistText } = await import("./blocklist");

		expect(
			parseBlocklistText(`
# comment
@alpha
- @beta reason here
* \`https://x.com/gamma/status/123?s=20\`
delta
plain text should be ignored
@alpha
			`),
		).toEqual([
			"@alpha",
			"@beta",
			"https://x.com/gamma/status/123?s=20",
			"delta",
		]);
	});

	it("imports a blocklist file and reports partial failures", async () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-blocklist-"));
		tempRoots.push(tempRoot);
		const filePath = path.join(tempRoot, "blocklist.txt");
		writeFileSync(filePath, "@alpha\n@beta\n");
		addBlockMock
			.mockResolvedValueOnce({
				ok: true,
				blockedAt: "2026-03-09T00:00:00.000Z",
				profile: { handle: "alpha" },
				transport: { ok: true, output: "blocked" },
			})
			.mockRejectedValueOnce(new Error("Profile not found: @beta"));
		const { importBlocklist } = await import("./blocklist");

		const result = await importBlocklist("acct_primary", filePath);

		expect(addBlockMock).toHaveBeenNthCalledWith(1, "acct_primary", "@alpha");
		expect(addBlockMock).toHaveBeenNthCalledWith(2, "acct_primary", "@beta");
		expect(result).toEqual({
			ok: false,
			accountId: "acct_primary",
			path: filePath,
			requestedCount: 2,
			blockedCount: 1,
			failedCount: 1,
			items: [
				{
					query: "@alpha",
					ok: true,
					blockedAt: "2026-03-09T00:00:00.000Z",
					handle: "alpha",
				},
				{
					query: "@beta",
					ok: false,
					error: "Profile not found: @beta",
				},
			],
		});
	});

	it("exposes blocklist imports as Effect programs", async () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-blocklist-"));
		tempRoots.push(tempRoot);
		const filePath = path.join(tempRoot, "blocklist.txt");
		writeFileSync(filePath, "@alpha\n");
		addBlockMock.mockResolvedValueOnce({
			ok: true,
			blockedAt: "2026-03-09T00:00:00.000Z",
			profile: { handle: "alpha" },
			transport: { ok: true, output: "blocked" },
		});
		const { importBlocklistEffect } = await import("./blocklist");

		await expect(
			Effect.runPromise(importBlocklistEffect("acct_primary", filePath)),
		).resolves.toMatchObject({
			ok: true,
			blockedCount: 1,
		});
	});
});
