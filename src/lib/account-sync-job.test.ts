import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const maybeAutoSyncBackupMock = vi.hoisted(() => vi.fn());
const syncDirectMessagesViaCachedBirdMock = vi.hoisted(() => vi.fn());
const syncMentionThreadsMock = vi.hoisted(() => vi.fn());
const syncMentionsMock = vi.hoisted(() => vi.fn());
const syncTimelineCollectionMock = vi.hoisted(() => vi.fn());
const syncHomeTimelineMock = vi.hoisted(() => vi.fn());

vi.mock("./backup", () => ({
	maybeAutoSyncBackup: (...args: unknown[]) => maybeAutoSyncBackupMock(...args),
}));

vi.mock("./dms-live", () => ({
	syncDirectMessagesViaCachedBird: (...args: unknown[]) =>
		syncDirectMessagesViaCachedBirdMock(...args),
}));

vi.mock("./mention-threads-live", () => ({
	syncMentionThreads: (...args: unknown[]) => syncMentionThreadsMock(...args),
}));

vi.mock("./mentions-live", () => ({
	syncMentions: (...args: unknown[]) => syncMentionsMock(...args),
}));

vi.mock("./timeline-collections-live", () => ({
	syncTimelineCollection: (...args: unknown[]) =>
		syncTimelineCollectionMock(...args),
}));

vi.mock("./timeline-live", () => ({
	syncHomeTimeline: (...args: unknown[]) => syncHomeTimelineMock(...args),
}));

import {
	buildAccountSyncLaunchAgentPlist,
	installAccountSyncLaunchAgent,
	parseAccountSyncSteps,
	runAccountSyncJob,
} from "./account-sync-job";

