#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command } from "commander";
import { registerModerationCommands } from "#/cli-moderation";
import { findArchives } from "#/lib/archive-finder";
import { importArchive } from "#/lib/archive-import";
import {
	exportBackup,
	importBackup,
	maybeAutoSyncBackup,
	maybeAutoUpdateBackup,
	syncBackup,
	validateBackup,
} from "#/lib/backup";
import {
	installBookmarkSyncLaunchAgent,
	runBookmarkSyncJob,
} from "#/lib/bookmark-sync-job";
import { importBlocklist } from "#/lib/blocklist";
import {
	type ActionsTransport,
	ensureBirdclawDirs,
	getBirdclawPaths,
	resolveMentionsDataSource,
} from "#/lib/config";
import { syncDirectMessagesViaCachedBird } from "#/lib/dms-live";
import { listInboxItems, scoreInbox } from "#/lib/inbox";
import { exportMentionItems } from "#/lib/mentions-export";
import {
	exportMentionsViaCachedBird,
	exportMentionsViaCachedXurl,
} from "#/lib/mentions-live";
import { hydrateProfilesFromX } from "#/lib/profile-hydration";
import { inspectProfileReplies } from "#/lib/profile-replies";
import { runResearchMode } from "#/lib/research";
import {
	createDmReply,
	createPost,
	createTweetReply,
	getQueryEnvelope,
	listDmConversations,
	listTimelineItems,
} from "#/lib/queries";
import {
	syncTimelineCollection,
	type TimelineCollectionMode,
} from "#/lib/timeline-collections-live";

const program = new Command();
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageVersion = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version?: string };

function print(data: unknown, asJson: boolean) {
	if (asJson) {
		console.log(JSON.stringify(data, null, 2));
		return;
	}
	console.log(data);
}

function printError(error: string) {
	console.error(JSON.stringify({ error }));
}

function parseNonNegativeIntegerOption(
	value: string | undefined,
	option: string,
) {
	if (value === undefined) {
		return undefined;
	}

	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) {
		printError(`${option} must be a non-negative integer`);
		process.exitCode = 1;
		return undefined;
	}

	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isSafeInteger(parsed)) {
		printError(`${option} must be a non-negative integer`);
		process.exitCode = 1;
		return undefined;
	}

	return parsed;
}

function resolveActionOptions(options: { transport?: string }) {
	return {
		transport: options.transport as ActionsTransport | undefined,
	};
}

async function autoUpdateBeforeRead() {
	const result = await maybeAutoUpdateBackup();
	if (!result.ok) {
		console.error(`birdclaw backup auto-sync failed: ${result.error}`);
	}
}

async function autoSyncAfterWrite() {
	const result = await maybeAutoSyncBackup();
	if (!result.ok) {
		console.error(`birdclaw backup sync failed: ${result.error}`);
	}
}

program
	.name("birdclaw")
	.description("Local-first Twitter workspace")
	.version(packageVersion.version ?? "0.0.0")
	.option("--json", "Emit JSON output");

program
	.command("init")
	.description("Create local birdclaw root and seed the database")
	.action(async () => {
		const paths = ensureBirdclawDirs();
		await getQueryEnvelope();
		print(
			{
				ok: true,
				rootDir: paths.rootDir,
				configPath: paths.configPath,
				dbPath: paths.dbPath,
				mediaOriginalsDir: paths.mediaOriginalsDir,
				mediaThumbsDir: paths.mediaThumbsDir,
			},
			program.opts().json ?? false,
		);
	});

program
	.command("auth status")
	.description("Show transport status")
	.action(async () => {
		const meta = await getQueryEnvelope();
		print(meta.transport, program.opts().json ?? false);
	});

program
	.command("archive find")
	.description("Find likely Twitter archives on disk")
	.action(async () => {
		const items = await findArchives();
		print(items, program.opts().json ?? false);
	});

const importCommand = program
	.command("import")
	.description("Import local archive data");

