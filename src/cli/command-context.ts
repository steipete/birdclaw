import type { Command } from "commander";
import { CliInputError } from "./numeric-options";
import {
	resolveOperationAccount,
	type OperationAccount,
} from "#/lib/account-selection";
import { maybeAutoSyncBackup, maybeAutoUpdateBackup } from "#/lib/backup";
import { getDefaultAccountSelector } from "#/lib/config";

export type CliCommandContext = ReturnType<typeof createCommandContext>;

type NumericOptionParser = {
	(value: string, option: string): number;
	(value: string | undefined, option: string): number | undefined;
};

function numericOptionParser({
	decimal = false,
	positive = false,
	finite = false,
} = {}): NumericOptionParser {
	function parse(value: string, option: string): number;
	function parse(value: string | undefined, option: string): number | undefined;
	function parse(value: string | undefined, option: string) {
		if (value === undefined) return undefined;
		const number = Number(value);
		const message = finite
			? "must be a finite number"
			: "must be a non-negative integer";
		if (
			finite
				? !Number.isFinite(number)
				: !Number.isSafeInteger(number) ||
					number < 0 ||
					(decimal && !/^\d+$/.test(value.trim()))
		) {
			throw new CliInputError(`${option} ${message}`);
		}
		if (positive && number < 1)
			throw new CliInputError(`${option} must be at least 1`);
		return number;
	}
	return parse;
}

export const parseNonNegativeIntegerOption = numericOptionParser({
	decimal: true,
});
export const parsePositiveIntegerOption = numericOptionParser({
	decimal: true,
	positive: true,
});
export const parseFiniteNumberOption = numericOptionParser({ finite: true });
// Limits retain Number() spellings such as 1e3 and 0x10; integer-only flags do not.
export const parseLimitOption = numericOptionParser();
export const parsePositiveLimitOption = numericOptionParser({ positive: true });

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

export function createCommandContext(program: Command) {
	return {
		program,
		print,
		asJson: () => program.opts().json ?? false,
		autoSyncAfterWrite,
		autoUpdateBeforeRead,
		parseNonNegativeIntegerOption,
		parseFiniteNumberOption,
		parseLimitOption,
		parsePositiveLimitOption,
		parsePositiveIntegerOption,
	};
}
