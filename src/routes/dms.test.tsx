import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/components/DmWorkspace", () => ({
	DmWorkspace: ({
		selectedConversation,
		replyDraft,
		onReplyDraftChange,
		onReplySend,
	}: {
		selectedConversation: { id: string; title: string } | null;
		replyDraft: string;
		onReplyDraftChange: (value: string) => void;
		onReplySend: (id: string) => void;
	}) => (
		<div>
			<div>{selectedConversation?.title ?? "none"}</div>
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

import { Route } from "./dms";

const DmsRoute = Route.options.component as ComponentType;

describe("dms route", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
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
					return new Response(JSON.stringify({ ok: true }));
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

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/action",
				expect.objectContaining({ method: "POST" }),
			);
		});
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
		fireEvent.click(screen.getByRole("button", { name: "Sync DMs" }));

		await waitFor(() => {
			expect(syncBodies).toEqual([{ kind: "dms" }]);
			expect(queryUrls.at(-1)?.searchParams.get("refresh")).toBe("1");
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
