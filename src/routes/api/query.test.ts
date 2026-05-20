// @vitest-environment node
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const queryResourceMock = vi.fn();
const maybeAutoUpdateBackupMock = vi.fn();

vi.mock("#/lib/queries", () => ({
	queryResource: (...args: unknown[]) => queryResourceMock(...args),
}));
vi.mock("#/lib/backup", () => ({
	maybeAutoUpdateBackup: () => maybeAutoUpdateBackupMock(),
	maybeAutoUpdateBackupEffect: () =>
		Effect.promise(() => Promise.resolve(maybeAutoUpdateBackupMock())),
}));

import { Route } from "./query";

const GET = getRouteHandler(Route, "GET");

describe("api query route", () => {
	beforeEach(() => {
		queryResourceMock.mockReset();
		maybeAutoUpdateBackupMock.mockReset();
		maybeAutoUpdateBackupMock.mockResolvedValue({ skipped: true });
	});

	it("parses dm filters", async () => {
		queryResourceMock.mockReturnValue({ resource: "dms", items: [] });
		const response = await GET({
			request: new Request(
				"http://localhost/api/query?resource=dms&replyFilter=unreplied&minFollowers=10&minInfluenceScore=90&sort=followers",
			),
		});

		expect(queryResourceMock).toHaveBeenCalledWith(
			"dms",
			expect.objectContaining({
				replyFilter: "unreplied",
				minFollowers: 10,
				minInfluenceScore: 90,
				sort: "followers",
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
});
