import type { z } from "zod";
import type * as contracts from "./api-contracts";
import { existsSync } from "node:fs";
import { Effect } from "effect";
import { maybeAutoSyncBackupEffect } from "./backup";
import { syncDirectMessagesViaCachedBirdEffect } from "./dms-live";
import { runEffectBackground, runEffectPromise } from "./effect-runtime";
import { syncMentionThreadsEffect } from "./mention-threads-live";
import { syncMentionsEffect } from "./mentions-live";
import {
	defaultServerRuntimeServices,
	type ServerRuntimeServices,
} from "./server-runtime-services";
import NativeSqliteDatabase from "./sqlite";
import { syncTimelineCollectionEffect } from "./timeline-collections-live";
import { syncHomeTimelineEffect } from "./timeline-live";

import type { WebSyncKind } from "./api-enums";
export type { WebSyncKind } from "./api-enums";

export type WebSyncStep = z.infer<typeof contracts.webSyncStepSchema>;

export type WebSyncResponse = z.infer<typeof contracts.webSyncResponseSchema>;

export type WebSyncBackup = Effect.Effect.Success<
	ReturnType<typeof maybeAutoSyncBackupEffect>
>;

export type WebSyncJobStatus = "running" | "succeeded" | "failed";

export type WebSyncJobSnapshot = z.infer<typeof contracts.webSyncJobSchema>;

export type WebSyncDmInbox = "all" | "accepted" | "requests";

export interface WebSyncOptions {
	inbox?: WebSyncDmInbox;
	limit?: number;
	maxPages?: number;
	allPages?: boolean;
}

interface WebSyncPlan {
	label: string;
	run: (
		accountId: string | undefined,
		options: WebSyncOptions,
		runtime: ServerRuntimeServices,
	) => Effect.Effect<WebSyncStep[], unknown>;
}

const runningSyncs = new Map<string, WebSyncJobSnapshot>();
const webSyncJobs = new Map<string, WebSyncJobSnapshot>();
const webSyncJobKeys = new Map<string, string>();
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

