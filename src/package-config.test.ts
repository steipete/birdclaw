// @vitest-environment node
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { configDefaults, coverageConfigDefaults } from "vitest/config";
import { describe, expect, it } from "vitest";
import vitestConfig from "../vitest.config";

const execFileAsync = promisify(execFile);

const packageJson = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
	version: string;
	bin: Record<string, string>;
	scripts: Record<string, string>;
	files: string[];
};

function resolvedVitestConfig() {
	return vitestConfig;
}

describe("package configuration", () => {
	it("runs the published bin wrapper without tsx CLI startup", async () => {
		const { stdout } = await execFileAsync(
			process.execPath,
			["bin/birdclaw.mjs", "--version"],
			{
				cwd: new URL("..", import.meta.url),
				env: process.env,
			},
		);

		expect(stdout.trim()).toBe(packageJson.version);
	}, 15_000);

	it("keeps published bin files in lint and format script coverage", () => {
		const binTargets = Object.values(packageJson.bin);
		for (const scriptName of ["lint", "format", "format:check"]) {
			const script = packageJson.scripts[scriptName];
			for (const binTarget of binTargets) {
				expect(binTarget).toMatch(/^bin\//);
				expect(script).toMatch(/\bbin\b/);
			}
		}
	});

	it("uses the Node vitest wrapper directly for portable test scripts", () => {
		expect(packageJson.scripts.test).toBe("node ./scripts/run-vitest.mjs run");
		expect(packageJson.scripts.coverage).toBe(
			"node ./scripts/run-vitest.mjs run --coverage",
		);
	});

	it("publishes script helpers referenced by package scripts", () => {
		const isPublished = (filePath: string) =>
			packageJson.files.some(
				(entry) =>
					!entry.startsWith("!") &&
					(entry === filePath ||
						(entry.endsWith("/") && filePath.startsWith(entry))),
			);

		for (const script of Object.values(packageJson.scripts)) {
			for (const match of script.matchAll(/(?:^|\s)(\.\/scripts\/\S+)/g)) {
				const scriptPath = match[1]?.replace(/^\.\//, "");
				expect(scriptPath && isPublished(scriptPath)).toBe(true);
			}
		}
	});

	it("preserves Vitest default excludes while adding project excludes", () => {
		const config = resolvedVitestConfig();
		expect(config.test?.exclude).toEqual([
			...configDefaults.exclude,
			"playwright/**/*",
		]);
		expect(config.test?.coverage?.exclude).toEqual([
			...coverageConfigDefaults.exclude,
			"src/routeTree.gen.ts",
			"src/styles.css",
			"src/lib/types.ts",
		]);
	});
});
