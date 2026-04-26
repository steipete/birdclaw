#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tsxCli = join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs");
const birdclawCli = join(packageRoot, "src", "cli.ts");

const result = spawnSync(
	process.execPath,
	[tsxCli, birdclawCli, ...process.argv.slice(2)],
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
