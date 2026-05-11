#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { withSanitizedNodeOptions } from "./sanitize-node-options.mjs";

const DEFAULT_BASE_URL = "http://localhost:3000";
const DEFAULT_ITERATIONS = 5;
const READY_TIMEOUT_MS = 20_000;

const SCENARIOS = {
	home: {
		path: "/",
		ready: async (page) => waitForAny(page, ['[data-perf="timeline-card"]']),
	},
	mentions: {
		path: "/mentions",
		ready: async (page) => waitForAny(page, ['[data-perf="timeline-card"]']),
	},
	"mentions-search": {
		path: "/mentions",
		ready: async (page) => {
			await page.getByPlaceholder("Search mentions").fill("peekaboo");
			await waitForAny(page, ['[data-perf="timeline-card"]']);
		},
	},
	links: {
		path: "/links",
		ready: async (page) =>
			waitForAny(page, [
				'[data-perf="link-insight-row"]',
				"text=No links in this window.",
			]),
	},
	"links-toggle": {
		path: "/links",
		ready: async (page) =>
			waitForAny(page, [
				'[data-perf="link-insight-row"]',
				"text=No links in this window.",
			]),
		action: async (page) => {
			await page.getByRole("button", { name: "videos" }).click();
			await waitForAny(page, [
				'[data-perf="link-insight-row"]',
				"text=No links in this window.",
			]);
		},
	},
};

function parseArgs(argv) {
	const options = {
		baseUrl: process.env.BIRDCLAW_PERF_URL || DEFAULT_BASE_URL,
		iterations: DEFAULT_ITERATIONS,
		scenarios: Object.keys(SCENARIOS),
		json: false,
		budgets: {},
	};

	for (const arg of argv) {
		if (arg === "--json") {
			options.json = true;
		} else if (arg.startsWith("--url=")) {
			options.baseUrl = arg.slice("--url=".length).replace(/\/$/, "");
		} else if (arg.startsWith("--iterations=")) {
			options.iterations = Math.max(
				1,
				Number.parseInt(arg.split("=")[1] ?? "", 10),
			);
		} else if (arg.startsWith("--scenario=")) {
			options.scenarios = arg
				.slice("--scenario=".length)
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean);
		} else if (arg.startsWith("--budget-ready-ms=")) {
			options.budgets.readyMs = Number(arg.split("=")[1]);
		} else if (arg.startsWith("--budget-action-ms=")) {
			options.budgets.actionMs = Number(arg.split("=")[1]);
		} else if (arg.startsWith("--budget-api-p95-ms=")) {
			options.budgets.apiP95Ms = Number(arg.split("=")[1]);
		} else if (arg.startsWith("--budget-preview-calls=")) {
			options.budgets.previewCalls = Number(arg.split("=")[1]);
		}
	}

	for (const scenario of options.scenarios) {
		if (!SCENARIOS[scenario]) {
			throw new Error(`Unknown scenario: ${scenario}`);
		}
	}

	return options;
}

async function isReachable(baseUrl) {
	try {
		const response = await fetch(baseUrl, {
			signal: AbortSignal.timeout(1000),
		});
		return response.ok || response.status < 500;
	} catch {
		return false;
	}
}

async function startServerIfNeeded(baseUrl) {
	if (await isReachable(baseUrl)) {
		return null;
	}

	const url = new URL(baseUrl);
	const port = url.port || "3000";
	const viteBin = path.join(
		process.cwd(),
		"node_modules",
		"vite",
		"bin",
		"vite.js",
	);
	const child = spawn(
		process.execPath,
		[viteBin, "dev", "--port", port, "--host", "127.0.0.1"],
		{
			cwd: process.cwd(),
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...withSanitizedNodeOptions(process.env),
			},
		},
	);

	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (await isReachable(baseUrl)) {
			return child;
		}
		await sleep(250);
	}

	child.kill("SIGTERM");
	throw new Error(`Timed out waiting for ${baseUrl}`);
}

async function waitForAny(page, selectors) {
	await page.waitForFunction(
		(values) =>
			values.some((selector) => {
				if (selector.startsWith("text=")) {
					return document.body.innerText.includes(selector.slice(5));
				}
				return Boolean(document.querySelector(selector));
			}),
		selectors,
		{ timeout: READY_TIMEOUT_MS },
	);
}

function percentile(values, point) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.min(
		sorted.length - 1,
		Math.ceil(sorted.length * point) - 1,
	);
	return sorted[index] ?? 0;
}

function median(values) {
	return percentile(values, 0.5);
}

function round(value) {
	return Math.round(value);
}

function apiBucket(rawUrl) {
	const url = new URL(rawUrl);
	if (url.pathname === "/api/link-insights") {
		return `${url.pathname}:${url.searchParams.get("kind") ?? "unknown"}`;
	}
	return url.pathname;
}

function summarizeRuns(runs) {
	const ready = runs.map((run) => run.readyMs);
	const action = runs
		.map((run) => run.actionMs)
		.filter((value) => typeof value === "number");
	const apiDurations = runs.flatMap((run) => run.apiDurationsMs);
	return {
		readyMedianMs: round(median(ready)),
		readyP95Ms: round(percentile(ready, 0.95)),
		actionMedianMs: action.length > 0 ? round(median(action)) : null,
		actionP95Ms: action.length > 0 ? round(percentile(action, 0.95)) : null,
		apiP95Ms: round(percentile(apiDurations, 0.95)),
		apiCallsMedian: round(median(runs.map((run) => run.apiCalls))),
		previewCallsMedian: round(median(runs.map((run) => run.previewCalls))),
		rowsMedian: round(median(runs.map((run) => run.rows))),
		previewsMedian: round(median(runs.map((run) => run.previews))),
		endpoints: summarizeEndpoints(runs),
	};
}

