// @vitest-environment node
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const view = vi.hoisted(() => vi.fn());
const full = vi.hoisted(() => vi.fn());
vi.mock("#/lib/network-map-view", () => ({ getNetworkMapViewEffect: view }));
vi.mock("#/lib/network-map", () => ({ getNetworkMap: full }));
vi.mock("#/lib/backup", () => ({ requestBackupAutoUpdate: vi.fn() }));
import { Route } from "./network-map";
const GET = getRouteHandler(Route, "GET");
const data = {
	features: [],
	markers: [],
	visibleProfiles: 0,
	matchingProfiles: 0,
	offset: 0,
	pageSize: 160,
	meta: {
		accountId: "demo",
		type: "followers",
		totalProfiles: 0,
		profilesWithLocation: 0,
		meaningfulProfiles: 0,
		locatedProfiles: 0,
		missingGeocodes: 0,
		geocodedThisRun: 0,
		suppressedGeocodes: 0,
		opencageConfigured: false,
		mapboxTokenConfigured: false,
	},
	config: { mapboxToken: null },
};
afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});
it("parses a bounded map viewport with account, search and page", async () => {
	view.mockReturnValue(Effect.succeed(data));
	const response = await GET({
		request: new Request(
			"http://localhost/api/network-map?format=view&type=followers&account=demo&bounds=170,-40,-170,60&zoom=4.5&q=person&offset=160",
		),
	});
	expect(response.status).toBe(200);
	expect(view).toHaveBeenCalledWith(
		expect.objectContaining({
			account: "demo",
			type: "followers",
			viewport: { bounds: [170, -40, -170, 60], zoom: 4.5 },
			search: "person",
			offset: 160,
			refresh: false,
		}),
	);
	expect(full).not.toHaveBeenCalled();
});
it.each([
	"bounds=1,2,3",
	"bounds=,2,3,4",
	"bounds=0,60,20,40",
	"bounds=0,-91,20,80",
	"bounds=NaN,0,20,40",
	"zoom=Infinity",
	"zoom=-1",
])("rejects invalid viewport %s", async (query) => {
	const response = await GET({
		request: new Request(
			`http://localhost/api/network-map?format=view&${query}`,
		),
	});
	expect(response.status).toBe(400);
	expect(view).not.toHaveBeenCalled();
});
it("retains the full GeoJSON API for existing callers", async () => {
	full.mockResolvedValue({ ...data, type: "FeatureCollection" });
	const response = await GET({
		request: new Request(
			"http://localhost/api/network-map?type=followers&limit=9",
		),
	});
	expect(response.status).toBe(200);
	expect(full).toHaveBeenCalledWith(
		expect.objectContaining({ type: "followers", limit: 9 }),
	);
	expect(view).not.toHaveBeenCalled();
});
it("keeps view requests behind the archive authentication boundary", async () => {
	vi.stubEnv("NODE_ENV", "production");
	vi.stubEnv("VITEST", "false");
	vi.stubEnv("BIRDCLAW_WEB_TOKEN", "test-secret");
	const response = await GET({
		request: new Request("https://archive.example/api/network-map?format=view"),
	});
	expect(response.status).toBe(403);
	expect(view).not.toHaveBeenCalled();
});

it("accepts multiple wrapped world copies when panning", async () => {
	view.mockReturnValue(Effect.succeed(data));
	const response = await GET({
		request: new Request(
			"http://localhost/api/network-map?format=view&bounds=1250,-80,1270,80&zoom=4",
		),
	});
	expect(response.status).toBe(200);
	expect(view).toHaveBeenCalledWith(
		expect.objectContaining({
			viewport: { bounds: [1250, -80, 1270, 80], zoom: 4 },
		}),
	);
});
