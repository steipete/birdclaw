import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import {
	networkMapResponseSchema,
	queryResponseSchema,
} from "../src/lib/api-contracts";
import { periodDigestStreamEventSchema } from "../src/lib/client-stream-contracts";

const profile = {
	id: "profile_demo",
	handle: "demo",
	displayName: "Demo",
	bio: "Synthetic profile",
	followersCount: 100,
	avatarHue: 42,
	createdAt: "2026-01-01T00:00:00Z",
};
const feature = {
	type: "Feature",
	geometry: { type: "Point", coordinates: [-122.4, 37.8] },
	properties: {
		profileId: profile.id,
		handle: profile.handle,
		name: profile.displayName,
		avatarUrl: null,
		location: "San Francisco",
		resolvedLocation: null,
		followersCount: 100,
		followingCount: 10,
		verified: null,
		relationship: "followers",
		approxRadiusM: null,
	},
};
const workloads: {
	name: string;
	schema: z.ZodType;
	input: unknown;
	iterations: number;
}[] = [
	{
		name: "timeline-50",
		schema: queryResponseSchema,
		iterations: 2_000,
		input: {
			resource: "home",
			items: Array.from({ length: 50 }, (_, i) => ({
				id: `tweet_${i}`,
				text: "Synthetic post",
				author: profile,
				media: [{ url: "https://example.com/photo.jpg", type: "photo" }],
				quotedTweet: { id: "quoted", text: "Quoted post", author: profile },
			})),
		},
	},
	{
		name: "dm-messages-100",
		schema: queryResponseSchema,
		iterations: 2_000,
		input: {
			resource: "dms",
			items: [],
			selectedConversation: {
				conversation: {
					id: "conversation_demo",
					accountId: "acct_demo",
					title: "Demo",
					participant: profile,
				},
				messages: Array.from({ length: 100 }, (_, i) => ({
					id: `dm_${i}`,
					text: "Synthetic message",
					sender: profile,
				})),
				nextCursor: null,
			},
		},
	},
	{
		name: "map-profiles-1000",
		schema: networkMapResponseSchema,
		iterations: 500,
		input: {
			type: "FeatureCollection",
			features: Array.from({ length: 1_000 }, () => feature),
			meta: {
				accountId: "acct_demo",
				type: "all",
				totalProfiles: 1_000,
				profilesWithLocation: 1_000,
				meaningfulProfiles: 1_000,
				locatedProfiles: 1_000,
				missingGeocodes: 0,
				geocodedThisRun: 0,
				suppressedGeocodes: 0,
				opencageConfigured: false,
				mapboxTokenConfigured: false,
			},
			config: { mapboxToken: null },
		},
	},
	{
		name: "report-delta",
		schema: periodDigestStreamEventSchema,
		iterations: 100_000,
		input: { type: "delta", delta: "Synthetic report text" },
	},
];

function median(values: number[]) {
	return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}
function measure(schema: z.ZodType, input: unknown, iterations: number) {
	const start = performance.now();
	for (let i = 0; i < iterations; i++) schema.parse(input);
	return (performance.now() - start) / iterations;
}

const results = workloads.map(({ name, schema, input, iterations }) => {
	// clone() reconstructs the ordinary parser from the same schema definition.
	const runtime = schema.clone();
	const compileStart = performance.now();
	z.compile(runtime, { strict: true });
	const compileMs = performance.now() - compileStart;
	const expected = runtime.parse(input);
	assert.deepStrictEqual(schema.parse(input), expected);
	measure(runtime, input, 100);
	measure(schema, input, 100);
	const samples = { runtime: [] as number[], compiled: [] as number[] };
	for (let round = 0; round < 8; round++) {
		const order =
			round % 2
				? (["compiled", "runtime"] as const)
				: (["runtime", "compiled"] as const);
		for (const mode of order) {
			samples[mode].push(
				measure(mode === "runtime" ? runtime : schema, input, iterations),
			);
		}
	}
	const runtimeMs = median(samples.runtime);
	const compiledMs = median(samples.compiled);
	return {
		name,
		iterations,
		compileMs,
		runtimeMs,
		compiledMs,
		speedup: runtimeMs / compiledMs,
		sha256: createHash("sha256").update(JSON.stringify(expected)).digest("hex"),
		samples,
	};
});
console.log(JSON.stringify({ runtime: process.versions, results }, null, 2));
