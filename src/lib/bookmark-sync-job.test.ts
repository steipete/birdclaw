// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildBookmarkSyncLaunchAgentPlist,
	installBookmarkSyncLaunchAgent,
	installBookmarkSyncLaunchAgentEffect,
	runBookmarkSyncJob,
	runBookmarkSyncJobEffect,
} from "./bookmark-sync-job";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";

const syncTimelineCollectionMock = vi.hoisted(() => vi.fn());
const maybeAutoSyncBackupMock = vi.hoisted(() => vi.fn());
const execFileAsyncMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());

Object.defineProperty(
	execFileMock,
	Symbol.for("nodejs.util.promisify.custom"),
	{
		value: execFileAsyncMock,
	},
);

vi.mock("./timeline-collections-live", () => ({
	syncTimelineCollection: (...args: unknown[]) =>
		syncTimelineCollectionMock(...args),
	syncTimelineCollectionEffect: (...args: unknown[]) =>
		Effect.tryPromise({
			try: () => syncTimelineCollectionMock(...args),
			catch: (error) => error,
		}),
}));

vi.mock("./backup", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./backup")>();
	return {
		...actual,
		maybeAutoSyncBackup: (...args: unknown[]) =>
			maybeAutoSyncBackupMock(...args),
		maybeAutoSyncBackupEffect: (...args: unknown[]) =>
			Effect.tryPromise({
				try: () => maybeAutoSyncBackupMock(...args),
				catch: (error) => error,
			}),
	};
});

vi.mock("node:child_process", () => ({
	execFile: execFileMock,
}));

const tempDirs: string[] = [];

