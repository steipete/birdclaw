import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import type { Database } from "./sqlite";
import {
	maybeAutoSyncBackupEffect,
	type BackupAutoUpdateResult,
} from "./backup";
import { ensureBirdclawDirs, getBirdclawPaths } from "./config";
import { getNativeDb } from "./db";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import {
	syncTimelineCollectionEffect,
	type TimelineCollectionMode,
} from "./timeline-collections-live";

const execFileAsync = promisify(execFile);
const DEFAULT_BOOKMARK_SYNC_INTERVAL_SECONDS = 3 * 60 * 60;
const DEFAULT_BOOKMARK_SYNC_LIMIT = 100;
const DEFAULT_BOOKMARK_SYNC_MAX_PAGES = 5;
const DEFAULT_LAUNCHD_LABEL = "com.steipete.birdclaw.bookmarks-sync";
const DEFAULT_LAUNCHD_PATH =
	"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
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

export interface BookmarkSyncLaunchAgentInstallResult {
	ok: true;
	label: string;
	plistPath: string;
	loaded: boolean;
	programArguments: string[];
	logPath: string;
	stdoutPath: string;
	stderrPath: string;
	intervalSeconds: number;
	envFile?: string;
}

function expandHome(input: string) {
	return input === "~" || input.startsWith("~/")
		? path.join(os.homedir(), input.slice(2))
		: input;
}

function resolvePath(input: string) {
	return path.resolve(expandHome(input));
}

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

function appendAuditEntryEffect(
	logPath: string,
	entry: BookmarkSyncAuditEntry,
) {
	return Effect.gen(function* () {
		yield* tryPromise(() =>
			fs.mkdir(path.dirname(logPath), { recursive: true }),
		);
		yield* tryPromise(() =>
			fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8"),
		);
	});
}

function messageFromError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function isFileExistsError(error: unknown) {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "EEXIST"
	);
}

function acquireLockEffect(
	lockPath: string,
): Effect.Effect<(() => Effect.Effect<void, never>) | undefined, unknown> {
	return Effect.gen(function* () {
		yield* tryPromise(() =>
			fs.mkdir(path.dirname(lockPath), { recursive: true }),
		);
		const handleResult = yield* tryPromise(() => fs.open(lockPath, "wx")).pipe(
			Effect.map((handle) => ({ handle, ok: true as const })),
			Effect.catchAll((error) => {
				if (isFileExistsError(error)) {
					return Effect.succeed({ error, ok: false as const });
				}
				return Effect.fail(error);
			}),
		);

		if (!handleResult.ok) {
			const stats = yield* tryPromise(() => fs.stat(lockPath)).pipe(
				Effect.catchAll(() => Effect.succeed(undefined)),
			);
			if (stats && Date.now() - stats.mtimeMs > DEFAULT_LOCK_STALE_MS) {
				yield* tryPromise(() => fs.rm(lockPath, { force: true }));
				return yield* acquireLockEffect(lockPath);
			}
			return undefined;
		}

		const { handle } = handleResult;
		yield* tryPromise(() =>
			handle.writeFile(
				`${JSON.stringify({
					pid: process.pid,
					host: os.hostname(),
					startedAt: new Date().toISOString(),
				})}\n`,
				"utf8",
			),
		).pipe(
			Effect.ensuring(
				tryPromise(() => handle.close()).pipe(
					Effect.catchAll(() => Effect.void),
				),
			),
		);
		return () =>
			tryPromise(() => fs.rm(lockPath, { force: true })).pipe(
				Effect.asVoid,
				Effect.catchAll(() => Effect.void),
			);
	});
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
			resolvePath(logPath ?? getDefaultBookmarkSyncAuditLogPath()),
		);
		const resolvedLockPath = yield* trySync(() =>
			resolvePath(lockPath ?? getDefaultBookmarkSyncLockPath()),
		);
		const effectiveAll = all ?? maxPages !== undefined;
		const started = Date.now();
		const startedAt = new Date(started).toISOString();
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

		const releaseLock = yield* acquireLockEffect(resolvedLockPath);
		if (!releaseLock) {
			const finished = Date.now();
			const entry: BookmarkSyncAuditEntry = {
				job: "bookmarks-sync",
				ok: true,
				startedAt,
				finishedAt: new Date(finished).toISOString(),
				durationMs: finished - started,
				host: os.hostname(),
				pid: process.pid,
				options,
				before,
				after: before,
				added: 0,
				skipped: "already-running",
			};
			yield* appendAuditEntryEffect(resolvedLogPath, entry);
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
				const finished = Date.now();
				const after = yield* trySync(() => ({
					bookmarks: countBookmarks(database),
				}));
				return {
					job: "bookmarks-sync",
					ok: true,
					startedAt,
					finishedAt: new Date(finished).toISOString(),
					durationMs: finished - started,
					host: os.hostname(),
					pid: process.pid,
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
						const finished = Date.now();
						const after = yield* trySync(() => ({
							bookmarks: countBookmarks(database),
						}));
						return {
							job: "bookmarks-sync",
							ok: false,
							startedAt,
							finishedAt: new Date(finished).toISOString(),
							durationMs: finished - started,
							host: os.hostname(),
							pid: process.pid,
							options,
							before,
							after,
							added: Math.max(0, after.bookmarks - before.bookmarks),
							error: messageFromError(error),
						} satisfies BookmarkSyncAuditEntry;
					}),
				),
			);
			yield* appendAuditEntryEffect(resolvedLogPath, result);
			return result;
		}).pipe(Effect.ensuring(releaseLock()));
	});
}

