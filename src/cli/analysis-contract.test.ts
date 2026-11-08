// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "../lib/config";
import { getNativeDb, resetDatabaseForTests } from "../lib/db";
import {
	configureOperationAccountSelection,
	createCommandContext,
	resetOperationAccountSelection,
} from "./command-context";
import { CliInputError, configureNumericOptions } from "./numeric-options";
import { registerAnalysisCommands } from "./register-analysis";
import { registerGraphCommands } from "./register-graph";
import { registerMentionCommands } from "./register-mentions";

const calls = vi.hoisted(() => ({
	research: vi.fn(),
	digest: vi.fn(),
	local: vi.fn(),
	auto: vi.fn(),
	bird: vi.fn(),
	xurl: vi.fn(),
	replies: vi.fn(),
	events: vi.fn(),
	unfollowed: vi.fn(),
	nonMutual: vi.fn(),
	update: vi.fn(),
	sync: vi.fn(),
	print: vi.fn(),
}));
vi.mock("../lib/research", () => ({ runResearchMode: calls.research }));
vi.mock("../lib/period-digest", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/period-digest")>()),
	streamPeriodDigest: calls.digest,
}));
vi.mock("../lib/mentions-export", () => ({ exportMentionItems: calls.local }));
vi.mock("../lib/mentions-live", () => ({
	exportMentionsViaCachedAuto: calls.auto,
	exportMentionsViaCachedBird: calls.bird,
	exportMentionsViaCachedXurl: calls.xurl,
}));
vi.mock("../lib/profile-replies", () => ({
	inspectProfileReplies: calls.replies,
}));
vi.mock("../lib/follow-graph", () => ({
	getFollowGraphSummary: vi.fn(),
	listMutuals: vi.fn(),
	listTopFollowers: vi.fn(),
	listFollowEvents: calls.events,
	listUnfollowedSince: calls.unfollowed,
	listNonMutualFollowing: calls.nonMutual,
}));
let home: string;
beforeEach(() => {
	vi.clearAllMocks();
	home = mkdtempSync(path.join(os.tmpdir(), "birdclaw-analysis-contract-"));
	vi.stubEnv("BIRDCLAW_HOME", home);
	vi.stubEnv("BIRDCLAW_CONFIG", path.join(home, "config.json"));
	vi.stubEnv("BIRDCLAW_MENTIONS_DATA_SOURCE", "birdclaw");
	vi.stubEnv("BIRDCLAW_DIGEST_LIVE_MODE", "xurl");
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
	calls.research.mockResolvedValue({ markdown: "research" });
	calls.digest.mockResolvedValue({ markdown: "digest" });
	calls.local.mockReturnValue([]);
});
afterEach(() => {
	resetOperationAccountSelection();
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});
function run(args: string[]) {
	const program = new Command().option("--json").exitOverride();
	configureNumericOptions(program);
	configureOperationAccountSelection(program);
	const context = {
		...createCommandContext(program),
		autoUpdateBeforeRead: calls.update,
		autoSyncAfterWrite: calls.sync,
		print: calls.print,
	};
	registerAnalysisCommands(context);
	registerGraphCommands(context);
	registerMentionCommands(context);
	return program.parseAsync(["--json", ...args], { from: "user" });
}

