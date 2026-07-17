import type { Command } from "commander";
import {
	addBlock,
	listBlocks,
	recordBlock,
	removeBlock,
	syncBlocks,
} from "#/lib/blocks";
import { addMute, listMutes, recordMute, removeMute } from "#/lib/mutes";

interface RegisterModerationCommandsParams {
	program: Command;
	print: (data: unknown, asJson: boolean) => void;
	asJson: () => boolean;
	importBlocklist: (accountId: string, filePath: string) => Promise<unknown>;
	resolveActionOptions: (options: { transport?: string }) => {
		transport: "auto" | "bird" | "xurl" | undefined;
	};
}

export function registerModerationCommands({
	program,
	print,
	asJson,
	importBlocklist,
	resolveActionOptions,
}: RegisterModerationCommandsParams) {
	const blocksCommand = program
		.command("blocks")
		.description("Maintain the local blocklist");

	blocksCommand
		.command("list")
		.option("--account <username>", "Account username or id")
		.option("--search <query>", "Filter blocked profiles")
		.option("--limit <n>", "Limit results", "50")
		.action((options) => {
			const items = listBlocks({
				account: options.account,
				search: options.search,
				limit: Number(options.limit),
			});
			print(items, asJson());
		});

	blocksCommand
		.command("add <query>")
		.option("--account <username>", "Account username or id", "acct_primary")
		.option("--transport <mode>", "auto, bird, or xurl")
		.action(async (query, options) => {
			const result = await addBlock(
				options.account,
				query,
				resolveActionOptions(options),
			);
			print(result, asJson());
		});

	blocksCommand
		.command("remove <query>")
		.option("--account <username>", "Account username or id", "acct_primary")
		.option("--transport <mode>", "auto, bird, or xurl")
		.action(async (query, options) => {
			const result = await removeBlock(
				options.account,
				query,
				resolveActionOptions(options),
			);
			print(result, asJson());
		});

	blocksCommand
		.command("sync")
		.option("--account <username>", "Account username or id", "acct_primary")
		.action(async (options) => {
			const result = await syncBlocks(options.account);
			print(result, asJson());
		});

	blocksCommand
		.command("import <path>")
		.description("Import a newline-delimited blocklist file")
		.option("--account <username>", "Account username or id", "acct_primary")
		.action(async (filePath, options) => {
			const result = await importBlocklist(options.account, filePath);
			print(result, asJson());
		});

	blocksCommand
		.command("record <query>")
		.description(
			"Record a known-good remote block locally without another live write",
		)
		.option("--account <username>", "Account username or id", "acct_primary")
		.action(async (query, options) => {
			const result = await recordBlock(options.account, query);
			print(result, asJson());
		});

	const mutesCommand = program
		.command("mutes")
		.description("Maintain the local mute list");

	mutesCommand
		.command("list")
		.option("--account <username>", "Account username or id")
		.option("--search <query>", "Filter muted profiles")
		.option("--limit <n>", "Limit results", "50")
		.action((options) => {
			const items = listMutes({
				account: options.account,
				search: options.search,
				limit: Number(options.limit),
			});
			print(items, asJson());
		});

	mutesCommand
		.command("add <query>")
		.option("--account <username>", "Account username or id", "acct_primary")
		.option("--transport <mode>", "auto, bird, or xurl")
		.action(async (query, options) => {
			const result = await addMute(
				options.account,
				query,
				resolveActionOptions(options),
			);
			print(result, asJson());
		});

	mutesCommand
		.command("remove <query>")
		.option("--account <username>", "Account username or id", "acct_primary")
		.option("--transport <mode>", "auto, bird, or xurl")
		.action(async (query, options) => {
			const result = await removeMute(
				options.account,
				query,
				resolveActionOptions(options),
			);
			print(result, asJson());
		});

	mutesCommand
		.command("record <query>")
		.description(
			"Record a known-good remote mute locally without another live write",
		)
		.option("--account <username>", "Account username or id", "acct_primary")
		.action(async (query, options) => {
			const result = await recordMute(options.account, query);
			print(result, asJson());
		});

	program
		.command("ban <query>")
		.description("Alias for blocks add")
		.option("--account <username>", "Account username or id", "acct_primary")
		.option("--transport <mode>", "auto, bird, or xurl")
		.action(async (query, options) => {
			const result = await addBlock(
				options.account,
				query,
				resolveActionOptions(options),
			);
			print(result, asJson());
		});

	program
		.command("unban <query>")
		.description("Alias for blocks remove")
		.option("--account <username>", "Account username or id", "acct_primary")
		.option("--transport <mode>", "auto, bird, or xurl")
		.action(async (query, options) => {
			const result = await removeBlock(
				options.account,
				query,
				resolveActionOptions(options),
			);
			print(result, asJson());
		});

	program
		.command("mute <query>")
		.description("Mute a user for one account")
		.option("--account <username>", "Account username or id", "acct_primary")
		.option("--transport <mode>", "auto, bird, or xurl")
		.action(async (query, options) => {
			const result = await addMute(
				options.account,
				query,
				resolveActionOptions(options),
			);
			print(result, asJson());
		});

	program
		.command("unmute <query>")
		.description("Unmute a user for one account")
		.option("--account <username>", "Account username or id", "acct_primary")
		.option("--transport <mode>", "auto, bird, or xurl")
		.action(async (query, options) => {
			const result = await removeMute(
				options.account,
				query,
				resolveActionOptions(options),
			);
			print(result, asJson());
		});
}
