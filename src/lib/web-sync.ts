import { maybeAutoSyncBackup } from "./backup";
import { syncDirectMessagesViaCachedBird } from "./dms-live";
import { syncMentionThreads } from "./mention-threads-live";
import { syncMentions } from "./mentions-live";
import { syncTimelineCollection } from "./timeline-collections-live";
import { syncHomeTimeline } from "./timeline-live";

export type WebSyncKind =
	| "timeline"
	| "mentions"
	| "likes"
	| "bookmarks"
	| "dms";

export interface WebSyncStep {
	kind: WebSyncKind | "mention-threads";
	label: string;
	count: number;
	source?: string;
	partial?: boolean;
	warnings?: string[];
}

export interface WebSyncResponse {
	ok: boolean;
	kind: WebSyncKind;
	startedAt: string;
	finishedAt?: string;
	summary: string;
	steps: WebSyncStep[];
	inProgress?: boolean;
	backup?: Awaited<ReturnType<typeof maybeAutoSyncBackup>>;
	error?: string;
}

export type WebSyncJobStatus = "running" | "succeeded" | "failed";

export interface WebSyncJobSnapshot {
	id: string;
	kind: WebSyncKind;
	status: WebSyncJobStatus;
	startedAt: string;
	finishedAt?: string;
	summary: string;
	inProgress: boolean;
	result?: WebSyncResponse;
	error?: string;
}

interface WebSyncPlan {
	label: string;
	run: () => Promise<WebSyncStep[]>;
}

const runningSyncs = new Map<WebSyncKind, WebSyncJobSnapshot>();
const webSyncJobs = new Map<string, WebSyncJobSnapshot>();
const completedJobCleanupTimers = new Map<
	string,
	ReturnType<typeof setTimeout>
>();
const COMPLETED_JOB_TTL_MS = 5 * 60 * 1000;

function assertRecord(
	value: unknown,
): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object") {
		throw new Error("Expected sync result object");
	}
}

