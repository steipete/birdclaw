#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require.resolve("tsx")).href;
const birdclawCli = join(packageRoot, "src", "cli.ts");

const child = spawn(
	process.execPath,
	["--import", tsxLoader, birdclawCli, ...process.argv.slice(2)],
	{
		stdio: "inherit",
		env: process.env,
		detached: process.platform !== "win32",
	},
);

const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];

function removeSignalHandlers() {
	for (const signal of forwardedSignals) {
		process.removeListener(signal, forwardSignal);
	}
}

function forwardSignal(signal) {
	if (child.exitCode === null && child.signalCode === null) {
		signalChild(signal);
	}
}

function signalChild(signal) {
	if (child.pid === undefined) {
		return;
	}
	const targetPid = process.platform === "win32" ? child.pid : -child.pid;
	try {
		process.kill(targetPid, signal);
	} catch (error) {
		if (error?.code !== "ESRCH") {
			throw error;
		}
	}
}

for (const signal of forwardedSignals) {
	process.on(signal, forwardSignal);
}

child.on("error", (error) => {
	removeSignalHandlers();
	console.error(error.message);
	process.exit(1);
});

child.on("exit", (code, signal) => {
	removeSignalHandlers();

	if (signal) {
		process.kill(process.pid, signal);
		return;
	}

	process.exit(code ?? 0);
});
