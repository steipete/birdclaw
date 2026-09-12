import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(
	await readFile(path.join(root, "package.json"), "utf8"),
);

await rm(path.join(root, "dist/cli"), { recursive: true, force: true });

await build({
	absWorkingDir: root,
	entryPoints: { birdclaw: "src/cli.ts" },
	outdir: "dist/cli",
	splitting: true,
	chunkNames: "chunks/[name]-[hash]",
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node26",
	// Bundle Effect's used modules to avoid loading its full module graph per command.
	external: Object.keys({
		...manifest.dependencies,
		...manifest.devDependencies,
	}).filter((name) => name !== "effect"),
	logLevel: "info",
});
