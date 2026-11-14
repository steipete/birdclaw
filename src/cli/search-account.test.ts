// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests, writeBirdclawConfig } from "../lib/config";
import { getNativeDb, resetDatabaseForTests } from "../lib/db";
import type { DmConversationItem } from "../lib/types";
import {
	configureOperationAccountSelection,
	createCommandContext,
	resetOperationAccountSelection,
} from "./command-context";
import { configureNumericOptions } from "./numeric-options";
import { registerSearchCommands } from "./register-search";

describe("search command account and author scope", () => {
	let home: string;
	beforeEach(() => {
		home = mkdtempSync(path.join(os.tmpdir(), "birdclaw-search-"));
		vi.stubEnv("BIRDCLAW_HOME", home);
		vi.stubEnv("BIRDCLAW_CONFIG", path.join(home, "config.json"));
		resetBirdclawPathsForTests();
		resetDatabaseForTests();
		const db = getNativeDb();
		db.exec(
			"update dm_messages set text = 'scopeneedle'; update dm_fts set text = 'scopeneedle'",
		);
	});
	afterEach(() => {
		resetOperationAccountSelection();
		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});

	function searchCommand() {
		const program = new Command()
			.exitOverride()
			.configureOutput({ writeErr: () => {} });
		const print = vi.fn();
		configureNumericOptions(program);
		configureOperationAccountSelection(program);
		registerSearchCommands({
			...createCommandContext(program),
			print,
			autoUpdateBeforeRead: async () => {},
		});
		return { program, print };
	}

	it.each([
		{
			configured: "@steipete",
			explicit: undefined,
			accounts: ["acct_primary"],
		},
		{
			configured: "acct_studio",
			explicit: undefined,
			accounts: ["acct_studio"],
		},
		{
			configured: undefined,
			explicit: "@steipete",
			accounts: ["acct_primary"],
		},
		{
			configured: "acct_primary",
			explicit: "acct_studio",
			accounts: ["acct_studio"],
		},
		{
			configured: "acct_studio",
			explicit: "  @STEIPETE  ",
			accounts: ["acct_primary"],
		},
		{
			configured: undefined,
			explicit: undefined,
			accounts: ["acct_primary", "acct_studio"],
		},
	])(
		"scopes real DM search with default=$configured explicit=$explicit",
		async ({ configured, explicit, accounts }) => {
			writeBirdclawConfig({ accounts: { default: configured } });
			const { program, print } = searchCommand();
			await program.parseAsync(
				[
					"search",
					"dms",
					"scopeneedle",
					"--context",
					"1",
					...(explicit ? ["--account", explicit] : []),
				],
				{ from: "user" },
			);
			const items = print.mock.calls[0][0] as DmConversationItem[];
			expect(items.length).toBeGreaterThan(0);
			expect([...new Set(items.map((item) => item.accountId))].sort()).toEqual(
				accounts,
			);
			expect(
				items.every((item) => item.searchSnippet?.includes("scopeneedle")),
			).toBe(true);
		},
	);

	it("fails closed for an unknown configured DM account", async () => {
		writeBirdclawConfig({ accounts: { default: "missing-account" } });
		const { program, print } = searchCommand();
		await expect(
			program.parseAsync(["search", "dms", "scopeneedle"], { from: "user" }),
		).rejects.toThrow("Unknown account: missing-account");
		expect(print).not.toHaveBeenCalled();
	});

	it.each(["@", "   "])(
		"keeps explicit CLI author %j from broadening results",
		async (author) => {
			const { program, print } = searchCommand();
			await program.parseAsync(
				["search", "tweets", "local-first", "--author", author],
				{ from: "user" },
			);
			expect(print).toHaveBeenCalledWith([], expect.any(Boolean));
		},
	);
});
