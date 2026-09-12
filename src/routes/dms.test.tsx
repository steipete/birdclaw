import {
	act,
	cleanup,
	fireEvent,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQueryClient as render } from "#/test/render";
import { queryKeys } from "#/lib/query-client";

vi.mock("#/components/DmWorkspace", () => ({
	DmWorkspace: ({
		selectedConversation,
		selectedMessages,
		conversations,
		replyDraft,
		onReplyDraftChange,
		onReplySend,
		onSelectConversation,
	}: {
		selectedConversation: { id: string; title: string } | null;
		selectedMessages: Array<{ id: string; text: string }>;
		conversations: Array<{ id: string; title: string }>;
		replyDraft: string;
		onReplyDraftChange: (value: string) => void;
		onReplySend: (id: string) => void;
		onSelectConversation: (id: string) => void;
	}) => (
		<div>
			{conversations.map((conversation) => (
				<button
					key={conversation.id}
					onClick={() => onSelectConversation(conversation.id)}
					type="button"
				>
					{conversation.title}
				</button>
			))}
			{selectedMessages.map((message) => (
				<div key={message.id}>{message.text}</div>
			))}
			<input
				aria-label="draft"
				onChange={(event) => onReplyDraftChange(event.target.value)}
				value={replyDraft}
			/>
			<button
				onClick={() =>
					selectedConversation && onReplySend(selectedConversation.id)
				}
				type="button"
			>
				send dm
			</button>
		</div>
	),
}));

import { DmsRouteView as DmsRoute } from "./dms";