importCommand
	.command("archive [archivePath]")
	.description("Import a Twitter archive into the local SQLite store")
	.action(async (archivePath) => {
		let resolvedArchivePath = archivePath;
		if (!resolvedArchivePath) {
			const [latestArchive] = await findArchives();
			resolvedArchivePath = latestArchive?.path;
		}

		if (!resolvedArchivePath) {
			throw new Error(
				"No archive found. Pass a path or place one in Downloads.",
			);
		}

		const result = await importArchive(resolvedArchivePath);
		await autoSyncAfterWrite();
		print(result, program.opts().json ?? false);
	});

importCommand
	.command("hydrate-profiles")
	.description("Backfill archive-imported profiles from live Twitter metadata")
	.action(async () => {
		const result = await hydrateProfilesFromX();
		await autoSyncAfterWrite();
		print(result, program.opts().json ?? false);
	});

const searchCommand = program
	.command("search")
	.description("Search local data");

searchCommand
	.command("tweets [query]")
	.option("--resource <resource>", "home or mentions", "home")
	.option("--replied", "Only replied items")
	.option("--unreplied", "Only unreplied items")
	.option("--since <date>", "Include tweets created at or after this date")
	.option("--until <date>", "Include tweets created before this date")
	.option("--originals-only", "Exclude authored replies that start with @")
	.option("--hide-low-quality", "Hide RTs, tiny replies, and link-only noise")
	.option(
		"--min-likes <n>",
		"Override the low-quality like threshold (default 50)",
	)
	.option("--quality-reason", "Include qualityReason on each row")
	.option("--liked", "Only liked tweets")
	.option("--bookmarked", "Only bookmarked tweets")
	.option("--limit <n>", "Limit results", "20")
	.action(async (query, options) => {
		const minLikes = parseNonNegativeIntegerOption(
			options.minLikes,
			"--min-likes",
		);
		if (options.minLikes !== undefined && minLikes === undefined) {
			return;
		}

		await autoUpdateBeforeRead();
		const replyFilter = options.replied
			? "replied"
			: options.unreplied
				? "unreplied"
				: "all";
		const items = listTimelineItems({
			resource: options.resource === "mentions" ? "mentions" : "home",
			search: query,
			replyFilter,
			since: options.since,
			until: options.until,
			includeReplies: !options.originalsOnly,
			qualityFilter: options.hideLowQuality ? "summary" : "all",
			lowQualityThreshold: minLikes,
			includeQualityReason: Boolean(options.qualityReason),
			likedOnly: Boolean(options.liked),
			bookmarkedOnly: Boolean(options.bookmarked),
			limit: Number(options.limit),
		});
		print(items, program.opts().json ?? false);
	});

searchCommand
	.command("dms <query>")
	.option("--participant <value>")
	.option("--min-followers <n>", "Minimum sender follower count")
	.option("--max-followers <n>", "Maximum sender follower count")
	.option("--min-influence-score <n>", "Minimum derived influence score")
	.option("--max-influence-score <n>", "Maximum derived influence score")
	.option("--sort <mode>", "recent or influence", "recent")
	.option("--replied", "Only replied threads")
	.option("--unreplied", "Only unreplied threads")
	.option("--limit <n>", "Limit results", "20")
	.action(async (query, options) => {
		await autoUpdateBeforeRead();
		const replyFilter = options.replied
			? "replied"
			: options.unreplied
				? "unreplied"
				: "all";
		const items = listDmConversations({
			search: query,
			participant: options.participant,
			minFollowers: options.minFollowers
				? Number(options.minFollowers)
				: undefined,
			maxFollowers: options.maxFollowers
				? Number(options.maxFollowers)
				: undefined,
			minInfluenceScore: options.minInfluenceScore
				? Number(options.minInfluenceScore)
				: undefined,
			maxInfluenceScore: options.maxInfluenceScore
				? Number(options.maxInfluenceScore)
				: undefined,
			sort: options.sort === "influence" ? "influence" : "recent",
			replyFilter,
			limit: Number(options.limit),
		});
		print(items, program.opts().json ?? false);
	});

