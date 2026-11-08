// @vitest-environment node
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSyncCommands } from "./register-sync";
import { createCommandContext } from "./command-context";
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
describe("Pass 11 sync registration contracts", () => {
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
	for (const kind of [
		"timeline",
		"mentions",
		"likes",
		"bookmarks",
		"followers",
		"following",
	]) {
		it.each(["-1", "NaN", "not-a-number", "Infinity", "1e308"])(
			"rejects " + kind + " cache TTL %j before sync or backup",
			async (ttl) => {
				const f = fixture();
				await f.run([kind, "--cache-ttl", ttl]);
				expect(f.print).toHaveBeenCalledWith(
					expect.objectContaining({
						ok: false,
						error: "--cache-ttl must be a non-negative number",
					}),
					true,
				);
				expect(process.exitCode).toBe(1);
				for (const mock of Object.values(mocks))
					expect(mock).not.toHaveBeenCalled();
				expect(f.backup).not.toHaveBeenCalled();
				process.exitCode = 0;
				await fixture().run([kind, "--cache-ttl", "0"]);
				const mock =
					kind === "timeline"
						? mocks.timeline
						: kind === "mentions"
							? mocks.mentions
							: kind === "likes" || kind === "bookmarks"
								? mocks.collection
								: mocks.graph;
				expect(mock).toHaveBeenLastCalledWith(
					expect.objectContaining({ cacheTtlMs: 0 }),
				);
				await fixture().run([kind, "--cache-ttl", "0.25"]);
				expect(mock).toHaveBeenLastCalledWith(
					expect.objectContaining({ cacheTtlMs: 250 }),
				);
			},
		);
	}
});
