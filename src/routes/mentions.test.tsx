import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/components/TimelineCard", () => ({
	TimelineCard: ({
		item,
		onReply,
	}: {
		item: { id: string; text: string };
		onReply: (tweetId: string) => void;
	}) => (
		<button onClick={() => onReply(item.id)} type="button">
			{item.text}
		</button>
	),
}));

import { Route } from "./mentions";

const MentionsRoute = Route.options.component as ComponentType;

describe("mentions route", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	it("loads mentions and sends a reply", async () => {
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
							resource: "mentions",
							items: [
								{
									id: "tweet_4",
									text: "@steipete curious...",
								},
							],
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
		vi.spyOn(window, "prompt").mockReturnValue("Answering");

		render(<MentionsRoute />);

		expect(await screen.findByText("@steipete curious...")).toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("button", { name: "@steipete curious..." }),
		);

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/action",
				expect.objectContaining({ method: "POST" }),
			);
		});
	});

	it("trims search terms, changes reply filters, and ignores blank replies", async () => {
		const queryUrls: URL[] = [];
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
							resource: "mentions",
							items: [{ id: "mention_search", text: "@steipete signal" }],
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
		vi.spyOn(window, "prompt").mockReturnValue("");

		render(<MentionsRoute />);

		expect(await screen.findByText("@steipete signal")).toBeInTheDocument();
		fireEvent.change(screen.getByPlaceholderText("Search mentions"), {
			target: { value: "  thread  " },
		});
		fireEvent.click(screen.getByRole("button", { name: "All" }));

		await waitFor(() => {
			const queryUrl = queryUrls.at(-1);
			expect(queryUrl?.searchParams.get("search")).toBe("thread");
			expect(queryUrl?.searchParams.get("replyFilter")).toBe("all");
		});

		fireEvent.click(screen.getByRole("button", { name: "@steipete signal" }));
		expect(fetchMock).not.toHaveBeenCalledWith(
			"/api/action",
			expect.anything(),
		);
	});

	it("runs a live mentions sync and reloads local data", async () => {
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
							resource: "mentions",
							items: [{ id: "mention_sync", text: "@steipete fresh" }],
						}),
					);
				}
				if (url.endsWith("/api/sync") && init?.body) {
					syncBodies.push(JSON.parse(String(init.body)));
					return new Response(
						JSON.stringify({
							id: "sync_mentions_1",
							kind: "mentions",
							status: "succeeded",
							startedAt: "2026-05-15T12:00:00.000Z",
							summary: "Synced 7 items",
							inProgress: false,
							result: {
								ok: true,
								kind: "mentions",
								summary: "Synced 7 items",
								steps: [],
							},
						}),
					);
				}
				throw new Error(`Unexpected fetch ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		render(<MentionsRoute />);

		expect(await screen.findByText("@steipete fresh")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Sync mentions" }));

		await waitFor(() => {
			expect(syncBodies).toEqual([{ kind: "mentions" }]);
			expect(queryUrls.at(-1)?.searchParams.get("refresh")).toBe("1");
		});
		expect(screen.getByText("Synced 7 items")).toBeInTheDocument();
	});

	it("shows a retryable error when mentions loading fails", async () => {
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
				throw new Error("Mentions store unavailable");
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<MentionsRoute />);

		expect(
			await screen.findByText("Could not load mentions"),
		).toBeInTheDocument();
		expect(screen.getByText("Mentions store unavailable")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(3);
		});
	});
});
