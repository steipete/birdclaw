import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBirdclawQueryClient, queryKeys } from "./query-client";

const mocks = vi.hoisted(() => ({
	accounts: vi.fn(),
	envelope: vi.fn(),
}));
vi.mock("./db", () => ({
	getReadDb: () => ({ prepare: () => ({ all: mocks.accounts }) }),
}));
vi.mock("./query-status", () => ({
	getQueryEnvelopeEffect: () => Effect.try(mocks.envelope),
}));
import { readStatusBootstrap } from "./status-bootstrap.server";

const envelope = {
	readOnly: true,
	stats: { home: 3, mentions: 2, dms: 1, needsReply: 1, inbox: 3 },
	accounts: [
		{
			id: "acct_demo",
			name: "Demo",
			handle: "demo",
			transport: "local",
			isDefault: 1,
			createdAt: "2026-01-01T00:00:00Z",
		},
	],
	archives: [],
	transport: {
		installed: false,
		availableTransport: "local",
		statusText: "Read-only cached archive",
	},
};
const request = (headers: HeadersInit = {}, method = "GET") =>
	new Request("https://archive.example/dms", { method, headers });
const authorized = { "x-birdclaw-token": "synthetic-bootstrap-test" };

beforeEach(() => {
	vi.stubEnv("NODE_ENV", "production");
	vi.stubEnv("VITEST", "false");
	vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "1");
	vi.stubEnv("BIRDCLAW_ALLOW_REMOTE_WEB", "1");
	vi.stubEnv("BIRDCLAW_WEB_TOKEN", "synthetic-bootstrap-test");
	vi.stubEnv("BIRDCLAW_LOCAL_WEB", "0");
	mocks.accounts.mockReturnValue([{ id: "acct_demo" }]);
	mocks.envelope.mockReturnValue(envelope);
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

describe("status HTML bootstrap", () => {
	it("seeds one authenticated read-only account and strips unknown fields", async () => {
		mocks.envelope.mockReturnValue({
			...envelope,
			internalOnly: "omit",
			accounts: [{ ...envelope.accounts[0], internalOnly: "omit" }],
		});
		expect(await readStatusBootstrap(request(authorized))).toEqual(envelope);
	});
	it.each([
		["missing token", {}, "GET"],
		["bad token", { "x-birdclaw-token": "wrong" }, "GET"],
		[
			"cross-origin",
			{ ...authorized, origin: "https://elsewhere.example" },
			"GET",
		],
		["cross-site", { ...authorized, "sec-fetch-site": "cross-site" }, "GET"],
		["write method", authorized, "POST"],
		[
			"unproven cookie origin",
			{ cookie: "birdclaw_token=synthetic-bootstrap-test" },
			"GET",
		],
	])("does not read the database for %s", async (_name, headers, method) => {
		expect(await readStatusBootstrap(request(headers, method))).toBeNull();
		expect(mocks.accounts).not.toHaveBeenCalled();
		expect(mocks.envelope).not.toHaveBeenCalled();
	});
	it("accepts the same-origin cookie authorization used by the status API", async () => {
		expect(
			await readStatusBootstrap(
				request({
					cookie: "birdclaw_token=synthetic-bootstrap-test",
					"sec-fetch-site": "same-origin",
				}),
			),
		).toEqual(envelope);
	});
	it("does no database work on writable deployments", async () => {
		vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "0");
		expect(await readStatusBootstrap(request(authorized))).toBeNull();
		expect(mocks.accounts).not.toHaveBeenCalled();
	});
	it.each([0, 2])("skips status counts for %i accounts", async (count) => {
		mocks.accounts.mockReturnValue(
			Array.from({ length: count }, () => ({ id: "demo" })),
		);
		expect(await readStatusBootstrap(request(authorized))).toBeNull();
		expect(mocks.envelope).not.toHaveBeenCalled();
	});
	it("falls back when the database is not ready", async () => {
		mocks.accounts.mockImplementation(() => {
			throw new Error("not ready");
		});
		expect(await readStatusBootstrap(request(authorized))).toBeNull();
	});
	it("falls back on malformed or newly multi-account status", async () => {
		mocks.envelope.mockReturnValue({ ...envelope, stats: { home: "invalid" } });
		expect(await readStatusBootstrap(request(authorized))).toBeNull();
		mocks.envelope.mockReturnValue({
			...envelope,
			accounts: [...envelope.accounts, ...envelope.accounts],
		});
		expect(await readStatusBootstrap(request(authorized))).toBeNull();
	});
	it("gives each document its own query cache and avoids another fresh status read", async () => {
		const initial = await readStatusBootstrap(request(authorized));
		const first = createBirdclawQueryClient(initial);
		const second = createBirdclawQueryClient();
		const fetch = vi.fn();
		expect(
			await first.fetchQuery({ queryKey: queryKeys.status, queryFn: fetch }),
		).toEqual(envelope);
		expect(fetch).not.toHaveBeenCalled();
		expect(second.getQueryData(queryKeys.status)).toBeUndefined();
		first.clear();
		second.clear();
	});
});
