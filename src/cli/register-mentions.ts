import { resolveMentionsDataSource } from "#/lib/config";
import { exportMentionItems } from "#/lib/mentions-export";
import {
	exportMentionsViaCachedAuto,
	exportMentionsViaCachedBird,
	exportMentionsViaCachedXurl,
} from "#/lib/mentions-live";
import { inspectProfileReplies } from "#/lib/profile-replies";
import type { CliCommandContext } from "./command-context";

export function registerMentionCommands({
	program,
	print,
	asJson,
	autoSyncAfterWrite,
	autoUpdateBeforeRead,
}: CliCommandContext) {
	const mentionsCommand = program
		.command("mentions")
		.description("Export local mention tweets for scripts and agents");
	mentionsCommand
		.command("export [query]")
		.description(
			"Return mention tweets with plain-text and markdown renderings",
		)
		.option("--account <username>", "Account username or id")
		.option("--mode <mode>", "birdclaw, auto, xurl, or bird")
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
			if (mode === "xurl" || mode === "bird" || mode === "auto") {
				const exportFn =
					mode === "xurl"
						? exportMentionsViaCachedXurl
						: mode === "bird"
							? exportMentionsViaCachedBird
							: exportMentionsViaCachedAuto;
				const payload = await exportFn({
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
		.option("--account <username>", "Account username or id")
		.option("--limit <n>", "Limit replies", "12")
		.action(async (query, options) => {
			const result = await inspectProfileReplies(query, {
				account: options.account,
				limit: Number(options.limit),
			});
			print(result, asJson());
		});
}
