import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getNativeDb, resetDatabaseForTests } from "../src/lib/db";
import { getDatabasePerformanceTotals } from "../src/lib/database-metrics";
import { networkMapViewResponseSchema } from "../src/lib/api-contracts";
import {
	getNetworkMapView,
	type NetworkMapViewOptions,
} from "../src/lib/network-map-view";

const iterations = 30;
const fixture = process.argv[2];
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
  with recursive seq(n) as (select 0 union all select n+1 from seq where n<2047)
  insert into geocoded_locations (normalized_key,original,lat,lng,formatted,provider,hits,created_at,last_used_at)
  select 'synthetic city '||n,'Synthetic City '||n,-75+150.0*(n/64)/31,-175+350.0*(n%64)/63,'Synthetic City '||n,'opencage',1,'2026-01-01','2026-01-01' from seq;
 `);
	process.env.BIRDCLAW_DEPLOYMENT_READ_ONLY = "1";
	const measure = async (options: NetworkMapViewOptions) => {
		const databaseBefore = getDatabasePerformanceTotals();
		const start = performance.now();
		const data = await getNetworkMapView({ type: "followers", ...options }, db);
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
	const cold = await measure({});
	console.log(JSON.stringify({ scenario: "cold", ...cold }));
	const scenarios: Array<[string, (i: number) => NetworkMapViewOptions]> = [
		["pagination", (i) => ({ offset: (i + 1) * 160 })],
		["changing-search", (i) => ({ search: `person${220000 + i}` })],
		[
			"typing-search",
			(i) => ({ search: "person224706".slice(0, 3 + (i % 10)) }),
		],
		[
			"fresh-pan",
			(i) => ({ viewport: { bounds: [i / 10, 40, 30 + i / 10, 55], zoom: 4 } }),
		],
	];
	for (const [scenario, options] of scenarios) {
		const samples: Array<Awaited<ReturnType<typeof measure>>> = [];
		for (let i = 0; i < iterations; i++)
			samples.push(await measure(options(i)));
		const percentile = (
			key: "generateMs" | "totalMs" | "databaseMs",
			p: number,
		) =>
			samples.map((sample) => sample[key]).sort((a, b) => a - b)[
				Math.ceil(iterations * p) - 1
			];
		console.log(
			JSON.stringify({
				scenario,
				iterations,
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
} finally {
	resetDatabaseForTests();
	if (!fixture) rmSync(home, { recursive: true, force: true });
}
