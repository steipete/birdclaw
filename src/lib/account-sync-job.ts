import path from "node:path";
import { maybeAutoSyncBackup, type BackupAutoUpdateResult } from "./backup";
import { ensureBirdclawDirs, getBirdclawPaths } from "./config";
import { getNativeDb } from "./db";
import { syncDirectMessagesViaCachedBird } from "./dms-live";
import {
	buildLaunchAgent,
	buildLaunchProgramArguments,
	installLaunchAgent,
	resolveUserPath,
	type LaunchAgentInstallResult,
} from "./launchd";
import { syncMentionThreads } from "./mention-threads-live";
import { syncMentions } from "./mentions-live";
import {
	acquireScheduledJobLock,
	appendScheduledJobAudit,
	startScheduledJobRun,
} from "./scheduled-job";
import type { Database } from "./sqlite";
import {
	syncTimelineCollection,
	type TimelineCollectionKind,
	type TimelineCollectionMode,
} from "./timeline-collections-live";
import { syncHomeTimeline } from "./timeline-live";

const DEFAULT_ACCOUNT_SYNC_INTERVAL_SECONDS = 30 * 60;
const DEFAULT_ACCOUNT_SYNC_LIMIT = 100;
const DEFAULT_ACCOUNT_SYNC_MAX_PAGES = 3;
const DEFAULT_ACCOUNT_SYNC_LABEL = "com.steipete.birdclaw.account-sync";
const DEFAULT_LOCK_STALE_MS = 60 * 60 * 1000;

export type AccountSyncStepKind =
	| "timeline"
	| "mentions"
	| "mention-threads"
	| "likes"
	| "bookmarks"
	| "dms";

export interface AccountSyncJobOptions {
	account?: string;
	steps?: AccountSyncStepKind[];
	mode?: TimelineCollectionMode;
	limit?: number;
	maxPages?: number;
	refresh?: boolean;
	cacheTtlMs?: number;
	allowBirdAccount?: boolean;
	logPath?: string;
	lockPath?: string;
	db?: Database;
}

export interface AccountSyncAuditStep {
	kind: AccountSyncStepKind;
	ok: boolean;
	count: number;
	source?: string;
	error?: string;
}

export interface AccountSyncAuditEntry {
	job: "account-sync";
	ok: boolean;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	host: string;
	pid: number;
	options: {
		account?: string;
		steps: AccountSyncStepKind[];
		mode: TimelineCollectionMode;
		limit: number;
		maxPages: number;
		refresh: boolean;
		cacheTtlMs?: number;
		allowBirdAccount?: boolean;
	};
	steps: AccountSyncAuditStep[];
	skipped?: "already-running";
	backup?: BackupAutoUpdateResult;
	error?: string;
}

export interface AccountSyncLaunchAgentOptions {
	label?: string;
	intervalSeconds?: number;
	program?: string;
	account?: string;
	steps?: AccountSyncStepKind[];
	mode?: TimelineCollectionMode;
	limit?: number;
	maxPages?: number;
	refresh?: boolean;
	allowBirdAccount?: boolean;
	cacheTtlSeconds?: number;
	logPath?: string;
	envFile?: string;
	stdoutPath?: string;
	stderrPath?: string;
	launchAgentsDir?: string;
	load?: boolean;
}

export interface AccountSyncLaunchAgentInstallResult extends LaunchAgentInstallResult {}

const DEFAULT_STEPS: AccountSyncStepKind[] = [
	"timeline",
	"mentions",
	"mention-threads",
	"likes",
	"bookmarks",
	"dms",
];

export function getDefaultAccountSyncAuditLogPath() {
	return path.join(getBirdclawPaths().rootDir, "audit", "account-sync.jsonl");
}

export function getDefaultAccountSyncLockPath() {
	return path.join(getBirdclawPaths().rootDir, "locks", "account-sync.lock");
}