function makeTempDir(prefix: string) {
	const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	syncTimelineCollectionMock.mockReset();
	maybeAutoSyncBackupMock.mockReset();
	execFileAsyncMock.mockReset();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("bookmark sync job", () => {
	it("builds bookmark sync jobs lazily as Effect programs", async () => {
		process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-job-lazy-");
		resetBirdclawPathsForTests();
		const logPath = path.join(process.env.BIRDCLAW_HOME, "audit.jsonl");
		syncTimelineCollectionMock.mockResolvedValue({
			ok: true,
			source: "xurl",
			kind: "bookmarks",
			accountId: "acct_primary",
			count: 1,
			payload: { data: [] },
		});
		maybeAutoSyncBackupMock.mockResolvedValue({
			ok: true,
			enabled: false,
			skipped: true,
		});

		const effect = runBookmarkSyncJobEffect({ logPath, limit: 5 });

		expect(existsSync(logPath)).toBe(false);
		expect(syncTimelineCollectionMock).not.toHaveBeenCalled();
		await expect(Effect.runPromise(effect)).resolves.toMatchObject({
			ok: true,
			sync: { count: 1 },
		});
		expect(syncTimelineCollectionMock).toHaveBeenCalledTimes(1);
		expect(readFileSync(logPath, "utf8")).toContain('"ok":true');
	});

	it("writes a successful JSONL audit entry", async () => {
		process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-job-");
		resetBirdclawPathsForTests();
		const logPath = path.join(process.env.BIRDCLAW_HOME, "audit.jsonl");
		syncTimelineCollectionMock.mockResolvedValue({
			ok: true,
			source: "xurl",
			kind: "bookmarks",
			accountId: "acct_primary",
			count: 4,
			payload: { data: [] },
		});
		maybeAutoSyncBackupMock.mockResolvedValue({
			ok: true,
			enabled: true,
			skipped: false,
		});

		const result = await runBookmarkSyncJob({
			logPath,
			mode: "auto",
			limit: 50,
			maxPages: 3,
			refresh: true,
		});

		expect(result).toMatchObject({
			job: "bookmarks-sync",
			ok: true,
			options: {
				mode: "auto",
				limit: 50,
				all: true,
				maxPages: 3,
				refresh: true,
			},
			before: { bookmarks: 0 },
			after: { bookmarks: 0 },
			sync: { source: "xurl", count: 4, accountId: "acct_primary" },
			backup: { ok: true, enabled: true, skipped: false },
		});
		expect(syncTimelineCollectionMock).toHaveBeenCalledWith({
			kind: "bookmarks",
			account: undefined,
			mode: "auto",
			limit: 50,
			all: true,
			maxPages: 3,
			refresh: true,
			cacheTtlMs: undefined,
		});
		const entries = readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { ok: boolean });
		expect(entries).toHaveLength(1);
		expect(entries[0]?.ok).toBe(true);
	});

	it("writes a failed audit entry instead of throwing", async () => {
		process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-job-fail-");
		resetBirdclawPathsForTests();
		const logPath = path.join(process.env.BIRDCLAW_HOME, "audit.jsonl");
		syncTimelineCollectionMock.mockRejectedValue(new Error("rate limited"));

		const result = await runBookmarkSyncJob({ logPath });

		expect(result).toMatchObject({
			ok: false,
			error: "rate limited",
		});
		expect(readFileSync(logPath, "utf8")).toContain('"ok":false');
		expect(maybeAutoSyncBackupMock).not.toHaveBeenCalled();
	});

	it("logs and skips when another bookmark job is running", async () => {
		process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-job-lock-");
		resetBirdclawPathsForTests();
		const logPath = path.join(process.env.BIRDCLAW_HOME, "audit.jsonl");
		const lockPath = path.join(process.env.BIRDCLAW_HOME, "locks", "job.lock");
		await mkdir(path.dirname(lockPath), { recursive: true });
		await writeFile(lockPath, "{}\n", "utf8");

		const result = await runBookmarkSyncJob({ logPath, lockPath });

		expect(result).toMatchObject({
			ok: true,
			skipped: "already-running",
		});
		expect(readFileSync(logPath, "utf8")).toContain(
			'"skipped":"already-running"',
		);
		expect(syncTimelineCollectionMock).not.toHaveBeenCalled();
	});

	it("builds and installs the launchd plist without loading when requested", async () => {
		process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-launchd-home-");
		resetBirdclawPathsForTests();
		const launchAgentsDir = makeTempDir("birdclaw-launchagents-");
		const agent = buildBookmarkSyncLaunchAgentPlist({
			account: "acct_work",
			program: "/opt/homebrew/bin/birdclaw",
			intervalSeconds: 10_800,
			maxPages: 5,
		});

		expect(agent.plist).toContain("<key>StartInterval</key>");
		expect(agent.plist).toContain("<integer>10800</integer>");
		expect(agent.programArguments).toContain("sync-bookmarks");
		expect(agent.programArguments).toContain("acct_work");
		expect(agent.programArguments).toContain("--all");
		expect(agent.programArguments).toContain("--max-pages");
		expect(agent.programArguments).toContain("5");

		const result = await installBookmarkSyncLaunchAgent({
			launchAgentsDir,
			program: "/opt/homebrew/bin/birdclaw",
			load: false,
		});

		expect(result.loaded).toBe(false);
		expect(existsSync(result.plistPath)).toBe(true);
		expect(execFileAsyncMock).not.toHaveBeenCalled();
		expect(getNativeDb({ seedDemoData: false })).toBeTruthy();
	});

	it("builds launchd install effects lazily", async () => {
		process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-launchd-lazy-home-");
		resetBirdclawPathsForTests();
		const launchAgentsDir = makeTempDir("birdclaw-launchagents-lazy-");
		const effect = installBookmarkSyncLaunchAgentEffect({
			launchAgentsDir,
			program: "/opt/homebrew/bin/birdclaw",
			load: false,
		});

		expect(execFileAsyncMock).not.toHaveBeenCalled();
		expect(
			existsSync(
				path.join(
					launchAgentsDir,
					"com.steipete.birdclaw.bookmarks-sync.plist",
				),
			),
		).toBe(false);
		await expect(Effect.runPromise(effect)).resolves.toMatchObject({
			ok: true,
			loaded: false,
		});
	});

	it("can source an env file before running the launchd command", () => {
		const agent = buildBookmarkSyncLaunchAgentPlist({
			program: "/opt/homebrew/bin/birdclaw",
			envFile: "~/private bird/env.sh",
			mode: "bird",
			logPath: "~/bird audit/bookmarks.jsonl",
		});

		expect(agent.envFile).toBe(path.join(os.homedir(), "private bird/env.sh"));
		expect(agent.programArguments).toHaveLength(3);
		expect(agent.programArguments[0]).toBe("/bin/bash");
		expect(agent.programArguments[1]).toBe("-lc");
		expect(agent.programArguments[2]).toContain(
			`. '${path.join(os.homedir(), "private bird/env.sh")}'`,
		);
		expect(agent.programArguments[2]).toContain(
			"exec '/opt/homebrew/bin/birdclaw' '--json' 'jobs' 'sync-bookmarks'",
		);
		expect(agent.programArguments[2]).toContain("'--mode' 'bird'");
		expect(agent.plist).toContain("private bird/env.sh");
	});
});
