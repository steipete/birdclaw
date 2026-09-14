import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getNativeDb, resetDatabaseForTests } from "../src/lib/db";
import { getDatabasePerformanceTotals } from "../src/lib/database-metrics";
import { networkMapViewResponseSchema } from "../src/lib/api-contracts";
import {
	getNetworkMapView,
	type NetworkMapViewOptions,
} from "../src/lib/network-map-view";

const iterations = 30;
const fixture = process.argv[2] === "-" ? undefined : process.argv[2];
const baseline = process.argv[3];
const readers = new Map<string, typeof getNetworkMapView>();
if (baseline)
	readers.set(
		"before",
		(
			await import(
				pathToFileURL(path.resolve(baseline, "src/lib/network-map-view.ts"))
					.href
			)
		).getNetworkMapView,
	);
readers.set("after", getNetworkMapView);
if (fixture && !existsSync(path.join(fixture, "birdclaw.sqlite"))) {
	throw new Error("Expected an existing benchmark fixture directory");
}
const home =
	fixture ?? mkdtempSync(path.join(os.tmpdir(), "birdclaw-map-perf-"));
process.env.BIRDCLAW_HOME = home;
process.env.BIRDCLAW_DEPLOYMENT_READ_ONLY = fixture ? "1" : "0";
try {
	const db = getNativeDb({ seedDemoData: false });
	if (!fixture)
		db.exec(`
  insert into accounts (id,name,handle,external_user_id,transport,is_default,created_at)
  values ('map-perf','Synthetic network','map-perf','1','archive',1,'2026-01-01');
  with recursive seq(n) as (select 1 union all select n+1 from seq where n<544560)
  insert into profiles (id,handle,display_name,bio,followers_count,following_count,public_metrics_json,avatar_hue,location,created_at)
  select 'profile_'||n,'person'||n,'Synthetic Person '||n,'',544560-n,0,'{}',0,case when n<=224706 then 'Synthetic City '||(n%2048) else null end,'2026-01-01' from seq;
  insert into follow_edges (account_id,direction,profile_id,external_user_id,source,current,first_seen_at,last_seen_at,updated_at)
  select 'map-perf','followers',id,id,'test',1,'2026-01-01','2026-01-01','2026-01-01' from profiles;
  insert into follow_edges (account_id,direction,profile_id,external_user_id,source,current,first_seen_at,last_seen_at,updated_at)
  select 'map-perf','following',id,id,'test',1,'2026-01-01','2026-01-01','2026-01-01' from profiles where cast(substr(id,9) as integer)%100=0;
  with recursive seq(n) as (select 0 union all select n+1 from seq where n<2047)
  insert into geocoded_locations (normalized_key,original,lat,lng,formatted,provider,hits,created_at,last_used_at)
  select 'synthetic city '||n,'Synthetic City '||n,-75+150.0*(n/64)/31,-175+350.0*(n%64)/63,'Synthetic City '||n,'opencage',1,'2026-01-01','2026-01-01' from seq;
 `);
	process.env.BIRDCLAW_DEPLOYMENT_READ_ONLY = "1";
	process.env.OPENCAGE_API_KEY = "";
	process.env.BIRDCLAW_MAPBOX_ACCESS_TOKEN = "";
	process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN = "";
	const measure = async (
		read: typeof getNetworkMapView,
		options: NetworkMapViewOptions,
	) => {
		const databaseBefore = getDatabasePerformanceTotals();
		const start = performance.now();
		const data = await read({ type: "followers", ...options }, db);
		const generated = performance.now();
		const json = JSON.stringify(networkMapViewResponseSchema.parse(data));
		const end = performance.now();
		return {
			generateMs: generated - start,
			totalMs: end - start,
			databaseMs:
				getDatabasePerformanceTotals().milliseconds -
				databaseBefore.milliseconds,
			bytes: Buffer.byteLength(json),
			profiles: data.meta.totalProfiles,
			located: data.meta.locatedProfiles,
			digest: createHash("sha256").update(json).digest("hex"),
		};
	};
	const scenarios: Array<
		[string, number, (i: number) => NetworkMapViewOptions]
	> = [
		["cold", 1, () => ({})],
		...["followers", "following", "mutual"].map(
			(type) =>
				[
					`rebuild-${type}`,
					10,
					() => ({
						type: type as NetworkMapViewOptions["type"],
						refresh: true,
						geocodeLimit: 0,
					}),
				] as [string, number, () => NetworkMapViewOptions],
		),
		["pagination", iterations, (i) => ({ offset: (i + 1) * 160 })],
		["changing-search", iterations, (i) => ({ search: `person${220000 + i}` })],
		[
			"typing-search",
			iterations,
			(i) => ({ search: "person224706".slice(0, 3 + (i % 10)) }),
		],
		[
			"fresh-pan",
			iterations,
			(i) => ({ viewport: { bounds: [i / 10, 40, 30 + i / 10, 55], zoom: 4 } }),
		],
	];
	for (const [scenario, count, options] of scenarios) {
		const samplesByVariant = new Map(
			[...readers.keys()].map((name) => [
				name,
				[] as Array<Awaited<ReturnType<typeof measure>>>,
			]),
		);
		for (let i = 0; i < count; i++) {
			const order = [...readers];
			if (i % 2) order.reverse();
			const digests = new Set<string>();
			for (const [name, read] of order) {
				const sample = await measure(read, options(i));
				samplesByVariant.get(name)!.push(sample);
				digests.add(sample.digest);
			}
			if (digests.size !== 1)
				throw new Error(`${scenario}: response digests differ`);
		}
		for (const [variant, samples] of samplesByVariant) {
			const measured = scenario.startsWith("rebuild-")
				? samples.slice(2)
				: samples;
			const percentile = (
				key: "generateMs" | "totalMs" | "databaseMs",
				p: number,
			) =>
				measured.map((sample) => sample[key]).sort((a, b) => a - b)[
					Math.ceil(measured.length * p) - 1
				];
			console.log(
				JSON.stringify({
					scenario,
					variant,
					iterations: count,
					first: samples[0],
					samples: scenario.startsWith("rebuild-") ? samples : undefined,
					medianGenerateMs: percentile("generateMs", 0.5),
					medianTotalMs: percentile("totalMs", 0.5),
					p95TotalMs: percentile("totalMs", 0.95),
					medianDatabaseMs: percentile("databaseMs", 0.5),
					digest: createHash("sha256")
						.update(samples.map((sample) => sample.digest).join("\n"))
						.digest("hex"),
				}),
			);
		}
	}
} finally {
	resetDatabaseForTests();
	if (!fixture) rmSync(home, { recursive: true, force: true });
}
