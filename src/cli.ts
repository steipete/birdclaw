#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command } from "commander";
import {
	configureOperationAccountSelection,
	createCommandContext,
	resetOperationAccountSelection,
} from "#/cli/command-context";
import { registerAnalysisCommands } from "#/cli/register-analysis";
import { registerComposeCommands } from "#/cli/register-compose";
import { registerCoreCommands } from "#/cli/register-core";
import { registerDirectMessageCommands } from "#/cli/register-dms";
import { registerGraphCommands } from "#/cli/register-graph";
import { registerInboxCommand } from "#/cli/register-inbox";
import { registerJobCommands } from "#/cli/register-jobs";
import { registerListCommands } from "#/cli/register-lists";
import { registerMentionCommands } from "#/cli/register-mentions";
import { registerModerationCommands } from "#/cli/register-moderation";
import { registerSearchCommands } from "#/cli/register-search";
import { registerServeCommand } from "#/cli/register-serve";
import { registerStorageCommands } from "#/cli/register-storage";
import { registerSyncCommands } from "#/cli/register-sync";
import { closeDatabase } from "#/lib/db";

function findPackageRoot(entryUrl: string) {
	let directory = dirname(fileURLToPath(entryUrl));
	for (;;) {
		if (existsSync(join(directory, "package.json"))) return directory;
		const parent = dirname(directory);
		if (parent === directory) {
			throw new Error("Could not locate birdclaw package.json");
		}
		directory = parent;
	}
}

const packageRoot = findPackageRoot(import.meta.url);
const packageVersion = JSON.parse(
	readFileSync(join(packageRoot, "package.json"), "utf8"),
) as { version?: string };
const program = new Command()
	.name("birdclaw")
	.description("Local-first Twitter workspace")
	.version(packageVersion.version ?? "0.0.0")
	.option("--json", "Emit JSON output");
const commandContext = createCommandContext(program);
configureOperationAccountSelection(program);

registerCoreCommands(commandContext);
registerSearchCommands(commandContext);
registerAnalysisCommands(commandContext);
registerMentionCommands(commandContext);
registerDirectMessageCommands(commandContext);
registerSyncCommands(commandContext);
registerJobCommands(commandContext);
registerListCommands(commandContext);
registerModerationCommands(commandContext);
registerComposeCommands(commandContext);
registerInboxCommand(commandContext);
registerGraphCommands(commandContext);
registerStorageCommands(commandContext);
registerServeCommand(
	commandContext,
	packageRoot,
	packageVersion.version ?? "0.0.0",
);

export async function runCli(argv = process.argv) {
	try {
		await program.parseAsync(argv);
	} finally {
		resetOperationAccountSelection();
		await closeDatabase();
	}
}

/* v8 ignore next 5 */
if (process.argv[1]) {
	const entryUrl = pathToFileURL(process.argv[1]).href;
	if (import.meta.url === entryUrl) {
		void runCli().catch((error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		});
	}
}
