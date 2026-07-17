import type { Command } from "commander";
import {
	resolveOperationAccount,
	type OperationAccount,
} from "#/lib/account-selection";
import { maybeAutoSyncBackup, maybeAutoUpdateBackup } from "#/lib/backup";
import { getDefaultAccountSelector } from "#/lib/config";

export interface CliCommandContext {
	program: Command;
	print: (data: unknown, asJson: boolean) => void;
	asJson: () => boolean;
	autoSyncAfterWrite: () => Promise<void>;
	autoUpdateBeforeRead: () => Promise<void>;
	parseNonNegativeIntegerOption: (
		value: string | undefined,
		option: string,
	) => number | undefined;
	parsePositiveIntegerOption: (
		value: string | undefined,
		option: string,
	) => number | undefined;
}

let previousXurlUsername:
	| { existed: boolean; value: string | undefined }
	| undefined;

function commandHasAccountOption(command: Command) {
	return command.options.some((option) => option.attributeName() === "account");
}

function selectOperationAccount(
	command: Command,
): OperationAccount | undefined {
	if (!commandHasAccountOption(command)) return undefined;

	const source = command.getOptionValueSource("account");
	const current = command.getOptionValue("account");
	const explicit =
		source === "cli" && typeof current === "string" ? current : undefined;
	const configSelector = getDefaultAccountSelector();
	const selector = explicit || configSelector;
	if (!selector) return undefined;

	const account = resolveOperationAccount(selector);
	command.setOptionValueWithSource(
		"account",
		account.id,
		explicit ? "cli" : "config",
	);
	return account;
}

export function resetOperationAccountSelection() {
	if (!previousXurlUsername) return;
	if (previousXurlUsername.existed) {
		process.env.BIRDCLAW_XURL_OAUTH2_USERNAME = previousXurlUsername.value;
	} else {
		delete process.env.BIRDCLAW_XURL_OAUTH2_USERNAME;
	}
	previousXurlUsername = undefined;
}

export function configureOperationAccountSelection(program: Command) {
	program.hook("preAction", (_root, actionCommand) => {
		const account = selectOperationAccount(actionCommand);
		if (!account) return;
		previousXurlUsername ??= {
			existed: Object.hasOwn(process.env, "BIRDCLAW_XURL_OAUTH2_USERNAME"),
			value: process.env.BIRDCLAW_XURL_OAUTH2_USERNAME,
		};
		process.env.BIRDCLAW_XURL_OAUTH2_USERNAME = account.username;
	});
	program.hook("postAction", resetOperationAccountSelection);
}

export function print(data: unknown, asJson: boolean) {
	if (asJson) {
		console.log(JSON.stringify(data, null, 2));
		return;
	}
	console.log(data);
}

export function printError(error: string) {
	console.error(JSON.stringify({ error }));
}

export function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export function parseNonNegativeIntegerOption(
	value: string | undefined,
	option: string,
) {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) {
		printError(`${option} must be a non-negative integer`);
		process.exitCode = 1;
		return undefined;
	}
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isSafeInteger(parsed)) {
		printError(`${option} must be a non-negative integer`);
		process.exitCode = 1;
		return undefined;
	}
	return parsed;
}

export function parsePositiveIntegerOption(
	value: string | undefined,
	option: string,
) {
	const parsed = parseNonNegativeIntegerOption(value, option);
	if (parsed === undefined) return undefined;
	if (parsed < 1) {
		printError(`${option} must be at least 1`);
		process.exitCode = 1;
		return undefined;
	}
	return parsed;
}

async function autoUpdateBeforeRead() {
	try {
		const result = await maybeAutoUpdateBackup();
		if (!result.ok) {
			console.error(`birdclaw backup auto-sync failed: ${result.error}`);
		}
	} catch (error) {
		console.error(`birdclaw backup auto-sync failed: ${errorMessage(error)}`);
	}
}

async function autoSyncAfterWrite() {
	try {
		const result = await maybeAutoSyncBackup();
		if (!result.ok) {
			console.error(`birdclaw backup sync failed: ${result.error}`);
		}
	} catch (error) {
		console.error(`birdclaw backup sync failed: ${errorMessage(error)}`);
	}
}

export function createCommandContext(program: Command): CliCommandContext {
	return {
		program,
		print,
		asJson: () => program.opts().json ?? false,
		autoSyncAfterWrite,
		autoUpdateBeforeRead,
		parseNonNegativeIntegerOption,
		parsePositiveIntegerOption,
	};
}
