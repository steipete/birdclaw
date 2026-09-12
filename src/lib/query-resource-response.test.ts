// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeSqliteDatabase } from "./sqlite";
const mocks = vi.hoisted(() => ({ query: vi.fn(), db: vi.fn() }));
vi.mock("./query-resource", () => ({ queryResource: mocks.query }));
vi.mock("./db", () => ({ getReadDb: mocks.db }));
import { queryResourceResponse } from "./query-resource-response";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});
describe("query response reuse", () => {
	it("bypasses caching and database lookups on writable deployments", async () => {
		vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "0");
		mocks.query.mockReturnValue({ resource: "home", items: [] });
		await queryResourceResponse("home", {}).text();
		await queryResourceResponse("home", {}).text();
		expect(mocks.query).toHaveBeenCalledTimes(2);
		expect(mocks.db).not.toHaveBeenCalled();
	});
	it("caches only schema-validated JSON and returns independent responses", async () => {
		const db = new NativeSqliteDatabase(":memory:");
		mocks.db.mockReturnValue(db);
		vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "1");
		try {
			mocks.query.mockReturnValue({ resource: "invalid", items: [] });
			expect(() => queryResourceResponse("home", {})).toThrow(/Invalid/);
			mocks.query.mockReturnValue({
				resource: "home",
				items: [],
				extra: "omit",
			});
			const first = queryResourceResponse("home", {}),
				second = queryResourceResponse("home", {});
			expect(first).not.toBe(second);
			expect(await first.json()).toEqual({ resource: "home", items: [] });
			expect(await second.json()).toEqual({ resource: "home", items: [] });
			expect(mocks.query).toHaveBeenCalledTimes(2);
			expect(second.headers.get("cache-control")).toBeNull();
		} finally {
			db.close();
		}
	});
});
