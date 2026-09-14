import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getNativeDb, resetDatabaseForTests } from "../src/lib/db";
import { getLinkInsights } from "../src/lib/link-insights";
import { getNetworkMap } from "../src/lib/network-map";
import { getNetworkMapView } from "../src/lib/network-map-view";
import {
	networkMapResponseSchema,
	networkMapViewResponseSchema,
} from "../src/lib/api-contracts";

const root = mkdtempSync(path.join(os.tmpdir(), "birdclaw-cold-perf-"));
const home = path.join(root, "home");
const current = {
	getLinkInsights,
	getNetworkMap,
	getNetworkMapView,
	close: resetDatabaseForTests,
};
const variants = new Map<string, typeof current>();
const results: unknown[] = [];

try {
	const fixture = spawnSync(
		process.execPath,
		[
			"--no-env-file",
			fileURLToPath(new URL("./page-perf-fixture.ts", import.meta.url)),
			home,
		],
		{ encoding: "utf8" },
	);
	if (fixture.status !== 0)
		throw new Error(fixture.stderr || "Fixture creation failed");
	process.env.BIRDCLAW_HOME = home;
	process.env.BIRDCLAW_DEPLOYMENT_READ_ONLY = "0";
	process.env.OPENCAGE_API_KEY = "";
	process.env.BIRDCLAW_MAPBOX_ACCESS_TOKEN = "";
	process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN = "";
	if (process.argv[2]) {
		const base = path.resolve(process.argv[2]);
		const moduleAt = (file: string) =>
			import(pathToFileURL(path.join(base, "src/lib", file)).href);
		variants.set("before", {
			getLinkInsights: (await moduleAt("link-insights.ts")).getLinkInsights,
			getNetworkMap: (await moduleAt("network-map.ts")).getNetworkMap,
			getNetworkMapView: (await moduleAt("network-map-view.ts"))
				.getNetworkMapView,
			close: (await moduleAt("db.ts")).resetDatabaseForTests,
		});
	}
	variants.set("after", current);
	const db = getNativeDb({ seedDemoData: false });
	for (const scenario of ["links-control", "videos", "map-data", "map-view"]) {
		const samples = new Map<string, number[]>();
		const digests = new Map<string, string>();
		for (let iteration = 0; iteration < 10; iteration++) {
			const order = [...variants.entries()];
			if (iteration % 2) order.reverse();
			for (const [name, read] of order) {
				const map = scenario.startsWith("map-");
				process.env.BIRDCLAW_DEPLOYMENT_READ_ONLY = map ? "1" : "0";
				const start = performance.now();
				const result =
					scenario === "map-data"
						? await read.getNetworkMap(
								{ account: "audit", type: "followers", limit: null },
								db,
							)
						: scenario === "map-view"
							? await read.getNetworkMapView(
									{
										account: "audit",
										type: "followers",
										refresh: true,
										geocodeLimit: 0,
									},
									db,
								)
							: read.getLinkInsights({
									account: "audit",
									kind: scenario === "videos" ? "videos" : "links",
									range: "all",
									limit: 30,
								});
				const ms = performance.now() - start;
				const values = samples.get(name) ?? [];
				values.push(ms);
				samples.set(name, values);
				const digest = createHash("sha256")
					.update(
						JSON.stringify(
							scenario === "map-data"
								? networkMapResponseSchema.parse(result)
								: scenario === "map-view"
									? networkMapViewResponseSchema.parse(result)
									: result,
						),
					)
					.digest("hex");
				if (digests.has(name) && digests.get(name) !== digest)
					throw new Error(`${scenario}: ${name} changed between samples`);
				digests.set(name, digest);
			}
		}
		if (new Set(digests.values()).size !== 1)
			throw new Error(`${scenario}: before/after content differs`);
		results.push({
			scenario,
			variants: Object.fromEntries(
				[...samples].map(([name, values]) => {
					const warm = values.slice(2).sort((a, b) => a - b);
					return [
						name,
						{
							firstMs: values[0],
							medianMs: (warm[3]! + warm[4]!) / 2,
							samplesMs: values,
							digest: digests.get(name),
						},
					];
				}),
			),
		});
	}
	console.log(
		JSON.stringify(
			{
				runtime: { bun: process.versions.bun, sqlite: process.versions.sqlite },
				method:
					"Uncached model reads on one synthetic archive, alternating execution order. Ten samples; warm median excludes the first two. Filesystem/SQLite pages may be warm. No geocoding or HTTP response caches. map-view includes cluster construction.",
				results,
			},
			null,
			2,
		),
	);
} finally {
	for (const value of variants.values()) value.close();
	resetDatabaseForTests();
	rmSync(root, { recursive: true, force: true });
}
