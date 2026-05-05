import { describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const mocks = vi.hoisted(() => ({
	maybeAutoUpdateBackup: vi.fn(),
	getQueryEnvelope: vi.fn(),
}));

vi.mock("#/lib/backup", () => ({
	maybeAutoUpdateBackup: mocks.maybeAutoUpdateBackup,
}));

vi.mock("#/lib/queries", () => ({
	getQueryEnvelope: mocks.getQueryEnvelope,
}));

import { Route } from "./status";

const GET = getRouteHandler(Route, "GET");

describe("status api route", () => {
	it("returns the query envelope as json", async () => {
		mocks.maybeAutoUpdateBackup.mockResolvedValue(undefined);
		mocks.getQueryEnvelope.mockResolvedValue({
			stats: { home: 4, mentions: 2, dms: 4, needsReply: 2, inbox: 4 },
			accounts: [{ id: "acct_primary" }],
			archives: [{ path: "/tmp/archive.zip" }],
			transport: { statusText: "xurl available" },
		});

		const response = await GET({
			request: new Request("http://birdclaw.test/api/status"),
		});

		await expect(response.json()).resolves.toEqual({
			stats: { home: 4, mentions: 2, dms: 4, needsReply: 2, inbox: 4 },
			accounts: [{ id: "acct_primary" }],
			archives: [{ path: "/tmp/archive.zip" }],
			transport: { statusText: "xurl available" },
		});
		expect(mocks.maybeAutoUpdateBackup).toHaveBeenCalledTimes(1);
		expect(response.headers.get("content-type")).toBe("application/json");
	});
});
