import { existsSync } from "node:fs";
import { Effect } from "effect";
import { maybeAutoSyncBackupEffect } from "./backup";
import { getBirdclawPaths } from "./config";
import { syncDirectMessagesViaCachedBirdEffect } from "./dms-live";
import { runEffectBackground, runEffectPromise } from "./effect-runtime";
import { syncMentionThreadsEffect } from "./mention-threads-live";
import { syncMentionsEffect } from "./mentions-live";
import NativeSqliteDatabase from "./sqlite";
import { syncTimelineCollectionEffect } from "./timeline-collections-live";
import { syncHomeTimelineEffect } from "./timeline-live";

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
		accountAware: false,
		run: (account) =>
			Effect.gen(function* () {
				const result = yield* syncHomeTimelineEffect({
					account,
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
			}),
	},
	mentions: {
		label: "Mentions",
		accountAware: true,
		run: (account) =>
			Effect.gen(function* () {
				const mentions = yield* syncMentionsEffect({
					account,
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
		run: (account) => syncSavedCollection("likes", account),
	},
	bookmarks: {
		label: "Bookmarks",
		accountAware: true,
		run: (account) => syncSavedCollection("bookmarks", account),
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
): Effect.Effect<WebSyncStep[], unknown> {
	return Effect.gen(function* () {
		const isNonDefaultAccount =
			account !== undefined && account !== resolveDefaultSyncAccountId();
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
) {
	return Effect.gen(function* () {
		const startedAt = new Date().toISOString();
		const steps = yield* WEB_SYNC_PLANS[kind].run(accountId, options);

		const backup = yield* maybeAutoSyncBackupEffect();
		const finishedAt = new Date().toISOString();
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

function createWebSyncJobId(kind: WebSyncKind) {
	return `sync_${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function resolveDefaultSyncAccountId() {
	const dbPath = getBirdclawPaths().dbPath;
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
) {
	if (!WEB_SYNC_PLANS[kind].accountAware) {
		const optionKey = serializeSyncOptions(kind, options);
		return optionKey ? `${kind}:${optionKey}` : kind;
	}
	return `${kind}:${accountId ?? resolveDefaultSyncAccountId()}`;
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
): WebSyncResponse {
	const finishedAt = new Date().toISOString();
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
): WebSyncJobSnapshot {
	const effectiveAccountId = getEffectiveAccountId(kind, accountId);
	const syncKey = getRunningSyncKey(kind, effectiveAccountId, options);
	const current = runningSyncs.get(syncKey);
	if (current) {
		return current;
	}

	const startedAt = new Date().toISOString();
	const job: WebSyncJobSnapshot = {
		id: createWebSyncJobId(kind),
		kind,
		...(effectiveAccountId ? { accountId: effectiveAccountId } : {}),
		status: "running",
		startedAt,
		summary: `Syncing ${WEB_SYNC_PLANS[kind].label}`,
		inProgress: true,
	};
	webSyncJobKeys.set(job.id, syncKey);
	setJobSnapshot(job);

	runEffectBackground(performWebSyncEffect(kind, effectiveAccountId, options), {
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
	});

	return job;
}

export function getWebSyncJob(id: string): WebSyncJobSnapshot | null {
	return webSyncJobs.get(id) ?? null;
}

export function runWebSyncEffect(
	kind: WebSyncKind,
	accountId?: string,
	options: WebSyncOptions = {},
): Effect.Effect<WebSyncResponse, Error> {
	return Effect.gen(function* () {
		const effectiveAccountId = getEffectiveAccountId(kind, accountId);
		const current = runningSyncs.get(
			getRunningSyncKey(kind, effectiveAccountId, options),
		);
		const startedAt = new Date().toISOString();
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

		const job = startWebSync(kind, effectiveAccountId, options);
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
): Promise<WebSyncResponse> {
	return runEffectPromise(runWebSyncEffect(kind, accountId, options));
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