program
	.command("research [query]")
	.description("Build a markdown research brief from bookmarked threads")
	.option("--account <accountId>", "Account id")
	.option("--limit <n>", "Seed bookmark limit", "20")
	.option("--thread-depth <n>", "Maximum ancestor walk depth", "10")
	.option("--out <path>", "Write the markdown brief to a file")
	.action(async (query, options) => {
		await autoUpdateBeforeRead();
		const report = await runResearchMode({
			account: options.account,
			query,
			limit: Number(options.limit),
			maxThreadDepth: Number(options.threadDepth),
			outPath: options.out,
		});
		print(
			program.opts().json ? report : report.markdown,
			program.opts().json ?? false,
		);
	});

const mentionsCommand = program
	.command("mentions")
	.description("Export local mention tweets for scripts and agents");

mentionsCommand
	.command("export [query]")
	.description("Return mention tweets with plain-text and markdown renderings")
	.option("--account <accountId>", "Account id")
	.option("--mode <mode>", "birdclaw, xurl, or bird")
	.option("--replied", "Only replied items")
	.option("--unreplied", "Only unreplied items")
	.option("--refresh", "Refresh the live xurl cache before returning")
	.option("--cache-ttl <seconds>", "Live-cache freshness window", "120")
	.option("--all", "Fetch every retrievable xurl mentions page")
	.option(
		"--max-pages <n>",
		"Maximum xurl mention pages to fetch (implies --all)",
	)
	.option("--limit <n>", "Limit results", "20")
	.action(async (query, options) => {
		await autoUpdateBeforeRead();
		const replyFilter = options.replied
			? "replied"
			: options.unreplied
				? "unreplied"
				: "all";
		const limit = Number(options.limit);
		const mode = resolveMentionsDataSource(options.mode);
		if (mode === "xurl") {
			const payload = await exportMentionsViaCachedXurl({
				account: options.account,
				search: query,
				replyFilter,
				limit,
				all: Boolean(options.all) || options.maxPages !== undefined,
				maxPages: options.maxPages ? Number(options.maxPages) : undefined,
				refresh: Boolean(options.refresh),
				cacheTtlMs: Number(options.cacheTtl) * 1000,
			});
			await autoSyncAfterWrite();
			print(payload, true);
			return;
		}
		if (mode === "bird") {
			const payload = await exportMentionsViaCachedBird({
				account: options.account,
				search: query,
				replyFilter,
				limit,
				all: Boolean(options.all) || options.maxPages !== undefined,
				maxPages: options.maxPages ? Number(options.maxPages) : undefined,
				refresh: Boolean(options.refresh),
				cacheTtlMs: Number(options.cacheTtl) * 1000,
			});
			await autoSyncAfterWrite();
			print(payload, true);
			return;
		}

		const items = exportMentionItems({
			account: options.account,
			search: query,
			replyFilter,
			limit,
		});
		print({ resource: "mentions", count: items.length, items }, true);
	});

const profilesCommand = program
	.command("profiles")
	.description("Inspect live profile context for moderation and triage");

profilesCommand
	.command("replies <query>")
	.description("Inspect recent authored replies for one profile")
	.option("--limit <n>", "Limit replies", "12")
	.action(async (query, options) => {
		const result = await inspectProfileReplies(query, {
			limit: Number(options.limit),
		});
		print(result, program.opts().json ?? false);
	});

const dmsCommand = program.command("dms").description("Direct messages");

const syncCommand = program
	.command("sync")
	.description("Refresh live Twitter collections into the local store");

for (const kind of ["likes", "bookmarks"] as const) {
	syncCommand
		.command(kind)
		.description(`Refresh live ${kind} through xurl or bird`)
		.option("--account <accountId>", "Account id")
		.option("--mode <mode>", "auto, xurl, or bird", "auto")
		.option("--limit <n>", "Per-page/result limit", "20")
		.option("--all", "Fetch every retrievable page")
		.option("--max-pages <n>", "Stop after N pages when using --all")
		.option("--cache-ttl <seconds>", "Live-cache freshness window", "120")
		.option("--refresh", "Bypass live-cache freshness window")
		.action(async (options) => {
			const result = await syncTimelineCollection({
				kind,
				account: options.account,
				mode: options.mode as TimelineCollectionMode,
				limit: Number(options.limit),
				all: Boolean(options.all) || options.maxPages !== undefined,
				maxPages: options.maxPages ? Number(options.maxPages) : undefined,
				refresh: Boolean(options.refresh),
				cacheTtlMs: Number(options.cacheTtl) * 1000,
			});
			await autoSyncAfterWrite();
			print(result, true);
		});
}

