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

import { Route } from "./index";

const HomeRoute = Route.options.component as ComponentType;

describe("home route", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	it("loads timeline items and posts replies", async () => {
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/api/status")) {
					return new Response(
						JSON.stringify({
							stats: { home: 3, mentions: 2, dms: 4, needsReply: 2, inbox: 4 },
							transport: { statusText: "local" },
							accounts: [],
							archives: [],
						}),
					);
				}
				if (url.includes("/api/query")) {
					return new Response(
						JSON.stringify({
							resource: "home",
							items: [
								{
									id: "tweet_1",
									text: "Ship it",
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
		vi.spyOn(window, "prompt").mockReturnValue("On it.");

		render(<HomeRoute />);

		expect(await screen.findByText("Ship it")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Ship it" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/action",
				expect.objectContaining({ method: "POST" }),
			);
		});
	});

	it("restores timeline data without refetching after a sidebar-style remount", async () => {
		let queryCalls = 0;
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) {
				return Response.json({
					stats: { home: 1, mentions: 0, dms: 0, needsReply: 0, inbox: 0 },
					transport: { statusText: "local" },
					accounts: [],
					archives: [],
				});
			}
			if (url.includes("/api/query")) {
				queryCalls += 1;
				return Response.json({
					resource: "home",
					items: [{ id: "tweet_cached", text: "Cached post" }],
				});
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const first = render(<HomeRoute />);
		expect(await screen.findByText("Cached post")).toBeInTheDocument();
		first.unmount();

		render(<HomeRoute />);

		expect(screen.getByText("Cached post")).toBeInTheDocument();
		expect(queryCalls).toBe(1);
	});

	it("shows reply transport errors without dropping the timeline", async () => {
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/api/status")) {
					return new Response(
						JSON.stringify({
							stats: { home: 3, mentions: 2, dms: 4, needsReply: 2, inbox: 4 },
							transport: { statusText: "local" },
							accounts: [],
							archives: [],
						}),
					);
				}
				if (url.includes("/api/query")) {
					return new Response(
						JSON.stringify({
							resource: "home",
							items: [{ id: "tweet_1", text: "Ship it" }],
						}),
					);
				}
				if (url.endsWith("/api/action") && init?.method === "POST") {
					return new Response(JSON.stringify({ message: "reply denied" }), {
						status: 500,
					});
				}
				throw new Error(`Unexpected fetch ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(window, "prompt").mockReturnValue("On it.");

		render(<HomeRoute />);

		expect(await screen.findByText("Ship it")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Ship it" }));

		expect(await screen.findByText("reply denied")).toBeInTheDocument();
		expect(screen.getByText("Ship it")).toBeInTheDocument();
	});

	it("trims search terms, changes reply filters, and ignores blank replies", async () => {
		const queryUrls: URL[] = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/api/status")) {
					return new Response(
						JSON.stringify({
							stats: { home: 3, mentions: 2, dms: 4, needsReply: 2, inbox: 4 },
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
							resource: "home",
							items: [{ id: "tweet_search", text: "Find me" }],
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
		vi.spyOn(window, "prompt").mockReturnValue("  ");

		render(<HomeRoute />);

		expect(await screen.findByText("Find me")).toBeInTheDocument();
		fireEvent.change(screen.getByPlaceholderText("Search local timeline"), {
			target: { value: "  signal  " },
		});
		fireEvent.click(screen.getByRole("button", { name: "Replied" }));

		await waitFor(() => {
			const queryUrl = queryUrls.at(-1);
			expect(queryUrl?.searchParams.get("search")).toBe("signal");
			expect(queryUrl?.searchParams.get("replyFilter")).toBe("replied");
		});

		fireEvent.click(screen.getByRole("button", { name: "Find me" }));
		expect(fetchMock).not.toHaveBeenCalledWith(
			"/api/action",
			expect.anything(),
		);
	});

	it("runs a live timeline sync and reloads local data", async () => {
		const queryUrls: URL[] = [];
		const syncBodies: unknown[] = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/api/status")) {
					return new Response(
						JSON.stringify({
							stats: { home: 3, mentions: 2, dms: 4, needsReply: 2, inbox: 4 },
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
							resource: "home",
							items: [{ id: "tweet_sync", text: "Fresh post" }],
						}),
					);
				}
				if (url.endsWith("/api/sync") && init?.body) {
					syncBodies.push(JSON.parse(String(init.body)));
					return new Response(
						JSON.stringify({
							id: "sync_timeline_1",
							kind: "timeline",
							status: "succeeded",
							startedAt: "2026-05-15T12:00:00.000Z",
							summary: "Synced 12 items",
							inProgress: false,
							result: {
								ok: true,
								kind: "timeline",
								summary: "Synced 12 items",
								steps: [],
							},
						}),
					);
				}
				throw new Error(`Unexpected fetch ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		render(<HomeRoute />);

		expect(await screen.findByText("Fresh post")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Sync timeline" }));

		await waitFor(() => {
			expect(syncBodies).toEqual([{ kind: "timeline" }]);
			expect(queryUrls.at(-1)?.searchParams.get("refresh")).toBe("1");
		});
		expect(screen.getByText("Synced 12 items")).toBeInTheDocument();
	});

	it("shows a retryable error when timeline loading fails", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) {
				return new Response(
					JSON.stringify({
						stats: { home: 3, mentions: 2, dms: 4, needsReply: 2, inbox: 4 },
						transport: { statusText: "local" },
						accounts: [],
						archives: [],
					}),
				);
			}
			if (url.includes("/api/query")) {
				throw "Timeline unavailable";
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<HomeRoute />);

		expect(await screen.findByText("Could not load posts")).toBeInTheDocument();
		expect(screen.getByText("Timeline unavailable")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(3);
		});
	});
});
