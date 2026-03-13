import path from "node:path";
import { spawn } from "node:child_process";
import { withSanitizedNodeOptions } from "./sanitize-node-options.mjs";

const cwd = process.cwd();
const vitestBin = path.join(cwd, "node_modules", "vitest", "vitest.mjs");

const child = spawn(process.execPath, [vitestBin, ...process.argv.slice(2)], {
	cwd,
	stdio: "inherit",
	env: withSanitizedNodeOptions(process.env),
});

child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}

	process.exit(code ?? 0);
});
