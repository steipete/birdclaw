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
import { backfillLinkIndex, searchLinks } from "#/lib/link-index";
import { syncMentionThreads } from "#/lib/mention-threads-live";
import { exportMentionItems } from "#/lib/mentions-export";
import {
	exportMentionsViaCachedBird,
	exportMentionsViaCachedXurl,
	syncMentions,
} from "#/lib/mentions-live";
import {
	getFollowGraphSummary,
	listFollowEvents,
	listMutuals,
	listNonMutualFollowing,
	listTopFollowers,
	listUnfollowedSince,
	syncFollowGraph,
} from "#/lib/follow-graph";
import { hydrateProfilesFromX } from "#/lib/profile-hydration";
import { resolveProfilesForIds } from "#/lib/profile-resolver";
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
import { syncHomeTimeline } from "#/lib/timeline-live";
import { expandUrlsFromTexts } from "#/lib/url-expansion";
import { formatWhois, runWhois } from "#/lib/whois";

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

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function formatLinkSearchItems(items: ReturnType<typeof searchLinks>) {
	return items
		.map((item) => {
			const linked = item.linkedTweet
				? ` -> @${item.linkedTweet.author.handle}/${item.linkedTweet.id}: ${item.linkedTweet.text}`
				: ` -> ${item.expansion.finalUrl}`;
			const source =
				item.occurrence.sourceKind === "dm"
					? `dm ${item.occurrence.direction ?? ""}`.trim()
					: "tweet";
			const participant = item.participant
				? ` @${item.participant.handle}`
				: "";
			return `${item.occurrence.createdAt} ${source}${participant}: ${item.occurrence.shortUrl}${linked}`;
		})
		.join("\n");
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

async function enrichDmItems(
	query: Parameters<typeof listDmConversations>[0],
	options: {
		resolveProfiles?: boolean;
		expandUrls?: boolean;
		refreshProfileCache?: boolean;
		refreshUrlCache?: boolean;
		xurlFallback?: boolean;
	},
) {
	let items = listDmConversations(query);
	const profileResolution = options.resolveProfiles
		? await resolveProfilesForIds(
				items.map((item) => item.participant.id),
				{
					refresh: options.refreshProfileCache,
					xurlFallback: options.xurlFallback ?? true,
				},
			)
		: undefined;
	if (profileResolution) {
		items = listDmConversations(query);
	}

	const urlExpansions = options.expandUrls
		? await expandUrlsFromTexts(
				items.flatMap((item) => [
					item.lastMessagePreview,
					item.searchSnippet ?? "",
					...(item.matches ?? []).flatMap((match) => [
						...match.before.map((message) => message.text),
						match.message.text,
						...match.after.map((message) => message.text),
					]),
				]),
				{ refresh: options.refreshUrlCache },
			)
		: undefined;

	if (!profileResolution && !urlExpansions) {
		return items;
	}

	return {
		items,
		...(profileResolution ? { profileResolution } : {}),
		...(urlExpansions ? { urlExpansions } : {}),
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
	.option(
		"--context <n>",
		"Include N messages before and after each match",
		"0",
	)
	.option(
		"--resolve-profiles",
		"Resolve placeholder DM profiles through cache/bird/xurl",
	)
	.option("--expand-urls", "Expand URLs through the persistent URL cache")
	.option("--refresh-profile-cache", "Bypass profile lookup cache")
	.option("--refresh-url-cache", "Bypass URL expansion cache")
	.option(
		"--no-xurl-fallback",
		"Do not fall back to xurl after bird profile lookup",
	)
	.option("--replied", "Only replied threads")
	.option("--unreplied", "Only unreplied threads")
	.option("--limit <n>", "Limit results", "20")
	.action(async (query, options) => {
		await autoUpdateBeforeRead();
		const context = parseNonNegativeIntegerOption(options.context, "--context");
		if (context === undefined) {
			return;
		}
		const replyFilter = options.replied
			? "replied"
			: options.unreplied
				? "unreplied"
				: "all";
		const dmQuery = {
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
			context,
			limit: Number(options.limit),
		} as const;
		const items = await enrichDmItems(dmQuery, {
			resolveProfiles: Boolean(options.resolveProfiles),
			expandUrls: Boolean(options.expandUrls),
			refreshProfileCache: Boolean(options.refreshProfileCache),
			refreshUrlCache: Boolean(options.refreshUrlCache),
			xurlFallback: options.xurlFallback,
		});
		print(items, program.opts().json ?? false);
	});

searchCommand
	.command("links <query>")
	.description("Search indexed short links, expansions, and linked tweets")
	.option("--account <accountIdOrHandle>", "Account id or handle")
	.option("--since <date>", "Include links created at or after this date")
	.option("--until <date>", "Include links created before this date")
	.option("--source <kind>", "dm or tweet")
	.option("--direction <direction>", "inbound or outbound")
	.option("--participant <value>", "DM participant handle or name")
	.option("--media <type>", "image, video, or gif")
	.option("--limit <n>", "Limit results", "20")
	.action(async (query, options) => {
		await autoUpdateBeforeRead();
		const items = searchLinks(query, {
			account: options.account,
			since: options.since,
			until: options.until,
			source:
				options.source === "tweet"
					? "tweet"
					: options.source === "dm"
						? "dm"
						: undefined,
			direction:
				options.direction === "inbound"
					? "inbound"
					: options.direction === "outbound"
						? "outbound"
						: undefined,
			participant: options.participant,
			mediaType:
				options.media === "image" ||
				options.media === "video" ||
				options.media === "gif"
					? options.media
					: undefined,
			limit: Number(options.limit),
		});
		if (program.opts().json) {
			print(items, true);
			return;
		}
		console.log(formatLinkSearchItems(items));
	});

const linksCommand = program
	.command("links")
	.description("Build and inspect the short-link index");

linksCommand
	.command("backfill")
	.description("Backfill indexed URL occurrences and t.co expansions")
	.option("--all-urls", "Index all URLs, not only t.co")
	.option("--source <kind>", "dm or tweet")
	.option("--refresh-url-cache", "Re-expand URLs already in the index")
	.option("--limit <n>", "Limit network/cache expansions for this run")
	.option("--concurrency <n>", "Concurrent URL expansion workers", "12")
	.option("--timeout-ms <n>", "Per-redirect fetch timeout", "15000")
	.action(async (options) => {
		const limit = parseNonNegativeIntegerOption(options.limit, "--limit");
		if (options.limit !== undefined && limit === undefined) {
			return;
		}
		const concurrency = parseNonNegativeIntegerOption(
			options.concurrency,
			"--concurrency",
		);
		if (concurrency === undefined) {
			return;
		}
		const timeoutMs = parseNonNegativeIntegerOption(
			options.timeoutMs,
			"--timeout-ms",
		);
		if (timeoutMs === undefined) {
			return;
		}
		const result = await backfillLinkIndex({
			includeAllUrls: Boolean(options.allUrls),
			refresh: Boolean(options.refreshUrlCache),
			source:
				options.source === "tweet"
					? "tweet"
					: options.source === "dm"
						? "dm"
						: undefined,
			limit,
			concurrency,
			timeoutMs,
		});
		await autoSyncAfterWrite();
		print(result, program.opts().json ?? false);
	});

program
	.command("whois <query>")
	.description("Identify likely people or orgs from local DMs and tweets")
	.option("--account <accountId>", "Account id")
	.option("--no-dms", "Do not search DMs")
	.option("--tweets", "Include local tweet search evidence")
	.option("--no-resolve-profiles", "Do not resolve placeholder profiles")
	.option("--no-expand-urls", "Do not expand URLs")
	.option("--refresh-profile-cache", "Bypass profile lookup cache")
	.option("--refresh-url-cache", "Bypass URL expansion cache")
	.option(
		"--no-xurl-fallback",
		"Do not fall back to xurl after bird profile lookup",
	)
	.option(
		"--affiliation <query>",
		"Require affiliation, bio, or history evidence",
	)
	.option(
		"--current-affiliation <query>",
		"Require an active affiliation badge",
	)
	.option(
		"--exclude-domain-only",
		"Drop candidates that only match domains/URLs",
	)
	.option("--context <n>", "DM messages before and after each match", "4")
	.option("--limit <n>", "Limit candidates", "10")
	.action(async (query, options) => {
		await autoUpdateBeforeRead();
		const context = parseNonNegativeIntegerOption(options.context, "--context");
		if (context === undefined) {
			return;
		}
		const result = await runWhois(query, {
			account: options.account,
			dms: options.dms,
			tweets: Boolean(options.tweets),
			resolveProfiles: options.resolveProfiles,
			expandUrls: options.expandUrls,
			refreshProfileCache: Boolean(options.refreshProfileCache),
			refreshUrlCache: Boolean(options.refreshUrlCache),
			xurlFallback: options.xurlFallback,
			affiliation: options.affiliation,
			currentAffiliation: options.currentAffiliation,
			excludeDomainOnly: Boolean(options.excludeDomainOnly),
			context,
			limit: Number(options.limit),
		});
		print(
			program.opts().json ? result : formatWhois(result),
			program.opts().json ?? false,
		);
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

syncCommand
	.command("timeline")
	.description("Refresh live home timeline through bird")
	.option("--account <accountId>", "Account id")
	.option("--limit <n>", "Result limit", "100")
	.option("--for-you", 'Fetch "For You" instead of chronological Following')
	.option("--cache-ttl <seconds>", "Live-cache freshness window", "120")
	.option("--refresh", "Bypass live-cache freshness window")
	.action(async (options) => {
		const result = await syncHomeTimeline({
			account: options.account,
			limit: Number(options.limit),
			following: !options.forYou,
			refresh: Boolean(options.refresh),
			cacheTtlMs: Number(options.cacheTtl) * 1000,
		});
		await autoSyncAfterWrite();
		print(result, true);
	});

syncCommand
	.command("mentions")
	.description("Refresh live mentions through xurl or bird")
	.option("--account <accountId>", "Account id")
	.option("--mode <mode>", "bird or xurl", "xurl")
	.option("--limit <n>", "Result limit per page", "20")
	.option("--max-pages <n>", "Stop after N pages")
	.option("--refresh", "Bypass live-cache freshness window")
	.option("--cache-ttl <seconds>", "Live-cache freshness window", "120")
	.action(async (options) => {
		try {
			const result = await syncMentions({
				account: options.account,
				mode: options.mode,
				limit: Number(options.limit),
				maxPages: options.maxPages ? Number(options.maxPages) : undefined,
				refresh: Boolean(options.refresh),
				cacheTtlMs: Number(options.cacheTtl) * 1000,
			});
			await autoSyncAfterWrite();
			print(result, true);
			if (result.partial) {
				process.exitCode = 5;
			}
		} catch (error) {
			print(
				{
					ok: false,
					kind: "mentions",
					mode: options.mode ?? "xurl",
					error: errorMessage(error),
				},
				true,
			);
			process.exitCode = 1;
		}
	});

syncCommand
	.command("mention-threads")
	.description(
		"Fetch tweet conversation context for recent mentions through bird or xurl",
	)
	.option("--account <accountId>", "Account id")
	.option("--mode <mode>", "bird or xurl", "bird")
	.option("--limit <n>", "Recent mentions to inspect", "30")
	.option("--delay-ms <n>", "Delay between thread fetches", "1500")
	.option("--timeout-ms <n>", "Per-thread timeout", "15000")
	.option("--all", "Fetch all retrievable thread pages")
	.option("--max-pages <n>", "Stop after N pages")
	.action(async (options) => {
		try {
			const result = await syncMentionThreads({
				account: options.account,
				mode: options.mode,
				limit: Number(options.limit),
				delayMs: Number(options.delayMs),
				timeoutMs: Number(options.timeoutMs),
				all: Boolean(options.all),
				maxPages: options.maxPages ? Number(options.maxPages) : undefined,
			});
			await autoSyncAfterWrite();
			print(result, true);
		} catch (error) {
			print(
				{
					ok: false,
					kind: "mention-threads",
					mode: options.mode ?? "bird",
					error: errorMessage(error),
				},
				true,
			);
			process.exitCode = 1;
		}
	});

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

for (const direction of ["followers", "following"] as const) {
	syncCommand
		.command(direction)
		.description(
			`Dry-run or refresh live ${direction} into the local follow graph`,
		)
		.option("--account <accountId>", "Account id")
		.option("--mode <mode>", "auto, bird, or xurl", "auto")
		.option("--limit <n>", "X API users per page", "1000")
		.option("--max-pages <n>", "Stop after N pages")
		.option("--max-resources <n>", "Stop after N unique users")
		.option("--cache-ttl <seconds>", "Live-cache freshness window", "86400")
		.option("--refresh", "Bypass the live-cache freshness window")
		.option("--allow-partial", "Acknowledge capped/incomplete snapshot")
		.option("--yes", "Confirm live sync or fresh-cache merge")
		.action(async (options) => {
			try {
				const result = await syncFollowGraph({
					direction,
					account: options.account,
					mode: options.mode,
					limit: Number(options.limit),
					maxPages: options.maxPages ? Number(options.maxPages) : undefined,
					maxResources: options.maxResources
						? Number(options.maxResources)
						: undefined,
					cacheTtlMs: Number(options.cacheTtl) * 1000,
					refresh: Boolean(options.refresh),
					allowPartial: Boolean(options.allowPartial),
					yes: Boolean(options.yes),
				});
				if (!result.dryRun) {
					await autoSyncAfterWrite();
				}
				print(result, true);
			} catch (error) {
				print({ ok: false, direction, error: errorMessage(error) }, true);
				process.exitCode = 1;
			}
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
	.option(
		"--resolve-profiles",
		"Resolve placeholder DM profiles through cache/bird/xurl",
	)
	.option("--expand-urls", "Expand URLs through the persistent URL cache")
	.option("--refresh-profile-cache", "Bypass profile lookup cache")
	.option("--refresh-url-cache", "Bypass URL expansion cache")
	.option(
		"--no-xurl-fallback",
		"Do not fall back to xurl after bird profile lookup",
	)
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
		const items = await enrichDmItems(
			{
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
			},
			{
				resolveProfiles: Boolean(options.resolveProfiles),
				expandUrls: Boolean(options.expandUrls),
				refreshProfileCache: Boolean(options.refreshProfileCache),
				refreshUrlCache: Boolean(options.refreshUrlCache),
				xurlFallback: options.xurlFallback,
			},
		);
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

const graphCommand = program
	.command("graph")
	.description("Query the local cache-only follow graph");

graphCommand
	.command("summary")
	.description("Summarize cached followers, following, mutuals, and snapshots")
	.option("--account <accountId>", "Account id")
	.action(async (options) => {
		await autoUpdateBeforeRead();
		print(getFollowGraphSummary({ account: options.account }), true);
	});

graphCommand
	.command("top-followers")
	.description("List current followers sorted by their follower count")
	.option("--account <accountId>", "Account id")
	.option("--limit <n>", "Limit results", "20")
	.action(async (options) => {
		await autoUpdateBeforeRead();
		print(
			listTopFollowers({
				account: options.account,
				limit: Number(options.limit),
			}),
			true,
		);
	});

graphCommand
	.command("unfollowed")
	.description("List cached ended follow edges since a date")
	.requiredOption("--date <date>", "YYYY-MM-DD or ISO timestamp")
	.option("--account <accountId>", "Account id")
	.option("--direction <direction>", "followers or following", "followers")
	.option("--limit <n>", "Limit results", "100")
	.action(async (options) => {
		await autoUpdateBeforeRead();
		print(
			listUnfollowedSince({
				account: options.account,
				date: options.date,
				direction:
					options.direction === "following" ? "following" : "followers",
				limit: Number(options.limit),
			}),
			true,
		);
	});

graphCommand
	.command("events")
	.description("List cached append-only follow graph events")
	.option("--account <accountId>", "Account id")
	.option("--direction <direction>", "followers or following")
	.option("--kind <kind>", "started or ended")
	.option("--since <date>", "YYYY-MM-DD or ISO timestamp")
	.option("--until <date>", "YYYY-MM-DD or ISO timestamp")
	.option("--limit <n>", "Limit results", "100")
	.action(async (options) => {
		await autoUpdateBeforeRead();
		print(
			listFollowEvents({
				account: options.account,
				direction:
					options.direction === "followers" || options.direction === "following"
						? options.direction
						: undefined,
				kind:
					options.kind === "started" || options.kind === "ended"
						? options.kind
						: undefined,
				since: options.since,
				until: options.until,
				limit: Number(options.limit),
			}),
			true,
		);
	});

graphCommand
	.command("non-mutual-following")
	.description("List current following who are not current followers")
	.option("--account <accountId>", "Account id")
	.option("--sort <mode>", "followers or handle", "followers")
	.option("--limit <n>", "Limit results", "100")
	.action(async (options) => {
		await autoUpdateBeforeRead();
		print(
			listNonMutualFollowing({
				account: options.account,
				sort: options.sort === "handle" ? "handle" : "followers",
				limit: Number(options.limit),
			}),
			true,
		);
	});

graphCommand
	.command("mutuals")
	.description("List profiles that are both followers and following")
	.option("--account <accountId>", "Account id")
	.option("--limit <n>", "Limit results", "100")
	.action(async (options) => {
		await autoUpdateBeforeRead();
		print(
			listMutuals({
				account: options.account,
				limit: Number(options.limit),
			}),
			true,
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
		void runCli().catch((error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		});
	}
}