describe("dms route", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		window.localStorage.clear();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("loads dms and posts an inline reply", async () => {
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/api/status")) {
					return new Response(
						JSON.stringify({
							stats: { home: 3, mentions: 1, dms: 4, needsReply: 2, inbox: 3 },
							transport: { statusText: "local" },
							accounts: [
								{
									id: "acct_primary",
									handle: "@steipete",
									name: "Peter",
									isDefault: true,
								},
								{
									id: "acct_openclaw",
									handle: "@openclaw",
									name: "OpenClaw",
									isDefault: false,
								},
							],
							archives: [],
						}),
					);
				}
				if (url.includes("/api/query")) {
					return new Response(
						JSON.stringify({
							resource: "dms",
							items: [
								{
									id: "dm_1",
									title: "Sam Altman",
									accountId: "acct_primary",
									accountHandle: "@steipete",
								},
							],
							selectedConversation: {
								conversation: {
									id: "dm_1",
									title: "Sam Altman",
									accountId: "acct_primary",
									accountHandle: "@steipete",
								},
								messages: [],
							},
						}),
					);
				}
				if (url.endsWith("/api/action") && init?.method === "POST") {
					return new Response(JSON.stringify({ ok: true }));
				}
				throw new Error(`Unexpected fetch ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		window.localStorage.setItem("birdclaw:selected-account-id", "acct_primary");

		render(<DmsRoute />);

		expect(await screen.findByText("Sam Altman")).toBeInTheDocument();
		await waitFor(() => {
			const latestQuery = fetchMock.mock.calls
				.map(([input]) => String(input))
				.filter((url) => url.includes("/api/query"))
				.at(-1);
			expect(latestQuery).toContain("account=acct_primary");
		});
		const sendButton = await screen.findByRole("button", { name: "send dm" });
		fireEvent.change(screen.getByLabelText("draft"), {
			target: { value: "Need details" },
		});
		fireEvent.click(sendButton);

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/action",
				expect.objectContaining({ method: "POST" }),
			);
		});
	});

	it("reuses the initial conversation response and only fetches when selection changes", async () => {
		const conversations = [
			{
				id: "dm_a",
				title: "Demo A",
				accountId: "acct_demo",
				accountHandle: "@demo",
			},
			{
				id: "dm_b",
				title: "Demo B",
				accountId: "acct_demo",
				accountHandle: "@demo",
			},
		];
		const queries: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), window.location.origin);
				if (url.pathname === "/api/status")
					return Response.json({
						stats: { home: 0, mentions: 0, dms: 2, needsReply: 0, inbox: 0 },
						transport: { statusText: "local" },
						accounts: [],
						archives: [],
					});
				queries.push(url.searchParams.get("conversationId") ?? "default");
				const conversation =
					conversations.find(
						(item) => item.id === url.searchParams.get("conversationId"),
					) ?? conversations[0]!;
				return Response.json({
					resource: "dms",
					items: conversations,
					selectedConversation: {
						conversation,
						messages: [
							{
								id: `message_${conversation.id}`,
								text: `Message for ${conversation.title}`,
							},
						],
					},
				});
			}),
		);
		render(<DmsRoute />);
		expect(await screen.findByText("Message for Demo A")).toBeInTheDocument();
		expect(queries).toEqual(["default"]);
		fireEvent.click(screen.getByRole("button", { name: "Demo B" }));
		expect(await screen.findByText("Message for Demo B")).toBeInTheDocument();
		expect(queries).toEqual(["default", "dm_b"]);
		fireEvent.click(screen.getByRole("button", { name: "Demo A" }));
		expect(await screen.findByText("Message for Demo A")).toBeInTheDocument();
		expect(queries).toEqual(["default", "dm_b"]);
	});

	it("lets the dm list switch from newest to follower count sorting", async () => {
		const queryUrls: URL[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) {
				return new Response(
					JSON.stringify({
						stats: { home: 3, mentions: 1, dms: 4, needsReply: 2, inbox: 3 },
						transport: { statusText: "local" },
						accounts: [],
						archives: [],
					}),
				);
			}
			if (url.includes("/api/query")) {
				queryUrls.push(new URL(url));
				return new Response(
					JSON.stringify({
						resource: "dms",
						items: [
							{
								id: "dm_1",
								title: "Sam Altman",
								accountId: "acct_primary",
								accountHandle: "@steipete",
							},
						],
						selectedConversation: {
							conversation: {
								id: "dm_1",
								title: "Sam Altman",
								accountId: "acct_primary",
								accountHandle: "@steipete",
							},
							messages: [],
						},
					}),
				);
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<DmsRoute />);

		expect(await screen.findByText("Sam Altman")).toBeInTheDocument();
		await waitFor(() => {
			expect(queryUrls.at(-1)?.searchParams.get("sort")).toBe("recent");
		});

		fireEvent.click(screen.getByRole("button", { name: "Followers" }));

		await waitFor(() => {
			expect(queryUrls.at(-1)?.searchParams.get("sort")).toBe("followers");
		});
		const callsBeforeCachedReturn = queryUrls.length;

		fireEvent.click(screen.getByRole("button", { name: "Newest" }));

		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: "Newest" }).className,
			).toContain("bg-[var(--bg-active)]");
		});
		expect(queryUrls).toHaveLength(callsBeforeCachedReturn);
	});

	it("restores dm draft and shows transport errors", async () => {
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/api/status")) {
					return new Response(
						JSON.stringify({
							stats: { home: 3, mentions: 1, dms: 4, needsReply: 2, inbox: 3 },
							transport: { statusText: "local" },
							accounts: [],
							archives: [],
						}),
					);
				}
				if (url.includes("/api/query")) {
					return new Response(
						JSON.stringify({
							resource: "dms",
							items: [
								{
									id: "dm_1",
									title: "Sam Altman",
									accountId: "acct_primary",
									accountHandle: "@steipete",
								},
							],
							selectedConversation: {
								conversation: {
									id: "dm_1",
									title: "Sam Altman",
									accountId: "acct_primary",
									accountHandle: "@steipete",
								},
								messages: [],
							},
						}),
					);
				}
				if (url.endsWith("/api/action") && init?.method === "POST") {
					return new Response(JSON.stringify({ message: "dm denied" }), {
						status: 500,
					});
				}
				throw new Error(`Unexpected fetch ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		render(<DmsRoute />);

		expect(await screen.findByText("Sam Altman")).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("draft"), {
			target: { value: "Need details" },
		});
		fireEvent.click(screen.getByRole("button", { name: "send dm" }));

		expect(await screen.findByText("dm denied")).toBeInTheDocument();
		expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe(
			"Need details",
		);
	});

	it("keeps the selected conversation visible while refreshing it", async () => {
		let queryCalls = 0;
		let releaseRefresh: (() => void) | undefined;
		const dmResponse = {
			resource: "dms",
			items: [
				{
					id: "dm_1",
					title: "Sam Altman",
					accountId: "acct_primary",
					accountHandle: "@steipete",
				},
			],
			selectedConversation: {
				conversation: {
					id: "dm_1",
					title: "Sam Altman",
					accountId: "acct_primary",
					accountHandle: "@steipete",
				},
				messages: [],
			},
		};
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) {
				return new Response(
					JSON.stringify({
						stats: { home: 3, mentions: 1, dms: 4, needsReply: 2, inbox: 3 },
						transport: { statusText: "local" },
						accounts: [],
						archives: [],
					}),
				);
			}
			if (url.includes("/api/query")) {
				queryCalls += 1;
				if (queryCalls === 2) {
					await new Promise<void>((resolve) => {
						releaseRefresh = resolve;
					});
				}
				return new Response(JSON.stringify(dmResponse));
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const { queryClient } = render(<DmsRoute />);

		expect(await screen.findByText("Sam Altman")).toBeInTheDocument();
		await act(async () => {
			void queryClient.invalidateQueries({ queryKey: queryKeys.dms });
		});
		await waitFor(() => {
			expect(queryCalls).toBeGreaterThan(1);
		});
		expect(screen.getByRole("button", { name: "send dm" })).toBeInTheDocument();

		releaseRefresh?.();
	});

	it("hides stale thread content while switching conversations", async () => {
		let releaseSwitch: (() => void) | undefined;
		const conversations = [
			{
				id: "dm_1",
				title: "Sam Altman",
				accountId: "acct_primary",
				accountHandle: "@steipete",
			},
			{
				id: "dm_2",
				title: "Ada Lovelace",
				accountId: "acct_primary",
				accountHandle: "@steipete",
			},
		];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) {
				return new Response(
					JSON.stringify({
						stats: { home: 3, mentions: 1, dms: 4, needsReply: 2, inbox: 3 },
						transport: { statusText: "local" },
						accounts: [],
						archives: [],
					}),
				);
			}
			if (url.includes("/api/query")) {
				const requestUrl = new URL(url);
				const conversationId = requestUrl.searchParams.get("conversationId");
				if (conversationId === "dm_2") {
					await new Promise<void>((resolve) => {
						releaseSwitch = resolve;
					});
				}
				const selectedId = conversationId ?? "dm_1";
				return new Response(
					JSON.stringify({
						resource: "dms",
						items: conversations,
						selectedConversation: {
							conversation: conversations.find(
								(conversation) => conversation.id === selectedId,
							),
							messages: [
								{
									id: `message_${selectedId}`,
									text:
										selectedId === "dm_1"
											? "Old thread message"
											: "New thread message",
								},
							],
						},
					}),
				);
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<DmsRoute />);

		expect(await screen.findByText("Old thread message")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Ada Lovelace" }));
		expect(await screen.findByText("Loading messages")).toBeInTheDocument();
		expect(screen.queryByText("Old thread message")).not.toBeInTheDocument();

		releaseSwitch?.();
		expect(await screen.findByText("New thread message")).toBeInTheDocument();
	});

	it("shows a retryable error when switching conversations fails", async () => {
		const conversations = [
			{
				id: "dm_1",
				title: "Sam Altman",
				accountId: "acct_primary",
				accountHandle: "@steipete",
			},
			{
				id: "dm_2",
				title: "Ada Lovelace",
				accountId: "acct_primary",
				accountHandle: "@steipete",
			},
		];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) {
				return Response.json({
					stats: { home: 3, mentions: 1, dms: 4, needsReply: 2, inbox: 3 },
					transport: { statusText: "local" },
					accounts: [],
					archives: [],
				});
			}
			if (url.includes("/api/query")) {
				const conversationId = new URL(url).searchParams.get("conversationId");
				if (conversationId === "dm_2") {
					return Response.json(
						{ message: "Conversation unavailable" },
						{ status: 500 },
					);
				}
				return Response.json({
					resource: "dms",
					items: conversations,
					selectedConversation: {
						conversation: conversations[0],
						messages: [{ id: "message_dm_1", text: "Old thread message" }],
					},
				});
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<DmsRoute />);

		expect(await screen.findByText("Old thread message")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Ada Lovelace" }));

		expect(
			await screen.findByText("Could not load messages"),
		).toBeInTheDocument();
		expect(screen.getByText("Conversation unavailable")).toBeInTheDocument();
		expect(screen.queryByText("Old thread message")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
	});

	it("runs a live dm sync and reloads conversations", async () => {
		const queryUrls: URL[] = [];
		const syncBodies: unknown[] = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/api/status")) {
					return new Response(
						JSON.stringify({
							stats: { home: 3, mentions: 1, dms: 4, needsReply: 2, inbox: 3 },
							transport: { statusText: "local" },
							accounts: [],
							archives: [],
						}),
					);
				}
				if (url.includes("/api/query")) {
					queryUrls.push(new URL(url));
					return new Response(
						JSON.stringify({
							resource: "dms",
							items: [
								{
									id: "dm_1",
									title: "Sam Altman",
									accountId: "acct_primary",
									accountHandle: "@steipete",
								},
							],
							selectedConversation: {
								conversation: {
									id: "dm_1",
									title: "Sam Altman",
									accountId: "acct_primary",
									accountHandle: "@steipete",
								},
								messages: [],
							},
						}),
					);
				}
				if (url.endsWith("/api/sync") && init?.body) {
					syncBodies.push(JSON.parse(String(init.body)));
					return new Response(
						JSON.stringify({
							id: "sync_dms_1",
							kind: "dms",
							status: "succeeded",
							startedAt: "2026-05-15T12:00:00.000Z",
							summary: "Synced 9 items",
							inProgress: false,
							result: {
								ok: true,
								kind: "dms",
								summary: "Synced 9 items",
								steps: [],
							},
						}),
					);
				}
				throw new Error(`Unexpected fetch ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		render(<DmsRoute />);

		expect(await screen.findByText("Sam Altman")).toBeInTheDocument();
		expect(queryUrls).toHaveLength(1);
		const initialQueryCount = queryUrls.length;
		fireEvent.click(screen.getByRole("button", { name: "Sync DMs" }));

		await waitFor(() => {
			expect(syncBodies).toEqual([
				{ kind: "dms", inbox: "all", limit: 50, maxPages: 1 },
			]);
			expect(queryUrls.length).toBeGreaterThan(initialQueryCount);
			expect(queryUrls.at(-1)?.searchParams.get("conversationId")).toBe("dm_1");
		});
	});

	it("filters and syncs the selected dm inbox lane", async () => {
		const queryUrls: URL[] = [];
		const syncBodies: unknown[] = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/api/status")) {
					return new Response(
						JSON.stringify({
							stats: { home: 3, mentions: 1, dms: 4, needsReply: 2, inbox: 3 },
							transport: { statusText: "local" },
							accounts: [],
							archives: [],
						}),
					);
				}
				if (url.includes("/api/query")) {
					queryUrls.push(new URL(url));
					return new Response(
						JSON.stringify({
							resource: "dms",
							items: [
								{
									id: "dm_request",
									title: "Request sender",
									accountId: "acct_primary",
									accountHandle: "@steipete",
								},
							],
							selectedConversation: {
								conversation: {
									id: "dm_request",
									title: "Request sender",
									accountId: "acct_primary",
									accountHandle: "@steipete",
								},
								messages: [],
							},
						}),
					);
				}
				if (url.endsWith("/api/sync") && init?.body) {
					syncBodies.push(JSON.parse(String(init.body)));
					return new Response(
						JSON.stringify({
							id: "sync_dms_1",
							kind: "dms",
							status: "succeeded",
							startedAt: "2026-05-15T12:00:00.000Z",
							summary: "Synced 9 items",
							inProgress: false,
							result: {
								ok: true,
								kind: "dms",
								summary: "Synced 9 items",
								steps: [],
							},
						}),
					);
				}
				throw new Error(`Unexpected fetch ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		render(<DmsRoute />);

		await screen.findByText("Request sender");
		fireEvent.click(screen.getByRole("button", { name: "Requests" }));

		await waitFor(() => {
			expect(queryUrls.at(-1)?.searchParams.get("inbox")).toBe("requests");
			expect(queryUrls.at(-1)?.searchParams.get("account")).toBeNull();
		});

		fireEvent.click(screen.getByRole("button", { name: "Sync DMs" }));

		await waitFor(() => {
			expect(syncBodies.at(-1)).toEqual({
				kind: "dms",
				inbox: "requests",
				limit: 200,
				maxPages: 3,
			});
		});
	});

	it("shows an explicit empty state when no conversations match", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) {
				return new Response(
					JSON.stringify({
						stats: { home: 3, mentions: 1, dms: 0, needsReply: 0, inbox: 1 },
						transport: { statusText: "local" },
						accounts: [],
						archives: [],
					}),
				);
			}
			if (url.includes("/api/query")) {
				return new Response(
					JSON.stringify({
						resource: "dms",
						items: [],
						selectedConversation: null,
					}),
				);
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<DmsRoute />);

		expect(
			await screen.findByText("No conversations in this view"),
		).toBeInTheDocument();
	});

	it("shows a retryable error when conversations fail to load", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) {
				return new Response(
					JSON.stringify({
						stats: { home: 3, mentions: 1, dms: 4, needsReply: 2, inbox: 3 },
						transport: { statusText: "local" },
						accounts: [],
						archives: [],
					}),
				);
			}
			if (url.includes("/api/query")) {
				return new Response(
					JSON.stringify({ message: "DM store unavailable" }),
					{
						status: 500,
					},
				);
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<DmsRoute />);

		expect(
			await screen.findByText("Could not load messages"),
		).toBeInTheDocument();
		expect(screen.getByText("DM store unavailable")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(3);
		});
	});
});
