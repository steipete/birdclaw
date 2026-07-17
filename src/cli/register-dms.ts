import {
	getAuthenticatedBirdAccount,
	runDirectMessageRequestMutationViaBird,
} from "#/lib/bird";
import { resolveOperationAccount } from "#/lib/account-selection";
import { getConversationThread } from "#/lib/dm-read-model";
import { syncDirectMessagesViaCachedBird } from "#/lib/dms-live";
import { assertLiveAccountMatches } from "#/lib/live-sync-engine";
import { applyDmRequestMutationToLocalStore } from "#/lib/queries";
import type { CliCommandContext } from "./command-context";
import {
	enrichDmItems,
	parseDmInboxOption,
	parseDmSyncModeOption,
} from "./dm-command-helpers";

export function registerDirectMessageCommands({
	program,
	print,
	autoSyncAfterWrite,
	autoUpdateBeforeRead,
	parseNonNegativeIntegerOption,
}: CliCommandContext) {
	const dmsCommand = program.command("dms").description("Direct messages");

	dmsCommand
		.command("list")
		.option("--account <username>", "Account username or id")
		.option("--mode <mode>", "auto, bird, or xurl", "bird")
		.option("--refresh", "Refresh live DMs before listing")
		.option("--cache-ttl <seconds>", "Live-cache freshness window", "120")
		.option("--inbox <kind>", "all, accepted, or requests", "all")
		.option("--max-pages <n>", "Additional accepted/request pages to sync", "0")
		.option("--all-pages", "Fetch all accepted/request pages while syncing")
		.option("--page-delay-ms <n>", "Delay between live DM page requests", "0")
		.option("--participant <value>")
		.option("--min-followers <n>", "Minimum sender follower count")
		.option("--max-followers <n>", "Maximum sender follower count")
		.option("--min-influence-score <n>", "Minimum derived influence score")
		.option("--max-influence-score <n>", "Maximum derived influence score")
		.option("--sort <mode>", "recent or followers", "recent")
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
			const inbox = parseDmInboxOption(options.inbox);
			const mode = parseDmSyncModeOption(options.mode);
			const maxPages = parseNonNegativeIntegerOption(
				options.maxPages,
				"--max-pages",
			);
			const pageDelayMs = parseNonNegativeIntegerOption(
				options.pageDelayMs,
				"--page-delay-ms",
			);
			if (
				inbox === undefined ||
				mode === undefined ||
				maxPages === undefined ||
				pageDelayMs === undefined
			)
				return;
			if (options.refresh) {
				await syncDirectMessagesViaCachedBird({
					account: options.account,
					mode,
					limit: Number(options.limit),
					...(inbox !== "all" ? { inbox } : {}),
					...(maxPages > 0 ? { maxPages } : {}),
					...(options.allPages ? { allPages: true } : {}),
					...(pageDelayMs > 0 ? { pageDelayMs } : {}),
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
					...(inbox !== "all" ? { inbox } : {}),
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
					sort:
						options.sort === "followers" || options.sort === "influence"
							? "followers"
							: "recent",
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
		.description("Refresh live direct messages into the local store")
		.option("--account <username>", "Account username or id")
		.option("--mode <mode>", "auto, bird, or xurl", "bird")
		.option("--limit <n>", "Limit messages", "20")
		.option("--inbox <kind>", "all, accepted, or requests", "all")
		.option("--max-pages <n>", "Additional accepted/request pages to sync", "0")
		.option("--all-pages", "Fetch all accepted/request pages")
		.option("--page-delay-ms <n>", "Delay between live DM page requests", "0")
		.option("--cache-ttl <seconds>", "Live-cache freshness window", "120")
		.option("--refresh", "Bypass live-cache freshness window")
		.action(async (options) => {
			const inbox = parseDmInboxOption(options.inbox);
			const mode = parseDmSyncModeOption(options.mode);
			const maxPages = parseNonNegativeIntegerOption(
				options.maxPages,
				"--max-pages",
			);
			const pageDelayMs = parseNonNegativeIntegerOption(
				options.pageDelayMs,
				"--page-delay-ms",
			);
			if (
				inbox === undefined ||
				mode === undefined ||
				maxPages === undefined ||
				pageDelayMs === undefined
			)
				return;
			const result = await syncDirectMessagesViaCachedBird({
				account: options.account,
				mode,
				limit: Number(options.limit),
				...(inbox !== "all" ? { inbox } : {}),
				...(maxPages > 0 ? { maxPages } : {}),
				...(options.allPages ? { allPages: true } : {}),
				...(pageDelayMs > 0 ? { pageDelayMs } : {}),
				refresh: Boolean(options.refresh),
				cacheTtlMs: Number(options.cacheTtl) * 1000,
			});
			await autoSyncAfterWrite();
			print(result, true);
		});

	for (const action of ["accept", "reject", "block"] as const) {
		const command = dmsCommand
			.command(`${action} <conversationId>`)
			.description(`${action} a live DM message request through bird`)
			.option("--account <username>", "Account username or id");
		if (action === "block") {
			command
				.option("--max-pages <n>", "Additional timeline pages to search", "3")
				.option("--all-pages", "Search all accepted/request timeline pages");
		}
		command.action(async (conversationId, options) => {
			const conversation = getConversationThread(conversationId);
			if (!conversation) throw new Error("Conversation not found");
			const selected = resolveOperationAccount(
				options.account ?? conversation.conversation.accountId,
			);
			if (selected.id !== conversation.conversation.accountId) {
				throw new Error(
					`Conversation belongs to ${conversation.conversation.accountId}, not ${selected.id}`,
				);
			}
			if (process.env.BIRDCLAW_DISABLE_LIVE_WRITES !== "1") {
				const authenticated = await getAuthenticatedBirdAccount();
				assertLiveAccountMatches({
					source: "bird",
					account: {
						accountId: selected.id,
						username: selected.username,
						externalUserId: selected.externalUserId,
						isDefault: false,
					},
					liveUsername: authenticated.username,
					liveExternalUserId: authenticated.id,
				});
			}
			const maxPages =
				action === "block"
					? parseNonNegativeIntegerOption(options.maxPages, "--max-pages")
					: undefined;
			if (action === "block" && maxPages === undefined) return;
			const result = await runDirectMessageRequestMutationViaBird({
				action,
				conversationId,
				...(action === "block" && maxPages !== undefined ? { maxPages } : {}),
				...(action === "block" && options.allPages ? { allPages: true } : {}),
			});
			if (result.success) {
				await applyDmRequestMutationToLocalStore(conversationId, action);
			} else {
				process.exitCode = 1;
			}
			await autoSyncAfterWrite();
			print(result, true);
		});
	}
}