describe("account sync job", () => {
	let tempDir: string | undefined;

	beforeEach(() => {
		maybeAutoSyncBackupMock.mockReset();
		syncDirectMessagesViaCachedBirdMock.mockReset();
		syncMentionThreadsMock.mockReset();
		syncMentionsMock.mockReset();
		syncTimelineCollectionMock.mockReset();
		syncHomeTimelineMock.mockReset();
		maybeAutoSyncBackupMock.mockResolvedValue({
			ok: true,
			enabled: false,
			skipped: true,
		});
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	function makeAccountsDb({
		defaultAccount = "acct_primary",
		profiles = {},
	}: {
		defaultAccount?: string;
		profiles?: Record<string, string | null>;
	}) {
		return {
			prepare: (sql: string) => ({
				get: (account?: string) => {
					if (sql.includes("where id = ?")) {
						if (!account) return undefined;
						return {
							id: account,
							is_default: account === defaultAccount ? 1 : 0,
							bird_profile_name: profiles[account] ?? null,
						};
					}
					return {
						id: defaultAccount,
						is_default: 1,
						bird_profile_name: profiles[defaultAccount] ?? null,
					};
				},
			}),
		} as never;
	}

	it("parses comma-separated step lists", () => {
		expect(parseAccountSyncSteps("timeline,mentions,dms")).toEqual([
			"timeline",
			"mentions",
			"dms",
		]);
		expect(() => parseAccountSyncSteps("timeline,unknown")).toThrow(
			"--steps must contain",
		);
	});

	it("builds an account-scoped launchd command", () => {
		const agent = buildAccountSyncLaunchAgentPlist({
			account: "acct_openclaw",
			program: "/opt/homebrew/bin/birdclaw",
			steps: ["timeline", "mentions", "dms"],
			allowBirdAccount: true,
			envFile: "~/.config/bird/openclaw.env",
		});

		expect(agent.programArguments).toEqual([
			"/bin/bash",
			"-lc",
			expect.stringContaining("'--account' 'acct_openclaw'"),
		]);
		expect(agent.programArguments[2]).toContain(
			"'--steps' 'timeline,mentions,dms'",
		);
		expect(agent.programArguments[2]).toContain("'--allow-bird-account'");
		expect(agent.plist).toContain("com.steipete.birdclaw.account-sync");
	});

	it("builds default launchd arguments through env lookup when no program path is supplied", () => {
		const agent = buildAccountSyncLaunchAgentPlist({
			label: "com.example.birdclaw.sync&test",
			refresh: false,
			cacheTtlSeconds: 60,
			logPath: "~/birdclaw audit/account-sync.jsonl",
			stdoutPath: "~/birdclaw logs/out.log",
			stderrPath: "~/birdclaw logs/err.log",
		});

		expect(agent.programArguments.slice(0, 2)).toEqual([
			"/usr/bin/env",
			"birdclaw",
		]);
		expect(agent.programArguments).not.toContain("--refresh");
		expect(agent.programArguments).toContain("--cache-ttl");
		expect(agent.programArguments).toContain("60");
		expect(agent.plist).toContain("com.example.birdclaw.sync&amp;test");
		expect(agent.envFile).toBeUndefined();
	});

	it("treats empty step lists as the default selection", () => {
		expect(parseAccountSyncSteps(undefined)).toBeUndefined();
		expect(parseAccountSyncSteps(" , ")).toBeUndefined();
	});

	it("installs without loading when requested", async () => {
		tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-account-job-"));
		const result = await installAccountSyncLaunchAgent({
			account: "acct_openclaw",
			launchAgentsDir: tempDir,
			load: false,
			program: "/opt/homebrew/bin/birdclaw",
		});

		expect(result.loaded).toBe(false);
		expect(result.plistPath).toBe(
			path.join(tempDir, "com.steipete.birdclaw.account-sync.plist"),
		);
		expect(result.programArguments).toContain("--account");
		expect(result.programArguments).toContain("acct_openclaw");
	});

	it("writes an audit entry when backup sync fails", async () => {
		tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-account-job-"));
		const logPath = path.join(tempDir, "audit.jsonl");
		const lockPath = path.join(tempDir, "sync.lock");
		syncMentionsMock.mockResolvedValue({
			ok: true,
			source: "bird",
			count: 3,
		});
		maybeAutoSyncBackupMock.mockRejectedValue(new Error("backup failed"));

		const result = await runAccountSyncJob({
			steps: ["mentions"],
			logPath,
			lockPath,
			db: {} as never,
		});

		expect(result).toMatchObject({
			ok: false,
			error: "backup failed",
			steps: [{ kind: "mentions", ok: true, count: 3, source: "bird" }],
		});
		const entry = JSON.parse(readFileSync(logPath, "utf8").trim()) as unknown;
		expect(entry).toMatchObject({
			ok: false,
			error: "backup failed",
			steps: [{ kind: "mentions", ok: true, count: 3, source: "bird" }],
		});
	});

	it("refuses Bird-backed non-default account sync without a bird profile", async () => {
		tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-account-job-"));
		const logPath = path.join(tempDir, "audit.jsonl");
		const lockPath = path.join(tempDir, "sync.lock");
		const db = makeAccountsDb({ profiles: { acct_openclaw: null } });

		const result = await runAccountSyncJob({
			account: "acct_openclaw",
			steps: ["timeline"],
			mode: "bird",
			logPath,
			lockPath,
			db,
		});

		expect(syncHomeTimelineMock).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			ok: false,
			steps: [
				{
					kind: "timeline",
					ok: false,
					error: expect.stringContaining("bird_profile_name"),
				},
			],
		});
	});

	it("uses bird for non-default saved collection syncs when auto is selected", async () => {
		tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-account-job-"));
		const logPath = path.join(tempDir, "audit.jsonl");
		const lockPath = path.join(tempDir, "sync.lock");
		const db = makeAccountsDb({ profiles: { acct_openclaw: "work" } });
		syncTimelineCollectionMock.mockResolvedValue({
			source: "bird",
			count: 4,
		});

		const result = await runAccountSyncJob({
			account: "acct_openclaw",
			steps: ["likes"],
			logPath,
			lockPath,
			db,
		});

		expect(syncTimelineCollectionMock).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "likes",
				account: "acct_openclaw",
				mode: "bird",
			}),
		);
		expect(result).toMatchObject({
			ok: true,
			steps: [{ kind: "likes", ok: true, count: 4, source: "bird" }],
		});
	});

	it("refuses explicit Bird saved collection syncs for non-default accounts without a bird profile", async () => {
		tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-account-job-"));
		const logPath = path.join(tempDir, "audit.jsonl");
		const lockPath = path.join(tempDir, "sync.lock");
		const db = makeAccountsDb({ profiles: { acct_openclaw: null } });

		const result = await runAccountSyncJob({
			account: "acct_openclaw",
			steps: ["bookmarks"],
			mode: "bird",
			logPath,
			lockPath,
			db,
		});

		expect(syncTimelineCollectionMock).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			ok: false,
			steps: [
				{
					kind: "bookmarks",
					ok: false,
					error: expect.stringContaining("bird_profile_name"),
				},
			],
		});
	});

	it("does not let deprecated allow flag bypass a missing bird profile", async () => {
		tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-account-job-"));
		const logPath = path.join(tempDir, "audit.jsonl");
		const lockPath = path.join(tempDir, "sync.lock");

		const result = await runAccountSyncJob({
			account: "acct_openclaw",
			steps: ["mentions"],
			mode: "bird",
			allowBirdAccount: true,
			logPath,
			lockPath,
			db: makeAccountsDb({ profiles: { acct_openclaw: null } }),
		});

		expect(syncMentionsMock).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			ok: false,
			steps: [
				{
					kind: "mentions",
					ok: false,
					error: expect.stringContaining("bird_profile_name"),
				},
			],
		});
	});

	it("skips cleanly when another account sync job holds the lock", async () => {
		tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-account-job-"));
		const logPath = path.join(tempDir, "audit.jsonl");
		const lockPath = path.join(tempDir, "sync.lock");
		writeFileSync(lockPath, "{}\n");

		const result = await runAccountSyncJob({
			steps: ["mention-threads"],
			logPath,
			lockPath,
			db: {} as never,
		});

		expect(syncMentionThreadsMock).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			ok: true,
			skipped: "already-running",
			steps: [],
		});
		const entry = JSON.parse(readFileSync(logPath, "utf8").trim()) as unknown;
		expect(entry).toMatchObject({
			ok: true,
			skipped: "already-running",
			steps: [],
		});
	});

	it("runs Bird-backed non-default account steps when a bird profile is configured", async () => {
		tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-account-job-"));
		const logPath = path.join(tempDir, "audit.jsonl");
		const lockPath = path.join(tempDir, "sync.lock");
		const db = makeAccountsDb({ profiles: { acct_openclaw: "work" } });
		syncHomeTimelineMock.mockResolvedValue({
			source: "bird",
			count: 10,
		});
		syncMentionsMock.mockResolvedValue({
			source: "bird",
			count: 5,
		});
		syncDirectMessagesViaCachedBirdMock.mockResolvedValue({
			source: "bird",
			messages: 2,
		});

		const result = await runAccountSyncJob({
			account: "acct_openclaw",
			steps: ["timeline", "mentions", "dms"],
			mode: "bird",
			limit: 120,
			maxPages: 4,
			refresh: false,
			cacheTtlMs: 1000,
			logPath,
			lockPath,
			db,
		});

		expect(syncHomeTimelineMock).toHaveBeenCalledWith(
			expect.objectContaining({
				account: "acct_openclaw",
				mode: "bird",
				limit: 120,
				following: true,
				refresh: false,
				cacheTtlMs: 1000,
			}),
		);
		expect(syncMentionsMock).toHaveBeenCalledWith(
			expect.objectContaining({
				account: "acct_openclaw",
				mode: "bird",
				limit: 120,
				maxPages: 4,
				refresh: false,
			}),
		);
		expect(syncDirectMessagesViaCachedBirdMock).toHaveBeenCalledWith(
			expect.objectContaining({
				account: "acct_openclaw",
				limit: 50,
				refresh: false,
				cacheTtlMs: 1000,
			}),
		);
		expect(result).toMatchObject({
			ok: true,
			options: {
				account: "acct_openclaw",
				refresh: false,
				cacheTtlMs: 1000,
			},
			steps: [
				{ kind: "timeline", ok: true, count: 10, source: "bird" },
				{ kind: "mentions", ok: true, count: 5, source: "bird" },
				{ kind: "dms", ok: true, count: 2, source: "bird" },
			],
		});
	});

	it("uses bird timeline mode for profiled non-default auto jobs", async () => {
		tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-account-job-"));
		const logPath = path.join(tempDir, "audit.jsonl");
		const lockPath = path.join(tempDir, "sync.lock");
		syncHomeTimelineMock.mockResolvedValue({
			source: "bird",
			count: 10,
		});

		await runAccountSyncJob({
			account: "acct_openclaw",
			steps: ["timeline"],
			mode: "auto",
			logPath,
			lockPath,
			db: makeAccountsDb({ profiles: { acct_openclaw: "work" } }),
		});

		expect(syncHomeTimelineMock).toHaveBeenCalledWith(
			expect.objectContaining({
				account: "acct_openclaw",
				mode: "bird",
			}),
		);
	});

	it("records mention-thread sync errors as failed step results", async () => {
		tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-account-job-"));
		const logPath = path.join(tempDir, "audit.jsonl");
		const lockPath = path.join(tempDir, "sync.lock");
		syncMentionThreadsMock.mockRejectedValue(new Error("bird failed"));

		const result = await runAccountSyncJob({
			account: "acct_openclaw",
			steps: ["mention-threads"],
			limit: 100,
			logPath,
			lockPath,
			db: makeAccountsDb({ profiles: { acct_openclaw: "work" } }),
		});

		expect(syncMentionThreadsMock).toHaveBeenCalledWith(
			expect.objectContaining({
				account: "acct_openclaw",
				mode: "bird",
				limit: 30,
				delayMs: 1500,
				timeoutMs: 15000,
			}),
		);
		expect(result).toMatchObject({
			ok: false,
			steps: [
				{
					kind: "mention-threads",
					ok: false,
					count: 0,
					error: "bird failed",
				},
			],
		});
	});
});
