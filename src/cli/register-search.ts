import { backfillLinkIndex, searchLinks } from "#/lib/link-index";
import { fetchTweetMedia, formatMediaFetchResult } from "#/lib/media-fetch";
import { listTimelineItems } from "#/lib/queries";
import { formatWhois, runWhois } from "#/lib/whois";
import { resolveStoredXListSelector } from "#/lib/x-lists";
import type { CliCommandContext } from "./command-context";
import { enrichDmItems, parseDmInboxOption } from "./dm-command-helpers";

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

export function registerSearchCommands({
	program,
	print,
	asJson,
	autoSyncAfterWrite,
	autoUpdateBeforeRead,
	parseNonNegativeIntegerOption,
	parsePositiveIntegerOption,
}: CliCommandContext) {
	const searchCommand = program
		.command("search")
		.description("Search local data");

	searchCommand
		.command("tweets [query]")
		.option("--resource <resource>", "home, mentions, or authored", "home")
		.option("--account <username>", "Account username or id")
		.option("--list <name>", "Only authors in a cached X List")
		.option("--list-id <id>", "Only authors in a cached X List id")
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
			if (options.minLikes !== undefined && minLikes === undefined) return;
			await autoUpdateBeforeRead();
			const selectedList =
				options.list || options.listId
					? resolveStoredXListSelector({
							account: options.account,
							name: options.list,
							listId: options.listId,
						})
					: undefined;
			const replyFilter = options.replied
				? "replied"
				: options.unreplied
					? "unreplied"
					: "all";
			print(
				listTimelineItems({
					resource:
						options.resource === "mentions"
							? "mentions"
							: options.resource === "authored"
								? "authored"
								: "home",
					account: options.account,
					listAccountId: selectedList?.accountId,
					listId: selectedList?.listId,
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
				}),
				asJson(),
			);
		});

	searchCommand
		.command("dms <query>")
		.option("--inbox <kind>", "all, accepted, or requests", "all")
		.option("--participant <value>")
		.option("--min-followers <n>", "Minimum sender follower count")
		.option("--max-followers <n>", "Maximum sender follower count")
		.option("--min-influence-score <n>", "Minimum derived influence score")
		.option("--max-influence-score <n>", "Maximum derived influence score")
		.option("--sort <mode>", "recent or followers", "recent")
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
			const context = parseNonNegativeIntegerOption(
				options.context,
				"--context",
			);
			if (context === undefined) return;
			const inbox = parseDmInboxOption(options.inbox);
			if (inbox === undefined) return;
			const replyFilter = options.replied
				? "replied"
				: options.unreplied
					? "unreplied"
					: "all";
			const items = await enrichDmItems(
				{
					search: query,
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
					context,
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
			print(items, asJson());
		});

	searchCommand
		.command("links <query>")
		.description("Search indexed short links, expansions, and linked tweets")
		.option("--account <username>", "Account username or id")
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
			if (asJson()) print(items, true);
			else console.log(formatLinkSearchItems(items));
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
			if (options.limit !== undefined && limit === undefined) return;
			const concurrency = parseNonNegativeIntegerOption(
				options.concurrency,
				"--concurrency",
			);
			if (concurrency === undefined) return;
			const timeoutMs = parseNonNegativeIntegerOption(
				options.timeoutMs,
				"--timeout-ms",
			);
			if (timeoutMs === undefined) return;
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
			print(result, asJson());
		});

	const mediaCommand = program
		.command("media")
		.description("Manage the local media cache");
	mediaCommand
		.command("fetch")
		.description(
			"Fetch missing pbs.twimg.com image media already stored in tweets",
		)
		.option("--account <username>", "Account username or id")
		.option("--limit <n>", "Stop after N tweets processed")
		.option(
			"--kind <kind>",
			"Tweet or collection kind, e.g. home, like, bookmark",
		)
		.option("--since <isoDate>", "Only tweets created at or after this date")
		.option("--parallel <n>", "Concurrent fetch workers, capped at 5", "1")
		.option("--pacing-ms <n>", "Delay between request starts", "250")
		.option("--video-pacing-ms <n>", "Delay between video request starts")
		.option("--retry-max <n>", "Retries per file after rate limiting", "3")
		.option("--include-video", "Include video and animated GIF media", true)
		.option("--no-include-video", "Skip video and animated GIF media")
		.option("--max-bytes <n>", "Maximum media file size in bytes", "104857600")
		.option("--dry-run", "List what would be fetched without downloading")
		.option("--json", "Emit JSON output")
		.action(async (options) => {
			const limit = parseNonNegativeIntegerOption(options.limit, "--limit");
			if (options.limit !== undefined && limit === undefined) return;
			const parallel =
				parsePositiveIntegerOption(options.parallel, "--parallel") ?? 1;
			const pacingMs =
				parseNonNegativeIntegerOption(options.pacingMs, "--pacing-ms") ?? 250;
			const retryMax =
				parseNonNegativeIntegerOption(options.retryMax, "--retry-max") ?? 3;
			const videoPacingMs =
				options.videoPacingMs === undefined
					? undefined
					: parseNonNegativeIntegerOption(
							options.videoPacingMs,
							"--video-pacing-ms",
						);
			const maxBytes =
				parseNonNegativeIntegerOption(options.maxBytes, "--max-bytes") ??
				100 * 1024 * 1024;
			if (process.exitCode) return;
			const result = await fetchTweetMedia({
				account: options.account,
				limit,
				kind: options.kind,
				since: options.since,
				parallel,
				pacingMs,
				videoPacingMs,
				retryMax,
				includeVideo: Boolean(options.includeVideo),
				maxBytes,
				dryRun: Boolean(options.dryRun),
			});
			const json = Boolean(asJson() || options.json);
			print(json ? result : formatMediaFetchResult(result), json);
		});

	program
		.command("whois <query>")
		.description("Identify likely people or orgs from local DMs and tweets")
		.option("--account <username>", "Account username or id")
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
			const context = parseNonNegativeIntegerOption(
				options.context,
				"--context",
			);
			if (context === undefined) return;
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
			print(asJson() ? result : formatWhois(result), asJson());
		});
}
