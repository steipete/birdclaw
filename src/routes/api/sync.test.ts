// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const runWebSyncMock = vi.fn();

vi.mock("#/lib/web-sync", async (importOriginal) => {
	const actual = await importOriginal<typeof import("#/lib/web-sync")>();
	return {
		...actual,
		runWebSync: (...args: unknown[]) => runWebSyncMock(...args),
	};
});

import { Route } from "./sync";

const POST = getRouteHandler(Route, "POST");

describe("api sync route", () => {
	beforeEach(() => {
		runWebSyncMock.mockReset();
	});

	it("runs a supported sync kind", async () => {
		runWebSyncMock.mockResolvedValue({
			ok: true,
			kind: "timeline",
			summary: "Synced 5 items",
			steps: [],
		});

		const response = await POST({
			request: new Request("http://localhost/api/sync", {
				method: "POST",
				body: JSON.stringify({ kind: "timeline" }),
			}),
		});

		expect(response.status).toBe(200);
		expect(runWebSyncMock).toHaveBeenCalledWith("timeline");
		expect(await response.json()).toMatchObject({
			ok: true,
			summary: "Synced 5 items",
		});
	});

	it("returns conflict while a matching sync is already running", async () => {
		runWebSyncMock.mockResolvedValue({
			ok: false,
			kind: "mentions",
			inProgress: true,
			summary: "Sync already running",
			steps: [],
		});

		const response = await POST({
			request: new Request("http://localhost/api/sync", {
				method: "POST",
				body: JSON.stringify({ kind: "mentions" }),
			}),
		});

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ inProgress: true });
	});

	it("rejects unknown sync kinds", async () => {
		const response = await POST({
			request: new Request("http://localhost/api/sync", {
				method: "POST",
				body: JSON.stringify({ kind: "blocks" }),
			}),
		});

		expect(response.status).toBe(400);
		expect(runWebSyncMock).not.toHaveBeenCalled();
	});
});
