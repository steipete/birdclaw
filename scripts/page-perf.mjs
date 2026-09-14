import { createHash } from "node:crypto";

const base = new URL(process.argv[2] ?? "http://127.0.0.1:3143");
const account = process.argv[3] ?? "audit";
const pages = [
	"/",
	"/mentions",
	"/likes",
	"/bookmarks",
	"/dms",
	"/inbox",
	"/blocks",
	"/links",
	"/network-map",
	"/today",
	"/discuss",
	"/profile-analyze",
	"/profiles/synthetic",
	"/data-sources",
	"/rate-limits",
];
const api = (path, params) => {
	const url = new URL(path, base);
	for (const [key, value] of Object.entries(params))
		url.searchParams.set(key, String(value));
	return url;
};
const scenarios = [
	["Home", "/api/query", { resource: "home", account, limit: 50 }],
	["Mentions", "/api/query", { resource: "mentions", account, limit: 50 }],
	[
		"Likes",
		"/api/query",
		{ resource: "home", account, liked: true, limit: 50 },
	],
	[
		"Bookmarks",
		"/api/query",
		{ resource: "home", account, bookmarked: true, limit: 50 },
	],
	["DMs", "/api/query", { resource: "dms", account, messageLimit: 100 }],
	["Inbox", "/api/inbox", { account, limit: 20 }],
	["Blocks", "/api/blocks", { account, limit: 50 }],
	[
		"Links, all time",
		"/api/link-insights",
		{ range: "all", limit: 30, commentsLimit: 30 },
	],
	[
		"Links, rolling week",
		"/api/link-insights",
		{ range: "week", limit: 30, commentsLimit: 30 },
	],
	["Map", "/api/network-map", { account, type: "followers", format: "view" }],
];
const request = async (url) => {
	const start = performance.now();
	let target = url;
	let response;
	for (let redirects = 0; redirects <= 5; redirects++) {
		response = await fetch(target, { redirect: "manual" });
		if (![301, 302, 303, 307, 308].includes(response.status)) break;
		const location = response.headers.get("location");
		if (!location || redirects === 5) throw new Error("Invalid redirect chain");
		const next = new URL(location, target);
		if (next.origin !== url.origin)
			throw new Error("Refusing a cross-origin redirect");
		await response.body?.cancel();
		target = next;
	}
	const text = await response.text();
	const ms = performance.now() - start;
	if (!response.ok) throw new Error(`${url.pathname}: HTTP ${response.status}`);
	return {
		ms,
		bytes: Buffer.byteLength(text),
		digest: createHash("sha256").update(text).digest("hex"),
		text,
	};
};
for (const path of pages) {
	const result = await request(new URL(path, base));
	console.log(
		JSON.stringify({
			page: path,
			htmlMs: result.ms,
			bytes: result.bytes,
			readOnlyGate: result.text.includes(
				"This page is unavailable in a read-only archive deployment",
			),
		}),
	);
}
for (const [page, path, params] of scenarios) {
	const url = api(path, params);
	const first = await request(url);
	const warm = [];
	for (let i = 0; i < 5; i++) warm.push(await request(url));
	const durations = warm.map((result) => result.ms).sort((a, b) => a - b);
	console.log(
		JSON.stringify({
			page,
			api: path,
			firstMs: first.ms,
			warmMedianMs: durations[2],
			warmP95Ms: durations[4],
			bytes: first.bytes,
			digest: first.digest,
		}),
	);
}
