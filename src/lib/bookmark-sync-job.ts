import path from "node:path";
import { Effect } from "effect";
import type { Database } from "./sqlite";
import {
	maybeAutoSyncBackupEffect,
	type BackupAutoUpdateResult,
} from "./backup";
import { ensureBirdclawDirs, getBirdclawPaths } from "./config";
import { getNativeDb } from "./db";
import { runEffectPromise } from "./effect-runtime";
import {
	buildLaunchAgent,
	buildLaunchProgramArguments,
	installLaunchAgentEffect,
	resolveUserPath,
	type LaunchAgentInstallResult,
} from "./launchd";
import {
	acquireScheduledJobLockEffect,
	appendScheduledJobAuditEffect,
	startScheduledJobRun,
} from "./scheduled-job";
import {
	syncTimelineCollectionEffect,
	type TimelineCollectionMode,
} from "./timeline-collections-live";

const DEFAULT_BOOKMARK_SYNC_INTERVAL_SECONDS = 3 * 60 * 60;
const DEFAULT_BOOKMARK_SYNC_LIMIT = 100;
const DEFAULT_BOOKMARK_SYNC_MAX_PAGES = 5;
const DEFAULT_LAUNCHD_LABEL = "com.steipete.birdclaw.bookmarks-sync";
const DEFAULT_LOCK_STALE_MS = 6 * 60 * 60 * 1000;

export interface BookmarkSyncJobOptions {
	account?: string;
	mode?: TimelineCollectionMode;
	limit?: number;
	all?: boolean;
	maxPages?: number;
	refresh?: boolean;
	cacheTtlMs?: number;
	logPath?: string;
	lockPath?: string;
	db?: Database;
}

export interface BookmarkSyncAuditEntry {
	job: "bookmarks-sync";
	ok: boolean;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	host: string;
	pid: number;
	options: {
		account?: string;
		mode: TimelineCollectionMode;
		limit: number;
		all: boolean;
		maxPages?: number;
		refresh: boolean;
		cacheTtlMs?: number;
	};
	before: {
		bookmarks: number;
	};
	after: {
		bookmarks: number;
	};
	added: number;
	skipped?: "already-running";
	sync?: {
		source: string;
		count: number;
		accountId: string;
	};
	backup?: BackupAutoUpdateResult;
	error?: string;
}

export interface BookmarkSyncLaunchAgentOptions {
	account?: string;
	label?: string;
	intervalSeconds?: number;
	program?: string;
	mode?: TimelineCollectionMode;
	limit?: number;
	all?: boolean;
	maxPages?: number;
	refresh?: boolean;
	cacheTtlSeconds?: number;
	logPath?: string;
	envFile?: string;
	stdoutPath?: string;
	stderrPath?: string;
	launchAgentsDir?: string;
	load?: boolean;
}

export interface BookmarkSyncLaunchAgentInstallResult extends LaunchAgentInstallResult {}

export function getDefaultBookmarkSyncAuditLogPath() {
	return path.join(getBirdclawPaths().rootDir, "audit", "bookmarks-sync.jsonl");
}

export function getDefaultBookmarkSyncLockPath() {
	return path.join(getBirdclawPaths().rootDir, "locks", "bookmarks-sync.lock");
}

function countBookmarks(db: Database) {
	const row = db
		.prepare("select count(*) as count from tweet_collections where kind = ?")
		.get("bookmarks") as { count: number };
	return row.count;
}

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function trySync<T>(try_: () => T) {
	return Effect.try({
		try: try_,
		catch: toError,
	});
}

function messageFromError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export function runBookmarkSyncJobEffect({
	account,
	mode = "auto",
	limit = DEFAULT_BOOKMARK_SYNC_LIMIT,
	all,
	maxPages = DEFAULT_BOOKMARK_SYNC_MAX_PAGES,
	refresh = true,
	cacheTtlMs,
	logPath,
	lockPath,
	db,
}: BookmarkSyncJobOptions = {}): Effect.Effect<
	BookmarkSyncAuditEntry,
	unknown
