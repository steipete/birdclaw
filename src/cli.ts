#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { findArchives } from "#/lib/archive-finder";
import { importArchive } from "#/lib/archive-import";
import { addBlock, listBlocks, removeBlock } from "#/lib/blocks";
import { ensureBirdclawDirs, getBirdclawPaths } from "#/lib/config";
import { listInboxItems, scoreInbox } from "#/lib/inbox";
import { exportMentionItems } from "#/lib/mentions-export";
import { exportMentionsViaCachedXurl } from "#/lib/mentions-live";
import { addMute, listMutes, removeMute } from "#/lib/mutes";
import { hydrateProfilesFromX } from "#/lib/profile-hydration";
import { inspectProfileReplies } from "#/lib/profile-replies";
import {
	createDmReply,
	createPost,
	createTweetReply,
	getQueryEnvelope,
	listDmConversations,
	listTimelineItems,
} from "#/lib/queries";

const program = new Command();

function print(data: unknown, asJson: boolean) {
	if (asJson) {
		console.log(JSON.stringify(data, null, 2));
		return;
	}
	console.log(data);
}

program
	.name("birdclaw")
	.description("Local-first X workspace")
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
	.description("Find likely X/Twitter archives on disk")
	.action(async () => {
		const items = await findArchives();
		print(items, program.opts().json ?? false);
	});

const importCommand = program
	.command("import")
	.description("Import local archive data");

importCommand
	.command("archive [archivePath]")
	.description("Import an X/Twitter archive into the local SQLite store")
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
		print(result, program.opts().json ?? false);
	});

importCommand
	.command("hydrate-profiles")
	.description("Backfill archive-imported profiles from live X metadata")
	.action(async () => {
		const result = await hydrateProfilesFromX();
		print(result, program.opts().json ?? false);
	});

const searchCommand = program
	.command("search")
	.description("Search local data");

