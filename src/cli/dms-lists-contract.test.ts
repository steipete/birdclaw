// @vitest-environment node
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createCommandContext,
	configureOperationAccountSelection,
	resetOperationAccountSelection,
} from "./command-context";
import { configureNumericOptions, CliInputError } from "./numeric-options";
import { registerDirectMessageCommands } from "./register-dms";
import { registerListCommands } from "./register-lists";

const mocks = vi.hoisted(() => ({
	read: vi.fn(),
	sync: vi.fn(),
	update: vi.fn(),
	members: vi.fn(),
	lists: vi.fn(),
	defaultAccount: vi.fn(),
	resolveAccount: vi.fn(),
}));
vi.mock("./dm-command-helpers", async (original) => ({
	...(await original<typeof import("./dm-command-helpers")>()),
	enrichDmItems: mocks.read,
}));
vi.mock("#/lib/dms-live", () => ({
	syncDirectMessagesViaCachedBird: mocks.sync,
}));
vi.mock("#/lib/x-lists", () => ({
	listStoredXListMembers: mocks.members,
	listStoredXLists: mocks.lists,
}));
vi.mock("#/lib/account-selection", () => ({
	resolveOperationAccount: mocks.resolveAccount,
}));
vi.mock("#/lib/config", async (original) => ({
	...(await original<typeof import("#/lib/config")>()),
	getDefaultAccountSelector: mocks.defaultAccount,
}));

function run(args: string[]) {
	const program = new Command().option("--json").exitOverride();
	configureNumericOptions(program);
	configureOperationAccountSelection(program);
	const context = {
		...createCommandContext(program),
		print: vi.fn(),
		autoUpdateBeforeRead: mocks.update,
		autoSyncAfterWrite: vi.fn(),
	};
	registerDirectMessageCommands(context);
	registerListCommands(context);
	return program.parseAsync(["--json", ...args], { from: "user" });
}
beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.read.mockResolvedValue([]);
	mocks.sync.mockResolvedValue({ ok: true });
	mocks.members.mockReturnValue({ items: [] });
	mocks.lists.mockReturnValue([]);
	mocks.resolveAccount.mockReturnValue({
		id: "acct_studio",
		username: "studio",
	});
});
afterEach(resetOperationAccountSelection);

describe("DM and List CLI contracts", () => {
	it.each([false, true])(
		"rejects conflicting DM reply filters before reads or refresh=%s",
		async (refresh) => {
			await expect(
				run([
					"dms",
					"list",
					"--replied",
					"--unreplied",
					...(refresh ? ["--refresh"] : []),
				]),
			).rejects.toThrow(CliInputError);
			expect(mocks.update).not.toHaveBeenCalled();
			expect(mocks.sync).not.toHaveBeenCalled();
			expect(mocks.read).not.toHaveBeenCalled();
		},
	);
	it.each(["bogus", "", "FOLLOWER"])(
		"rejects invalid DM sort %j before refresh",
		async (sort) => {
			await expect(
				run(["dms", "list", "--sort", sort, "--refresh"]),
			).rejects.toThrow("--sort must be recent or followers");
			expect(mocks.sync).not.toHaveBeenCalled();
			expect(mocks.read).not.toHaveBeenCalled();
		},
	);
	it.each(["recent", "followers", "influence"])(
		"preserves DM sort %s including the legacy alias",
		async (sort) => {
			await run(["dms", "list", "--sort", sort]);
			expect(mocks.read).toHaveBeenCalledWith(
				expect.objectContaining({
					sort: sort === "influence" ? "followers" : sort,
				}),
				expect.anything(),
			);
		},
	);
	it.each(["0", "-1", "NaN", "1.5"])(
		"rejects List member limit %s before backup auto-update",
		async (limit) => {
			await expect(
				run(["lists", "members", "builders", "--limit", limit]),
			).rejects.toThrow(CliInputError);
			expect(mocks.update).not.toHaveBeenCalled();
			expect(mocks.members).not.toHaveBeenCalled();
		},
	);
	it("preserves valid List member limit and selector", async () => {
		await run(["lists", "members", "builders", "--limit", "1"]);
		expect(mocks.members).toHaveBeenCalledWith(
			expect.objectContaining({ name: "builders", limit: 1 }),
		);
	});
	it("keeps zero additional DM pages valid", async () => {
		await run(["dms", "sync", "--max-pages", "0", "--limit", "1"]);
		expect(mocks.sync).toHaveBeenCalledWith(
			expect.objectContaining({ limit: 1 }),
		);
		expect(mocks.sync.mock.calls[0][0].maxPages).toBeUndefined();
	});
	it.each(["0", "-1", "NaN"])(
		"rejects invalid live DM limit %s before invoking sync",
		async (limit) => {
			await expect(
				run(["dms", "list", "--refresh", "--limit", limit]),
			).rejects.toThrow(CliInputError);
			expect(mocks.sync).not.toHaveBeenCalled();
		},
	);
	it("preserves zero as an empty offline DM result limit", async () => {
		await run(["dms", "list", "--limit", "0"]);
		expect(mocks.read).toHaveBeenCalledWith(
			expect.objectContaining({ limit: 0 }),
			expect.anything(),
		);
	});
	it.each([
		["dms", "list"],
		["dms", "sync"],
		["lists", "list"],
		["lists", "members", "builders"],
	])("resolves configured selectors for %j", async (...args) => {
		mocks.defaultAccount.mockReturnValue("@studio");
		await run(args);
		expect(mocks.resolveAccount).toHaveBeenCalledWith("@studio");
		const target =
			args[0] === "dms"
				? args[1] === "list"
					? mocks.read
					: mocks.sync
				: args[1] === "list"
					? mocks.lists
					: mocks.members;
		expect(target.mock.calls[0][0]).toMatchObject({ account: "acct_studio" });
	});
	it.each(["studio", "@studio", "acct_studio"])(
		"explicit selector %s overrides config",
		async (account) => {
			mocks.defaultAccount.mockReturnValue("@other");
			await run(["dms", "list", "--account", account]);
			expect(mocks.resolveAccount).toHaveBeenCalledWith(account);
			expect(mocks.read.mock.calls[0][0].account).toBe("acct_studio");
		},
	);
});
