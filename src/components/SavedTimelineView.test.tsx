import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SavedTimelineView } from "./SavedTimelineView";

vi.mock("#/components/TimelineCard", () => ({
	TimelineCard: ({ item }: { item: { text: string } }) => (
		<article>{item.text}</article>
	),
}));

describe("SavedTimelineView", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("loads liked posts through the query API", async () => {
		let queryUrl: URL | null = null;
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
				queryUrl = new URL(url);
				return new Response(
					JSON.stringify({
						resource: "home",
						items: [{ id: "liked_1", text: "good thing" }],
					}),
				);
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SavedTimelineView
				eyebrow="liked posts"
				filter="liked"
				loadingLabel="Loading liked posts..."
				searchPlaceholder="Search likes"
				title="Liked"
			/>,
		);

		expect(await screen.findByText("good thing")).toBeInTheDocument();
		expect(queryUrl?.searchParams.get("liked")).toBe("true");
		expect(queryUrl?.searchParams.get("bookmarked")).toBeNull();
	});

	it("loads bookmarks through the query API", async () => {
		let queryUrl: URL | null = null;
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
				queryUrl = new URL(url);
				return new Response(
					JSON.stringify({
						resource: "home",
						items: [{ id: "bookmark_1", text: "saved thing" }],
					}),
				);
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SavedTimelineView
				eyebrow="bookmarks"
				filter="bookmarked"
				loadingLabel="Loading bookmarks..."
				searchPlaceholder="Search bookmarks"
				title="Bookmarks"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText("saved thing")).toBeInTheDocument();
		});
		expect(queryUrl?.searchParams.get("bookmarked")).toBe("true");
		expect(queryUrl?.searchParams.get("liked")).toBeNull();
	});
});
