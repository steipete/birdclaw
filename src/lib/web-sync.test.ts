// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

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
