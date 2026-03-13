import { rmSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { withSanitizedNodeOptions } from "./sanitize-node-options.mjs";

const cwd = process.cwd();
const home = process.env.BIRDCLAW_HOME || path.join(cwd, ".playwright-home");
const viteBin = path.join(cwd, "node_modules", "vite", "bin", "vite.js");

rmSync(home, { recursive: true, force: true });

const child = spawn(
	process.execPath,
	[viteBin, "dev", "--port", "3000", "--host", "127.0.0.1"],
	{
		cwd,
		stdio: "inherit",
		env: {
			...withSanitizedNodeOptions(process.env),
			BIRDCLAW_HOME: home,
			BIRDCLAW_DISABLE_LIVE_WRITES: "1",
		},
	},
);

child.on("exit", (code) => {
	process.exit(code ?? 0);
});
