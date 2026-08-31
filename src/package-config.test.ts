// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { configDefaults, coverageConfigDefaults } from "vitest/config";
import { describe, expect, it } from "vitest";
import vitestConfig from "../vitest.config";

const packageJson = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
	version: string;
	bin: Record<string, string>;
	scripts: Record<string, string>;
	files: string[];
	dependencies: Record<string, string>;
	devDependencies: Record<string, string>;
	engines: Record<string, string>;
	overrides: Record<string, string>;
	trustedDependencies: string[];
	packageManager: string;
};

function resolvedVitestConfig() {
	return vitestConfig;
}

describe("package configuration", () => {
	it("launches the compiled CLI without source or tsx", () => {
		const launcher = readFileSync(
			new URL("../bin/birdclaw.mjs", import.meta.url),
			"utf8",
		);
		expect(launcher).toContain("../dist/cli/birdclaw.js");
		expect(launcher).not.toContain("tsx");
		expect(launcher).not.toContain("src/cli");
		expect(packageJson.dependencies).not.toHaveProperty("tsx");
	});

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

	it("uses Bun by default while retaining explicit Node compatibility", () => {
		expect(packageJson.scripts.test).toBe(
			"bun --no-env-file ./scripts/run-vitest.mjs run",
		);
		expect(packageJson.scripts["test:node"]).toBe(
			"node ./scripts/run-vitest.mjs run",
		);
		expect(packageJson.scripts.coverage).toContain("bun --no-env-file");
		expect(packageJson.scripts["coverage:node"]).toContain(
			"BIRDCLAW_COVERAGE_PROVIDER=v8 node",
		);
		expect(packageJson.packageManager).toMatch(
			/^bun@1\.4\.0-canary\.1\+[0-9a-f]{9}$/,
		);
		expect(packageJson.engines).toMatchObject({
			bun: "1.4.0",
			node: ">=26.5.1 <27",
		});
		expect(packageJson.overrides).toEqual({
			"@hono/node-server": "2.1.1",
			hono: "4.13.5",
			nanoid: "6.0.1",
		});
		expect(packageJson.trustedDependencies).toEqual([
			"esbuild",
			"lightningcss",
		]);
		expect(existsSync(new URL("../bun.lock", import.meta.url))).toBe(true);
		expect(existsSync(new URL("../pnpm-lock.yaml", import.meta.url))).toBe(
			false,
		);
	});

	it("marks source dev server as local-only for token-free loopback APIs", () => {
		expect(packageJson.scripts.dev).toContain("BIRDCLAW_LOCAL_WEB=1");
		expect(packageJson.scripts.dev).toContain("--host 127.0.0.1");
	});

	it("publishes only compiled runtime trees", () => {
		expect(packageJson.files).toEqual(
			expect.arrayContaining([
				"bin/",
				"dist/cli/",
				"dist/client/",
				"dist/server/",
			]),
		);
		expect(packageJson.files).not.toContain("src/");
		expect(packageJson.files).not.toContain("scripts/");
		expect(packageJson.devDependencies).not.toHaveProperty("tsx");
		expect(packageJson.devDependencies).toHaveProperty("vite");
		expect(packageJson.dependencies).not.toHaveProperty("vite");
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
			"src/routes/network-map.tsx",
			"src/routes/api/data-sources.tsx",
			"src/routes/api/network-map.tsx",
		]);
		const usesV8Coverage = process.env.BIRDCLAW_COVERAGE_PROVIDER === "v8";
		expect(config.test?.coverage?.provider).toBe(
			usesV8Coverage ? "v8" : "istanbul",
		);
		expect(config.test?.coverage?.thresholds?.branches).toBe(
			usesV8Coverage ? 80 : 79,
		);
		expect(config.test?.server?.deps?.inline).toEqual(
			"bun" in process.versions ? ["zod"] : [],
		);
		expect(config.test?.testTimeout).toBe(
			process.env.BIRDCLAW_COVERAGE_RUN === "1" ? 30_000 : 10_000,
		);
	});
});
