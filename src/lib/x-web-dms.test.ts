// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./subprocess", async () => ({
	...(await vi.importActual<typeof import("./subprocess")>("./subprocess")),
	runSubprocessEffect: () =>
		Effect.fail(new Error("External CLIs are disabled in native DM tests")),
}));

const auth = "synthetic-auth-cookie-".repeat(2);
const csrf = "synthetic-csrf-cookie-".repeat(2);
const bearer = "AAAAAA" + "SyntheticPublicWebToken".repeat(3);
const account = {
	accountId: "acct_fixture",
	username: "fixture",
	externalUserId: "123",
};
const requests: Array<{ url: URL; init: RequestInit }> = [];
let home = "";
let identity: Record<string, unknown>;
let initial: Record<string, unknown>;
let next: Record<string, unknown>;
let mutation: () => Response;

function message(id: string, conversationId: string, body: string) {
	return {
		message: {
			id,
			conversation_id: conversationId,
			time: "1789250000000",
			message_data: { text: body, sender_id: "7", recipient_id: "123" },
		},
	};
}

beforeEach(() => {
	vi.resetModules();
	home = mkdtempSync(path.join(os.tmpdir(), "birdclaw-native-dms-"));
	vi.stubEnv("BIRDCLAW_HOME", home);
	vi.stubEnv("AUTH_TOKEN", auth);
	vi.stubEnv("CT0", csrf);
	vi.stubEnv("BIRDCLAW_DISABLE_LIVE_WRITES", "0");
	vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "0");
	requests.length = 0;
	identity = { user_id: "123", screen_name: "fixture", name: "Fixture" };
	initial = {
		inbox_initial_state: {
			users: {
				"123": { screen_name: "fixture", name: "Fixture" },
				"7": { screen_name: "sender", name: "Sender" },
			},
			conversations: {
				"123-7": {
					conversation_id: "123-7",
					trusted: false,
					participants: [{ user_id: "123" }, { user_id: "7" }],
				},
			},
			entries: [message("100", "123-7", "native request message")],
			inbox_timelines: {
				untrusted: { status: "HAS_MORE", min_entry_id: "100" },
				trusted: { status: "AT_END" },
			},
		},
	};
	next = {
		inbox_timeline: {
			status: "AT_END",
			entries: [
				message("99", "123-7", "older native request"),
				message("100", "123-7", "native request message"),
			],
		},
	};
	mutation = () => Response.json({});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL, init: RequestInit = {}) => {
			const url = new URL(String(input));
			requests.push({ url, init });
			if (url.href === "https://x.com/")
				return new Response(
					'<script src="https://abs.twimg.com/responsive-web/client-web/main.fixture.js"></script>',
				);
			if (url.hostname === "abs.twimg.com")
				return new Response(
					'const bearer="' +
						bearer +
						'";const query={params:{id:"base-fixture-viewer",metadata:{},name:"viewerQuery"}};',
				);
			if (url.pathname.includes("/graphql/"))
				return Response.json({
					data: {
						viewer: {
							user_results: {
								result: {
									user: {
										rest_id: identity.user_id,
										core: {
											screen_name: identity.screen_name,
											name: identity.name,
										},
									},
								},
							},
						},
					},
				});
			if (init.method === "POST") return mutation();
			if (url.pathname.endsWith("inbox_initial_state.json"))
				return Response.json(initial);
			if (url.pathname.includes("inbox_timeline")) return Response.json(next);
			throw new Error("Unexpected fixture request");
		}),
	);
});

