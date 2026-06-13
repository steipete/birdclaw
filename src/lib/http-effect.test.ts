import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	jsonResponse,
	parseBoundedInteger,
	requestJsonEffect,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "./http-effect";

describe("http Effect helpers", () => {
	it("serializes json responses and preserves custom init headers", async () => {
		const response = jsonResponse(
			{ ok: true },
			{ status: 202, headers: { "x-test": "yes" } },
		);

		expect(response.status).toBe(202);
		expect(response.headers.get("content-type")).toBe("application/json");
		expect(response.headers.get("x-test")).toBe("yes");
		await expect(response.json()).resolves.toEqual({ ok: true });
	});

	it("preserves Headers instances passed through ResponseInit", () => {
		const response = jsonResponse(
			{ ok: true },
			{ headers: new Headers({ "cache-control": "no-store" }) },
		);

		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("content-type")).toBe("application/json");
	});

	it("parses request JSON through an Effect boundary", async () => {
		await expect(
			runRouteEffect(
				requestJsonEffect(
					new Request("http://localhost/api", {
						method: "POST",
						body: JSON.stringify({ kind: "sync" }),
					}),
				),
			),
		).resolves.toEqual({ kind: "sync" });
	});

	it("uses fallback JSON values when parsing fails", async () => {
		await expect(
			runRouteEffect(
				requestJsonEffect(
					new Request("http://localhost/api", {
						method: "POST",
						body: "{",
					}),
					{ kind: "fallback" },
				),
			),
		).resolves.toEqual({ kind: "fallback" });
	});

	it("fails JSON parsing when no fallback is supplied", async () => {
		await expect(
			runRouteEffect(
				requestJsonEffect(
					new Request("http://localhost/api", {
						method: "POST",
						body: "{",
					}),
				),
			),
		).rejects.toBeInstanceOf(Error);
	});

	it("runs arbitrary route effects", async () => {
		await expect(runRouteEffect(Effect.succeed("ok"))).resolves.toBe("ok");
	});

	it("bounds numeric and string integers", () => {
		expect(parseBoundedInteger(8, { defaultValue: 4, max: 20 })).toBe(8);
		expect(parseBoundedInteger("42", { defaultValue: 4, max: 20 })).toBe(20);
		expect(parseBoundedInteger("nope", { defaultValue: 4, max: 20 })).toBe(4);
	});

	it("allows default local API requests outside tests", () => {
		const originalNodeEnv = process.env.NODE_ENV;
		const originalVitest = process.env.VITEST;
		const originalToken = process.env.BIRDCLAW_WEB_TOKEN;
		const originalLocalWeb = process.env.BIRDCLAW_LOCAL_WEB;
		delete process.env.VITEST;
		process.env.NODE_ENV = "production";
		delete process.env.BIRDCLAW_WEB_TOKEN;
		process.env.BIRDCLAW_LOCAL_WEB = "1";

		try {
			expect(
				sensitiveRequestErrorResponse(
					new Request("http://localhost/api/action", {
						headers: { "sec-fetch-site": "same-origin" },
					}),
				),
			).toBeNull();
		} finally {
			if (originalNodeEnv === undefined) {
				delete process.env.NODE_ENV;
			} else {
				process.env.NODE_ENV = originalNodeEnv;
			}
			if (originalVitest === undefined) {
				delete process.env.VITEST;
			} else {
				process.env.VITEST = originalVitest;
			}
			if (originalToken === undefined) {
				delete process.env.BIRDCLAW_WEB_TOKEN;
			} else {
				process.env.BIRDCLAW_WEB_TOKEN = originalToken;
			}
			if (originalLocalWeb === undefined) {
				delete process.env.BIRDCLAW_LOCAL_WEB;
			} else {
				process.env.BIRDCLAW_LOCAL_WEB = originalLocalWeb;
			}
		}
	});

	it("does not trust localhost Host without local web mode", async () => {
		const originalNodeEnv = process.env.NODE_ENV;
		const originalVitest = process.env.VITEST;
		const originalToken = process.env.BIRDCLAW_WEB_TOKEN;
		const originalLocalWeb = process.env.BIRDCLAW_LOCAL_WEB;
		delete process.env.VITEST;
		process.env.NODE_ENV = "production";
		delete process.env.BIRDCLAW_WEB_TOKEN;
		delete process.env.BIRDCLAW_LOCAL_WEB;

		try {
			const response = sensitiveRequestErrorResponse(
				new Request("http://localhost/api/action", {
					headers: { "sec-fetch-site": "same-origin" },
				}),
			);

			expect(response?.status).toBe(403);
			await expect(response?.json()).resolves.toMatchObject({
				message: expect.stringContaining("Remote API access requires"),
			});
		} finally {
			if (originalNodeEnv === undefined) {
				delete process.env.NODE_ENV;
			} else {
				process.env.NODE_ENV = originalNodeEnv;
			}
			if (originalVitest === undefined) {
				delete process.env.VITEST;
			} else {
				process.env.VITEST = originalVitest;
			}
			if (originalToken === undefined) {
				delete process.env.BIRDCLAW_WEB_TOKEN;
			} else {
				process.env.BIRDCLAW_WEB_TOKEN = originalToken;
			}
			if (originalLocalWeb === undefined) {
				delete process.env.BIRDCLAW_LOCAL_WEB;
			} else {
				process.env.BIRDCLAW_LOCAL_WEB = originalLocalWeb;
			}
		}
	});

	it("does not trust forwarded localhost requests as local", async () => {
		const originalNodeEnv = process.env.NODE_ENV;
		const originalVitest = process.env.VITEST;
		const originalToken = process.env.BIRDCLAW_WEB_TOKEN;
		const originalLocalWeb = process.env.BIRDCLAW_LOCAL_WEB;
		delete process.env.VITEST;
		process.env.NODE_ENV = "production";
		delete process.env.BIRDCLAW_WEB_TOKEN;
		process.env.BIRDCLAW_LOCAL_WEB = "1";

		try {
			const response = sensitiveRequestErrorResponse(
				new Request("http://localhost/api/action", {
					headers: {
						"sec-fetch-site": "same-origin",
						"x-forwarded-for": "203.0.113.10",
					},
				}),
			);

			expect(response?.status).toBe(403);
			await expect(response?.json()).resolves.toMatchObject({
				message: expect.stringContaining("Remote API access requires"),
			});
		} finally {
			if (originalNodeEnv === undefined) {
				delete process.env.NODE_ENV;
			} else {
				process.env.NODE_ENV = originalNodeEnv;
			}
			if (originalVitest === undefined) {
				delete process.env.VITEST;
			} else {
				process.env.VITEST = originalVitest;
			}
			if (originalToken === undefined) {
				delete process.env.BIRDCLAW_WEB_TOKEN;
			} else {
				process.env.BIRDCLAW_WEB_TOKEN = originalToken;
			}
			if (originalLocalWeb === undefined) {
				delete process.env.BIRDCLAW_LOCAL_WEB;
			} else {
				process.env.BIRDCLAW_LOCAL_WEB = originalLocalWeb;
			}
		}
	});

	it("requires remote web opt-in for remote sensitive API requests outside tests", async () => {
		const originalNodeEnv = process.env.NODE_ENV;
		const originalVitest = process.env.VITEST;
		const originalToken = process.env.BIRDCLAW_WEB_TOKEN;
		delete process.env.VITEST;
		process.env.NODE_ENV = "production";
		delete process.env.BIRDCLAW_WEB_TOKEN;

		try {
			const response = sensitiveRequestErrorResponse(
				new Request("https://birdclaw.example/api/action"),
			);

			expect(response?.status).toBe(403);
			await expect(response?.json()).resolves.toMatchObject({
				message: expect.stringContaining("Remote API access requires"),
			});
		} finally {
			if (originalNodeEnv === undefined) {
				delete process.env.NODE_ENV;
			} else {
				process.env.NODE_ENV = originalNodeEnv;
			}
			if (originalVitest === undefined) {
				delete process.env.VITEST;
			} else {
				process.env.VITEST = originalVitest;
			}
			if (originalToken === undefined) {
				delete process.env.BIRDCLAW_WEB_TOKEN;
			} else {
				process.env.BIRDCLAW_WEB_TOKEN = originalToken;
			}
		}
	});

	it("accepts trusted remote private-proxy requests without a token", () => {
		const originalNodeEnv = process.env.NODE_ENV;
		const originalVitest = process.env.VITEST;
		const originalToken = process.env.BIRDCLAW_WEB_TOKEN;
		const originalAllowRemote = process.env.BIRDCLAW_ALLOW_REMOTE_WEB;
		const originalLocalWeb = process.env.BIRDCLAW_LOCAL_WEB;
		delete process.env.VITEST;
		process.env.NODE_ENV = "production";
		delete process.env.BIRDCLAW_WEB_TOKEN;
		process.env.BIRDCLAW_ALLOW_REMOTE_WEB = "1";
		delete process.env.BIRDCLAW_LOCAL_WEB;

		try {
			expect(
				sensitiveRequestErrorResponse(
					new Request("http://clawmac.sheep-coho.ts.net/api/action", {
						headers: {
							"sec-fetch-site": "same-origin",
							"x-forwarded-host": "clawmac.sheep-coho.ts.net",
							"x-forwarded-proto": "https",
						},
					}),
				),
			).toBeNull();
			expect(
				sensitiveRequestErrorResponse(
					new Request("http://clawmac.sheep-coho.ts.net/api/action", {
						headers: {
							"x-forwarded-host": "clawmac.sheep-coho.ts.net",
							"x-forwarded-proto": "https",
						},
					}),
				),
			).toBeNull();
			expect(
				sensitiveRequestErrorResponse(
					new Request("http://clawmac.sheep-coho.ts.net/api/action", {
						headers: { "sec-fetch-site": "cross-site" },
					}),
				)?.status,
			).toBe(403);
		} finally {
			if (originalNodeEnv === undefined) {
				delete process.env.NODE_ENV;
			} else {
				process.env.NODE_ENV = originalNodeEnv;
			}
			if (originalVitest === undefined) {
				delete process.env.VITEST;
			} else {
				process.env.VITEST = originalVitest;
			}
			if (originalToken === undefined) {
				delete process.env.BIRDCLAW_WEB_TOKEN;
			} else {
				process.env.BIRDCLAW_WEB_TOKEN = originalToken;
			}
			if (originalAllowRemote === undefined) {
				delete process.env.BIRDCLAW_ALLOW_REMOTE_WEB;
			} else {
				process.env.BIRDCLAW_ALLOW_REMOTE_WEB = originalAllowRemote;
			}
			if (originalLocalWeb === undefined) {
				delete process.env.BIRDCLAW_LOCAL_WEB;
			} else {
				process.env.BIRDCLAW_LOCAL_WEB = originalLocalWeb;
			}
		}
	});

	it("requires configured remote tokens even with trusted remote web enabled", () => {
		const originalNodeEnv = process.env.NODE_ENV;
		const originalVitest = process.env.VITEST;
		const originalToken = process.env.BIRDCLAW_WEB_TOKEN;
		const originalAllowRemote = process.env.BIRDCLAW_ALLOW_REMOTE_WEB;
		const originalLocalWeb = process.env.BIRDCLAW_LOCAL_WEB;
		delete process.env.VITEST;
		process.env.NODE_ENV = "production";
		process.env.BIRDCLAW_WEB_TOKEN = "secret";
		process.env.BIRDCLAW_ALLOW_REMOTE_WEB = "1";
		delete process.env.BIRDCLAW_LOCAL_WEB;

		try {
			expect(
				sensitiveRequestErrorResponse(
					new Request("http://clawmac.sheep-coho.ts.net/api/action", {
						headers: { "sec-fetch-site": "same-origin" },
					}),
				)?.status,
			).toBe(403);
			expect(
				sensitiveRequestErrorResponse(
					new Request("http://clawmac.sheep-coho.ts.net/api/action", {
						headers: {
							"sec-fetch-site": "same-origin",
							"x-birdclaw-token": "wrong",
						},
					}),
				)?.status,
			).toBe(403);
			expect(
				sensitiveRequestErrorResponse(
					new Request("http://clawmac.sheep-coho.ts.net/api/action", {
						headers: { "x-birdclaw-token": "secret" },
					}),
				),
			).toBeNull();
		} finally {
			if (originalNodeEnv === undefined) {
				delete process.env.NODE_ENV;
			} else {
				process.env.NODE_ENV = originalNodeEnv;
			}
			if (originalVitest === undefined) {
				delete process.env.VITEST;
			} else {
				process.env.VITEST = originalVitest;
			}
			if (originalToken === undefined) {
				delete process.env.BIRDCLAW_WEB_TOKEN;
			} else {
				process.env.BIRDCLAW_WEB_TOKEN = originalToken;
			}
			if (originalAllowRemote === undefined) {
				delete process.env.BIRDCLAW_ALLOW_REMOTE_WEB;
			} else {
				process.env.BIRDCLAW_ALLOW_REMOTE_WEB = originalAllowRemote;
			}
			if (originalLocalWeb === undefined) {
				delete process.env.BIRDCLAW_LOCAL_WEB;
			} else {
				process.env.BIRDCLAW_LOCAL_WEB = originalLocalWeb;
			}
		}
	});

	it("rejects cross-site local API requests without a token", async () => {
		const originalNodeEnv = process.env.NODE_ENV;
		const originalVitest = process.env.VITEST;
		const originalToken = process.env.BIRDCLAW_WEB_TOKEN;
		delete process.env.VITEST;
		process.env.NODE_ENV = "production";
		delete process.env.BIRDCLAW_WEB_TOKEN;

		try {
			const response = sensitiveRequestErrorResponse(
				new Request("http://localhost/api/action", {
					headers: { "sec-fetch-site": "cross-site" },
				}),
			);

			expect(response?.status).toBe(403);
			await expect(response?.json()).resolves.toMatchObject({
				message: "Cross-site web API access is disabled",
			});
		} finally {
			if (originalNodeEnv === undefined) {
				delete process.env.NODE_ENV;
			} else {
				process.env.NODE_ENV = originalNodeEnv;
			}
			if (originalVitest === undefined) {
				delete process.env.VITEST;
			} else {
				process.env.VITEST = originalVitest;
			}
			if (originalToken === undefined) {
				delete process.env.BIRDCLAW_WEB_TOKEN;
			} else {
				process.env.BIRDCLAW_WEB_TOKEN = originalToken;
			}
		}
	});

	it("accepts valid local web tokens and keeps remote access opt-in", () => {
		const originalNodeEnv = process.env.NODE_ENV;
		const originalVitest = process.env.VITEST;
		const originalToken = process.env.BIRDCLAW_WEB_TOKEN;
		const originalAllowRemote = process.env.BIRDCLAW_ALLOW_REMOTE_WEB;
		const originalLocalWeb = process.env.BIRDCLAW_LOCAL_WEB;
		delete process.env.VITEST;
		process.env.NODE_ENV = "production";
		process.env.BIRDCLAW_WEB_TOKEN = "secret";
		process.env.BIRDCLAW_LOCAL_WEB = "1";
		delete process.env.BIRDCLAW_ALLOW_REMOTE_WEB;

		try {
			expect(
				sensitiveRequestErrorResponse(
					new Request("http://localhost/api/action", {
						headers: { "sec-fetch-site": "same-origin" },
					}),
				),
			).toBeNull();
			expect(
				sensitiveRequestErrorResponse(
					new Request("http://localhost/api/action", {
						headers: { "x-birdclaw-token": "secret" },
					}),
				),
			).toBeNull();
			expect(
				sensitiveRequestErrorResponse(
					new Request("https://birdclaw.example/api/action", {
						headers: { "x-birdclaw-token": "secret" },
					}),
				)?.status,
			).toBe(403);

			process.env.BIRDCLAW_ALLOW_REMOTE_WEB = "1";
			expect(
				sensitiveRequestErrorResponse(
					new Request("https://birdclaw.example/api/action", {
						headers: { "x-birdclaw-token": "secret" },
					}),
				),
			).toBeNull();
		} finally {
			if (originalNodeEnv === undefined) {
				delete process.env.NODE_ENV;
			} else {
				process.env.NODE_ENV = originalNodeEnv;
			}
			if (originalVitest === undefined) {
				delete process.env.VITEST;
			} else {
				process.env.VITEST = originalVitest;
			}
			if (originalToken === undefined) {
				delete process.env.BIRDCLAW_WEB_TOKEN;
			} else {
				process.env.BIRDCLAW_WEB_TOKEN = originalToken;
			}
			if (originalAllowRemote === undefined) {
				delete process.env.BIRDCLAW_ALLOW_REMOTE_WEB;
			} else {
				process.env.BIRDCLAW_ALLOW_REMOTE_WEB = originalAllowRemote;
			}
			if (originalLocalWeb === undefined) {
				delete process.env.BIRDCLAW_LOCAL_WEB;
			} else {
				process.env.BIRDCLAW_LOCAL_WEB = originalLocalWeb;
			}
		}
	});

	it("accepts tokened same-origin requests through forwarded https proxies", () => {
		const originalNodeEnv = process.env.NODE_ENV;
		const originalVitest = process.env.VITEST;
		const originalToken = process.env.BIRDCLAW_WEB_TOKEN;
		const originalAllowRemote = process.env.BIRDCLAW_ALLOW_REMOTE_WEB;
		const originalLocalWeb = process.env.BIRDCLAW_LOCAL_WEB;
		delete process.env.VITEST;
		process.env.NODE_ENV = "production";
		process.env.BIRDCLAW_WEB_TOKEN = "secret";
		process.env.BIRDCLAW_ALLOW_REMOTE_WEB = "1";
		delete process.env.BIRDCLAW_LOCAL_WEB;

		try {
			expect(
				sensitiveRequestErrorResponse(
					new Request("http://clawmac.sheep-coho.ts.net/api/action", {
						headers: {
							origin: "https://clawmac.sheep-coho.ts.net",
							"x-birdclaw-token": "secret",
							"x-forwarded-host": "clawmac.sheep-coho.ts.net",
							"x-forwarded-proto": "https",
						},
					}),
				),
			).toBeNull();
			expect(
				sensitiveRequestErrorResponse(
					new Request("http://clawmac.sheep-coho.ts.net/api/action", {
						headers: {
							origin: "https://evil.example",
							"x-birdclaw-token": "secret",
							"x-forwarded-host": "clawmac.sheep-coho.ts.net",
							"x-forwarded-proto": "https",
						},
					}),
				)?.status,
			).toBe(403);
		} finally {
			if (originalNodeEnv === undefined) {
				delete process.env.NODE_ENV;
			} else {
				process.env.NODE_ENV = originalNodeEnv;
			}
			if (originalVitest === undefined) {
				delete process.env.VITEST;
			} else {
				process.env.VITEST = originalVitest;
			}
			if (originalToken === undefined) {
				delete process.env.BIRDCLAW_WEB_TOKEN;
			} else {
				process.env.BIRDCLAW_WEB_TOKEN = originalToken;
			}
			if (originalAllowRemote === undefined) {
				delete process.env.BIRDCLAW_ALLOW_REMOTE_WEB;
			} else {
				process.env.BIRDCLAW_ALLOW_REMOTE_WEB = originalAllowRemote;
			}
			if (originalLocalWeb === undefined) {
				delete process.env.BIRDCLAW_LOCAL_WEB;
			} else {
				process.env.BIRDCLAW_LOCAL_WEB = originalLocalWeb;
			}
		}
	});

	it("treats malformed token cookies as invalid credentials", async () => {
		const originalNodeEnv = process.env.NODE_ENV;
		const originalVitest = process.env.VITEST;
		const originalToken = process.env.BIRDCLAW_WEB_TOKEN;
		delete process.env.VITEST;
		process.env.NODE_ENV = "production";
		process.env.BIRDCLAW_WEB_TOKEN = "secret";

		try {
			const response = sensitiveRequestErrorResponse(
				new Request("http://localhost/api/action", {
					headers: { cookie: "birdclaw_token=%" },
				}),
			);

			expect(response?.status).toBe(403);
			await expect(response?.json()).resolves.toMatchObject({
				message: "Invalid web token",
			});
		} finally {
			if (originalNodeEnv === undefined) {
				delete process.env.NODE_ENV;
			} else {
				process.env.NODE_ENV = originalNodeEnv;
			}
			if (originalVitest === undefined) {
				delete process.env.VITEST;
			} else {
				process.env.VITEST = originalVitest;
			}
			if (originalToken === undefined) {
				delete process.env.BIRDCLAW_WEB_TOKEN;
			} else {
				process.env.BIRDCLAW_WEB_TOKEN = originalToken;
			}
		}
	});
});