const jobsCommand = program
	.command("jobs")
	.description("Run and install background Birdclaw jobs");

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
		if (!result.ok) {
			process.exitCode = 1;
		}
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
	.option("--env-file <path>", "Shell env file to source before running")
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
			envFile: options.envFile,
			stdoutPath: options.stdout,
			stderrPath: options.stderr,
			launchAgentsDir: options.launchAgentsDir,
			load: options.load,
		});
		print(result, true);
	});

dmsCommand
	.command("list")
	.option("--account <accountId>", "Account id")
	.option("--refresh", "Refresh live DMs through bird before listing")
	.option("--cache-ttl <seconds>", "Live-cache freshness window", "120")
	.option("--participant <value>")
	.option("--min-followers <n>", "Minimum sender follower count")
	.option("--max-followers <n>", "Maximum sender follower count")
	.option("--min-influence-score <n>", "Minimum derived influence score")
	.option("--max-influence-score <n>", "Maximum derived influence score")
	.option("--sort <mode>", "recent or influence", "recent")
	.option("--replied", "Only replied threads")
	.option("--unreplied", "Only unreplied threads")
	.option("--limit <n>", "Limit results", "20")
	.action(async (options) => {
		const replyFilter = options.replied
			? "replied"
			: options.unreplied
				? "unreplied"
				: "all";
		if (options.refresh) {
			await syncDirectMessagesViaCachedBird({
				account: options.account,
				limit: Number(options.limit),
				refresh: true,
				cacheTtlMs: Number(options.cacheTtl) * 1000,
			});
			await autoSyncAfterWrite();
		} else {
			await autoUpdateBeforeRead();
		}
		const items = listDmConversations({
			account: options.account,
			participant: options.participant,
			minFollowers: options.minFollowers
				? Number(options.minFollowers)
				: undefined,
			maxFollowers: options.maxFollowers
				? Number(options.maxFollowers)
				: undefined,
			minInfluenceScore: options.minInfluenceScore
				? Number(options.minInfluenceScore)
				: undefined,
			maxInfluenceScore: options.maxInfluenceScore
				? Number(options.maxInfluenceScore)
				: undefined,
			sort: options.sort === "influence" ? "influence" : "recent",
			replyFilter,
			limit: Number(options.limit),
		});
		print(items, program.opts().json ?? false);
	});

dmsCommand
	.command("sync")
	.description("Refresh live direct messages through bird into the local store")
	.option("--account <accountId>", "Account id")
	.option("--limit <n>", "Limit messages", "20")
	.option("--cache-ttl <seconds>", "Live-cache freshness window", "120")
	.option("--refresh", "Bypass live-cache freshness window")
	.action(async (options) => {
		const result = await syncDirectMessagesViaCachedBird({
			account: options.account,
			limit: Number(options.limit),
			refresh: Boolean(options.refresh),
			cacheTtlMs: Number(options.cacheTtl) * 1000,
		});
		await autoSyncAfterWrite();
		print(result, true);
	});

registerModerationCommands({
	program,
	print,
	asJson: () => program.opts().json ?? false,
	importBlocklist,
	resolveActionOptions,
});

const composeCommand = program
	.command("compose")
	.description("Create local/xurl actions");

composeCommand
	.command("post <text>")
	.option("--account <accountId>", "Account id", "acct_primary")
	.action(async (text, options) => {
		const result = await createPost(options.account, text);
		await autoSyncAfterWrite();
		print(result, program.opts().json ?? false);
	});

composeCommand
	.command("reply <tweetId> <text>")
	.option("--account <accountId>", "Account id", "acct_primary")
	.action(async (tweetId, text, options) => {
		const result = await createTweetReply(options.account, tweetId, text);
		await autoSyncAfterWrite();
		print(result, program.opts().json ?? false);
	});

