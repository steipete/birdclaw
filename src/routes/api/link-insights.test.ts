// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const getLinkInsightsMock = vi.fn();
const maybeAutoUpdateBackupMock = vi.fn();

vi.mock("#/lib/link-insights", () => ({
	getLinkInsights: (...args: unknown[]) => getLinkInsightsMock(...args),
}));
vi.mock("#/lib/backup", () => ({
	maybeAutoUpdateBackup: () => maybeAutoUpdateBackupMock(),
}));

import { Route } from "./link-insights";

const GET = getRouteHandler(Route, "GET");

describe("api link insights route", () => {
	beforeEach(() => {
		getLinkInsightsMock.mockReset();
		maybeAutoUpdateBackupMock.mockReset();
		maybeAutoUpdateBackupMock.mockResolvedValue({ skipped: true });
		getLinkInsightsMock.mockReturnValue({
			kind: "links",
			range: "week",
			sort: "rank",
			source: "all",
			since: null,
			until: null,
			items: [],
			stats: { occurrences: 0, groups: 0 },
		});
	});

	it("parses kind, range, source, dates, and limits", async () => {
		const response = await GET({
			request: new Request(
				"http://localhost/api/link-insights?kind=videos&range=today&sort=comments&source=dm&since=2026-05-01&until=2026-05-11&limit=12&commentsLimit=3",
			),
		});

		expect(getLinkInsightsMock).toHaveBeenCalledWith({
			kind: "videos",
			range: "today",
			sort: "comments",
			source: "dm",
			since: "2026-05-01",
			until: "2026-05-11",
			limit: 12,
			commentsLimit: 3,
		});
		expect(response.status).toBe(200);
	});

	it("defaults invalid filters", async () => {
		await GET({
			request: new Request(
				"http://localhost/api/link-insights?kind=nope&range=bad&source=else&limit=nah",
			),
		});

		expect(getLinkInsightsMock).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "links",
				range: "week",
				sort: "rank",
				source: "all",
				limit: undefined,
			}),
		);
	});
});
