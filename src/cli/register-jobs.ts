import {
	installAccountSyncLaunchAgent,
	parseAccountSyncSteps,
	runAccountSyncJob,
} from "#/lib/account-sync-job";
import {
	installBookmarkSyncLaunchAgent,
	runBookmarkSyncJob,
} from "#/lib/bookmark-sync-job";
import type { TimelineCollectionMode } from "#/lib/timeline-collections-live";
import type { CliCommandContext } from "./command-context";

export function registerJobCommands({ program, print }: CliCommandContext) {
	const jobsCommand = program
		.command("jobs")
		.description("Run and install background Birdclaw jobs");

	jobsCommand
		.command("sync-account")
		.description(
			"Refresh live account timelines and append a JSONL audit entry",
		)
		.option("--account <accountId>", "Account id")
		.option(
			"--steps <steps>",
			"Comma list: timeline,mentions,mention-threads,likes,bookmarks,dms",
		)
		.option("--mode <mode>", "auto, xurl, or bird for likes/bookmarks", "auto")
		.option("--limit <n>", "Per-page/result limit", "100")
		.option("--max-pages <n>", "Stop after N pages", "3")
		.option("--cache-ttl <seconds>", "Live-cache freshness window", "120")
		.option("--refresh", "Bypass live-cache freshness window")
		.option(
			"--allow-bird-account",
			"Assert the account's bird profile is configured for Bird-backed steps",
		)
		.option("--log <path>", "Audit JSONL path")
		.action(async (options) => {
			const result = await runAccountSyncJob({
				account: options.account,
				steps: parseAccountSyncSteps(options.steps),
				mode: options.mode as TimelineCollectionMode,
				limit: Number(options.limit),
				maxPages: Number(options.maxPages),
				refresh: Boolean(options.refresh),
				cacheTtlMs: Number(options.cacheTtl) * 1000,
				allowBirdAccount: Boolean(options.allowBirdAccount),
				logPath: options.log,
			});
			print(result, true);
			if (!result.ok) process.exitCode = 1;
		});

	jobsCommand
		.command("install-account-launchd")
		.description("Install a LaunchAgent that runs account sync")
		.option("--label <label>", "LaunchAgent label")
		.option("--interval-seconds <seconds>", "Launch interval", "1800")
		.option("--program <path>", "birdclaw executable or command", "birdclaw")
		.option("--account <accountId>", "Account id")
		.option(
			"--steps <steps>",
			"Comma list: timeline,mentions,mention-threads,likes,bookmarks,dms",
		)
		.option("--mode <mode>", "auto, xurl, or bird for likes/bookmarks", "auto")
		.option("--limit <n>", "Per-page/result limit", "100")
		.option("--max-pages <n>", "Stop after N pages", "3")
		.option("--cache-ttl <seconds>", "Live-cache freshness window", "120")
		.option("--no-refresh", "Allow live-cache reuse")
		.option(
			"--allow-bird-account",
			"Assert the account's bird profile is configured for Bird-backed steps",
		)
		.option("--log <path>", "Audit JSONL path")
		.option(
			"--env-path <path>",
			"Shell env file to source before running",
		)
		.option("--env-file <path>", "Deprecated alias for --env-path")
		.option("--stdout <path>", "launchd stdout path")
		.option("--stderr <path>", "launchd stderr path")
		.option("--launch-agents-dir <path>", "LaunchAgents directory")
		.option("--no-load", "Write plist without loading it")
		.action(async (options) => {
			const result = await installAccountSyncLaunchAgent({
				label: options.label,
				intervalSeconds: Number(options.intervalSeconds),
				program: options.program,
				account: options.account,
				steps: parseAccountSyncSteps(options.steps),
				mode: options.mode as TimelineCollectionMode,
				limit: Number(options.limit),
				maxPages: Number(options.maxPages),
				refresh: options.refresh,
				allowBirdAccount: Boolean(options.allowBirdAccount),
				cacheTtlSeconds: Number(options.cacheTtl),
				logPath: options.log,
				envFile: options.envPath ?? options.envFile,
				stdoutPath: options.stdout,
				stderrPath: options.stderr,
				launchAgentsDir: options.launchAgentsDir,
				load: options.load,
			});
			print(result, true);
		});

	jobsCommand
		.command("sync-bookmarks")
		.description("Refresh live bookmarks and append a JSONL audit entry")
		.option("--account <accountId>", "Account id")
		.option("--mode <mode>", "auto, xurl, or bird", "auto")
		.option("--limit <n>", "Per-page/result limit", "100")
		.option("--all", "Fetch every retrievable page")
		.option("--max-pages <n>", "Stop after N pages", "5")
		.option("--cache-ttl <seconds>", "Live-cache freshness window", "120")
		.option("--refresh", "Bypass live-cache freshness window")
		.option("--log <path>", "Audit JSONL path")
		.action(async (options) => {
			const result = await runBookmarkSyncJob({
				account: options.account,
				mode: options.mode as TimelineCollectionMode,
				limit: Number(options.limit),
				all: Boolean(options.all) || options.maxPages !== undefined,
				maxPages: options.all ? undefined : Number(options.maxPages),
				refresh: Boolean(options.refresh),
				cacheTtlMs: Number(options.cacheTtl) * 1000,
				logPath: options.log,
			});
			print(result, true);
			if (!result.ok) process.exitCode = 1;
		});

	jobsCommand
		.command("install-bookmarks-launchd")
		.description("Install a LaunchAgent that runs bookmark sync every 3 hours")
		.option("--label <label>", "LaunchAgent label")
		.option("--interval-seconds <seconds>", "Launch interval", "10800")
		.option("--program <path>", "birdclaw executable or command", "birdclaw")
		.option("--mode <mode>", "auto, xurl, or bird", "auto")
		.option("--limit <n>", "Per-page/result limit", "100")
		.option("--all", "Fetch every retrievable page")
		.option("--max-pages <n>", "Stop after N pages", "5")
		.option("--cache-ttl <seconds>", "Live-cache freshness window", "120")
		.option("--no-refresh", "Allow live-cache reuse")
		.option("--log <path>", "Audit JSONL path")
		.option(
			"--env-path <path>",
			"Shell env file to source before running",
		)
		.option("--env-file <path>", "Deprecated alias for --env-path")
		.option("--stdout <path>", "launchd stdout path")
		.option("--stderr <path>", "launchd stderr path")
		.option("--launch-agents-dir <path>", "LaunchAgents directory")
		.option("--no-load", "Write plist without loading it")
		.action(async (options) => {
			const result = await installBookmarkSyncLaunchAgent({
				label: options.label,
				intervalSeconds: Number(options.intervalSeconds),
				program: options.program,
				mode: options.mode as TimelineCollectionMode,
				limit: Number(options.limit),
				all: Boolean(options.all) || options.maxPages !== undefined,
				maxPages: options.all ? undefined : Number(options.maxPages),
				refresh: options.refresh,
				cacheTtlSeconds: Number(options.cacheTtl),
				logPath: options.log,
				envFile: options.envPath ?? options.envFile,
				stdoutPath: options.stdout,
				stderrPath: options.stderr,
				launchAgentsDir: options.launchAgentsDir,
				load: options.load,
			});
			print(result, true);
		});
}
