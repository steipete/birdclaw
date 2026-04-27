import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import { maybeAutoSyncBackup, type BackupAutoUpdateResult } from "./backup";
import { ensureBirdclawDirs, getBirdclawPaths } from "./config";
import { getNativeDb } from "./db";
import {
	syncTimelineCollection,
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
	db?: Database.Database;
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

function countBookmarks(db: Database.Database) {
	const row = db
		.prepare("select count(*) as count from tweet_collections where kind = ?")
		.get("bookmarks") as { count: number };
	return row.count;
}

async function appendAuditEntry(
	logPath: string,
	entry: BookmarkSyncAuditEntry,
) {
	await fs.mkdir(path.dirname(logPath), { recursive: true });
	await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}

function messageFromError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

async function acquireLock(lockPath: string) {
	await fs.mkdir(path.dirname(lockPath), { recursive: true });
	try {
		const handle = await fs.open(lockPath, "wx");
		await handle.writeFile(
			`${JSON.stringify({
				pid: process.pid,
				host: os.hostname(),
				startedAt: new Date().toISOString(),
			})}\n`,
			"utf8",
		);
		await handle.close();
		return async () => {
			await fs.rm(lockPath, { force: true });
		};
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "EEXIST"
		) {
			const stats = await fs.stat(lockPath).catch(() => undefined);
			if (stats && Date.now() - stats.mtimeMs > DEFAULT_LOCK_STALE_MS) {
				await fs.rm(lockPath, { force: true });
				return acquireLock(lockPath);
			}
			return undefined;
		}
		throw error;
	}
}

export async function runBookmarkSyncJob({
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
}: BookmarkSyncJobOptions = {}): Promise<BookmarkSyncAuditEntry> {
	ensureBirdclawDirs();
	const database = db ?? getNativeDb({ seedDemoData: false });
	const resolvedLogPath = resolvePath(
		logPath ?? getDefaultBookmarkSyncAuditLogPath(),
	);
	const resolvedLockPath = resolvePath(
		lockPath ?? getDefaultBookmarkSyncLockPath(),
	);
	const effectiveAll = all ?? maxPages !== undefined;
	const started = Date.now();
	const startedAt = new Date(started).toISOString();
	const before = { bookmarks: countBookmarks(database) };
	const options = {
		...(account ? { account } : {}),
		mode,
		limit,
		all: effectiveAll,
		...(maxPages === undefined ? {} : { maxPages }),
		refresh,
		...(cacheTtlMs === undefined ? {} : { cacheTtlMs }),
	};

	const releaseLock = await acquireLock(resolvedLockPath);
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
		await appendAuditEntry(resolvedLogPath, entry);
		return entry;
	}

	try {
		const sync = await syncTimelineCollection({
			kind: "bookmarks",
			account,
			mode,
			limit,
			all: effectiveAll,
			maxPages,
			refresh,
			cacheTtlMs,
		});
		const backup = await maybeAutoSyncBackup(database);
		const finished = Date.now();
		const after = { bookmarks: countBookmarks(database) };
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
			after,
			added: Math.max(0, after.bookmarks - before.bookmarks),
			sync: {
				source: sync.source,
				count: sync.count,
				accountId: sync.accountId,
			},
			backup,
		};
		await appendAuditEntry(resolvedLogPath, entry);
		return entry;
	} catch (error) {
		const finished = Date.now();
		const after = { bookmarks: countBookmarks(database) };
		const entry: BookmarkSyncAuditEntry = {
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
		};
		await appendAuditEntry(resolvedLogPath, entry);
		return entry;
	} finally {
		await releaseLock();
	}
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

function buildProgramArguments({
	program = "birdclaw",
	mode = "auto",
	limit = DEFAULT_BOOKMARK_SYNC_LIMIT,
	all = false,
	maxPages = DEFAULT_BOOKMARK_SYNC_MAX_PAGES,
	refresh = true,
	cacheTtlSeconds,
	logPath,
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
		stdoutPath,
		stderrPath,
		programArguments,
		plist,
	};
}

export async function installBookmarkSyncLaunchAgent(
	options: BookmarkSyncLaunchAgentOptions = {},
): Promise<BookmarkSyncLaunchAgentInstallResult> {
	ensureBirdclawDirs();
	const agent = buildBookmarkSyncLaunchAgentPlist(options);
	const launchAgentsDir = resolvePath(
		options.launchAgentsDir ?? "~/Library/LaunchAgents",
	);
	const plistPath = path.join(launchAgentsDir, `${agent.label}.plist`);
	await fs.mkdir(launchAgentsDir, { recursive: true });
	await fs.mkdir(path.dirname(agent.logPath), { recursive: true });
	await fs.mkdir(path.dirname(agent.stdoutPath), { recursive: true });
	await fs.mkdir(path.dirname(agent.stderrPath), { recursive: true });
	await fs.writeFile(plistPath, agent.plist, "utf8");

	let loaded = false;
	if (options.load !== false) {
		await execFileAsync("launchctl", ["unload", plistPath]).catch(() => {});
		await execFileAsync("launchctl", ["load", "-w", plistPath]);
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
	};
}
