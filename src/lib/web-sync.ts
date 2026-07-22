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
import { redactSensitiveLogText } from "./live-sync-engine";
import NativeSqliteDatabase from "./sqlite";
import { syncTimelineCollectionEffect } from "./timeline-collections-live";
import { syncHomeTimelineEffect } from "./timeline-live";

import type { WebSyncKind } from "./api-enums";
export type { WebSyncKind } from "./api-enums";

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
	accountId?: string;
	startedAt: string;
	finishedAt?: string;
	summary: string;
	steps: WebSyncStep[];
	inProgress?: boolean;
	backup?: Effect.Effect.Success<ReturnType<typeof maybeAutoSyncBackupEffect>>;
	error?: string;
}

export type WebSyncJobStatus = "running" | "succeeded" | "failed";

export interface WebSyncJobSnapshot {
	id: string;
	kind: WebSyncKind;
	accountId?: string;
	status: WebSyncJobStatus;
	startedAt: string;
	finishedAt?: string;
	summary: string;
	inProgress: boolean;
	result?: WebSyncResponse;
	error?: string;
}

export type WebSyncDmInbox = "all" | "accepted" | "requests";

export interface WebSyncOptions {
	inbox?: WebSyncDmInbox;
	limit?: number;
	maxPages?: number;
	allPages?: boolean;
}

interface WebSyncPlan {
	label: string;
	accountAware: boolean;
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

function formatFullError(error: unknown, runtime: ServerRuntimeServices) {
	const value =
		error instanceof Error ? (error.stack ?? error.message) : String(error);
	const secrets = [
		"AUTH_TOKEN",
		"CT0",
		"BIRDCLAW_WEB_TOKEN",
		"BIRDCLAW_MCP_TOKEN",
		"OPENAI_API_KEY",
		"OPENCAGE_API_KEY",
	].map((name) => runtime.env(name) ?? "");
	return redactSensitiveLogText(value, secrets).replaceAll("\n", "\\n");
}

function summarizeSyncResult(result: WebSyncResponse) {
	const transports = [
		...new Set(result.steps.map((step) => step.source).filter(Boolean)),
	];
	return {
		transport: transports.join(",") || "unknown",
		fetched: result.steps.reduce((sum, step) => sum + step.count, 0),
	};
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
		accountAware: true,
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
		accountAware: true,
		run: (account) =>
			Effect.gen(function* () {
				const mentions = yield* syncMentionsEffect({
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
		accountAware: true,
		run: (account, _options, runtime) =>
			syncSavedCollection("likes", account, runtime),
	},
	bookmarks: {
		label: "Bookmarks",
		accountAware: true,
		run: (account, _options, runtime) =>
			syncSavedCollection("bookmarks", account, runtime),
	},
	dms: {
		label: "Direct messages",
		accountAware: false,
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
	if (!WEB_SYNC_PLANS[kind].accountAware) {
		const optionKey = serializeSyncOptions(kind, options);
		return optionKey ? `${kind}:${optionKey}` : kind;
	}
	return `${kind}:${accountId ?? resolveDefaultSyncAccountId(runtime)}`;
}

function getEffectiveAccountId(
	kind: WebSyncKind,
	accountId: string | undefined,
) {
	return WEB_SYNC_PLANS[kind].accountAware ? accountId : undefined;
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
	const effectiveAccountId = getEffectiveAccountId(kind, accountId);
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
	const resolvedAccountId =
		effectiveAccountId ?? resolveDefaultSyncAccountId(runtime);
	console.info(
		`[${startedAt}] web-sync start jobId=${job.id} kind=${kind} accountId=${resolvedAccountId} transport=pending fetched=0`,
	);

	runEffectBackground(
		performWebSyncEffect(kind, effectiveAccountId, options, runtime),
		{
			onSuccess: (result) => {
				const { transport, fetched } = summarizeSyncResult(result);
				console.info(
					`[${result.finishedAt}] web-sync end jobId=${job.id} kind=${kind} accountId=${resolvedAccountId} transport=${transport} fetched=${String(fetched)} status=succeeded`,
				);
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
				console.error(
					`[${result.finishedAt}] web-sync end jobId=${job.id} kind=${kind} accountId=${resolvedAccountId} transport=unknown fetched=0 status=failed error=${formatFullError(error, runtime)}`,
				);
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
		const effectiveAccountId = getEffectiveAccountId(kind, accountId);
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
