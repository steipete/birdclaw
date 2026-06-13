import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const mocks = vi.hoisted(() => ({
	maybeAutoUpdateBackup: vi.fn(),
	getQueryEnvelope: vi.fn(),
	getPublicQueryEnvelope: vi.fn(),
}));

vi.mock("#/lib/backup", () => ({
	maybeAutoUpdateBackup: mocks.maybeAutoUpdateBackup,
	maybeAutoUpdateBackupEffect: () =>
		Effect.promise(() => Promise.resolve(mocks.maybeAutoUpdateBackup())),
}));

vi.mock("#/lib/queries", () => ({
	getQueryEnvelope: mocks.getQueryEnvelope,
	getQueryEnvelopeEffect: () =>
		Effect.promise(() => Promise.resolve(mocks.getQueryEnvelope())),
	getPublicQueryEnvelopeEffect: () =>
		Effect.promise(() => Promise.resolve(mocks.getPublicQueryEnvelope())),
}));

import { Route } from "./status";

const GET = getRouteHandler(Route, "GET");

describe("status api route", () => {
	beforeEach(() => {
		mocks.maybeAutoUpdateBackup.mockReset();
		mocks.getQueryEnvelope.mockReset();
		mocks.getPublicQueryEnvelope.mockReset();
	});

	it("returns the query envelope as json", async () => {
		mocks.maybeAutoUpdateBackup.mockResolvedValue(undefined);
		mocks.getQueryEnvelope.mockResolvedValue({
			stats: { home: 4, mentions: 2, dms: 4, needsReply: 2, inbox: 4 },
			accounts: [{ id: "acct_primary" }],
			archives: [{ path: "/tmp/archive.zip" }],
			transport: { statusText: "xurl available" },
		});

		const response = await GET({
			request: new Request("http://localhost/api/status"),
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

	it("returns only public counts in public read-only mode", async () => {
		const originalProfile = process.env.BIRDCLAW_WEB_PROFILE;
		process.env.BIRDCLAW_WEB_PROFILE = "public-readonly";
		mocks.getPublicQueryEnvelope.mockResolvedValue({
			stats: { home: 4, mentions: 2, dms: 0, needsReply: 0, inbox: 0 },
			accounts: [],
			archives: [],
			transport: {
				installed: false,
				availableTransport: "local",
				statusText: "Read-only archive",
			},
		});

		try {
			const response = await GET({
				request: new Request("http://localhost/api/status"),
			});

			await expect(response.json()).resolves.toEqual({
				stats: { home: 4, mentions: 2, dms: 0, needsReply: 0, inbox: 0 },
				accounts: [],
				archives: [],
				transport: {
					installed: false,
					availableTransport: "local",
					statusText: "Read-only archive",
				},
			});
			expect(mocks.getQueryEnvelope).not.toHaveBeenCalled();
			expect(mocks.maybeAutoUpdateBackup).not.toHaveBeenCalled();
		} finally {
			if (originalProfile === undefined) {
				delete process.env.BIRDCLAW_WEB_PROFILE;
			} else {
				process.env.BIRDCLAW_WEB_PROFILE = originalProfile;
			}
		}
	});
});
