// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const resolveProfilesForHandlesMock = vi.fn();

vi.mock("#/lib/profile-resolver", () => ({
	resolveProfilesForHandles: (...args: unknown[]) =>
		resolveProfilesForHandlesMock(...args),
}));

import { Route } from "./profile-hydrate";

const GET = getRouteHandler(Route, "GET");

describe("api profile hydrate route", () => {
	beforeEach(() => {
		resolveProfilesForHandlesMock.mockReset();
		resolveProfilesForHandlesMock.mockResolvedValue([
			{ handle: "fcoury", status: "hit", source: "bird" },
			{ handle: "bad", status: "miss", source: "xurl" },
		]);
	});

	it("hydrates clean handles and returns counts", async () => {
		const response = await GET({
			request: new Request(
				"http://localhost/api/profile-hydrate?handles=@fcoury,bad!,jxnLco&handle=fcoury",
			),
		});

		expect(resolveProfilesForHandlesMock).toHaveBeenCalledWith([
			"fcoury",
			"jxnLco",
		]);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			ok: true,
			hydratedProfiles: 1,
		});
	});

	it("rejects empty handle requests", async () => {
		const response = await GET({
			request: new Request("http://localhost/api/profile-hydrate"),
		});

		expect(response.status).toBe(400);
		expect(resolveProfilesForHandlesMock).not.toHaveBeenCalled();
	});
});
