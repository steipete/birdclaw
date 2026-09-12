// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const queryResourceMock = vi.fn();
const maybeAutoUpdateBackupMock = vi.fn();

vi.mock("#/lib/query-resource", () => ({
	queryResource: (...args: unknown[]) => queryResourceMock(...args),
}));
vi.mock("#/lib/backup", () => ({
	requestBackupAutoUpdate: () => maybeAutoUpdateBackupMock(),
}));

import { Route } from "./query";

const GET = getRouteHandler(Route, "GET");

describe("api query route", () => {
	afterEach(() => vi.unstubAllEnvs());
	it("authorizes before accessing cached query responses", async () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("VITEST", "false");
		vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "1");
		vi.stubEnv("BIRDCLAW_ALLOW_REMOTE_WEB", "1");
		vi.stubEnv("BIRDCLAW_WEB_TOKEN", "synthetic-query-cache-test");
		const response = await GET({
			request: new Request("https://archive.example/api/query?resource=home"),
		});
		expect(response.status).toBe(403);
		expect(queryResourceMock).not.toHaveBeenCalled();
		expect(maybeAutoUpdateBackupMock).not.toHaveBeenCalled();
	});

	beforeEach(() => {
		queryResourceMock.mockReset();
		maybeAutoUpdateBackupMock.mockReset();
		maybeAutoUpdateBackupMock.mockResolvedValue({ skipped: true });
	});

	it("parses dm filters", async () => {
		queryResourceMock.mockReturnValue({ resource: "dms", items: [] });
		const response = await GET({
			request: new Request(
				"http://localhost/api/query?resource=dms&inbox=requests&replyFilter=unreplied&minFollowers=10&minInfluenceScore=90&sort=followers",
			),
		});

		expect(queryResourceMock).toHaveBeenCalledWith(
			"dms",
			expect.objectContaining({
				replyFilter: "unreplied",
				minFollowers: 10,
				minInfluenceScore: 90,
				sort: "followers",
				inbox: "requests",
			}),
		);
		expect(response.status).toBe(200);
	});

	it("accepts the legacy dm influence sort as followers", async () => {
		queryResourceMock.mockReturnValue({ resource: "dms", items: [] });
		await GET({
			request: new Request(
				"http://localhost/api/query?resource=dms&sort=influence",
			),
		});

		expect(queryResourceMock).toHaveBeenCalledWith(
			"dms",
			expect.objectContaining({
				sort: "followers",
			}),
		);
	});

	it("defaults invalid reply filters to all", async () => {
		queryResourceMock.mockReturnValue({ resource: "home", items: [] });
		await GET({
			request: new Request(
				"http://localhost/api/query?resource=home&replyFilter=bad&since=2020-01-01&until=2021-01-01&qualityFilter=summary&originalsOnly=true",
			),
		});

		expect(queryResourceMock).toHaveBeenCalledWith(
			"home",
			expect.objectContaining({
				replyFilter: "all",
				resource: "home",
				since: "2020-01-01",
				until: "2021-01-01",
				includeReplies: false,
				qualityFilter: "summary",
			}),
		);
	});

	it("drops invalid numeric filters and defaults sort", async () => {
		queryResourceMock.mockReturnValue({ resource: "dms", items: [] });
		await GET({
			request: new Request(
				"http://localhost/api/query?resource=dms&minFollowers=wat&maxFollowers=33&maxInfluenceScore=nope&sort=bad",
			),
		});

		expect(queryResourceMock).toHaveBeenCalledWith(
			"dms",
			expect.objectContaining({
				minFollowers: undefined,
				maxFollowers: 33,
				maxInfluenceScore: undefined,
				inbox: "all",
				sort: "recent",
			}),
		);
	});

	it("defaults to home when resource is omitted", async () => {
		queryResourceMock.mockReturnValue({ resource: "home", items: [] });

		await GET({
			request: new Request("http://localhost/api/query"),
		});

		expect(queryResourceMock).toHaveBeenCalledWith(
			"home",
			expect.objectContaining({
				resource: "home",
			}),
		);
	});

	it("rejects invalid resources before querying", async () => {
		const response = await GET({
			request: new Request("http://localhost/api/query?resource=unknown"),
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			message: "Invalid query resource",
		});
		expect(queryResourceMock).not.toHaveBeenCalled();
		expect(maybeAutoUpdateBackupMock).not.toHaveBeenCalled();
	});
});