afterEach(async () => {
	(await import("./db")).resetDatabaseForTests();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

describe("native X web DMs", () => {
	it.each([null, true, "invalid", []])(
		"rejects malformed inbox containers: %j",
		async (value) => {
			const { readWebDirectMessages } = await import("./x-web-dms");
			initial = { inbox_initial_state: value };
			await expect(
				readWebDirectMessages({ account, limit: 20 }),
			).rejects.toThrow("invalid DM inbox");
		},
	);
	it.each([null, true, "invalid", []])(
		"rejects malformed timeline containers: %j",
		async (value) => {
			const { readWebDirectMessages } = await import("./x-web-dms");
			next = { inbox_timeline: value };
			await expect(
				readWebDirectMessages({
					account,
					limit: 20,
					inbox: "requests",
					maxPages: 1,
				}),
			).rejects.toThrow("invalid DM timeline");
		},
	);

	it("keeps cookies out of serialization and requires identity before private operations", async () => {
		const { XWebSession } = await import("./x-web");
		const session = new XWebSession();
		expect(JSON.stringify(session)).not.toContain(auth);
		expect(JSON.stringify(session)).not.toContain(csrf);
		await expect(
			session.json("/i/api/1.1/dm/inbox_initial_state.json"),
		).rejects.toThrow("Verify the X web account");
		await expect(
			session.json(
				"/i/api/1.1/blocks/create.json",
				new URLSearchParams({ user_id: "7" }),
			),
		).rejects.toThrow("Verify the X web account");
		expect(requests).toHaveLength(0);
	});
	it("discovers the current module-based client and verifies its authenticated Viewer", async () => {
		const ordinaryFetch = fetch;
		const viewers: Array<{ url: URL; authorization: string | null }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL, init: RequestInit = {}) => {
				const url = new URL(String(input));
				if (url.href === "https://x.com/")
					return new Response(
						'<script src="https://abs.twimg.com/x-web/x-web/entry-client.js"></script>',
					);
				if (url.pathname.endsWith("/entry-client.js"))
					return new Response(
						'import "./assets/guest-token.js";import "./assets/viewer-query.js";import "https://other.example/unsafe.js";',
					);
				if (url.pathname.endsWith("/guest-token.js"))
					return new Response('const header="Bearer ' + bearer + '%2F";');
				if (url.pathname.endsWith("/viewer-query.js"))
					return new Response(
						'const query={params:{id:"fixture-viewer-query",metadata:{},name:"viewerQuery"}};',
					);
				if (url.pathname.includes("/graphql/")) {
					viewers.push({
						url,
						authorization: new Headers(init.headers).get("authorization"),
					});
					return Response.json({
						data: {
							viewer: {
								user_results: {
									result: {
										rest_id: "123",
										core: { screen_name: "fixture", name: "Fixture" },
									},
								},
							},
						},
					});
				}
				if (url.hostname === "other.example")
					throw new Error("Must not fetch an untrusted module");
				return ordinaryFetch(input, init);
			}),
		);
		const { readWebDirectMessages } = await import("./x-web-dms");
		await expect(
			readWebDirectMessages({ account, limit: 1, inbox: "requests" }),
		).resolves.toMatchObject({
			authenticated: { id: "123" },
			payload: { events: [{ id: "100", isMessageRequest: true }] },
		});
		expect(viewers).toHaveLength(1);
		expect(viewers[0].url.pathname).toBe(
			"/i/api/graphql/fixture-viewer-query/viewerQuery",
		);
		expect(JSON.parse(viewers[0].url.searchParams.get("variables")!)).toEqual({
			__relay_internal__pv__appviewerisloggedinprovider: true,
		});
		expect(viewers[0].authorization).toBe("Bearer " + bearer + "%2F");
	});

	it("fails closed when no current public client metadata can be discovered", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						'<script src="https://other.example/client.js"></script>',
					),
			),
		);
		const { readWebDirectMessages } = await import("./x-web-dms");
		await expect(readWebDirectMessages({ account, limit: 1 })).rejects.toThrow(
			"Could not discover X web authentication",
		);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("preserves profile and request metadata across sparse pages", async () => {
		next = {
			inbox_timeline: {
				status: "AT_END",
				users: { "7": { id_str: "7" } },
				conversations: { "123-7": { conversation_id: "123-7", trusted: null } },
				entries: [message("99", "123-7", "older request")],
			},
		};
		const { readWebDirectMessages } = await import("./x-web-dms");
		const result = await readWebDirectMessages({
			account,
			limit: 5,
			inbox: "requests",
			maxPages: 1,
		});
		expect(result.payload.conversations[0]).toMatchObject({
			inboxKind: "request",
			participants: expect.arrayContaining([
				expect.objectContaining({
					id: "7",
					username: "sender",
					name: "Sender",
				}),
			]),
		});
		expect(result.payload.events).toHaveLength(2);
	});

	it("filters accepted conversations and refuses invalid pagination inputs", async () => {
		const { readWebDirectMessages } = await import("./x-web-dms");
		await expect(
			readWebDirectMessages({ account, limit: 5, inbox: "accepted" }),
		).resolves.toMatchObject({ payload: { events: [], conversations: [] } });
		requests.length = 0;
		for (const options of [
			{ limit: 0 },
			{ limit: 1, maxPages: -1 },
			{ limit: 1, pageDelayMs: -1 },
		])
			await expect(
				readWebDirectMessages({ account, ...options }),
			).rejects.toThrow("pagination options");
		expect(requests).toHaveLength(0);
	});
	it("reads request pages, preserves request state, and deduplicates events without a CLI", async () => {
		const { readWebDirectMessages } = await import("./x-web-dms");
		const result = await readWebDirectMessages({
			account,
			limit: 5,
			inbox: "requests",
			maxPages: 1,
		});
		expect(result.authenticated).toMatchObject({
			id: "123",
			username: "fixture",
		});
		expect(result.payload.events.map((event) => event.id).sort()).toEqual([
			"100",
			"99",
		]);
		expect(result.payload.conversations[0]).toMatchObject({
			id: "123-7",
			inboxKind: "request",
			isMessageRequest: true,
			participants: [
				{ id: "123", username: "fixture" },
				{ id: "7", username: "sender" },
			],
		});
		expect(
			requests
				.find((request) => request.url.pathname.includes("inbox_timeline"))
				?.url.searchParams.get("max_id"),
		).toBe("100");
		for (const request of requests) {
			expect(request.init.redirect).toBe("manual");
			const headers = new Headers(request.init.headers);
			const api = request.url.pathname.startsWith("/i/api/");
			expect(headers.get("cookie")).toBe(
				api ? `auth_token=${auth}; ct0=${csrf}` : null,
			);
			expect(headers.get("x-csrf-token")).toBe(api ? csrf : null);
			expect(headers.get("authorization")).toBe(
				api ? "Bearer " + bearer : null,
			);
		}
	});

	it("merges native requests into the existing store through auto mode", async () => {
		const { getNativeDb } = await import("./db");
		getNativeDb()
			.prepare(
				"insert into accounts(id,name,handle,external_user_id,transport,is_default,created_at) values(?,?,?,?,?,?, '2026-01-01T00:00:00Z')",
			)
			.run(account.accountId, "Fixture", account.username, "123", "xurl", 1);
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");
		await expect(
			syncDirectMessagesViaCachedBird({
				account: account.accountId,
				inbox: "requests",
				limit: 5,
				refresh: true,
			}),
		).resolves.toMatchObject({ ok: true, source: "web", messages: 1 });
		expect(
			getNativeDb()
				.prepare("select inbox_kind from dm_conversations where id=?")
				.get("123-7"),
		).toEqual({ inbox_kind: "request" });
	});

	it("uses native all-inbox reads when cookies are configured", async () => {
		const { getNativeDb } = await import("./db");
		getNativeDb()
			.prepare(
				"insert into accounts(id,name,handle,external_user_id,transport,is_default,created_at) values(?,?,?,?,?,?, '2026-01-01T00:00:00Z')",
			)
			.run(account.accountId, "Fixture", account.username, "123", "xurl", 1);
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");
		await expect(
			syncDirectMessagesViaCachedBird({
				account: account.accountId,
				limit: 5,
				refresh: true,
			}),
		).resolves.toMatchObject({ ok: true, source: "web", messages: 1 });
	});

	it("refuses a cookie account mismatch before reading private messages", async () => {
		identity = { user_id: "999", screen_name: "other" };
		const { readWebDirectMessages } = await import("./x-web-dms");
		await expect(readWebDirectMessages({ account, limit: 5 })).rejects.toThrow(
			"refusing to sync",
		);
		expect(
			requests.some((request) => request.url.pathname.includes("/dm/")),
		).toBe(false);
	});

	it("rejects repeated cursors instead of returning partial data as complete", async () => {
		next = {
			inbox_timeline: { status: "HAS_MORE", min_entry_id: "100", entries: [] },
		};
		const { readWebDirectMessages } = await import("./x-web-dms");
		await expect(
			readWebDirectMessages({
				account,
				limit: 5,
				inbox: "requests",
				maxPages: 2,
			}),
		).rejects.toThrow("repeated a cursor");
	});

	it.each(["accept", "reject"] as const)(
		"performs %s natively without replaying the POST",
		async (action) => {
			mutation = () => new Response(null, { status: 204 });
			const { mutateWebDirectMessage } = await import("./x-web-dms");
			await expect(
				mutateWebDirectMessage({ account, conversationId: "123-7", action }),
			).resolves.toMatchObject({ success: true, conversationId: "123-7" });
			const writes = requests.filter(
				(request) => request.init.method === "POST",
			);
			expect(writes).toHaveLength(1);
			expect(writes[0].url.pathname).toBe(
				`/i/api/1.1/dm/conversation/123-7/${action === "accept" ? "accept" : "delete"}.json`,
			);
			expect(writes[0].init.body).toBe("conversation_id=123-7");
		},
	);

	it.each([
		() => Response.json({ success: false }),
		() => Response.json({ errors: [{ message: auth }] }),
		() => new Response("<html>login</html>"),
		() => new Response(csrf, { status: 403 }),
	])(
		"does not accept false, error, HTML, or HTTP failure responses",
		async (failure) => {
			mutation = failure;
			const { mutateWebDirectMessage } = await import("./x-web-dms");
			const error = await mutateWebDirectMessage({
				account,
				conversationId: "123-7",
				action: "accept",
			}).catch((error) => error);
			expect(error).toBeInstanceOf(Error);
			expect(String(error)).not.toContain(auth);
			expect(String(error)).not.toContain(csrf);
			expect(
				requests.filter((request) => request.init.method === "POST"),
			).toHaveLength(1);
		},
	);

	it("does not follow credential-bearing redirects", async () => {
		mutation = () =>
			new Response(null, {
				status: 302,
				headers: { location: "https://other.example/collect" },
			});
		const { mutateWebDirectMessage } = await import("./x-web-dms");
		await expect(
			mutateWebDirectMessage({
				account,
				conversationId: "123-7",
				action: "accept",
			}),
		).rejects.toThrow("HTTP 302");
		expect(
			requests.every((request) =>
				["x.com", "abs.twimg.com"].includes(request.url.hostname),
			),
		).toBe(true);
	});

	it("verifies participant blocks and rejects ambiguous targets", async () => {
		mutation = () => Response.json({ id_str: "7", blocking: true });
		const { mutateWebDirectMessage } = await import("./x-web-dms");
		await expect(
			mutateWebDirectMessage({
				account,
				conversationId: "123-7",
				action: "block",
				targetUserId: "7",
			}),
		).resolves.toMatchObject({ success: true, blockedUserId: "7" });
		await expect(
			mutateWebDirectMessage({
				account,
				conversationId: "123-7",
				action: "block",
				targetUserId: "8",
			}),
		).rejects.toThrow("ambiguous");
		expect(
			requests.filter((request) => request.init.method === "POST"),
		).toHaveLength(1);
	});

	it("honors disabled writes and read-only deployment before any network work", async () => {
		vi.stubEnv("BIRDCLAW_DISABLE_LIVE_WRITES", "1");
		const { mutateWebDirectMessage, readWebDirectMessages } =
			await import("./x-web-dms");
		await expect(
			mutateWebDirectMessage({
				account,
				conversationId: "123-7",
				action: "accept",
			}),
		).resolves.toEqual({ success: false, error: "live writes disabled" });
		vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "1");
		await expect(readWebDirectMessages({ account, limit: 1 })).rejects.toThrow(
			"read-only",
		);
		expect(requests).toHaveLength(0);
	});

	it("rejects invalid credentials and ids without exposing or sending them", async () => {
		vi.stubEnv("AUTH_TOKEN", auth + "\r\nunsafe");
		const { mutateWebDirectMessage, readWebDirectMessages } =
			await import("./x-web-dms");
		await expect(readWebDirectMessages({ account, limit: 1 })).rejects.toThrow(
			"requires valid AUTH_TOKEN and CT0",
		);
		await expect(
			mutateWebDirectMessage({
				account,
				conversationId: "../other",
				action: "accept",
			}),
		).rejects.toThrow("Invalid X DM");
		expect(requests).toHaveLength(0);
	});
});
