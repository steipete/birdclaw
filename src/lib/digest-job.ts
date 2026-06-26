import path from "node:path";
import type { BackupAutoUpdateResult } from "./backup";
import { maybeAutoSyncBackup } from "./backup";
import {
	ensureBirdclawDirs,
	getBirdclawPaths,
	getDiscordWebhookUrl,
} from "./config";
import { getNativeDb } from "./db";
import type { DiscordNotifyResult } from "./discord-notify";
import { sendDiscordMessage } from "./discord-notify";
import {
	buildLaunchAgent,
	buildLaunchProgramArguments,
	installLaunchAgent,
	resolveUserPath,
	type LaunchAgentInstallResult,
} from "./launchd";
import {
	streamPeriodDigest,
	type PeriodDigestPreset,
} from "./period-digest";
import {
	acquireScheduledJobLock,
	appendScheduledJobAudit,
	startScheduledJobRun,
} from "./scheduled-job";
import type { Database } from "./sqlite";

const DEFAULT_DIGEST_INTERVAL_SECONDS = 60 * 60;
const DEFAULT_DIGEST_WINDOW_HOURS = 6;
const DEFAULT_DIGEST_LABEL = "com.steipete.birdclaw.digest";
const DEFAULT_LOCK_STALE_MS = 2 * 60 * 60 * 1000;

export interface DigestJobOptions {
	account?: string;
	windowHours?: number;
	period?: string;
	includeDms?: boolean;
	model?: string;
	language?: string;
	maxTweets?: number;
	maxLinks?: number;
	logPath?: string;
	lockPath?: string;
	db?: Database;
}

export interface DigestJobAuditEntry {
	job: "digest";
	ok: boolean;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	host: string;
	pid: number;
	options: {
		account?: string;
		windowHours: number;
		period?: string;
		includeDms: boolean;
		model?: string;
		maxTweets?: number;
		maxLinks?: number;
		window?: { since: string; until: string };
	};
	skipped?: "already-running";
	digest?: {
		title: string;
		tweetCount: number;
		topicCount: number;
	};
	notify?: DiscordNotifyResult;
	backup?: BackupAutoUpdateResult;
	error?: string;
}

export interface DigestJobLaunchAgentOptions {
	label?: string;
	intervalSeconds?: number;
	program?: string;
	account?: string;
	windowHours?: number;
	period?: string;
	includeDms?: boolean;
	model?: string;
	language?: string;
	maxTweets?: number;
	maxLinks?: number;
	logPath?: string;
	envFile?: string;
	stdoutPath?: string;
	stderrPath?: string;
	launchAgentsDir?: string;
	load?: boolean;
}

export interface DigestJobLaunchAgentInstallResult extends LaunchAgentInstallResult {}

export function getDefaultDigestAuditLogPath() {
	return path.join(getBirdclawPaths().rootDir, "audit", "digest.jsonl");
}

export function getDefaultDigestLockPath() {
	return path.join(getBirdclawPaths().rootDir, "locks", "digest.lock");
}

function messageFromError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function buildDigestWindow(windowHours: number) {
	const until = new Date();
	const since = new Date(until.getTime() - windowHours * 60 * 60 * 1000);
	return {
		since: since.toISOString(),
		until: until.toISOString(),
	};
}

