// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const getCookiesMock = vi.fn();

vi.mock("@steipete/sweet-cookie", () => ({
	getCookies: getCookiesMock,
}));

describe("x-web transport", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.unstubAllGlobals();
		getCookiesMock.mockReset();
		delete process.env.AUTH_TOKEN;
		delete process.env.TWITTER_AUTH_TOKEN;
		delete process.env.CT0;
		delete process.env.TWITTER_CT0;
	});

	it("blocks users with env cookies", async () => {
		process.env.AUTH_TOKEN = " auth ";
		process.env.CT0 = " csrf ";
		const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const { blockUserViaXWeb } = await import("./x-web");

		await expect(blockUserViaXWeb("42")).resolves.toEqual({
			ok: true,
			output: "x-web block ok via env",
		});
		expect(getCookiesMock).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledWith(
			"https://x.com/i/api/1.1/blocks/create.json",
			expect.objectContaining({
				method: "POST",
				body: expect.any(URLSearchParams),
				headers: expect.objectContaining({
					cookie: "auth_token=auth; ct0=csrf",
					"x-csrf-token": "csrf",
				}),
			}),
		);
	});

	it("unblocks users with browser cookies and prefers x.com over twitter.com", async () => {
		getCookiesMock.mockResolvedValue({
			cookies: [
				{ name: "auth_token", value: "twitter-auth", domain: ".twitter.com" },
				{ name: "ct0", value: "twitter-ct0", domain: ".twitter.com" },
				{ name: "auth_token", value: "x-auth", domain: ".x.com" },
				{ name: "ct0", value: "x-ct0", domain: ".x.com" },
			],
		});
		const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const { unblockUserViaXWeb } = await import("./x-web");

		await expect(unblockUserViaXWeb("42")).resolves.toEqual({
			ok: true,
			output: "x-web unblock ok via browser",
		});
		expect(getCookiesMock).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://x.com/",
				mode: "merge",
				names: ["auth_token", "ct0"],
			}),
		);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://x.com/i/api/1.1/blocks/destroy.json",
			expect.objectContaining({
				headers: expect.objectContaining({
					cookie: "auth_token=x-auth; ct0=x-ct0",
					"x-csrf-token": "x-ct0",
				}),
			}),
		);
	});

	it("reports missing cookies without calling fetch", async () => {
		getCookiesMock.mockResolvedValue({
			cookies: [{ name: "auth_token", value: "auth", domain: ".x.com" }],
		});
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const { blockUserViaXWeb } = await import("./x-web");

		await expect(blockUserViaXWeb("42")).resolves.toEqual({
			ok: false,
			output: "x-web block unavailable: missing auth_token/ct0 cookies",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns the response body for failed requests", async () => {
		process.env.TWITTER_AUTH_TOKEN = "auth";
		process.env.TWITTER_CT0 = "csrf";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("denied".repeat(80), { status: 403 })),
		);
		const { blockUserViaXWeb } = await import("./x-web");

		const result = await blockUserViaXWeb("42");

		expect(result.ok).toBe(false);
		expect(result.output).toContain("x-web block failed (403): denied");
		expect(result.output.length).toBeLessThan(290);
	});

	it("reports fetch errors", async () => {
		process.env.AUTH_TOKEN = "auth";
		process.env.CT0 = "csrf";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network down");
			}),
		);
		const { unblockUserViaXWeb } = await import("./x-web");

		await expect(unblockUserViaXWeb("42")).resolves.toEqual({
			ok: false,
			output: "x-web unblock failed: network down",
		});
	});
});
