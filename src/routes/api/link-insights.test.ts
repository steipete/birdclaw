// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const getLinkInsightsMock = vi.fn();
const maybeAutoUpdateBackupMock = vi.fn();

vi.mock("#/lib/link-insights", () => ({
	getLinkInsights: (...args: unknown[]) => getLinkInsightsMock(...args),
}));
vi.mock("#/lib/backup", () => ({
	requestBackupAutoUpdate: () => maybeAutoUpdateBackupMock(),
}));

import { Route } from "./link-insights";

const GET = getRouteHandler(Route, "GET");
afterEach(() => vi.unstubAllEnvs());

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
		expect(maybeAutoUpdateBackupMock).toHaveBeenCalledWith();
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
	it("recalculates rolling windows on repeated read-only requests", async () => {
		vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "1");
		let calls = 0;
		getLinkInsightsMock.mockImplementation(() => ({
			kind: "links",
			range: "week",
			sort: "rank",
			source: "all",
			since: null,
			until: `2026-09-13T00:00:0${calls++}.000Z`,
			items: [],
			stats: { occurrences: 0, groups: 0 },
		}));
		const request = () =>
			GET({
				request: new Request("http://localhost/api/link-insights?range=week"),
			});
		const first = await (await request()).json();
		const second = await (await request()).json();
		expect(first.until).not.toBe(second.until);
		expect(getLinkInsightsMock).toHaveBeenCalledTimes(2);
	});
});
