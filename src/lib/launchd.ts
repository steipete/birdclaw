import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import { runSubprocessEffect } from "./subprocess";

const DEFAULT_LAUNCHD_PATH =
	"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export interface LaunchAgent {
	label: string;
	intervalSeconds: number;
	logPath: string;
	stdoutPath: string;
	stderrPath: string;
	programArguments: string[];
	plist: string;
	envFile?: string;
}

export interface LaunchAgentInstallResult {
	ok: true;
	label: string;
	plistPath: string;
	loaded: boolean;
	programArguments: string[];
	logPath: string;
	stdoutPath: string;
	stderrPath: string;
	intervalSeconds: number;
	envFile?: string;
}

export interface LaunchAgentInstallOptions {
	launchAgentsDir?: string;
	load?: boolean;
}

export function expandHomePath(input: string) {
	return input === "~" || input.startsWith("~/")
		? path.join(os.homedir(), input.slice(2))
		: input;
}

export function resolveUserPath(input: string) {
	return path.resolve(expandHomePath(input));
}

export function shellQuote(value: string) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildLaunchProgramArguments({
	program = "birdclaw",
	args,
	envFile,
}: {
	program?: string;
	args: string[];
	envFile?: string;
}) {
	const programArguments =
		path.isAbsolute(program) || program.includes("/")
			? [program]
			: ["/usr/bin/env", program];
	programArguments.push(...args);
	if (!envFile) return programArguments;

	const resolvedEnvFile = resolveUserPath(envFile);
	return [
		"/bin/bash",
		"-lc",
		[
			"set -a",
			`[ ! -f ${shellQuote(resolvedEnvFile)} ] || . ${shellQuote(resolvedEnvFile)}`,
			"set +a",
			`exec ${programArguments.map(shellQuote).join(" ")}`,
		].join("; "),
	];
}

function xmlEscape(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function normalizeLaunchdValue(value: string) {
	return value.replaceAll(path.sep, path.posix.sep);
}

function stringEntry(value: string) {
	return `<string>${xmlEscape(normalizeLaunchdValue(value))}</string>`;
}

export function buildLaunchAgent({
	label,
	intervalSeconds,
	logPath,
	stdoutPath,
	stderrPath,
	programArguments,
	envFile,
}: Omit<LaunchAgent, "plist" | "envFile"> & { envFile?: string }): LaunchAgent {
	const resolvedLogPath = resolveUserPath(logPath);
	const resolvedStdoutPath = resolveUserPath(stdoutPath);
	const resolvedStderrPath = resolveUserPath(stderrPath);
	const resolvedEnvFile = envFile ? resolveUserPath(envFile) : undefined;
	const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${stringEntry(label)}
  <key>ProgramArguments</key>
  <array>
    ${programArguments.map(stringEntry).join("\n    ")}
  </array>
  <key>StartInterval</key>
  <integer>${String(intervalSeconds)}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  ${stringEntry(resolvedStdoutPath)}
  <key>StandardErrorPath</key>
  ${stringEntry(resolvedStderrPath)}
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    ${stringEntry(DEFAULT_LAUNCHD_PATH)}
  </dict>
</dict>
</plist>
`;
	return {
		label,
		intervalSeconds,
		logPath: resolvedLogPath,
		stdoutPath: resolvedStdoutPath,
		stderrPath: resolvedStderrPath,
		programArguments,
		plist,
		...(resolvedEnvFile ? { envFile: resolvedEnvFile } : {}),
	};
}

export function installLaunchAgentEffect(
	agent: LaunchAgent,
	options: LaunchAgentInstallOptions = {},
): Effect.Effect<LaunchAgentInstallResult, unknown> {
	return Effect.gen(function* () {
		const launchAgentsDir = resolveUserPath(
			options.launchAgentsDir ?? "~/Library/LaunchAgents",
		);
		const plistPath = path.join(launchAgentsDir, `${agent.label}.plist`);
		for (const directory of [
			launchAgentsDir,
			path.dirname(agent.logPath),
			path.dirname(agent.stdoutPath),
			path.dirname(agent.stderrPath),
		]) {
			yield* tryPromise(() => fs.mkdir(directory, { recursive: true }));
		}
		yield* tryPromise(() => fs.writeFile(plistPath, agent.plist, "utf8"));

		let loaded = false;
		if (options.load !== false) {
			yield* runSubprocessEffect({
				command: "launchctl",
				args: ["unload", plistPath],
			}).pipe(Effect.catchAll(() => Effect.void));
			yield* runSubprocessEffect({
				command: "launchctl",
				args: ["load", "-w", plistPath],
			});
			loaded = true;
		}

		return {
			ok: true,
			label: agent.label,
			plistPath,
			loaded,
			programArguments: agent.programArguments,
			logPath: agent.logPath,
			stdoutPath: agent.stdoutPath,
			stderrPath: agent.stderrPath,
			intervalSeconds: agent.intervalSeconds,
			...(agent.envFile ? { envFile: agent.envFile } : {}),
		};
	});
}

export function installLaunchAgent(
	agent: LaunchAgent,
	options: LaunchAgentInstallOptions = {},
) {
	return runEffectPromise(installLaunchAgentEffect(agent, options));
}
