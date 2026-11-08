// @vitest-environment node
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCommandContext } from "./command-context";
import { CliInputError } from "./numeric-options";
import { registerModerationCommands } from "./register-moderation";

const mutations = vi.hoisted(() => ({
	addBlock: vi.fn(),
	removeBlock: vi.fn(),
	addMute: vi.fn(),
	removeMute: vi.fn(),
}));
vi.mock("#/lib/blocks", () => ({
	...mutations,
	listBlocks: vi.fn(),
	recordBlock: vi.fn(),
	syncBlocks: vi.fn(),
}));
vi.mock("#/lib/mutes", () => ({
	...mutations,
	listMutes: vi.fn(),
	recordMute: vi.fn(),
}));
vi.mock("#/lib/blocklist", () => ({ importBlocklist: vi.fn() }));
const cases = [
	{ args: ["blocks", "add"], mutation: "addBlock" },
	{ args: ["blocks", "remove"], mutation: "removeBlock" },
	{ args: ["mutes", "add"], mutation: "addMute" },
	{ args: ["mutes", "remove"], mutation: "removeMute" },
	{ args: ["ban"], mutation: "addBlock" },
	{ args: ["unban"], mutation: "removeBlock" },
	{ args: ["mute"], mutation: "addMute" },
	{ args: ["unmute"], mutation: "removeMute" },
] as const;
function command() {
	const program = new Command().exitOverride();
	registerModerationCommands({
		...createCommandContext(program),
		print: vi.fn(),
	});
	return program;
}
describe("moderation transport CLI contract", () => {
	beforeEach(() => vi.clearAllMocks());
	for (const { args, mutation } of cases) {
		it.each(["bogus", "", "BIRD"])(
			args.join(" ") + " rejects invalid transport %j before mutation",
			async (transport) => {
				await expect(
					command().parseAsync([...args, "sam", "--transport", transport], {
						from: "user",
					}),
				).rejects.toThrow(CliInputError);
				for (const mock of Object.values(mutations))
					expect(mock).not.toHaveBeenCalled();
			},
		);
		it.each([undefined, "auto", "bird", "xurl"])(
			args.join(" ") + " preserves transport %j",
			async (transport) => {
				const argv: string[] = [...args, "sam", "--account", "acct_studio"];
				if (transport !== undefined) argv.push("--transport", transport);
				await command().parseAsync(argv, { from: "user" });
				expect(mutations[mutation]).toHaveBeenCalledWith("acct_studio", "sam", {
					transport,
				});
			},
		);
	}
});