const invalid: { args: string[]; message: string }[] = [
	...["bogus", "month", "", "   "].map((period) => ({
		args: ["digest", period],
		message: "period",
	})),
	...["today", "digest"].map((command) => ({
		args: [command, "--live-mode", "bogus"],
		message: "--live-mode",
	})),
	...["today", "digest"].map((command) => ({
		args: [command, "--language", "bad_tag"],
		message: "Unicode locale",
	})),
	...["--limit", "--thread-depth"].map((option) => ({
		args: ["research", option, "0"],
		message: option,
	})),
	...["weird", ""].map((mode) => ({
		args: ["mentions", "export", "--mode", mode],
		message: "--mode must be birdclaw, auto, xurl, or bird",
	})),
	{
		args: ["mentions", "export", "--replied", "--unreplied"],
		message: "Cannot combine --replied and --unreplied",
	},
	...["birdclaw", "auto", "xurl", "bird"].flatMap((mode) =>
		["--limit", "--max-pages"].map((option) => ({
			args: ["mentions", "export", "--mode", mode, option, "0"],
			message: option,
		})),
	),
	{
		args: ["profiles", "replies", "alice", "--limit", "0"],
		message: "--limit",
	},
	...["bogus", ""].flatMap((value) => [
		{
			args: [
				"graph",
				"unfollowed",
				"--date",
				"2026-01-01",
				"--direction",
				value,
			],
			message: "--direction",
		},
		{ args: ["graph", "events", "--direction", value], message: "--direction" },
		{ args: ["graph", "events", "--kind", value], message: "--kind" },
		{
			args: ["graph", "non-mutual-following", "--sort", value],
			message: "--sort",
		},
	]),
	// Existing numeric-hook rejection is an opposite control, not a new defect.
	...["-1", "1.5", "NaN", "Infinity", "junk", ""].flatMap((value) => [
		{ args: ["research", "--limit", value], message: "--limit" },
		{ args: ["research", "--thread-depth", value], message: "--thread-depth" },
		{
			args: ["mentions", "export", "--max-pages", value],
			message: "--max-pages",
		},
		{ args: ["mentions", "export", "--limit", value], message: "--limit" },
		{
			args: ["profiles", "replies", "alice", "--limit", value],
			message: "--limit",
		},
	]),
];
describe("analysis, mentions and graph CLI contracts", () => {
	it.each(invalid)(
		"rejects $args before read/update/transport effects",
		async ({ args, message }) => {
			const result = run(args).then(() => undefined);
			await expect(result).rejects.toBeInstanceOf(CliInputError);
			await expect(result).rejects.toThrow(message);
			for (const call of Object.values(calls))
				expect(call).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ args: [], period: "today" },
		{ args: ["today"], period: "today" },
		{ args: ["24h"], period: "24h" },
		{ args: ["day"], period: "24h" },
		{ args: ["yesterday"], period: "yesterday" },
		{ args: ["week"], period: "week" },
		{ args: ["7d"], period: "week" },
		{ args: [" WEEK "], period: "week" },
	])(
		"keeps digest period $args and zero context controls",
		async ({ args, period }) => {
			await run([
				"digest",
				...args,
				"--max-tweets",
				"0",
				"--max-links",
				"0",
				"--no-live-sync",
			]);
			expect(calls.digest).toHaveBeenCalledWith(
				expect.objectContaining({
					period,
					maxTweets: 0,
					maxLinks: 0,
					liveSync: false,
				}),
				expect.anything(),
			);
			expect(calls.update).toHaveBeenCalledOnce();
		},
	);
	it.each([
		{ args: [], limit: 20, maxThreadDepth: 10 },
		{
			args: ["--limit", "1", "--thread-depth", "2"],
			limit: 1,
			maxThreadDepth: 2,
		},
	])(
		"keeps research numeric defaults and positive bounds $args",
		async ({ args, limit, maxThreadDepth }) => {
			await run(["research", "sqlite", ...args]);
			expect(calls.research).toHaveBeenCalledWith(
				expect.objectContaining({ query: "sqlite", limit, maxThreadDepth }),
			);
		},
	);
	it("passes the configured account to research and honors an explicit override", async () => {
		getNativeDb()
			.prepare(
				"insert into accounts (id, name, handle, transport, is_default, created_at) values ('acct_research', 'Research', '@alice', 'xurl', 1, '2026-01-01')",
			)
			.run();
		writeFileSync(
			path.join(home, "config.json"),
			JSON.stringify({ accounts: { default: "@alice" } }),
		);
		await run(["research"]);
		expect(calls.research).toHaveBeenLastCalledWith(
			expect.objectContaining({ account: "acct_research" }),
		);
		await run(["research", "--account", "acct_primary"]);
		expect(calls.research).toHaveBeenLastCalledWith(
			expect.objectContaining({ account: "acct_primary" }),
		);
	});
	it.each(["birdclaw", "auto", "bird", "xurl"] as const)(
		"keeps explicit mentions mode %s and page contract",
		async (mode) => {
			await run([
				"mentions",
				"export",
				"sqlite",
				"--mode",
				mode,
				"--limit",
				"1",
				"--max-pages",
				"2",
				"--cache-ttl",
				"0",
				"--unreplied",
			]);
			const target = mode === "birdclaw" ? calls.local : calls[mode];
			const expected =
				mode === "birdclaw" ? {} : { all: true, maxPages: 2, cacheTtlMs: 0 };
			expect(target).toHaveBeenCalledWith(
				expect.objectContaining({
					...expected,
					search: "sqlite",
					limit: 1,
					replyFilter: "unreplied",
				}),
			);
			expect(calls.sync).toHaveBeenCalledTimes(mode === "birdclaw" ? 0 : 1);
		},
	);
	it.each([
		{ args: [], replyFilter: "all" },
		{ args: ["--replied"], replyFilter: "replied" },
	])(
		"keeps mentions defaults and single reply flags $args",
		async ({ args, replyFilter }) => {
			await run(["mentions", "export", ...args]);
			expect(calls.local).toHaveBeenCalledWith(
				expect.objectContaining({ limit: 20, replyFilter }),
			);
		},
	);
	it("uses omitted-mode environment fallback without inventing a page cap", async () => {
		vi.stubEnv("BIRDCLAW_MENTIONS_DATA_SOURCE", "xurl");
		await run(["mentions", "export"]);
		expect(calls.xurl).toHaveBeenCalledWith(
			expect.objectContaining({ all: false, maxPages: undefined, limit: 20 }),
		);
	});
	it.each([
		{ args: [], limit: 12 },
		{ args: ["--limit", "1"], limit: 1 },
	])("keeps profile reply limits $args", async ({ args, limit }) => {
		await run(["profiles", "replies", "alice", ...args]);
		expect(calls.replies).toHaveBeenCalledWith(
			"alice",
			expect.objectContaining({ limit }),
		);
	});
	it.each(["followers", "following"])(
		"keeps graph direction %s",
		async (direction) => {
			await run([
				"graph",
				"unfollowed",
				"--date",
				"2026-01-01",
				"--direction",
				direction,
			]);
			expect(calls.unfollowed).toHaveBeenCalledWith(
				expect.objectContaining({ direction }),
			);
			await run(["graph", "events", "--direction", direction]);
			expect(calls.events).toHaveBeenCalledWith(
				expect.objectContaining({ direction }),
			);
		},
	);
	it.each(["started", "ended"])("keeps event kind %s", async (kind) => {
		await run(["graph", "events", "--kind", kind]);
		expect(calls.events).toHaveBeenCalledWith(
			expect.objectContaining({ kind }),
		);
	});
	it.each(["followers", "handle"])("keeps non-mutual sort %s", async (sort) => {
		await run(["graph", "non-mutual-following", "--sort", sort]);
		expect(calls.nonMutual).toHaveBeenCalledWith(
			expect.objectContaining({ sort }),
		);
	});
	it("preserves graph omitted/default filters", async () => {
		await run(["graph", "unfollowed", "--date", "2026-01-01"]);
		expect(calls.unfollowed).toHaveBeenCalledWith(
			expect.objectContaining({ direction: "followers" }),
		);
		await run(["graph", "events"]);
		expect(calls.events).toHaveBeenCalledWith(
			expect.objectContaining({ direction: undefined, kind: undefined }),
		);
		await run(["graph", "non-mutual-following"]);
		expect(calls.nonMutual).toHaveBeenCalledWith(
			expect.objectContaining({ sort: "followers" }),
		);
	});
});