searchCommand
	.command("tweets <query>")
	.option("--resource <resource>", "home or mentions", "home")
	.option("--replied", "Only replied items")
	.option("--unreplied", "Only unreplied items")
	.option("--limit <n>", "Limit results", "20")
	.action((query, options) => {
		const replyFilter = options.replied
			? "replied"
			: options.unreplied
				? "unreplied"
				: "all";
		const items = listTimelineItems({
			resource: options.resource === "mentions" ? "mentions" : "home",
			search: query,
			replyFilter,
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
	.action((query, options) => {
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

const mentionsCommand = program
	.command("mentions")
	.description("Export local mention tweets for scripts and agents");

mentionsCommand
	.command("export [query]")
	.description("Return mention tweets with plain-text and markdown renderings")
	.option("--account <accountId>", "Account id")
	.option("--mode <mode>", "birdclaw or xurl", "birdclaw")
	.option("--replied", "Only replied items")
	.option("--unreplied", "Only unreplied items")
	.option("--refresh", "Refresh the live xurl cache before returning")
	.option("--cache-ttl <seconds>", "Live-cache freshness window", "120")
	.option("--limit <n>", "Limit results", "20")
	.action(async (query, options) => {
		const replyFilter = options.replied
			? "replied"
			: options.unreplied
				? "unreplied"
				: "all";
		const limit = Number(options.limit);
		if (options.mode === "xurl") {
			const payload = await exportMentionsViaCachedXurl({
				account: options.account,
				search: query,
				replyFilter,
				limit,
				refresh: Boolean(options.refresh),
				cacheTtlMs: Number(options.cacheTtl) * 1000,
			});
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

program
	.command("dms list")
	.option("--participant <value>")
	.option("--min-followers <n>", "Minimum sender follower count")
	.option("--max-followers <n>", "Maximum sender follower count")
	.option("--min-influence-score <n>", "Minimum derived influence score")
	.option("--max-influence-score <n>", "Maximum derived influence score")
	.option("--sort <mode>", "recent or influence", "recent")
	.option("--replied", "Only replied threads")
	.option("--unreplied", "Only unreplied threads")
	.option("--limit <n>", "Limit results", "20")
	.action((_, options) => {
		const replyFilter = options.replied
			? "replied"
			: options.unreplied
				? "unreplied"
				: "all";
		const items = listDmConversations({
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

const blocksCommand = program
	.command("blocks")
	.description("Maintain the local blocklist");

blocksCommand
	.command("list")
	.option("--account <accountId>", "Account id")
	.option("--search <query>", "Filter blocked profiles")
	.option("--limit <n>", "Limit results", "50")
	.action((options) => {
		const items = listBlocks({
			account: options.account,
			search: options.search,
			limit: Number(options.limit),
		});
		print(items, program.opts().json ?? false);
	});

blocksCommand
	.command("add <query>")
	.option("--account <accountId>", "Account id", "acct_primary")
	.action(async (query, options) => {
		const result = await addBlock(options.account, query);
		print(result, program.opts().json ?? false);
	});

blocksCommand
	.command("remove <query>")
	.option("--account <accountId>", "Account id", "acct_primary")
	.action(async (query, options) => {
		const result = await removeBlock(options.account, query);
		print(result, program.opts().json ?? false);
	});

const mutesCommand = program
	.command("mutes")
	.description("Maintain the local mute list");

mutesCommand
	.command("list")
	.option("--account <accountId>", "Account id")
	.option("--search <query>", "Filter muted profiles")
	.option("--limit <n>", "Limit results", "50")
	.action((options) => {
		const items = listMutes({
			account: options.account,
			search: options.search,
			limit: Number(options.limit),
		});
		print(items, program.opts().json ?? false);
	});

mutesCommand
	.command("add <query>")
	.option("--account <accountId>", "Account id", "acct_primary")
	.action(async (query, options) => {
		const result = await addMute(options.account, query);
		print(result, program.opts().json ?? false);
	});

mutesCommand
	.command("remove <query>")
	.option("--account <accountId>", "Account id", "acct_primary")
	.action(async (query, options) => {
		const result = await removeMute(options.account, query);
		print(result, program.opts().json ?? false);
	});

program
	.command("ban <query>")
	.description("Alias for blocks add")
	.option("--account <accountId>", "Account id", "acct_primary")
	.action(async (query, options) => {
		const result = await addBlock(options.account, query);
		print(result, program.opts().json ?? false);
	});

program
	.command("unban <query>")
	.description("Alias for blocks remove")
	.option("--account <accountId>", "Account id", "acct_primary")
	.action(async (query, options) => {
		const result = await removeBlock(options.account, query);
		print(result, program.opts().json ?? false);
	});

program
	.command("mute <query>")
	.description("Mute a user for one account")
	.option("--account <accountId>", "Account id", "acct_primary")
	.action(async (query, options) => {
		const result = await addMute(options.account, query);
		print(result, program.opts().json ?? false);
	});

program
	.command("unmute <query>")
	.description("Unmute a user for one account")
	.option("--account <accountId>", "Account id", "acct_primary")
	.action(async (query, options) => {
		const result = await removeMute(options.account, query);
		print(result, program.opts().json ?? false);
	});

const composeCommand = program
	.command("compose")
	.description("Create local/xurl actions");

composeCommand
	.command("post <text>")
	.option("--account <accountId>", "Account id", "acct_primary")
	.action(async (text, options) => {
		const result = await createPost(options.account, text);
		print(result, program.opts().json ?? false);
	});

composeCommand
	.command("reply <tweetId> <text>")
	.option("--account <accountId>", "Account id", "acct_primary")
	.action(async (tweetId, text, options) => {
		const result = await createTweetReply(options.account, tweetId, text);
		print(result, program.opts().json ?? false);
	});

composeCommand
	.command("dm <conversationId> <text>")
	.description("Reply inside an existing DM conversation")
	.action(async (conversationId, text) => {
		const result = await createDmReply(conversationId, text);
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
		const kind =
			options.kind === "mentions" || options.kind === "dms"
				? options.kind
				: "mixed";
		if (options.score) {
			await scoreInbox({
				kind,
				limit: Number(options.limit),
			});
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

program
	.command("serve")
	.description("Run the local web app")
	.action(() => {
		const child = spawn("pnpm", ["dev"], {
			stdio: "inherit",
			shell: true,
		});
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