function summarizeEndpoints(runs) {
	const totals = new Map();
	for (const run of runs) {
		for (const [endpoint, count] of Object.entries(run.apiEndpoints)) {
			totals.set(endpoint, (totals.get(endpoint) ?? 0) + count);
		}
	}
	return [...totals.entries()]
		.map(([endpoint, count]) => ({
			endpoint,
			medianCalls: Math.round(count / runs.length),
		}))
		.sort((left, right) => right.medianCalls - left.medianCalls)
		.slice(0, 8);
}

async function runScenario(browser, baseUrl, name) {
	const scenario = SCENARIOS[name];
	const page = await browser.newPage({
		viewport: { width: 1474, height: 910 },
	});
	const requestStart = new Map();
	const apiDurationsMs = [];
	let apiCalls = 0;
	let previewCalls = 0;
	const apiEndpoints = {};

	page.on("request", (request) => {
		if (request.url().includes("/api/")) {
			requestStart.set(request, performance.now());
		}
	});
	page.on("response", (response) => {
		const request = response.request();
		const startedAt = requestStart.get(request);
		if (startedAt === undefined) return;
		requestStart.delete(request);
		apiCalls += 1;
		const endpoint = apiBucket(response.url());
		apiEndpoints[endpoint] = (apiEndpoints[endpoint] ?? 0) + 1;
		apiDurationsMs.push(performance.now() - startedAt);
		if (response.url().includes("/api/link-preview")) {
			previewCalls += 1;
		}
	});

	const startedAt = performance.now();
	await page.goto(`${baseUrl}${scenario.path}`, {
		waitUntil: "domcontentloaded",
	});
	await scenario.ready(page);
	const readyMs = performance.now() - startedAt;

	let actionMs = null;
	if (scenario.action) {
		const actionStartedAt = performance.now();
		await scenario.action(page);
		actionMs = performance.now() - actionStartedAt;
	}

	await page.waitForTimeout(250);
	const counts = await page.evaluate(() => ({
		rows: document.querySelectorAll(
			'[data-perf="timeline-card"], [data-perf="link-insight-row"]',
		).length,
		previews: document.querySelectorAll('[data-perf="link-preview-card"]')
			.length,
	}));
	await page.close();

	return {
		readyMs,
		actionMs,
		apiCalls,
		previewCalls,
		apiEndpoints,
		apiDurationsMs,
		rows: counts.rows,
		previews: counts.previews,
	};
}

function budgetFailures(name, summary, budgets) {
	const failures = [];
	if (
		Number.isFinite(budgets.readyMs) &&
		summary.readyP95Ms > budgets.readyMs
	) {
		failures.push(
			`${name} ready p95 ${summary.readyP95Ms}ms > ${budgets.readyMs}ms`,
		);
	}
	if (
		Number.isFinite(budgets.actionMs) &&
		summary.actionP95Ms !== null &&
		summary.actionP95Ms > budgets.actionMs
	) {
		failures.push(
			`${name} action p95 ${summary.actionP95Ms}ms > ${budgets.actionMs}ms`,
		);
	}
	if (
		Number.isFinite(budgets.apiP95Ms) &&
		summary.apiP95Ms > budgets.apiP95Ms
	) {
		failures.push(
			`${name} api p95 ${summary.apiP95Ms}ms > ${budgets.apiP95Ms}ms`,
		);
	}
	if (
		Number.isFinite(budgets.previewCalls) &&
		summary.previewCallsMedian > budgets.previewCalls
	) {
		failures.push(
			`${name} preview calls median ${summary.previewCallsMedian} > ${budgets.previewCalls}`,
		);
	}
	return failures;
}

function printHuman(results, failures) {
	console.log("browser perf");
	for (const result of results) {
		const summary = result.summary;
		console.log("");
		console.log(`scenario: ${result.name}`);
		console.log(`ready median: ${summary.readyMedianMs}ms`);
		console.log(`ready p95: ${summary.readyP95Ms}ms`);
		if (summary.actionMedianMs !== null) {
			console.log(`action median: ${summary.actionMedianMs}ms`);
			console.log(`action p95: ${summary.actionP95Ms}ms`);
		}
		console.log(`api p95: ${summary.apiP95Ms}ms`);
		console.log(`api calls median: ${summary.apiCallsMedian}`);
		console.log(`preview calls median: ${summary.previewCallsMedian}`);
		console.log(`rows median: ${summary.rowsMedian}`);
		console.log(`preview cards median: ${summary.previewsMedian}`);
		if (summary.endpoints.length > 0) {
			console.log("top endpoints:");
			for (const endpoint of summary.endpoints) {
				console.log(`- ${endpoint.endpoint}: ${endpoint.medianCalls}`);
			}
		}
	}
	if (failures.length > 0) {
		console.log("");
		console.log("budget failures:");
		for (const failure of failures) {
			console.log(`- ${failure}`);
		}
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const server = await startServerIfNeeded(options.baseUrl);
	const browser = await chromium.launch({ headless: true });
	const results = [];
	const failures = [];

	try {
		for (const name of options.scenarios) {
			await runScenario(browser, options.baseUrl, name);
			const runs = [];
			for (let index = 0; index < options.iterations; index += 1) {
				runs.push(await runScenario(browser, options.baseUrl, name));
			}
			const summary = summarizeRuns(runs);
			results.push({ name, summary, runs });
			failures.push(...budgetFailures(name, summary, options.budgets));
		}
	} finally {
		await browser.close();
		if (server) {
			server.kill("SIGTERM");
		}
	}

	if (options.json) {
		console.log(JSON.stringify({ results, failures }, null, 2));
	} else {
		printHuman(results, failures);
	}

	if (failures.length > 0) {
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exit(1);
});