export async function runDigestJob({
	account,
	windowHours = DEFAULT_DIGEST_WINDOW_HOURS,
	period,
	includeDms = false,
	model,
	language,
	maxTweets,
	maxLinks,
	logPath,
	lockPath,
	db,
}: DigestJobOptions = {}): Promise<DigestJobAuditEntry> {
	ensureBirdclawDirs();
	const database = db ?? getNativeDb({ seedDemoData: false });
	const resolvedLogPath = resolveUserPath(
		logPath ?? getDefaultDigestAuditLogPath(),
	);
	const resolvedLockPath = resolveUserPath(
		lockPath ?? getDefaultDigestLockPath(),
	);
	const run = startScheduledJobRun();
	const window = buildDigestWindow(windowHours);
	const options = {
		...(account ? { account } : {}),
		windowHours,
		...(period ? { period } : {}),
		includeDms,
		...(model ? { model } : {}),
		...(maxTweets !== undefined ? { maxTweets } : {}),
		...(maxLinks !== undefined ? { maxLinks } : {}),
		window,
	};

	const releaseLock = await acquireScheduledJobLock(
		resolvedLockPath,
		DEFAULT_LOCK_STALE_MS,
	);
	if (!releaseLock) {
		const entry: DigestJobAuditEntry = {
			job: "digest",
			ok: true,
			...run.finish(),
			options,
			skipped: "already-running",
		};
		await appendScheduledJobAudit(resolvedLogPath, entry);
		return entry;
	}

	try {
		const result = await streamPeriodDigest({
			period: period as PeriodDigestPreset | undefined,
			since: period ? undefined : window.since,
			until: period ? undefined : window.until,
			account,
			includeDms,
			refresh: true,
			model,
			language,
			maxTweets,
			maxLinks,
		});

		let notify: DiscordNotifyResult | undefined;
		const webhookUrl = getDiscordWebhookUrl();
		if (webhookUrl && result.markdown) {
			notify = await sendDiscordMessage(result.markdown, webhookUrl);
		}

		const backup = await maybeAutoSyncBackup(database);
		const entry: DigestJobAuditEntry = {
			job: "digest",
			ok: true,
			...run.finish(),
			options,
			digest: {
				title: result.digest.title,
				tweetCount: result.context.tweets.length,
				topicCount: result.digest.keyTopics?.length ?? 0,
			},
			...(notify ? { notify } : {}),
			backup,
		};
		await appendScheduledJobAudit(resolvedLogPath, entry);
		return entry;
	} catch (error) {
		const entry: DigestJobAuditEntry = {
			job: "digest",
			ok: false,
			...run.finish(),
			options,
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
	windowHours = DEFAULT_DIGEST_WINDOW_HOURS,
	period,
	includeDms,
	model,
	language,
	maxTweets,
	maxLinks,
	logPath,
	envFile,
}: DigestJobLaunchAgentOptions) {
	const args = [
		"--json",
		"jobs",
		"run-digest",
		"--window-hours",
		String(windowHours),
		"--log",
		resolveUserPath(logPath ?? getDefaultDigestAuditLogPath()),
	];
	if (account) {
		args.push("--account", account);
	}
	if (period) {
		args.push("--period", period);
	}
	if (includeDms) {
		args.push("--include-dms");
	}
	if (model) {
		args.push("--model", model);
	}
	if (language) {
		args.push("--language", language);
	}
	if (maxTweets !== undefined) {
		args.push("--max-tweets", String(maxTweets));
	}
	if (maxLinks !== undefined) {
		args.push("--max-links", String(maxLinks));
	}
	return buildLaunchProgramArguments({ program, args, envFile });
}

export function buildDigestLaunchAgentPlist(
	options: DigestJobLaunchAgentOptions = {},
) {
	const label = options.label ?? DEFAULT_DIGEST_LABEL;
	const intervalSeconds =
		options.intervalSeconds ?? DEFAULT_DIGEST_INTERVAL_SECONDS;
	const logPath = resolveUserPath(
		options.logPath ?? getDefaultDigestAuditLogPath(),
	);
	const stdoutPath = resolveUserPath(
		options.stdoutPath ??
			path.join(getBirdclawPaths().rootDir, "logs", "digest.out.log"),
	);
	const stderrPath = resolveUserPath(
		options.stderrPath ??
			path.join(getBirdclawPaths().rootDir, "logs", "digest.err.log"),
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

export async function installDigestLaunchAgent(
	options: DigestJobLaunchAgentOptions = {},
): Promise<DigestJobLaunchAgentInstallResult> {
	ensureBirdclawDirs();
	const agent = buildDigestLaunchAgentPlist(options);
	return installLaunchAgent(agent, options);
}
