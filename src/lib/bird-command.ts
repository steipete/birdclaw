import { execFile } from "node:child_process";
import type { ExecFileOptions } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { promisify } from "node:util";
import { Data, Effect } from "effect";
import { getBirdCommand } from "./config";
import { runEffectPromise } from "./effect-runtime";

const execFileAsync = promisify(execFile);

export class BirdCommandUnavailableError extends Data.TaggedError(
	"BirdCommandUnavailableError",
)<{
	readonly message: string;
	readonly command: string;
	readonly cause?: unknown;
}> {}

export class BirdCommandExecutionError extends Data.TaggedError(
	"BirdCommandExecutionError",
)<{
	readonly message: string;
	readonly stdout?: string;
	readonly stderr?: string;
	readonly useFallbackMessage?: boolean;
	readonly cause?: unknown;
}> {}

function isPathCommand(command: string) {
	return command.includes("/") || command.startsWith(".");
}

function formatBirdInstallHint(command: string) {
	return [
		`bird command unavailable: ${command}`,
		"Install bird on PATH, set BIRDCLAW_BIRD_COMMAND, or update ~/.birdclaw/config.json mentions.birdCommand.",
	].join("\n");
}

function isUnavailableExecError(error: unknown) {
	return (
		error &&
		typeof error === "object" &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "EACCES")
	);
}

function execFailureFromCause(command: string, cause: unknown) {
	if (isUnavailableExecError(cause)) {
		return new BirdCommandUnavailableError({
			message: formatBirdInstallHint(command),
			command,
			cause,
		});
	}
	if (cause instanceof Error) {
		const output = cause as Error & {
			stdout?: unknown;
			stderr?: unknown;
		};
		return new BirdCommandExecutionError({
			message: cause.message,
			stdout: typeof output.stdout === "string" ? output.stdout : undefined,
			stderr: typeof output.stderr === "string" ? output.stderr : undefined,
			cause,
		});
	}
	return new BirdCommandExecutionError({
		message: "",
		useFallbackMessage: true,
		cause,
	});
}

function assertBirdCommandAvailableEffect(command: string) {
	if (!isPathCommand(command)) {
		return Effect.void;
	}

	return Effect.tryPromise({
		try: () => Promise.resolve(access(command, constants.X_OK)),
		catch: (cause) =>
			new BirdCommandUnavailableError({
				message: formatBirdInstallHint(command),
				command,
				cause,
			}),
	}).pipe(Effect.asVoid);
}

function getBirdCommandEffect() {
	return Effect.try({
		try: () => getBirdCommand(),
		catch: (cause) =>
			cause instanceof Error ? cause : new Error(String(cause)),
	});
}

export function runBirdCommandEffect(
	args: string[],
	options?: ExecFileOptions,
): Effect.Effect<
	{ stdout: string; stderr: string },
	BirdCommandExecutionError | BirdCommandUnavailableError | Error
> {
	return Effect.gen(function* () {
		const birdCommand = yield* getBirdCommandEffect();
		yield* assertBirdCommandAvailableEffect(birdCommand);

		const result = yield* Effect.tryPromise({
			try: () =>
				Promise.resolve(
					options === undefined
						? execFileAsync(birdCommand, args)
						: execFileAsync(birdCommand, args, options),
				),
			catch: (cause) => execFailureFromCause(birdCommand, cause),
		});
		return result as { stdout: string; stderr: string };
	});
}

export function runBirdCommand(
	args: string[],
	options?: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
	return runEffectPromise(runBirdCommandEffect(args, options));
}