composeCommand
	.command("dm <conversationId> <text>")
	.description("Reply inside an existing DM conversation")
	.action(async (conversationId, text) => {
		const result = await createDmReply(conversationId, text);
		await autoSyncAfterWrite();
		print(result, program.opts().json ?? false);
	});

program
	.command("inbox")
	.option("--kind <kind>", "mixed, mentions, or dms", "mixed")
	.option("--min-score <n>", "Minimum rank", "0")
	.option("--hide-low-signal", "Hide low-signal items")
	.option("--score", "Score top items with OpenAI before listing")
	.option("--limit <n>", "Limit results", "20")
	.action(async (options) => {
		await autoUpdateBeforeRead();
		const kind =
			options.kind === "mentions" || options.kind === "dms"
				? options.kind
				: "mixed";
		if (options.score) {
			await scoreInbox({
				kind,
				limit: Number(options.limit),
			});
			await autoSyncAfterWrite();
		}
		print(
			listInboxItems({
				kind,
				minScore: Number(options.minScore),
				hideLowSignal: Boolean(options.hideLowSignal),
				limit: Number(options.limit),
			}),
			program.opts().json ?? false,
		);
	});

program
	.command("db stats")
	.description("Show local storage and dataset stats")
	.action(async () => {
		await autoUpdateBeforeRead();
		const meta = await getQueryEnvelope();
		const paths = getBirdclawPaths();
		print(
			{
				paths,
				stats: meta.stats,
				transport: meta.transport,
			},
			program.opts().json ?? false,
		);
	});

const backupCommand = program
	.command("backup")
	.description("Export, import, and validate Git-friendly text backups");

backupCommand
	.command("export")
	.description("Export canonical JSONL backup shards")
	.requiredOption("--repo <path>", "Backup repository/path")
	.option("--commit", "Create a git commit in the backup repo")
	.option("--push", "Push the backup repo after committing")
	.option(
		"--message <message>",
		"Git commit message",
		"archive: update birdclaw backup",
	)
	.option("--no-validate", "Skip post-export validation")
	.action(async (options) => {
		const result = await exportBackup({
			repoPath: options.repo,
			commit: Boolean(options.commit) || Boolean(options.push),
			push: Boolean(options.push),
			message: options.message,
			validate: options.validate,
		});
		print(result, true);
	});

backupCommand
	.command("import <repo>")
	.description("Merge a canonical JSONL backup into the local SQLite store")
	.option("--no-validate", "Skip backup validation before import")
	.option("--replace", "Replace local portable tables instead of merging")
	.action(async (repo, options) => {
		const result = await importBackup({
			repoPath: repo,
			validate: options.validate,
			mode: options.replace ? "replace" : "merge",
		});
		print(result, true);
	});

backupCommand
	.command("sync")
	.description("Pull, merge-import, export, commit, and push a backup repo")
	.requiredOption("--repo <path>", "Backup repository/path")
	.option("--remote <url>", "Git remote to clone/configure")
	.option(
		"--message <message>",
		"Git commit message",
		"archive: sync birdclaw backup",
	)
	.action(async (options) => {
		const result = await syncBackup({
			repoPath: options.repo,
			remote: options.remote,
			message: options.message,
		});
		print(result, true);
	});

backupCommand
	.command("validate <repo>")
	.description("Validate backup manifest, shard hashes, and JSONL rows")
	.action(async (repo) => {
		const result = await validateBackup(repo);
		print(result, true);
		if (!result.ok) {
			process.exitCode = 1;
		}
	});

program
	.command("serve")
	.description("Run the local web app")
	.action(async () => {
		await autoUpdateBeforeRead();
		const child = spawn(
			process.execPath,
			["node_modules/vite/bin/vite.js", "dev", "--port", "3000"],
			{
				cwd: packageRoot,
				stdio: "inherit",
			},
		);
		child.on("exit", (code) => {
			process.exit(code ?? 0);
		});
	});

export async function runCli(argv = process.argv) {
	await program.parseAsync(argv);
}

/* v8 ignore next 5 */
if (process.argv[1]) {
	const entryUrl = pathToFileURL(process.argv[1]).href;
	if (import.meta.url === entryUrl) {
		void runCli();
	}
}
