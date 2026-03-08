// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const getBlocksResponseMock = vi.fn();

vi.mock("#/lib/blocks", () => ({
	getBlocksResponse: (...args: unknown[]) => getBlocksResponseMock(...args),
}));

import { Route } from "./blocks";

describe("api blocks route", () => {
	it("parses account, search, and limit", async () => {
		getBlocksResponseMock.mockReturnValue({ items: [], matches: [] });

		const response = await Route.options.server.handlers.GET({
			request: new Request(
				"http://localhost/api/blocks?account=acct_primary&search=amelia&limit=9",
			),
		});

		expect(getBlocksResponseMock).toHaveBeenCalledWith({
			accountId: "acct_primary",
			search: "amelia",
			limit: 9,
		});
		expect(response.status).toBe(200);
	});

	it("defaults invalid limits", async () => {
		getBlocksResponseMock.mockReturnValue({ items: [], matches: [] });

		await Route.options.server.handlers.GET({
			request: new Request("http://localhost/api/blocks?limit=wat"),
		});

		expect(getBlocksResponseMock).toHaveBeenCalledWith({
			accountId: undefined,
			search: undefined,
			limit: 12,
		});
	});
});
