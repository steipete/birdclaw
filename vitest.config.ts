import { fileURLToPath } from "node:url";
import { prepareBrandAsset } from "./scripts/brand-asset.ts";
import {
	configDefaults,
	coverageConfigDefaults,
	defineConfig,
} from "vitest/config";

const brandAsset = await prepareBrandAsset(
	fileURLToPath(new URL(".", import.meta.url)),
);

const isBun = Boolean(process.versions.bun);
const isCoverageRun = process.env.BIRDCLAW_COVERAGE_RUN === "1";
const coverageProvider =
	process.env.BIRDCLAW_COVERAGE_PROVIDER === "v8" ? "v8" : "istanbul";

export default defineConfig({
	resolve: {
		alias: { "virtual:birdclaw-brand?url": `${brandAsset}?url` },
		tsconfigPaths: true,
	},
	test: {
		environment: "jsdom",
		testTimeout: isCoverageRun ? 30_000 : 10_000,
		setupFiles: ["./src/test/setup.ts"],
		include: ["src/**/*.test.{ts,tsx}"],
		exclude: [...configDefaults.exclude, "playwright/**/*"],
		server: {
			deps: {
				inline: isBun ? ["zod"] : [],
			},
		},
		coverage: {
			provider: coverageProvider,
			reporter: ["text", "json-summary", "html"],
			include: ["src/**/*.{ts,tsx}"],
			exclude: [
				...coverageConfigDefaults.exclude,
				"src/routeTree.gen.ts",
				"src/styles.css",
				"src/lib/types.ts",
				"src/routes/network-map.tsx",
				"src/routes/api/data-sources.tsx",
				"src/routes/api/network-map.tsx",
			],
			thresholds: {
				lines: 85,
				functions: 85,
				branches: coverageProvider === "v8" ? 80 : 79,
				statements: 85,
			},
		},
	},
});