function messageFromError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function readNumber(value: unknown, key: string): number {
	if (!value || typeof value !== "object") return 0;
	const raw = (value as Record<string, unknown>)[key];
	return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

function readString(value: unknown, key: string) {
	if (!value || typeof value !== "object") return undefined;
	const raw = (value as Record<string, unknown>)[key];
	return typeof raw === "string" ? raw : undefined;
}

function defaultAccountId(db: Database) {
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
	return row?.id;
}

function isBirdAccountConfigured(db: Database, account: string | undefined) {
	if (!account) return true;
	const row = db
		.prepare(
			`
      select id, is_default, bird_profile_name
      from accounts
      where id = ?
      `,
		)
		.get(account) as
		| { id: string; is_default: number; bird_profile_name: string | null }
		| undefined;
	if (!row) return account === defaultAccountId(db);
	if (row.is_default === 1) return true;
	return (
		typeof row.bird_profile_name === "string" &&
		row.bird_profile_name.trim() !== ""
	);
}

function birdAccountError(kind: AccountSyncStepKind) {
	return `Bird-backed ${kind} sync for a non-default account requires bird_profile_name. Run birdclaw accounts set-bird-profile for that account first.`;
}

function resolveCollectionModeForAccount({
	mode,
	birdAccountConfigured,
}: {
	mode: TimelineCollectionMode;
	birdAccountConfigured: boolean;
}) {
	if (mode === "xurl") return "xurl";
	if (!birdAccountConfigured) return undefined;
	return "bird";
}

async function runStep({
	kind,
	account,
	mode,
	limit,
	maxPages,
	refresh,
	cacheTtlMs,
	birdAccountConfigured,
}: Required<
	Pick<AccountSyncJobOptions, "mode" | "limit" | "maxPages" | "refresh">
> &
	Pick<AccountSyncJobOptions, "account" | "cacheTtlMs"> & {
		birdAccountConfigured: boolean;
		kind: AccountSyncStepKind;
	}): Promise<AccountSyncAuditStep> {
	try {
		if (kind === "timeline") {
			const timelineMode = mode === "auto" ? (account ? "bird" : "auto") : mode;
			if (timelineMode !== "xurl" && !birdAccountConfigured) {
				return { kind, ok: false, count: 0, error: birdAccountError(kind) };
			}
			const result = await syncHomeTimeline({
				account,
				mode: timelineMode,
				limit,
				maxPages,
				following: true,
				refresh,
				cacheTtlMs,
			});
			return {
				kind,
				ok: true,
				count: readNumber(result, "count"),
				source: readString(result, "source"),
			};
		}
		if (kind === "mentions") {
			const mentionMode = mode === "auto" ? (account ? "bird" : "auto") : mode;
			if (mentionMode !== "xurl" && !birdAccountConfigured) {
				return { kind, ok: false, count: 0, error: birdAccountError(kind) };
			}
			const result = await syncMentions({
				account,
				mode: mentionMode,
				limit,
				maxPages,
				refresh,
				cacheTtlMs,
			});
			return {
				kind,
				ok: true,
				count: readNumber(result, "count"),
				source: readString(result, "source"),
			};
		}
		if (kind === "mention-threads") {
			if (!birdAccountConfigured) {
				return { kind, ok: false, count: 0, error: birdAccountError(kind) };
			}
			const result = await syncMentionThreads({
				account,
				mode: "bird",
				limit: Math.min(30, limit),
				delayMs: 1500,
				timeoutMs: 15000,
			});
			return {
				kind,
				ok: true,
				count: readNumber(result, "mergedTweets"),
				source: readString(result, "source"),
			};
		}
		if (kind === "dms") {
			const dmMode = birdAccountConfigured
				? mode
				: mode === "bird"
					? undefined
					: "xurl";
			if (!dmMode) {
				return { kind, ok: false, count: 0, error: birdAccountError(kind) };
			}
			const result = await syncDirectMessagesViaCachedBird({
				account,
				mode: dmMode,
				limit: Math.min(50, limit),
				refresh,
				cacheTtlMs,
			});
			return {
				kind,
				ok: true,
				count: readNumber(result, "messages"),
				source: readString(result, "source"),
			};
		}

		const collectionKind = kind as TimelineCollectionKind;
		const collectionMode = resolveCollectionModeForAccount({
			mode,
			birdAccountConfigured,
		});
		if (!collectionMode) {
			return { kind, ok: false, count: 0, error: birdAccountError(kind) };
		}

		const result = await syncTimelineCollection({
			kind: collectionKind,
			account,
			mode: collectionMode,
			limit,
			all: true,
			maxPages,
			refresh,
			cacheTtlMs,
			earlyStop: true,
		});
		return {
			kind,
			ok: true,
			count: readNumber(result, "count"),
			source: readString(result, "source"),
		};
	} catch (error) {
		return {
			kind,
			ok: false,
			count: 0,
			error: messageFromError(error),
		};
	}
}

export async function runAccountSyncJob({
	account,
	steps = DEFAULT_STEPS,
	mode = "auto",
	limit = DEFAULT_ACCOUNT_SYNC_LIMIT,
	maxPages = DEFAULT_ACCOUNT_SYNC_MAX_PAGES,
	refresh = true,
	cacheTtlMs,
	allowBirdAccount,
	logPath,
	lockPath,
	db,
}: AccountSyncJobOptions = {}): Promise<AccountSyncAuditEntry> {
	ensureBirdclawDirs();
	const database = db ?? getNativeDb({ seedDemoData: false });
	const resolvedLogPath = resolveUserPath(
		logPath ?? getDefaultAccountSyncAuditLogPath(),
	);
	const resolvedLockPath = resolveUserPath(
		lockPath ?? getDefaultAccountSyncLockPath(),
	);
	const run = startScheduledJobRun();
	const options = {
		...(account ? { account } : {}),
		steps,
		mode,
		limit,
		maxPages,
		refresh,
		...(cacheTtlMs === undefined ? {} : { cacheTtlMs }),
		...(allowBirdAccount ? { allowBirdAccount } : {}),
	};
	const birdAccountConfigured = isBirdAccountConfigured(database, account);

	const releaseLock = await acquireScheduledJobLock(
		resolvedLockPath,
		DEFAULT_LOCK_STALE_MS,
	);
	if (!releaseLock) {
		const entry: AccountSyncAuditEntry = {
			job: "account-sync",
			ok: true,
			...run.finish(),
			options,
			steps: [],
			skipped: "already-running",
		};
		await appendScheduledJobAudit(resolvedLogPath, entry);
		return entry;
	}

	const stepResults: AccountSyncAuditStep[] = [];
	try {
		for (const kind of steps) {
			stepResults.push(
				await runStep({
					kind,
					account,
					mode,
					limit,
					maxPages,
					refresh,
					cacheTtlMs,
					birdAccountConfigured,
				}),
			);
		}
		const backup = await maybeAutoSyncBackup(database);
		const entry: AccountSyncAuditEntry = {
			job: "account-sync",
			ok: stepResults.every((step) => step.ok),
			...run.finish(),
			options,
			steps: stepResults,
			backup,
		};
		await appendScheduledJobAudit(resolvedLogPath, entry);
		return entry;
	} catch (error) {
		const entry: AccountSyncAuditEntry = {
			job: "account-sync",
			ok: false,
			...run.finish(),
			options,
			steps: stepResults,
			error: messageFromError(error),
		};
		await appendScheduledJobAudit(resolvedLogPath, entry);
		return entry;
	} finally {
		await releaseLock();
	}
}

function buildProgramArguments({
	program = "birdclaw",
	account,
	steps,
	mode = "auto",
	limit = DEFAULT_ACCOUNT_SYNC_LIMIT,
	maxPages = DEFAULT_ACCOUNT_SYNC_MAX_PAGES,
	refresh = true,
	allowBirdAccount,
	cacheTtlSeconds,
	logPath,
	envFile,
}: AccountSyncLaunchAgentOptions) {
	const args = [
		"--json",
		"jobs",
		"sync-account",
		"--mode",
		mode,
		"--limit",
		String(limit),
		"--max-pages",
		String(maxPages),
		"--log",
		resolveUserPath(logPath ?? getDefaultAccountSyncAuditLogPath()),
	];
	if (account) {
		args.push("--account", account);
	}
	if (steps?.length) {
		args.push("--steps", steps.join(","));
	}
	if (refresh) {
		args.push("--refresh");
	}
	if (allowBirdAccount) {
		args.push("--allow-bird-account");
	}
	if (cacheTtlSeconds !== undefined) {
		args.push("--cache-ttl", String(cacheTtlSeconds));
	}
	return buildLaunchProgramArguments({ program, args, envFile });
}

export function buildAccountSyncLaunchAgentPlist(
	options: AccountSyncLaunchAgentOptions = {},
) {
	const label = options.label ?? DEFAULT_ACCOUNT_SYNC_LABEL;
	const intervalSeconds =
		options.intervalSeconds ?? DEFAULT_ACCOUNT_SYNC_INTERVAL_SECONDS;
	const logPath = resolveUserPath(
		options.logPath ?? getDefaultAccountSyncAuditLogPath(),
	);
	const stdoutPath = resolveUserPath(
		options.stdoutPath ??
			path.join(getBirdclawPaths().rootDir, "logs", "account-sync.out.log"),
	);
	const stderrPath = resolveUserPath(
		options.stderrPath ??
			path.join(getBirdclawPaths().rootDir, "logs", "account-sync.err.log"),
	);
	const programArguments = buildProgramArguments({ ...options, logPath });
	return buildLaunchAgent({
		label,
		intervalSeconds,
		logPath,
		stdoutPath,
		stderrPath,
		programArguments,
		envFile: options.envFile,
	});
}

export async function installAccountSyncLaunchAgent(
	options: AccountSyncLaunchAgentOptions = {},
): Promise<AccountSyncLaunchAgentInstallResult> {
	ensureBirdclawDirs();
	const agent = buildAccountSyncLaunchAgentPlist(options);
	return installLaunchAgent(agent, options);
}

export function parseAccountSyncSteps(value: string | undefined) {
	if (!value) return undefined;
	const valid = new Set<AccountSyncStepKind>(DEFAULT_STEPS);
	const steps = value
		.split(",")
		.map((step) => step.trim())
		.filter(Boolean);
	if (steps.length === 0) return undefined;
	for (const step of steps) {
		if (!valid.has(step as AccountSyncStepKind)) {
			throw new Error(`--steps must contain ${Array.from(valid).join(", ")}`);
		}
	}
	return steps as AccountSyncStepKind[];
}
