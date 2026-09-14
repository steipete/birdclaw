import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { withSanitizedNodeOptions } from "./sanitize-node-options.mjs";

const cwd = process.cwd();
const home = path.join(cwd, ".playwright-home");
const port = process.env.BIRDCLAW_PLAYWRIGHT_PORT || "3000";
const resolvedHome = path.resolve(home);
const resolvedCwd = path.resolve(cwd);
const isBunRuntime = Boolean(process.versions.bun);
const runtimeArgs = isBunRuntime ? ["--no-env-file"] : [];
const cliEntry = path.join(
	cwd,
	isBunRuntime ? "src/cli.ts" : "dist/cli/birdclaw.js",
);
const serverEntry = path.join(cwd, "bin/birdclaw.mjs");

if (
	!resolvedHome.startsWith(`${resolvedCwd}${path.sep}`) ||
	path.basename(resolvedHome) !== ".playwright-home"
) {
	throw new Error(`Refusing to delete unsafe test home: ${resolvedHome}`);
}
if (!existsSync(cliEntry)) {
	throw new Error(`Playwright CLI entry does not exist: ${cliEntry}`);
}

rmSync(resolvedHome, { recursive: true, force: true });

const commonEnv = {
	...withSanitizedNodeOptions(process.env),
	BIRDCLAW_HOME: resolvedHome,
	BIRDCLAW_E2E: "1",
	BIRDCLAW_BACKUP_AUTO_SYNC: "0",
	BIRDCLAW_DISABLE_LIVE_PROFILE_LOOKUP: "1",
	BIRDCLAW_DISABLE_LIVE_WRITES: "1",
	DO_NOT_TRACK: "1",
};
const seed = spawnSync(
	process.execPath,
	[...runtimeArgs, cliEntry, "--json", "init", "--demo"],
	{
		cwd,
		env: { ...commonEnv, BIRDCLAW_DEPLOYMENT_READ_ONLY: "0" },
		stdio: "inherit",
	},
);
if (seed.status !== 0) {
	throw new Error(`Could not seed Playwright demo (${String(seed.status)})`);
}

const child = spawn(
	process.execPath,
	[...runtimeArgs, serverEntry, "serve", "--host", "127.0.0.1", "--port", port],
	{
		cwd,
		stdio: "inherit",
		env: {
			...commonEnv,
			BIRDCLAW_E2E_FAKE_LIVE_WRITES: "1",
			BIRDCLAW_WEB_TOKEN: "birdclaw-e2e-token",
		},
	},
);

child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 0);
});
