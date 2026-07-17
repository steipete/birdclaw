import { rmSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { withSanitizedNodeOptions } from "./sanitize-node-options.mjs";

const cwd = process.cwd();
const home = path.join(cwd, ".playwright-home");
const port = process.env.BIRDCLAW_PLAYWRIGHT_PORT || "3000";
const viteBin = path.join(cwd, "node_modules", "vite", "bin", "vite.js");
const resolvedHome = path.resolve(home);
const resolvedCwd = path.resolve(cwd);

if (
	!resolvedHome.startsWith(`${resolvedCwd}${path.sep}`) ||
	path.basename(resolvedHome) !== ".playwright-home"
) {
	throw new Error(`Refusing to delete unsafe test home: ${resolvedHome}`);
}

rmSync(resolvedHome, { recursive: true, force: true });

const seedEnv = {
	...withSanitizedNodeOptions(process.env),
	BIRDCLAW_HOME: resolvedHome,
	BIRDCLAW_E2E: "1",
	BIRDCLAW_DISABLE_LIVE_WRITES: "1",
};
const require = createRequire(import.meta.url);
const seed = spawnSync(
	process.execPath,
	[
		require.resolve("tsx/cli"),
		path.join(cwd, "src", "cli.ts"),
		"--json",
		"init",
		"--demo",
	],
	{ cwd, env: seedEnv, stdio: "inherit" },
);
if (seed.status !== 0) {
	throw new Error(`Could not seed Playwright demo (${String(seed.status)})`);
}

const child = spawn(
	process.execPath,
	[viteBin, "dev", "--port", port, "--host", "127.0.0.1"],
	{
		cwd,
		stdio: "inherit",
		env: {
			...withSanitizedNodeOptions(process.env),
			BIRDCLAW_HOME: resolvedHome,
			BIRDCLAW_E2E: "1",
			BIRDCLAW_E2E_FAKE_LIVE_WRITES: "1",
			BIRDCLAW_DISABLE_LIVE_WRITES: "1",
			BIRDCLAW_LOCAL_WEB: "1",
			BIRDCLAW_WEB_TOKEN: "birdclaw-e2e-token",
		},
	},
);

child.on("exit", (code) => {
	process.exit(code ?? 0);
});
