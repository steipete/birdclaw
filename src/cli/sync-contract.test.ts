// @vitest-environment node
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommandContext } from "./command-context";
import { CliInputError, configureNumericOptions } from "./numeric-options";
import { registerSyncCommands } from "./register-sync";

const mocks = vi.hoisted(() => ({
	timeline: vi.fn(),
	collection: vi.fn(),
	mentions: vi.fn(),
	graph: vi.fn(),
}));
vi.mock("#/lib/timeline-live", () => ({ syncHomeTimeline: mocks.timeline }));
vi.mock("#/lib/timeline-collections-live", () => ({
	syncTimelineCollection: mocks.collection,
}));
vi.mock("#/lib/mentions-live", () => ({ syncMentions: mocks.mentions }));
vi.mock("#/lib/follow-graph", () => ({ syncFollowGraph: mocks.graph }));

function fixture() {
	const program = new Command().exitOverride();
	const print = vi.fn();
	const backup = vi.fn().mockResolvedValue(undefined);
	configureNumericOptions(program);
	registerSyncCommands({
		...createCommandContext(program),
		print,
		autoSyncAfterWrite: backup,
	});
	return {
		run: (args: string[]) =>
			program.parseAsync(["sync", ...args], { from: "user" }),
		print,
		backup,
	};
}

const initialExitCode = process.exitCode;
beforeEach(() => {
	process.exitCode = 0;
	for (const mock of Object.values(mocks))
		mock.mockReset().mockResolvedValue({ ok: true, count: 1 });
});
afterEach(() => {
	process.exitCode = initialExitCode;
});

describe("sync registration contracts", () => {
	for (const kind of ["timeline", "likes", "bookmarks"] as const) {
		it(
			"prints structured " + kind + " transport failures without backup writes",
			async () => {
				const f = fixture();
				const mock = kind === "timeline" ? mocks.timeline : mocks.collection;
				mock.mockRejectedValue(new Error("transport unavailable"));
				await expect(f.run([kind, "--mode", "bird"])).resolves.toBeInstanceOf(
					Command,
				);
				expect(f.print).toHaveBeenCalledWith(
					{ ok: false, kind, mode: "bird", error: "transport unavailable" },
					true,
				);
				expect(process.exitCode).toBe(1);
				expect(f.backup).not.toHaveBeenCalled();
				process.exitCode = 0;
				mock.mockResolvedValue({ ok: true });
				await fixture().run([kind]);
				expect(process.exitCode).toBe(0);
			},
		);
	}

	it("rejects overflowing --cache-ttl seconds in the shared numeric hook before sync or backup", async () => {
		const f = fixture();
		await expect(f.run(["timeline", "--cache-ttl", "1e308"])).rejects.toThrow(
			new CliInputError("--cache-ttl must be a non-negative finite number"),
		);
		expect(mocks.timeline).not.toHaveBeenCalled();
		expect(f.backup).not.toHaveBeenCalled();
	});
});