function readNumber(value: unknown, key: string): number {
	assertRecord(value);
	const raw = value[key];
	return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

function readString(value: unknown, key: string) {
	assertRecord(value);
	const raw = value[key];
	return typeof raw === "string" ? raw : undefined;
}

function readBoolean(value: unknown, key: string) {
	assertRecord(value);
	const raw = value[key];
	return typeof raw === "boolean" ? raw : undefined;
}

export function parseWebSyncKind(value: unknown): WebSyncKind | null {
	return value === "timeline" ||
		value === "mentions" ||
		value === "likes" ||
		value === "bookmarks" ||
		value === "dms"
		? value
		: null;
}

function summarizeSteps(steps: WebSyncStep[]) {
	const total = steps.reduce((sum, step) => sum + step.count, 0);
	const partial = steps.some((step) => step.partial);
	const suffix = partial ? " (partial)" : "";
	return `Synced ${String(total)} items${suffix}`;
}

const WEB_SYNC_PLANS: Record<WebSyncKind, WebSyncPlan> = {
	timeline: {
		label: "Home timeline",
		run: async () => {
			const result = await syncHomeTimeline({
				limit: 100,
				following: true,
				refresh: true,
			});
			return [
				{
					kind: "timeline",
					label: "Home timeline",
					count: readNumber(result, "count"),
					source: readString(result, "source"),
				},
			];
		},
	},
	mentions: {
		label: "Mentions",
		run: async () => {
			const mentions = await syncMentions({
				mode: "xurl",
				limit: 100,
				maxPages: 3,
				refresh: true,
			});
			const steps: WebSyncStep[] = [
				{
					kind: "mentions",
					label: "Mentions",
					count: readNumber(mentions, "count"),
					source: readString(mentions, "source"),
					partial: readBoolean(mentions, "partial"),
				},
			];

			const threads = await syncMentionThreads({
				mode: "xurl",
				limit: 30,
				delayMs: 1500,
				timeoutMs: 15000,
			});
			steps.push({
				kind: "mention-threads",
				label: "Mention threads",
				count: readNumber(threads, "mergedTweets"),
				source: readString(threads, "source"),
				partial: readBoolean(threads, "partial"),
				warnings:
					Array.isArray(threads.warnings) && threads.warnings.length > 0
						? threads.warnings.map(String)
						: undefined,
			});
			return steps;
		},
	},
	likes: {
		label: "Likes",
		run: () => syncSavedCollection("likes"),
	},
	bookmarks: {
		label: "Bookmarks",
		run: () => syncSavedCollection("bookmarks"),
	},
	dms: {
		label: "Direct messages",
		run: async () => {
			const result = await syncDirectMessagesViaCachedBird({
				limit: 50,
				refresh: true,
			});
			return [
				{
					kind: "dms",
					label: "Direct messages",
					count: readNumber(result, "messages"),
					source: readString(result, "source"),
				},
			];
		},
	},
};

async function syncSavedCollection(kind: "likes" | "bookmarks") {
	const result = await syncTimelineCollection({
		kind,
		mode: "auto",
		limit: 100,
		maxPages: 5,
		refresh: true,
		earlyStop: true,
	});
	return [
		{
			kind,
			label: kind === "likes" ? "Likes" : "Bookmarks",
			count: readNumber(result, "count"),
			source: readString(result, "source"),
		},
	];
}

async function performWebSync(kind: WebSyncKind): Promise<WebSyncResponse> {
	const startedAt = new Date().toISOString();
	const steps = await WEB_SYNC_PLANS[kind].run();

	const backup = await maybeAutoSyncBackup();
	const finishedAt = new Date().toISOString();
	return {
		ok: true,
		kind,
		startedAt,
		finishedAt,
		summary: summarizeSteps(steps),
		steps,
		backup,
	};
}

function createWebSyncJobId(kind: WebSyncKind) {
	return `sync_${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function setJobSnapshot(snapshot: WebSyncJobSnapshot) {
	webSyncJobs.set(snapshot.id, snapshot);
	const cleanupTimer = completedJobCleanupTimers.get(snapshot.id);
	if (cleanupTimer) {
		clearTimeout(cleanupTimer);
		completedJobCleanupTimers.delete(snapshot.id);
	}
	if (snapshot.inProgress) {
		runningSyncs.set(snapshot.kind, snapshot);
	} else if (runningSyncs.get(snapshot.kind)?.id === snapshot.id) {
		runningSyncs.delete(snapshot.kind);
		const timer = setTimeout(() => {
			webSyncJobs.delete(snapshot.id);
			completedJobCleanupTimers.delete(snapshot.id);
		}, COMPLETED_JOB_TTL_MS);
		timer.unref?.();
		completedJobCleanupTimers.set(snapshot.id, timer);
	}
}

function toFailedResponse(
	kind: WebSyncKind,
	startedAt: string,
	error: unknown,
): WebSyncResponse {
	const finishedAt = new Date().toISOString();
	const message = error instanceof Error ? error.message : "Sync failed";
	return {
		ok: false,
		kind,
		startedAt,
		finishedAt,
		summary: message,
		steps: [],
		error: message,
	};
}

export function startWebSync(kind: WebSyncKind): WebSyncJobSnapshot {
	const current = runningSyncs.get(kind);
	if (current) {
		return current;
	}

	const startedAt = new Date().toISOString();
	const job: WebSyncJobSnapshot = {
		id: createWebSyncJobId(kind),
		kind,
		status: "running",
		startedAt,
		summary: `Syncing ${WEB_SYNC_PLANS[kind].label}`,
		inProgress: true,
	};
	setJobSnapshot(job);

	void performWebSync(kind)
		.then((result) => {
			setJobSnapshot({
				...job,
				status: "succeeded",
				finishedAt: result.finishedAt,
				summary: result.summary,
				inProgress: false,
				result,
			});
		})
		.catch((error: unknown) => {
			const result = toFailedResponse(kind, startedAt, error);
			setJobSnapshot({
				...job,
				status: "failed",
				finishedAt: result.finishedAt,
				summary: result.summary,
				inProgress: false,
				result,
				error: result.error,
			});
		});

	return job;
}

export function getWebSyncJob(id: string): WebSyncJobSnapshot | null {
	return webSyncJobs.get(id) ?? null;
}

export async function runWebSync(kind: WebSyncKind): Promise<WebSyncResponse> {
	const current = runningSyncs.get(kind);
	const startedAt = new Date().toISOString();
	if (current) {
		return {
			ok: false,
			kind,
			startedAt,
			summary: "Sync already running",
			steps: [],
			inProgress: true,
		};
	}

	const job = startWebSync(kind);
	while (job.inProgress) {
		await new Promise((resolve) => setTimeout(resolve, 25));
		const latest = getWebSyncJob(job.id);
		if (!latest?.inProgress) {
			if (!latest?.result) throw new Error("Sync job disappeared");
			return latest.result;
		}
	}

	if (!job.result) throw new Error("Sync job did not finish");
	return job.result;
}

export function clearWebSyncLocksForTests() {
	runningSyncs.clear();
	webSyncJobs.clear();
	for (const timer of completedJobCleanupTimers.values()) {
		clearTimeout(timer);
	}
	completedJobCleanupTimers.clear();
}
