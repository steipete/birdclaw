#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require.resolve("tsx")).href;
const birdclawCli = join(packageRoot, "src", "cli.ts");

const result = spawnSync(
	process.execPath,
	["--import", tsxLoader, birdclawCli, ...process.argv.slice(2)],
	{
		stdio: "inherit",
		env: process.env,
	},
);

if (result.error) {
	console.error(result.error.message);
	process.exit(1);
}

if (result.signal) {
	process.kill(process.pid, result.signal);
}

process.exit(result.status ?? 0);
