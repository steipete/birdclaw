// @vitest-environment node
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCommandContext } from "./command-context";
import { configureNumericOptions, CliInputError } from "./numeric-options";
import { registerAnalysisCommands } from "./register-analysis";
const mocks = vi.hoisted(() => ({
	backupUpdate: vi.fn(),
	digest: vi.fn(),
	discuss: vi.fn(),
	profile: vi.fn(),
	research: vi.fn(),
}));
vi.mock("#/lib/backup", async (original) => ({
	...(await original<typeof import("#/lib/backup")>()),
	maybeAutoUpdateBackup: mocks.backupUpdate,
}));
vi.mock("#/lib/period-digest", async (original) => ({
	...(await original<typeof import("#/lib/period-digest")>()),
	streamPeriodDigest: mocks.digest,
}));
vi.mock("#/lib/search-discussion", () => ({
	streamSearchDiscussion: mocks.discuss,
}));
vi.mock("#/lib/profile-analysis", async (original) => ({
	...(await original<typeof import("#/lib/profile-analysis")>()),
	streamProfileAnalysis: mocks.profile,
}));
vi.mock("#/lib/research", () => ({ runResearchMode: mocks.research }));
function cli() {
	const program = new Command();
	configureNumericOptions(program);
	const update = vi.fn(async () => {});
	registerAnalysisCommands({
		...createCommandContext(program),
		autoUpdateBeforeRead: update,
		print: vi.fn(),
		asJson: () => true,
	});
	return {
		update,
		run: (args: string[]) => program.parseAsync(args, { from: "user" }),
	};
}
beforeEach(() => {
	for (const mock of Object.values(mocks)) {
		mock.mockReset();
		mock.mockResolvedValue({ markdown: "ok" });
	}
	mocks.backupUpdate.mockResolvedValue({ ok: true, updated: false });
});
describe("pass13 real analysis command parsing", () => {
	it.each([
		["today", "--live-mode", "bad"],
		["today", "--language", "bad language"],
		["digest", "bogus"],
		["digest", "30d"],
		["digest", ""],
		["digest", "--live-mode", "bad"],
		["digest", "--since", "2026-02-30"],
		["digest", "--since", "2026-02-02", "--until", "2026-02-01"],
		[
			"digest",
			"--since",
			" 2026-02-02T00:00:00Z ",
			"--until",
			" 2026-02-01T00:00:00Z ",
		],
		["discuss", "topic", "--source", "bad"],
		["discuss", "topic", "--mode", "bad"],
		["discuss", "topic", "--limit", "0"],
		["profile-analyze", "@bad!handle"],
		["profile-analyze", "   "],
		["profile-analyze", "abcdefghijklmnop"],
		["profile-analyze", "alice", "--max-tweets", "0"],
		["profile-analyze", "alice", "--max-pages", "0"],
		["research", "topic", "--limit", "0"],
		["research", "topic", "--thread-depth", "0"],
	])("rejects %j before automatic update", async (...args) => {
		const { run, update } = cli();
		await expect(run(args)).rejects.toBeInstanceOf(CliInputError);
		expect(update).not.toHaveBeenCalled();
		expect(mocks.backupUpdate).not.toHaveBeenCalled();
		for (const mock of [
			mocks.digest,
			mocks.discuss,
			mocks.profile,
			mocks.research,
		])
			expect(mock).not.toHaveBeenCalled();
	});
	it("rejects invalid profile handles before writable automatic backup sync", async () => {
		const program = new Command();
		configureNumericOptions(program);
		registerAnalysisCommands({
			...createCommandContext(program),
			print: vi.fn(),
			asJson: () => true,
		});
		await expect(
			program.parseAsync(["profile-analyze", "@bad!handle"], { from: "user" }),
		).rejects.toBeInstanceOf(CliInputError);
		expect(mocks.backupUpdate).not.toHaveBeenCalled();
		expect(mocks.profile).not.toHaveBeenCalled();

		await program.parseAsync(["profile-analyze", "https://x.com/alice"], {
			from: "user",
		});
		expect(mocks.backupUpdate).toHaveBeenCalledOnce();
		expect(mocks.profile).toHaveBeenCalledWith(
			expect.objectContaining({ handle: "alice" }),
			expect.anything(),
		);
	});
	it.each(["today", "yesterday", "24h", "day", "week", "7d"])(
		"preserves digest period %s and zero caps",
		async (period) => {
			const { run, update } = cli();
			await run(["digest", period, "--max-tweets", "0", "--max-links", "0"]);
			expect(update).toHaveBeenCalledOnce();
			expect(mocks.digest).toHaveBeenCalledWith(
				expect.objectContaining({ maxTweets: 0, maxLinks: 0 }),
				expect.anything(),
			);
		},
	);
	it.each([
		["today"],
		["digest"],
		["research", "topic", "--thread-depth", "1"],
		["discuss", "topic"],
		["profile-analyze", "alice", "--conversation-delay-ms", "0"],
	])("keeps valid command %j reachable", async (...args) => {
		const { run, update } = cli();
		await run(args);
		expect(update).toHaveBeenCalledOnce();
		expect(
			[mocks.digest, mocks.discuss, mocks.profile, mocks.research].reduce(
				(n, mock) => n + mock.mock.calls.length,
				0,
			),
		).toBe(1);
	});
});
