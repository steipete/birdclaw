import { execFile } from "node:child_process";
import type { ExecFileOptions } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { promisify } from "node:util";
import { getBirdCommand } from "./config";

const execFileAsync = promisify(execFile);

function isPathCommand(command: string) {
	return command.includes("/") || command.startsWith(".");
}

function formatBirdInstallHint(command: string) {
	return [
		`bird command unavailable: ${command}`,
		"Install bird on PATH, set BIRDCLAW_BIRD_COMMAND, or update ~/.birdclaw/config.json mentions.birdCommand.",
	].join("\n");
}

async function assertBirdCommandAvailable(command: string) {
	if (!isPathCommand(command)) {
		return;
	}

	try {
		await access(command, constants.X_OK);
	} catch {
		throw new Error(formatBirdInstallHint(command));
	}
}

export async function runBirdCommand(
	args: string[],
	options?: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
	const birdCommand = getBirdCommand();
	await assertBirdCommandAvailable(birdCommand);

	try {
		const result =
			options === undefined
				? await execFileAsync(birdCommand, args)
				: await execFileAsync(birdCommand, args, options);
		return result as { stdout: string; stderr: string };
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			(error.code === "ENOENT" || error.code === "EACCES")
		) {
			throw new Error(formatBirdInstallHint(birdCommand));
		}
		throw error;
	}
}