function messageFromError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
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
		run: (account, _options, runtime) =>
			Effect.gen(function* () {
				const result = yield* syncHomeTimelineEffect({
					account,
					mode:
						!account || account === resolveDefaultSyncAccountId(runtime)
							? "auto"
							: "xurl",
					limit: 100,
					maxPages: 3,
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
			}),
	},
	mentions: {
		label: "Mentions",
		run: (account) =>
			Effect.gen(function* () {
				const mentions = yield* syncMentionsEffect({
					intent: "latest",
					account,
					mode: "auto",
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

				const threads = yield* syncMentionThreadsEffect({
					account,
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
			}),
	},
	likes: {
		label: "Likes",
		run: (account, _options, runtime) =>
			syncSavedCollection("likes", account, runtime),
	},
	bookmarks: {
		label: "Bookmarks",
		run: (account, _options, runtime) =>
			syncSavedCollection("bookmarks", account, runtime),
	},
	dms: {
		label: "Direct messages",
		run: (account, options) =>
			Effect.gen(function* () {
				const inbox = options.inbox ?? "all";
				const result = yield* syncDirectMessagesViaCachedBirdEffect({
					account,
					inbox,
					limit: options.limit ?? (inbox === "requests" ? 200 : 50),
					...(options.maxPages !== undefined
						? { maxPages: options.maxPages }
						: {}),
					...(options.allPages !== undefined
						? { allPages: options.allPages }
						: {}),
					pageDelayMs: inbox === "requests" ? 750 : 0,
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
			}),
	},
};

function syncSavedCollection(
	kind: "likes" | "bookmarks",
	account: string | undefined,
	runtime: ServerRuntimeServices,
): Effect.Effect<WebSyncStep[], unknown> {
	return Effect.gen(function* () {
		const isNonDefaultAccount =
			account !== undefined && account !== resolveDefaultSyncAccountId(runtime);
		const result = yield* syncTimelineCollectionEffect({
			kind,
			account,
			mode: isNonDefaultAccount ? "xurl" : "auto",
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
	});
}

export function performWebSyncEffect(
	kind: WebSyncKind,
	accountId?: string,
	options: WebSyncOptions = {},
	runtime: ServerRuntimeServices = defaultServerRuntimeServices,
) {
	return Effect.gen(function* () {
		const startedAt = runtime.now().toISOString();
		const steps = yield* WEB_SYNC_PLANS[kind].run(accountId, options, runtime);

		const backup = yield* maybeAutoSyncBackupEffect();
		const finishedAt = runtime.now().toISOString();
		return {
			ok: true,
			kind,
			...(accountId ? { accountId } : {}),
			startedAt,
			finishedAt,
			summary: summarizeSteps(steps),
			steps,
			backup,
		} satisfies WebSyncResponse;
	});
}

function createWebSyncJobId(kind: WebSyncKind, runtime: ServerRuntimeServices) {
	return `sync_${kind}_${runtime.now().getTime().toString(36)}_${runtime.random().toString(36).slice(2, 8)}`;
}

function resolveDefaultSyncAccountId(runtime: ServerRuntimeServices) {
	const dbPath = runtime.getPaths().dbPath;
	if (!existsSync(dbPath)) {
		return "acct_primary";
	}

	let db: NativeSqliteDatabase | undefined;
	try {
		db = new NativeSqliteDatabase(dbPath, { readonly: true });
		const row = db
			.prepare(
				`
        select id
        from accounts
        order by is_default desc, created_at asc
        limit 1
        `,
			)
			.get() as { id: string } | undefined;
		return row?.id ?? "acct_primary";
	} catch {
		return "acct_primary";
	} finally {
		db?.close();
	}
}

function serializeSyncOptions(kind: WebSyncKind, options: WebSyncOptions) {
	if (kind !== "dms") return "";
	const parts = [
		options.inbox ?? "all",
		options.limit ?? "",
		options.maxPages ?? "",
		options.allPages === undefined ? "" : String(options.allPages),
	];
	return parts.join(":");
}

function getRunningSyncKey(
	kind: WebSyncKind,
	accountId: string | undefined,
	options: WebSyncOptions = {},
	runtime: ServerRuntimeServices = defaultServerRuntimeServices,
) {
	const optionKey = serializeSyncOptions(kind, options);
	return `${kind}:${accountId ?? resolveDefaultSyncAccountId(runtime)}${optionKey ? `:${optionKey}` : ""}`;
}

function setJobSnapshot(snapshot: WebSyncJobSnapshot) {
	webSyncJobs.set(snapshot.id, snapshot);
	const syncKey =
		webSyncJobKeys.get(snapshot.id) ??
		getRunningSyncKey(snapshot.kind, snapshot.accountId);
	const cleanupTimer = completedJobCleanupTimers.get(snapshot.id);
	if (cleanupTimer) {
		clearTimeout(cleanupTimer);
		completedJobCleanupTimers.delete(snapshot.id);
	}
	if (snapshot.inProgress) {
		runningSyncs.set(syncKey, snapshot);
	} else if (runningSyncs.get(syncKey)?.id === snapshot.id) {
		runningSyncs.delete(syncKey);
		const timer = setTimeout(() => {
			webSyncJobs.delete(snapshot.id);
			webSyncJobKeys.delete(snapshot.id);
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
	accountId?: string,
	runtime: ServerRuntimeServices = defaultServerRuntimeServices,
): WebSyncResponse {
	const finishedAt = runtime.now().toISOString();
	const message = messageFromError(error);
	return {
		ok: false,
		kind,
		...(accountId ? { accountId } : {}),
		startedAt,
		finishedAt,
		summary: message,
		steps: [],
		error: message,
	};
}

export function startWebSync(
	kind: WebSyncKind,
	accountId?: string,
	options: WebSyncOptions = {},
	runtime: ServerRuntimeServices = defaultServerRuntimeServices,
): WebSyncJobSnapshot {
	const effectiveAccountId = accountId;
	const syncKey = getRunningSyncKey(kind, effectiveAccountId, options, runtime);
	const current = runningSyncs.get(syncKey);
	if (current) {
		return current;
	}

	const startedAt = runtime.now().toISOString();
	const job: WebSyncJobSnapshot = {
		id: createWebSyncJobId(kind, runtime),
		kind,
		...(effectiveAccountId ? { accountId: effectiveAccountId } : {}),
		status: "running",
		startedAt,
		summary: `Syncing ${WEB_SYNC_PLANS[kind].label}`,
		inProgress: true,
	};
	webSyncJobKeys.set(job.id, syncKey);
	setJobSnapshot(job);

	runEffectBackground(
		performWebSyncEffect(kind, effectiveAccountId, options, runtime),
		{
			onSuccess: (result) => {
				setJobSnapshot({
					...job,
					status: "succeeded",
					finishedAt: result.finishedAt,
					summary: result.summary,
					inProgress: false,
					result,
				});
			},
			onFailure: (error) => {
				const result = toFailedResponse(
					kind,
					startedAt,
					error,
					effectiveAccountId,
					runtime,
				);
				setJobSnapshot({
					...job,
					status: "failed",
					finishedAt: result.finishedAt,
					summary: result.summary,
					inProgress: false,
					result,
					error: result.error,
				});
			},
		},
	);

	return job;
}

export function getWebSyncJob(id: string): WebSyncJobSnapshot | null {
	return webSyncJobs.get(id) ?? null;
}

export function runWebSyncEffect(
	kind: WebSyncKind,
	accountId?: string,
	options: WebSyncOptions = {},
	runtime: ServerRuntimeServices = defaultServerRuntimeServices,
): Effect.Effect<WebSyncResponse, Error> {
	return Effect.gen(function* () {
		const effectiveAccountId = accountId;
		const current = runningSyncs.get(
			getRunningSyncKey(kind, effectiveAccountId, options, runtime),
		);
		const startedAt = runtime.now().toISOString();
		if (current) {
			return {
				ok: false,
				kind,
				...(effectiveAccountId ? { accountId: effectiveAccountId } : {}),
				startedAt,
				summary: "Sync already running",
				steps: [],
				inProgress: true,
			} satisfies WebSyncResponse;
		}

		const job = startWebSync(kind, effectiveAccountId, options, runtime);
		while (job.inProgress) {
			yield* Effect.sleep(25);
			const latest = getWebSyncJob(job.id);
			if (!latest?.inProgress) {
				if (!latest?.result)
					return yield* Effect.fail(new Error("Sync job disappeared"));
				return latest.result;
			}
		}

		if (!job.result)
			return yield* Effect.fail(new Error("Sync job did not finish"));
		return job.result;
	});
}

export function runWebSync(
	kind: WebSyncKind,
	accountId?: string,
	options: WebSyncOptions = {},
	runtime: ServerRuntimeServices = defaultServerRuntimeServices,
): Promise<WebSyncResponse> {
	return runEffectPromise(runWebSyncEffect(kind, accountId, options, runtime));
}

export function clearWebSyncLocksForTests() {
	runningSyncs.clear();
	webSyncJobs.clear();
	webSyncJobKeys.clear();
	for (const timer of completedJobCleanupTimers.values()) {
		clearTimeout(timer);
	}
	completedJobCleanupTimers.clear();
}
