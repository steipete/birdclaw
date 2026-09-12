#!/usr/bin/env node
import { readFileSync } from "node:fs";

async function run() {
	const args = process.argv.slice(2);
	if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
		const manifest = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		);
		console.log(manifest.version ?? "0.0.0");
		return;
	}
	const { runCli } = await import("../dist/cli/birdclaw.js");
	await runCli();
}

void run().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
