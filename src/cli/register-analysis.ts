import type { CliCommandContext } from "./command-context";
import {
	normalizeDigestLanguage,
	streamPeriodDigest,
	type PeriodDigestOptions,
	type PeriodDigestPreset,
} from "#/lib/period-digest";
import {
	streamProfileAnalysis,
	type ProfileAnalysisOptions,
} from "#/lib/profile-analysis";
import { runResearchMode } from "#/lib/research";
import {
	streamSearchDiscussion,
	type SearchDiscussionOptions,
	type SearchDiscussionSource,
} from "#/lib/search-discussion";

export function registerAnalysisCommands({
	program,
	print,
	autoUpdateBeforeRead,
	parseNonNegativeIntegerOption,
	parsePositiveIntegerOption,
}: CliCommandContext) {
	function printError(error: string) {
		console.error(JSON.stringify({ error }));
	}

	function parseDigestLiveModeOption(
		value: string | undefined,
	): PeriodDigestOptions["liveSyncMode"] {
		const normalized = (value ?? "xurl").trim().toLowerCase();
		if (
			normalized === "auto" ||
			normalized === "bird" ||
			normalized === "xurl"
		) {
			return normalized;
		}
		printError("--live-mode must be auto, bird, or xurl");
		process.exitCode = 1;
		return undefined;
	}
	function parseDigestPeriod(value: string | undefined): PeriodDigestPreset {
		const normalized = value?.trim().toLowerCase();
		if (normalized === "yesterday") return "yesterday";
		if (normalized === "24h" || normalized === "day") return "24h";
		if (normalized === "week" || normalized === "7d") return "week";
		return "today";
	}

	function buildDigestOptions(
		period: string | undefined,
		options: {
			account?: string;
			includeDms?: boolean;
			model?: string;
			language?: string;
			refresh?: boolean;
			since?: string;
			until?: string;
			maxTweets?: string;
			maxLinks?: string;
			liveSync?: boolean;
			liveMode?: string;
		},
	): PeriodDigestOptions | null {
		const maxTweets = parseNonNegativeIntegerOption(
			options.maxTweets,
			"--max-tweets",
		);
		if (options.maxTweets !== undefined && maxTweets === undefined) {
			return null;
		}
		const maxLinks = parseNonNegativeIntegerOption(
			options.maxLinks,
			"--max-links",
		);
		if (options.maxLinks !== undefined && maxLinks === undefined) {
			return null;
		}
		const liveSyncMode = parseDigestLiveModeOption(options.liveMode);
		if (liveSyncMode === undefined) {
			return null;
		}
		let language: string | undefined;
		try {
			language = normalizeDigestLanguage(options.language);
		} catch (error) {
			printError(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
			return null;
		}
		return {
			period: parseDigestPeriod(period),
			since: options.since,
			until: options.until,
			account: options.account,
			includeDms: Boolean(options.includeDms),
			refresh: Boolean(options.refresh),
			model: options.model,
			language,
			maxTweets,
			maxLinks,
			liveSync: options.liveSync !== false,
			liveSyncMode,
		};
	}

	function runDigestCli(options: PeriodDigestOptions) {
		const asJson = Boolean(program.opts().json);
		return streamPeriodDigest(options, {
			onDelta: asJson
				? undefined
				: (delta) => {
						process.stdout.write(delta);
					},
		}).then((result) => {
			if (asJson) {
				print(result, true);
				return;
			}
			if (!result.markdown.endsWith("\n")) {
				process.stdout.write("\n");
			}
		});
	}

	function parseSearchDiscussionSource(
		value: string | undefined,
	): SearchDiscussionSource | undefined {
		const normalized = (value ?? "all").trim().toLowerCase();
		if (
			normalized === "all" ||
			normalized === "home" ||
			normalized === "mentions" ||
			normalized === "authored" ||
			normalized === "search" ||
			normalized === "likes" ||
			normalized === "bookmarks"
		) {
			return normalized;
		}
		printError(
			"--source must be all, search, home, mentions, authored, likes, or bookmarks",
		);
		process.exitCode = 1;
		return undefined;
	}

	function parseTweetSearchMode(value: string | undefined) {
		const normalized = (value ?? "auto").trim().toLowerCase();
		if (
			normalized === "auto" ||
			normalized === "bird" ||
			normalized === "xurl" ||
			normalized === "local"
		) {
			return normalized;
		}
		printError("--mode must be auto, bird, xurl, or local");
		process.exitCode = 1;
		return undefined;
	}

	function buildSearchDiscussionOptions(
		query: string,
		options: {
			account?: string;
			source?: string;
			includeDms?: boolean;
			since?: string;
			until?: string;
			question?: string;
			originalsOnly?: boolean;
			hideLowQuality?: boolean;
			mode?: string;
			model?: string;
			refresh?: boolean;
			limit?: string;
			maxPages?: string;
		},
	): SearchDiscussionOptions | null {
		const source = parseSearchDiscussionSource(options.source);
		if (!source) return null;
		const mode = parseTweetSearchMode(options.mode);
		if (!mode) return null;
		const limit = parsePositiveIntegerOption(options.limit, "--limit");
		if (options.limit !== undefined && limit === undefined) {
			return null;
		}
		const maxPages = parsePositiveIntegerOption(
			options.maxPages,
			"--max-pages",
		);
		if (options.maxPages !== undefined && maxPages === undefined) {
			return null;
		}
		return {
			query,
			account: options.account,
			source,
			includeDms: Boolean(options.includeDms),
			since: options.since,
			until: options.until,
			question: options.question,
			originalsOnly: Boolean(options.originalsOnly),
			hideLowQuality: Boolean(options.hideLowQuality),
			mode,
			model: options.model,
			refresh: Boolean(options.refresh),
			limit,
			maxPages,
		};
	}

	function runSearchDiscussionCli(options: SearchDiscussionOptions) {
		const asJson = Boolean(program.opts().json);
		return streamSearchDiscussion(options, {
			onDelta: asJson
				? undefined
				: (delta) => {
						process.stdout.write(delta);
					},
		}).then((result) => {
			if (asJson) {
				print(result, true);
				return;
			}
			if (!result.markdown.endsWith("\n")) {
				process.stdout.write("\n");
			}
		});
	}

	function buildProfileAnalysisOptions(
		handle: string,
		options: {
			account?: string;
			model?: string;
			refresh?: boolean;
			maxTweets?: string;
			maxPages?: string;
			maxConversations?: string;
			maxConversationPages?: string;
			conversationDelayMs?: string;
			rateLimitRetryMs?: string;
			rateLimitRetries?: string;
		},
	): ProfileAnalysisOptions | null {
		const maxTweets = parsePositiveIntegerOption(
			options.maxTweets,
			"--max-tweets",
		);
		if (options.maxTweets !== undefined && maxTweets === undefined) {
			return null;
		}
		const maxPages = parsePositiveIntegerOption(
			options.maxPages,
			"--max-pages",
		);
		if (options.maxPages !== undefined && maxPages === undefined) {
			return null;
		}
		const maxConversations = parsePositiveIntegerOption(
			options.maxConversations,
			"--max-conversations",
		);
		if (
			options.maxConversations !== undefined &&
			maxConversations === undefined
		) {
			return null;
		}
		const maxConversationPages = parsePositiveIntegerOption(
			options.maxConversationPages,
			"--max-conversation-pages",
		);
		if (
			options.maxConversationPages !== undefined &&
			maxConversationPages === undefined
		) {
			return null;
		}
		const conversationDelayMs = parseNonNegativeIntegerOption(
			options.conversationDelayMs,
			"--conversation-delay-ms",
		);
		if (
			options.conversationDelayMs !== undefined &&
			conversationDelayMs === undefined
		) {
			return null;
		}
		const rateLimitRetryMs = parseNonNegativeIntegerOption(
			options.rateLimitRetryMs,
			"--rate-limit-retry-ms",
		);
		if (
			options.rateLimitRetryMs !== undefined &&
			rateLimitRetryMs === undefined
		) {
			return null;
		}
		const rateLimitMaxRetries = parseNonNegativeIntegerOption(
			options.rateLimitRetries,
			"--rate-limit-retries",
		);
		if (
			options.rateLimitRetries !== undefined &&
			rateLimitMaxRetries === undefined
		) {
			return null;
		}
		return {
			handle,
			account: options.account,
			model: options.model,
			refresh: Boolean(options.refresh),
			maxTweets,
			maxPages,
			maxConversations,
			maxConversationPages,
			conversationDelayMs,
			rateLimitRetryMs,
			rateLimitMaxRetries,
		};
	}

	function runProfileAnalysisCli(options: ProfileAnalysisOptions) {
		const asJson = Boolean(program.opts().json);
		return streamProfileAnalysis(options, {
			onDelta: asJson
				? undefined
				: (delta) => {
						process.stdout.write(delta);
					},
			onEvent: asJson
				? undefined
				: (event) => {
						if (event.type === "status") {
							process.stderr.write(
								event.detail
									? `${event.label}: ${event.detail}\n`
									: `${event.label}\n`,
							);
						}
					},
		}).then((result) => {
			if (asJson) {
				print(result, true);
				return;
			}
			if (!result.markdown.endsWith("\n")) {
				process.stdout.write("\n");
			}
		});
	}
	program
		.command("research [query]")
		.description("Build a markdown research brief from bookmarked threads")
		.option("--account <username>", "Account username or id")
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

	program
		.command("discuss <query>")
		.description("Search live/local tweets and summarize the results with AI")
		.option("--account <username>", "Account username or id")
		.option(
			"--source <source>",
			"all, search, home, mentions, authored, likes, or bookmarks",
			"search",
		)
		.option("--mode <mode>", "auto, bird, xurl, or local", "xurl")
		.option("--include-dms", "Include private DM search matches")
		.option(
			"--since <isoDate>",
			"Include matches created at or after this date",
		)
		.option("--until <isoDate>", "Include matches created before this date")
		.option("--question <prompt>", "Discussion question or angle")
		.option("--originals-only", "Exclude authored replies that start with @")
		.option("--hide-low-quality", "Hide RTs, tiny replies, and link-only noise")
		.option("--model <model>", "OpenAI model id")
		.option("--refresh", "Bypass the local discussion cache")
		.option("--limit <n>", "Maximum tweet context", "20000")
		.option("--max-pages <n>", "Maximum live search pages", "200")
		.action(async (query, options) => {
			await autoUpdateBeforeRead();
			const discussionOptions = buildSearchDiscussionOptions(query, options);
			if (!discussionOptions) return;
			await runSearchDiscussionCli(discussionOptions);
		});

	program
		.command("profile-analyze <handle>")
		.alias("profile-analyse")
		.description("Backfill a profile with xurl and summarize it with AI")
		.option("--account <username>", "Account username or id")
		.option("--model <model>", "OpenAI model id")
		.option("--refresh", "Bypass profile fetch and analysis caches")
		.option("--max-tweets <n>", "Maximum profile tweets", "10000")
		.option("--max-pages <n>", "Maximum profile timeline pages", "100")
		.option(
			"--max-conversations <n>",
			"Maximum conversations to backfill",
			"80",
		)
		.option(
			"--max-conversation-pages <n>",
			"Maximum pages per conversation",
			"3",
		)
		.option(
			"--conversation-delay-ms <n>",
			"Delay between conversation search calls",
		)
		.option(
			"--rate-limit-retry-ms <n>",
			"Delay before retrying conversation 429s",
		)
		.option("--rate-limit-retries <n>", "Conversation 429 retry count")
		.action(async (handle, options) => {
			await autoUpdateBeforeRead();
			const analysisOptions = buildProfileAnalysisOptions(handle, options);
			if (!analysisOptions) return;
			await runProfileAnalysisCli(analysisOptions);
		});

	program
		.command("today")
		.description("Stream an AI digest of what happened today")
		.option("--account <username>", "Account username or id")
		.option("--include-dms", "Include private DM context")
		.option("--model <model>", "OpenAI model id")
		.option(
			"--language <tag>",
			"Report language as a Unicode locale id, e.g. zh-CN (env: BIRDCLAW_DIGEST_LANGUAGE)",
		)
		.option("--refresh", "Bypass the local digest cache")
		.option("--max-tweets <n>", "Maximum tweet context", "5000")
		.option("--max-links <n>", "Maximum linked articles", "12")
		.option("--no-live-sync", "Use only the local database")
		.option(
			"--live-mode <mode>",
			"Live timeline mode: xurl, bird, or auto",
			"xurl",
		)
		.action(async (options) => {
			await autoUpdateBeforeRead();
			const digestOptions = buildDigestOptions("today", options);
			if (!digestOptions) return;
			await runDigestCli(digestOptions);
		});

	program
		.command("digest [period]")
		.description("Stream an AI digest for today, 24h, yesterday, or week")
		.option("--account <username>", "Account username or id")
		.option("--include-dms", "Include private DM context")
		.option("--since <isoDate>", "Start of explicit window")
		.option("--until <isoDate>", "End of explicit window")
		.option("--model <model>", "OpenAI model id")
		.option(
			"--language <tag>",
			"Report language as a Unicode locale id, e.g. zh-CN (env: BIRDCLAW_DIGEST_LANGUAGE)",
		)
		.option("--refresh", "Bypass the local digest cache")
		.option("--max-tweets <n>", "Maximum tweet context", "5000")
		.option("--max-links <n>", "Maximum linked articles", "12")
		.option("--no-live-sync", "Use only the local database")
		.option(
			"--live-mode <mode>",
			"Live timeline mode: xurl, bird, or auto",
			"xurl",
		)
		.action(async (period, options) => {
			await autoUpdateBeforeRead();
			const digestOptions = buildDigestOptions(period, options);
			if (!digestOptions) return;
			await runDigestCli(digestOptions);
		});
}
