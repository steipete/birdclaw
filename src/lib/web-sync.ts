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

const runningSyncs = new Map<WebSyncKind, Promise<WebSyncResponse>>();

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

async function performWebSync(kind: WebSyncKind): Promise<WebSyncResponse> {
	const startedAt = new Date().toISOString();
	const steps: WebSyncStep[] = [];

	if (kind === "timeline") {
		const result = await syncHomeTimeline({
			limit: 100,
			following: true,
			refresh: true,
		});
		steps.push({
			kind,
			label: "Home timeline",
			count: readNumber(result, "count"),
			source: readString(result, "source"),
		});
	} else if (kind === "mentions") {
		const mentions = await syncMentions({
			mode: "xurl",
			limit: 100,
			maxPages: 3,
			refresh: true,
		});
		steps.push({
			kind,
			label: "Mentions",
			count: readNumber(mentions, "count"),
			source: readString(mentions, "source"),
			partial: readBoolean(mentions, "partial"),
		});

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
	} else if (kind === "likes" || kind === "bookmarks") {
		const result = await syncTimelineCollection({
			kind,
			mode: "auto",
			limit: 100,
			maxPages: 5,
			refresh: true,
			earlyStop: true,
		});
		steps.push({
			kind,
			label: kind === "likes" ? "Likes" : "Bookmarks",
			count: readNumber(result, "count"),
			source: readString(result, "source"),
		});
	} else {
		const result = await syncDirectMessagesViaCachedBird({
			limit: 50,
			refresh: true,
		});
		steps.push({
			kind,
			label: "Direct messages",
			count: readNumber(result, "messages"),
			source: readString(result, "source"),
		});
	}

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

	const pending = performWebSync(kind);
	runningSyncs.set(kind, pending);
	try {
		return await pending;
	} finally {
		if (runningSyncs.get(kind) === pending) {
			runningSyncs.delete(kind);
		}
	}
}

export function clearWebSyncLocksForTests() {
	runningSyncs.clear();
}