export function runBookmarkSyncJob(
	options: BookmarkSyncJobOptions = {},
): Promise<BookmarkSyncAuditEntry> {
	return runEffectPromise(runBookmarkSyncJobEffect(options));
}

function xmlEscape(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function stringEntry(value: string) {
	return `<string>${xmlEscape(value)}</string>`;
}

function shellQuote(value: string) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildProgramArguments({
	program = "birdclaw",
	mode = "auto",
	limit = DEFAULT_BOOKMARK_SYNC_LIMIT,
	all = false,
	maxPages = DEFAULT_BOOKMARK_SYNC_MAX_PAGES,
	refresh = true,
	cacheTtlSeconds,
	logPath,
	envFile,
}: BookmarkSyncLaunchAgentOptions) {
	const args =
		path.isAbsolute(program) || program.includes("/")
			? [program]
			: ["/usr/bin/env", program];
	args.push(
		"--json",
		"jobs",
		"sync-bookmarks",
		"--mode",
		mode,
		"--limit",
		String(limit),
		"--log",
		resolvePath(logPath ?? getDefaultBookmarkSyncAuditLogPath()),
	);
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
	if (envFile) {
		const resolvedEnvFile = resolvePath(envFile);
		return [
			"/bin/bash",
			"-lc",
			[
				"set -a",
				`[ ! -f ${shellQuote(resolvedEnvFile)} ] || . ${shellQuote(resolvedEnvFile)}`,
				"set +a",
				`exec ${args.map(shellQuote).join(" ")}`,
			].join("; "),
		];
	}
	return args;
}

export function buildBookmarkSyncLaunchAgentPlist(
	options: BookmarkSyncLaunchAgentOptions = {},
) {
	const label = options.label ?? DEFAULT_LAUNCHD_LABEL;
	const intervalSeconds =
		options.intervalSeconds ?? DEFAULT_BOOKMARK_SYNC_INTERVAL_SECONDS;
	const logPath = resolvePath(
		options.logPath ?? getDefaultBookmarkSyncAuditLogPath(),
	);
	const stdoutPath = resolvePath(
		options.stdoutPath ??
			path.join(getBirdclawPaths().rootDir, "logs", "bookmarks-sync.out.log"),
	);
	const stderrPath = resolvePath(
		options.stderrPath ??
			path.join(getBirdclawPaths().rootDir, "logs", "bookmarks-sync.err.log"),
	);
	const programArguments = buildProgramArguments({ ...options, logPath });
	const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${stringEntry(label)}
  <key>ProgramArguments</key>
  <array>
    ${programArguments.map(stringEntry).join("\n    ")}
  </array>
  <key>StartInterval</key>
  <integer>${String(intervalSeconds)}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  ${stringEntry(stdoutPath)}
  <key>StandardErrorPath</key>
  ${stringEntry(stderrPath)}
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    ${stringEntry(DEFAULT_LAUNCHD_PATH)}
  </dict>
</dict>
</plist>
`;
	return {
		label,
		intervalSeconds,
		logPath,
		...(options.envFile ? { envFile: resolvePath(options.envFile) } : {}),
		stdoutPath,
		stderrPath,
		programArguments,
		plist,
	};
}

export function installBookmarkSyncLaunchAgentEffect(
	options: BookmarkSyncLaunchAgentOptions = {},
): Effect.Effect<BookmarkSyncLaunchAgentInstallResult, unknown> {
	return Effect.gen(function* () {
		yield* trySync(() => ensureBirdclawDirs());
		const agent = yield* trySync(() =>
			buildBookmarkSyncLaunchAgentPlist(options),
		);
		const launchAgentsDir = yield* trySync(() =>
			resolvePath(options.launchAgentsDir ?? "~/Library/LaunchAgents"),
		);
		const plistPath = path.join(launchAgentsDir, `${agent.label}.plist`);
		yield* tryPromise(() => fs.mkdir(launchAgentsDir, { recursive: true }));
		yield* tryPromise(() =>
			fs.mkdir(path.dirname(agent.logPath), { recursive: true }),
		);
		yield* tryPromise(() =>
			fs.mkdir(path.dirname(agent.stdoutPath), { recursive: true }),
		);
		yield* tryPromise(() =>
			fs.mkdir(path.dirname(agent.stderrPath), { recursive: true }),
		);
		yield* tryPromise(() => fs.writeFile(plistPath, agent.plist, "utf8"));

		let loaded = false;
		if (options.load !== false) {
			yield* tryPromise(() =>
				execFileAsync("launchctl", ["unload", plistPath]),
			).pipe(Effect.catchAll(() => Effect.void));
			yield* tryPromise(() =>
				execFileAsync("launchctl", ["load", "-w", plistPath]),
			);
			loaded = true;
		}

		return {
			ok: true,
			label: agent.label,
			plistPath,
			loaded,
			programArguments: agent.programArguments,
			logPath: agent.logPath,
			stdoutPath: agent.stdoutPath,
			stderrPath: agent.stderrPath,
			intervalSeconds: agent.intervalSeconds,
			...(agent.envFile ? { envFile: agent.envFile } : {}),
		};
	});
}

export function installBookmarkSyncLaunchAgent(
	options: BookmarkSyncLaunchAgentOptions = {},
): Promise<BookmarkSyncLaunchAgentInstallResult> {
	return runEffectPromise(installBookmarkSyncLaunchAgentEffect(options));
}