> {
	return Effect.gen(function* () {
		yield* trySync(() => ensureBirdclawDirs());
		const database =
			db ?? (yield* trySync(() => getNativeDb({ seedDemoData: false })));
		const resolvedLogPath = yield* trySync(() =>
			resolveUserPath(logPath ?? getDefaultBookmarkSyncAuditLogPath()),
		);
		const resolvedLockPath = yield* trySync(() =>
			resolveUserPath(lockPath ?? getDefaultBookmarkSyncLockPath()),
		);
		const effectiveAll = all ?? maxPages !== undefined;
		const run = startScheduledJobRun();
		const before = yield* trySync(() => ({
			bookmarks: countBookmarks(database),
		}));
		const options = {
			...(account ? { account } : {}),
			mode,
			limit,
			all: effectiveAll,
			...(maxPages === undefined ? {} : { maxPages }),
			refresh,
			...(cacheTtlMs === undefined ? {} : { cacheTtlMs }),
		};

		const releaseLock = yield* acquireScheduledJobLockEffect(
			resolvedLockPath,
			DEFAULT_LOCK_STALE_MS,
		);
		if (!releaseLock) {
			const entry: BookmarkSyncAuditEntry = {
				job: "bookmarks-sync",
				ok: true,
				...run.finish(),
				options,
				before,
				after: before,
				added: 0,
				skipped: "already-running",
			};
			yield* appendScheduledJobAuditEffect(resolvedLogPath, entry);
			return entry;
		}

		return yield* Effect.gen(function* () {
			const result = yield* Effect.gen(function* () {
				const sync = yield* syncTimelineCollectionEffect({
					kind: "bookmarks",
					account,
					mode,
					limit,
					all: effectiveAll,
					maxPages,
					refresh,
					cacheTtlMs,
				});
				const backup = yield* maybeAutoSyncBackupEffect(database);
				const after = yield* trySync(() => ({
					bookmarks: countBookmarks(database),
				}));
				return {
					job: "bookmarks-sync",
					ok: true,
					...run.finish(),
					options,
					before,
					after,
					added: Math.max(0, after.bookmarks - before.bookmarks),
					sync: {
						source: sync.source,
						count: sync.count,
						accountId: sync.accountId,
					},
					backup,
				} satisfies BookmarkSyncAuditEntry;
			}).pipe(
				Effect.catchAll((error) =>
					Effect.gen(function* () {
						const after = yield* trySync(() => ({
							bookmarks: countBookmarks(database),
						}));
						return {
							job: "bookmarks-sync",
							ok: false,
							...run.finish(),
							options,
							before,
							after,
							added: Math.max(0, after.bookmarks - before.bookmarks),
							error: messageFromError(error),
						} satisfies BookmarkSyncAuditEntry;
					}),
				),
			);
			yield* appendScheduledJobAuditEffect(resolvedLogPath, result);
			return result;
		}).pipe(Effect.ensuring(releaseLock()));
	});
}

export function runBookmarkSyncJob(
	options: BookmarkSyncJobOptions = {},
): Promise<BookmarkSyncAuditEntry> {
	return runEffectPromise(runBookmarkSyncJobEffect(options));
}

function buildProgramArguments({
	program = "birdclaw",
	account,
	mode = "auto",
	limit = DEFAULT_BOOKMARK_SYNC_LIMIT,
	all = false,
	maxPages = DEFAULT_BOOKMARK_SYNC_MAX_PAGES,
	refresh = true,
	cacheTtlSeconds,
	logPath,
	envFile,
}: BookmarkSyncLaunchAgentOptions) {
	const args = [
		"--json",
		"jobs",
		"sync-bookmarks",
		"--mode",
		mode,
		"--limit",
		String(limit),
		"--log",
		resolveUserPath(logPath ?? getDefaultBookmarkSyncAuditLogPath()),
	];
	if (account) {
		args.push("--account", account);
	}
	if (all || maxPages !== undefined) {
		args.push("--all");
	}
	if (maxPages !== undefined) {
		args.push("--max-pages", String(maxPages));
	}
	if (refresh) {
		args.push("--refresh");
	}
	if (cacheTtlSeconds !== undefined) {
		args.push("--cache-ttl", String(cacheTtlSeconds));
	}
	return buildLaunchProgramArguments({ program, args, envFile });
}

export function buildBookmarkSyncLaunchAgentPlist(
	options: BookmarkSyncLaunchAgentOptions = {},
) {
	const label = options.label ?? DEFAULT_LAUNCHD_LABEL;
	const intervalSeconds =
		options.intervalSeconds ?? DEFAULT_BOOKMARK_SYNC_INTERVAL_SECONDS;
	const logPath = resolveUserPath(
		options.logPath ?? getDefaultBookmarkSyncAuditLogPath(),
	);
	const stdoutPath = resolveUserPath(
		options.stdoutPath ??
			path.join(getBirdclawPaths().rootDir, "logs", "bookmarks-sync.out.log"),
	);
	const stderrPath = resolveUserPath(
		options.stderrPath ??
			path.join(getBirdclawPaths().rootDir, "logs", "bookmarks-sync.err.log"),
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

export function installBookmarkSyncLaunchAgentEffect(
	options: BookmarkSyncLaunchAgentOptions = {},
): Effect.Effect<BookmarkSyncLaunchAgentInstallResult, unknown> {
	return Effect.gen(function* () {
		yield* trySync(() => ensureBirdclawDirs());
		const agent = yield* trySync(() =>
			buildBookmarkSyncLaunchAgentPlist(options),
		);
		return yield* installLaunchAgentEffect(agent, options);
	});
}

export function installBookmarkSyncLaunchAgent(
	options: BookmarkSyncLaunchAgentOptions = {},
): Promise<BookmarkSyncLaunchAgentInstallResult> {
	return runEffectPromise(installBookmarkSyncLaunchAgentEffect(options));
}
