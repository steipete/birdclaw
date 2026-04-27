// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	existsSync: vi.fn(),
	readdir: vi.fn(),
	stat: vi.fn(),
	homedir: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	exec: vi.fn(),
}));

vi.mock("node:util", async () => {
	const actual = await vi.importActual<typeof import("node:util")>("node:util");
	return {
		...actual,
		promisify: () => mocks.execAsync,
	};
});

vi.mock("node:fs", () => ({
	existsSync: mocks.existsSync,
	promises: {
		readdir: mocks.readdir,
		stat: mocks.stat,
	},
}));

vi.mock("node:os", () => ({
	homedir: mocks.homedir,
}));

import { findArchives } from "./archive-finder";

const originalPlatform = process.platform;

describe("archive finder", () => {
	beforeEach(() => {
		mocks.execAsync.mockReset();
		mocks.existsSync.mockReset();
		mocks.readdir.mockReset();
		mocks.stat.mockReset();
		mocks.homedir.mockReset();
		mocks.homedir.mockReturnValue("/Users/steipete");
		Object.defineProperty(process, "platform", {
			configurable: true,
			value: "darwin",
		});
	});

	afterEach(() => {
		Object.defineProperty(process, "platform", {
			configurable: true,
			value: originalPlatform,
		});
	});

	it("returns formatted, deduplicated archive candidates from downloads and spotlight", async () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.readdir.mockResolvedValue([
			"twitter-2026.zip",
			"x-2026.zip",
			"too-small.zip",
			"notes.txt",
		]);
		mocks.stat.mockImplementation(async (filePath: string) => {
			if (filePath.endsWith("twitter-2026.zip")) {
				return {
					isFile: () => true,
					size: 2_400_000,
					mtime: new Date(Date.now() - 86_400_000),
				};
			}
			if (filePath.endsWith("x-2026.zip")) {
				return {
					isFile: () => true,
					size: 12_500_000,
					mtime: new Date(Date.now() - 3 * 86_400_000),
				};
			}
			if (filePath.endsWith("archive-2025.zip")) {
				return {
					isFile: () => true,
					size: 6_700_000,
					mtime: new Date(),
				};
			}
			return {
				isFile: () => true,
				size: 32_000,
				mtime: new Date(),
			};
		});
		mocks.execAsync
			.mockResolvedValueOnce({
				stdout:
					"/Users/steipete/Downloads/x-2026.zip\n/Users/steipete/Desktop/archive-2025.zip\n",
			})
			.mockResolvedValueOnce({ stdout: "" })
			.mockRejectedValueOnce(new Error("spotlight unavailable"));

		const results = await findArchives();

		expect(results.map((item) => item.path)).toEqual([
			"/Users/steipete/Desktop/archive-2025.zip",
			"/Users/steipete/Downloads/twitter-2026.zip",
			"/Users/steipete/Downloads/x-2026.zip",
		]);
		expect(results[0]).toMatchObject({
			name: "archive-2025.zip",
			sizeFormatted: "6.4 MB",
			dateFormatted: "Today",
		});
		expect(results[1]?.dateFormatted).toBe("Yesterday");
		expect(results[2]?.dateFormatted).toBe("3 days ago");
	});

	it("formats older archives and ignores invalid candidates", async () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.readdir.mockResolvedValue([
			"twitter-week.zip",
			"twitter-month.zip",
			"twitter-year.zip",
			"archive-dir.zip",
			"archive-error.zip",
		]);
		mocks.stat.mockImplementation(async (filePath: string) => {
			if (filePath.endsWith("twitter-week.zip")) {
				return {
					isFile: () => true,
					size: 2_400_000,
					mtime: new Date(Date.now() - 15 * 86_400_000),
				};
			}
			if (filePath.endsWith("twitter-month.zip")) {
				return {
					isFile: () => true,
					size: 12_500_000,
					mtime: new Date(Date.now() - 120 * 86_400_000),
				};
			}
			if (filePath.endsWith("twitter-year.zip")) {
				return {
					isFile: () => true,
					size: 2_500_000_000,
					mtime: new Date(Date.now() - 800 * 86_400_000),
				};
			}
			if (filePath.endsWith("archive-dir.zip")) {
				return {
					isFile: () => false,
					size: 10_000_000,
					mtime: new Date(),
				};
			}
			throw new Error("stat failed");
		});
		mocks.execAsync.mockResolvedValue({ stdout: "" });

		const results = await findArchives();

		expect(results.map((item) => item.dateFormatted)).toEqual([
			"2 weeks ago",
			"4 months ago",
			"2 years ago",
		]);
		expect(results.at(-1)?.sizeFormatted).toBe("2.3 GB");
	});

	it("skips downloads when the directory is missing", async () => {
		mocks.existsSync.mockReturnValue(false);
		mocks.execAsync.mockResolvedValue({ stdout: "" });

		await expect(findArchives()).resolves.toEqual([]);
		expect(mocks.readdir).not.toHaveBeenCalled();
	});

	it("returns empty on non-darwin hosts", async () => {
		Object.defineProperty(process, "platform", {
			configurable: true,
			value: "linux",
		});

		await expect(findArchives()).resolves.toEqual([]);
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});
});
