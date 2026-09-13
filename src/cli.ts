#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import {
	configureOperationAccountSelection,
	createCommandContext,
	printError,
	resetOperationAccountSelection,
} from "#/cli/command-context";
import { configureNumericOptions, CliInputError } from "#/cli/numeric-options";
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
import { registerShowCommands } from "#/cli/register-show";
import { registerStorageCommands } from "#/cli/register-storage";
import { registerSyncCommands } from "#/cli/register-sync";
import { closeDatabase } from "#/lib/db";
import {
	captureCliPerformance,
	writeCliPerformance,
} from "#/lib/cli-performance";

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
export const program = new Command()
	.name("birdclaw")
	.description("Local-first Twitter workspace")
	.version(packageVersion.version ?? "0.0.0")
	.option("--json", "Emit JSON output")
	.configureHelp({ showGlobalOptions: true })
	.configureOutput({
		// The entrypoint reports parser failures once, in the selected output mode.
		outputError: () => {},
		writeErr: (text) => {
			if (!program.opts().json) process.stderr.write(text);
		},
	})
	.exitOverride();
const commandContext = createCommandContext(program);
configureNumericOptions(program);
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
registerShowCommands(commandContext);
registerServeCommand(
	commandContext,
	packageRoot,
	packageVersion.version ?? "0.0.0",
);

export async function runCli(argv = process.argv) {
	const profile =
		process.env.BIRDCLAW_CLI_METRICS === "1"
			? captureCliPerformance()
			: undefined;
	try {
		await program.parseAsync(argv);
	} catch (error) {
		if (error instanceof CliInputError) {
			printError(error.message);
			process.exitCode = 1;
			return;
		}
		if (!(error instanceof CommanderError) || error.exitCode !== 0) {
			throw error;
		}
	} finally {
		resetOperationAccountSelection();
		try {
			await closeDatabase();
		} finally {
			if (profile) writeCliPerformance(profile());
		}
	}
}

export async function runCliMain(argv = process.argv) {
	try {
		await runCli(argv);
	} catch (error) {
		const message =
			error instanceof CommanderError && error.code === "commander.help"
				? "A subcommand is required. Run birdclaw --help for usage."
				: error instanceof Error
					? error.message
					: String(error);
		console.error(
			program.opts().json ? JSON.stringify({ error: message }) : message,
		);
		process.exitCode = error instanceof CommanderError ? 2 : 1;
	}
}

/* v8 ignore next 4 */
if (process.argv[1]) {
	const entryUrl = pathToFileURL(process.argv[1]).href;
	if (import.meta.url === entryUrl) {
		void runCliMain();
	}
}
