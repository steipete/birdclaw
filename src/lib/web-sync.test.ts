// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const maybeAutoSyncBackupMock = vi.fn();
const syncDirectMessagesViaCachedBirdMock = vi.fn();
const syncMentionThreadsMock = vi.fn();
const syncMentionsMock = vi.fn();
const syncTimelineCollectionMock = vi.fn();
const syncHomeTimelineMock = vi.fn();

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

import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import {
	clearWebSyncLocksForTests,
	getWebSyncJob,
	parseWebSyncKind,
	runWebSync,
	startWebSync,
} from "./web-sync";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((innerResolve) => {
		resolve = innerResolve;
	});
	return { promise, resolve };
}

const originalBirdclawHome = process.env.BIRDCLAW_HOME;
const tempRoots: string[] = [];

function setupDefaultAccount(accountId: string) {
	const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-web-sync-"));
	tempRoots.push(tempRoot);
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
	getNativeDb({ seedDemoData: false })
		.prepare(
			`
      insert into accounts (id, name, handle, transport, is_default, created_at)
      values (?, ?, ?, ?, ?, ?)
      `,
		)
		.run(accountId, "Studio", "@studio", "bird", 1, "2026-01-01T00:00:00.000Z");
}

describe("web sync dispatcher", () => {
	beforeEach(() => {
		clearWebSyncLocksForTests();
		vi.useRealTimers();
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
		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		if (originalBirdclawHome === undefined) {
			delete process.env.BIRDCLAW_HOME;
		} else {
			process.env.BIRDCLAW_HOME = originalBirdclawHome;
		}
		for (const tempRoot of tempRoots.splice(0)) {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	it("syncs the home timeline with a live refresh and backup pass", async () => {
		syncHomeTimelineMock.mockResolvedValue({
			ok: true,
			source: "bird",
			count: 42,
		});

		const result = await runWebSync("timeline");

		expect(syncHomeTimelineMock).toHaveBeenCalledWith({
			limit: 100,
			following: true,
			refresh: true,
		});
		expect(maybeAutoSyncBackupMock).toHaveBeenCalled();
		expect(result).toMatchObject({
			ok: true,
			kind: "timeline",
			summary: "Synced 42 items",
			steps: [{ kind: "timeline", count: 42, source: "bird" }],
		});
	});

	it("syncs mentions and then hydrates mention thread context", async () => {
		syncMentionsMock.mockResolvedValue({
			ok: true,
			source: "xurl",
			count: 8,
			partial: false,
		});
		syncMentionThreadsMock.mockResolvedValue({
			ok: true,
			source: "xurl",
			mergedTweets: 17,
			partial: true,
			warnings: ["rate limited"],
		});

		const result = await runWebSync("mentions");

		expect(syncMentionsMock).toHaveBeenCalledWith({
			mode: "xurl",
			limit: 100,
			maxPages: 3,
			refresh: true,
		});
		expect(syncMentionThreadsMock).toHaveBeenCalledWith({
			mode: "xurl",
			limit: 30,
			delayMs: 1500,
			timeoutMs: 15000,
		});
		expect(result.summary).toBe("Synced 25 items (partial)");
		expect(result.steps.at(1)).toMatchObject({
			kind: "mention-threads",
			count: 17,
			warnings: ["rate limited"],
		});
	});

	it("syncs saved collections through the shared collection path", async () => {
		syncTimelineCollectionMock.mockResolvedValue({
			ok: true,
			source: "bird",
			count: 11,
		});

		await runWebSync("bookmarks");

		expect(syncTimelineCollectionMock).toHaveBeenCalledWith({
			kind: "bookmarks",
			mode: "auto",
			limit: 100,
			maxPages: 5,
			refresh: true,
			earlyStop: true,
		});
	});

	it("uses account-targeted xurl mode for selected saved collection syncs", async () => {
		syncTimelineCollectionMock.mockResolvedValue({
			ok: true,
			source: "xurl",
			count: 7,
		});

		await runWebSync("likes", "acct_studio");

		expect(syncTimelineCollectionMock).toHaveBeenCalledWith({
			kind: "likes",
			account: "acct_studio",
			mode: "xurl",
			limit: 100,
			maxPages: 5,
			refresh: true,
			earlyStop: true,
		});
	});

	it("keeps auto fallback for default-account saved collection syncs", async () => {
		setupDefaultAccount("acct_studio");
		syncTimelineCollectionMock.mockResolvedValue({
			ok: true,
			source: "bird",
			count: 7,
		});

		await runWebSync("likes", "acct_studio");

		expect(syncTimelineCollectionMock).toHaveBeenCalledWith({
			kind: "likes",
			account: "acct_studio",
			mode: "auto",
			limit: 100,
			maxPages: 5,
			refresh: true,
			earlyStop: true,
		});
	});

	it("returns an in-progress response for duplicate sync clicks", async () => {
		const pending = deferred<{ ok: boolean; source: string; count: number }>();
		syncHomeTimelineMock.mockReturnValue(pending.promise);

		const first = runWebSync("timeline");
		const second = await runWebSync("timeline");
		pending.resolve({ ok: true, source: "bird", count: 1 });
		await first;

		expect(second).toMatchObject({
			ok: false,
			kind: "timeline",
			inProgress: true,
			summary: "Sync already running",
		});
		expect(syncHomeTimelineMock).toHaveBeenCalledTimes(1);
	});

	it("keeps account-aware running locks scoped by account", async () => {
		const primary = deferred<{ ok: boolean; source: string; count: number }>();
		const studio = deferred<{ ok: boolean; source: string; count: number }>();
		syncMentionsMock
			.mockReturnValueOnce(primary.promise)
			.mockReturnValueOnce(studio.promise);
		syncMentionThreadsMock.mockResolvedValue({
			ok: true,
			source: "xurl",
			mergedTweets: 0,
			partial: false,
		});

		const primaryJob = startWebSync("mentions", "acct_primary");
		const studioJob = startWebSync("mentions", "acct_studio");

		expect(primaryJob.id).not.toBe(studioJob.id);
		expect(syncMentionsMock).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ account: "acct_primary" }),
		);
		expect(syncMentionsMock).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ account: "acct_studio" }),
		);

		primary.resolve({ ok: true, source: "bird", count: 1 });
		studio.resolve({ ok: true, source: "bird", count: 2 });
		await vi.waitFor(() => {
			expect(getWebSyncJob(primaryJob.id)).toMatchObject({
				status: "succeeded",
				accountId: "acct_primary",
			});
			expect(getWebSyncJob(studioJob.id)).toMatchObject({
				status: "succeeded",
				accountId: "acct_studio",
			});
		});
	});

	it("ignores selected accounts for bird-only sync plans", async () => {
		const pending = deferred<{ ok: boolean; source: string; count: number }>();
		syncHomeTimelineMock.mockReturnValue(pending.promise);

		const defaultJob = startWebSync("timeline");
		const selectedJob = startWebSync("timeline", "acct_studio");

		expect(selectedJob.id).toBe(defaultJob.id);
		expect(selectedJob.accountId).toBeUndefined();
		expect(syncHomeTimelineMock).toHaveBeenCalledTimes(1);
		expect(syncHomeTimelineMock).toHaveBeenCalledWith(
			expect.objectContaining({ account: undefined }),
		);

		pending.resolve({ ok: true, source: "bird", count: 1 });
		await vi.waitFor(() => {
			expect(getWebSyncJob(defaultJob.id)).toMatchObject({
				status: "succeeded",
			});
		});
	});

	it("treats omitted account and the default account as the same running sync", async () => {
		setupDefaultAccount("acct_studio");
		const pending = deferred<{ ok: boolean; source: string; count: number }>();
		syncMentionsMock.mockReturnValue(pending.promise);
		syncMentionThreadsMock.mockResolvedValue({
			ok: true,
			source: "xurl",
			mergedTweets: 0,
			partial: false,
		});

		const defaultJob = startWebSync("mentions");
		const explicitDefaultJob = startWebSync("mentions", "acct_studio");

		expect(explicitDefaultJob.id).toBe(defaultJob.id);
		expect(syncMentionsMock).toHaveBeenCalledTimes(1);

		pending.resolve({ ok: true, source: "bird", count: 1 });
		await vi.waitFor(() => {
			expect(getWebSyncJob(defaultJob.id)).toMatchObject({
				status: "succeeded",
			});
		});
	});

	it("tracks background sync jobs through completion", async () => {
		const pending = deferred<{ ok: boolean; source: string; count: number }>();
		syncHomeTimelineMock.mockReturnValue(pending.promise);

		const job = startWebSync("timeline");

		expect(job).toMatchObject({
			kind: "timeline",
			status: "running",
			inProgress: true,
		});
		expect(getWebSyncJob(job.id)).toMatchObject({ status: "running" });

		pending.resolve({ ok: true, source: "bird", count: 5 });
		await vi.waitFor(() => {
			expect(getWebSyncJob(job.id)).toMatchObject({
				status: "succeeded",
				inProgress: false,
				summary: "Synced 5 items",
			});
		});
	});

	it("expires completed background sync jobs after the polling window", async () => {
		vi.useFakeTimers();
		syncHomeTimelineMock.mockResolvedValue({
			ok: true,
			source: "bird",
			count: 5,
		});

		const job = startWebSync("timeline");
		await vi.waitFor(() => {
			expect(getWebSyncJob(job.id)).toMatchObject({
				status: "succeeded",
				inProgress: false,
			});
		});

		await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

		expect(getWebSyncJob(job.id)).toBeNull();
	});

	it("parses only supported sync kinds", () => {
		expect(parseWebSyncKind("likes")).toBe("likes");
		expect(parseWebSyncKind("blocks")).toBeNull();
		expect(parseWebSyncKind(undefined)).toBeNull();
	});
});
