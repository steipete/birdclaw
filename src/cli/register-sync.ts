import {
	AuthoredSyncError,
	syncAuthoredTweets,
	type AuthoredSyncMode,
} from "#/lib/authored-live";
import { syncFollowGraph } from "#/lib/follow-graph";
import { syncMentionThreads } from "#/lib/mention-threads-live";
import { syncMentions } from "#/lib/mentions-live";
import {
	syncTimelineCollection,
	type TimelineCollectionMode,
} from "#/lib/timeline-collections-live";
import { syncHomeTimeline } from "#/lib/timeline-live";
import { syncXLists, type XListSyncMode } from "#/lib/x-lists";
import { errorMessage, type CliCommandContext } from "./command-context";

export function registerSyncCommands({
	program,
	print,
	autoSyncAfterWrite,
}: CliCommandContext) {
	const syncCommand = program
		.command("sync")
		.description("Refresh live Twitter collections into the local store");

	syncCommand
		.command("lists")
		.description("Sync owned X Lists and rate-limited membership pages")
		.option("--account <username>", "Account username or id")
		.option("--mode <mode>", "auto, bird, or xurl", "auto")
		.option("--max-lists <n>", "Maximum owned Lists to inspect", "20")
		.option("--member-limit <n>", "Members per transport page", "20")
		.option("--max-member-pages <n>", "Maximum membership pages per List", "1")
		.option("--delay-ms <n>", "Delay between Lists", "1000")
		.action(async (options) => {
			try {
				const result = await syncXLists({
					account: options.account,
					mode: options.mode as XListSyncMode,
					maxLists: Number(options.maxLists),
					memberLimit: Number(options.memberLimit),
					maxMemberPages: Number(options.maxMemberPages),
					delayMs: Number(options.delayMs),
				});
				await autoSyncAfterWrite();
				print(result, true);
				if (!result.ok) process.exitCode = 5;
			} catch (error) {
				print(
					{
						ok: false,
						kind: "lists",
						mode: options.mode,
						error: errorMessage(error),
					},
					true,
				);
				process.exitCode = 1;
			}
		});

	syncCommand
		.command("timeline")
		.description("Refresh live home timeline through xurl or bird")
		.option("--account <username>", "Account username or id")
		.option("--mode <mode>", "auto, xurl, or bird", "auto")
		.option("--limit <n>", "Result limit", "100")
		.option("--max-pages <n>", "Stop after N xurl pages", "3")
		.option("--for-you", 'Fetch "For You" instead of chronological Following')
		.option("--cache-ttl <seconds>", "Live-cache freshness window", "120")
		.option("--refresh", "Bypass live-cache freshness window")
		.action(async (options) => {
			const result = await syncHomeTimeline({
				account: options.account,
				mode: options.mode,
				limit: Number(options.limit),
				maxPages: Number(options.maxPages),
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
		.option("--account <username>", "Account username or id")
		.option("--mode <mode>", "auto, bird, or xurl", "auto")
		.option("--limit <n>", "Result limit per page", "20")
		.option("--max-pages <n>", "Stop after N pages")
		.option("--since-id <id>", "Fetch mentions newer than this tweet id")
		.option(
			"--start-time <iso>",
			"Fetch mentions created at or after this time",
		)
		.option("--refresh", "Bypass live-cache freshness window")
		.option("--cache-ttl <seconds>", "Live-cache freshness window", "120")
		.action(async (options) => {
			try {
				const result = await syncMentions({
					account: options.account,
					mode: options.mode,
					limit: Number(options.limit),
					maxPages: options.maxPages ? Number(options.maxPages) : undefined,
					sinceId: options.sinceId,
					startTime: options.startTime,
					refresh: Boolean(options.refresh),
					cacheTtlMs: Number(options.cacheTtl) * 1000,
				});
				await autoSyncAfterWrite();
				print(result, true);
				if (result.partial) process.exitCode = 5;
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
		.command("authored")
		.description("Refresh authenticated authored tweets through xurl")
		.option("--account <username>", "Account username or id")
		.option("--mode <mode>", "xurl", "xurl")
		.option("--limit <n>", "X API page size", "100")
		.option("--max-pages <n>", "Stop after N pages and resume later")
		.option("--since-id <tweetId>", "Override the stored since_id cursor")
		.option(
			"--until-id <tweetId>",
			"Fetch tweets older than this id without moving the cursor",
		)
		.action(async (options) => {
			try {
				const result = await syncAuthoredTweets({
					account: options.account,
					mode: options.mode as AuthoredSyncMode,
					limit: Number(options.limit),
					maxPages: options.maxPages ? Number(options.maxPages) : undefined,
					sinceId: options.sinceId,
					untilId: options.untilId,
				});
				await autoSyncAfterWrite();
				print(result, true);
				if (result.partial) process.exitCode = 5;
			} catch (error) {
				print(
					{
						ok: false,
						kind: "authored",
						source: "xurl",
						error: errorMessage(error),
					},
					true,
				);
				process.exitCode =
					error instanceof AuthoredSyncError ? error.exitCode : 1;
			}
		});

	syncCommand
		.command("mention-threads")
		.description(
			"Fetch tweet conversation context for recent mentions through bird or xurl",
		)
		.option("--account <username>", "Account username or id")
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
				if (result.partial) process.exitCode = 5;
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
			.option("--account <username>", "Account username or id")
			.option("--mode <mode>", "auto, xurl, or bird", "auto")
			.option("--limit <n>", "Per-page/result limit", "20")
			.option("--all", "Fetch every retrievable page")
			.option(
				"--max-pages <n>",
				"Stop after N pages when using --all or --early-stop",
			)
			.option("--early-stop", "Stop when a fetched page is already fully local")
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
					earlyStop: Boolean(options.earlyStop),
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
			.option("--account <username>", "Account username or id")
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
					if (!result.dryRun) await autoSyncAfterWrite();
					print(result, true);
				} catch (error) {
					print({ ok: false, direction, error: errorMessage(error) }, true);
					process.exitCode = 1;
				}
			});
	}
}
