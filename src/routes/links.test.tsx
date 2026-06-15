import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "./links";

const LinksRoute = Route.options.component as ComponentType;

describe("links route", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	it("loads top links and switches ranges", async () => {
		const queryUrls: URL[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			queryUrls.push(url);
			if (url.pathname === "/api/profile-hydrate") {
				return new Response(
					JSON.stringify({ ok: true, hydratedProfiles: 0, results: [] }),
				);
			}
			const kind = url.searchParams.get("kind") ?? "links";
			const isVideo = kind === "videos";
			return new Response(
				JSON.stringify({
					kind,
					range: url.searchParams.get("range") ?? "week",
					sort: url.searchParams.get("sort") ?? "rank",
					source: url.searchParams.get("source") ?? "all",
					since: null,
					until: null,
					items: [
						{
							id: isVideo
								? "youtube.com/watch?v=mCO-D3pkviM"
								: "example.com/story",
							kind,
							url: isVideo
								? "https://youtube.com/watch?v=mCO-D3pkviM"
								: "https://example.com/story",
							canonicalKey: isVideo
								? "youtube.com/watch?v=mCO-D3pkviM"
								: "example.com/story",
							displayUrl: isVideo
								? "youtube.com/watch?v=mCO-D3pkviM"
								: "example.com/story",
							host: isVideo ? "youtube.com" : "example.com",
							title: isVideo ? "YouTube demo" : "Example story",
							description: isVideo ? null : "Useful article",
							shareCount: 3,
							uniqueSharers: 2,
							totalInfluence: 100,
							mentionCount: 2,
							commentCount: 1,
							pureShareCount: 1,
							hiddenMentionCount: 0,
							firstSeenAt: "2026-05-10T00:00:00.000Z",
							lastSeenAt: "2026-05-11T00:00:00.000Z",
							topSharer: {
								id: "profile_1",
								handle: "alice",
								displayName: "Alice",
								bio: "",
								followersCount: 10,
								avatarHue: 1,
								avatarUrl: "https://pbs.twimg.com/profile_images/1/a.jpg",
								createdAt: "2026-05-01T00:00:00.000Z",
							},
							sharers: [
								{
									id: "profile_1",
									handle: "alice",
									displayName: "Alice",
									bio: "",
									followersCount: 10,
									avatarHue: 1,
									avatarUrl: "https://pbs.twimg.com/profile_images/1/a.jpg",
									createdAt: "2026-05-01T00:00:00.000Z",
								},
								{
									id: "profile_idris",
									handle: "idris",
									displayName: "Idris",
									bio: "",
									followersCount: 0,
									avatarHue: 7,
									createdAt: "2026-05-01T00:00:00.000Z",
								},
								{
									id: "profile_user_42",
									handle: "id42",
									displayName: "id42",
									bio: "Imported from archive user 42",
									followersCount: 0,
									avatarHue: 42,
									createdAt: "2026-05-01T00:00:00.000Z",
								},
							],
							mentions: [
								{
									id: "tweet:1",
									sourceKind: "tweet",
									sourceId: "1",
									sourceUrl: "https://x.com/alice/status/1",
									sourceLabel: "tweet",
									shortUrl: "https://t.co/a",
									createdAt: "2026-05-11T00:00:00.000Z",
									text: "Worth reading",
									rawText: "Worth reading https://t.co/a",
									commentText: "Worth reading",
									hasComment: true,
									isPureShare: false,
									timelineTweetId: "1",
									contentTweetId: null,
									contentTweetUrl: null,
									contentAuthor: null,
									media: [],
									sharedBy: {
										id: "profile_1",
										handle: "alice",
										displayName: "Alice",
										bio: "",
										followersCount: 10,
										avatarHue: 1,
										avatarUrl: "https://pbs.twimg.com/profile_images/1/a.jpg",
										createdAt: "2026-05-01T00:00:00.000Z",
									},
								},
								{
									id: "tweet:2",
									sourceKind: "tweet",
									sourceId: "2",
									sourceUrl: "https://x.com/alice/status/2",
									sourceLabel: "tweet",
									shortUrl: "https://t.co/a",
									createdAt: "2026-05-10T00:00:00.000Z",
									text: "",
									rawText: "https://t.co/a",
									commentText: "",
									hasComment: false,
									isPureShare: true,
									timelineTweetId: "2",
									contentTweetId: null,
									contentTweetUrl: null,
									contentAuthor: null,
									media: [],
									sharedBy: {
										id: "profile_1",
										handle: "alice",
										displayName: "Alice",
										bio: "",
										followersCount: 10,
										avatarHue: 1,
										avatarUrl: "https://pbs.twimg.com/profile_images/1/a.jpg",
										createdAt: "2026-05-01T00:00:00.000Z",
									},
								},
							],
						},
					],
					stats: { occurrences: 3, groups: 1 },
				}),
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<LinksRoute />);

		expect(await screen.findByText("Example story")).toBeInTheDocument();
		const defaultCallsBeforeRemount = queryUrls.filter(
			(url) =>
				url.pathname === "/api/link-insights" &&
				url.searchParams.get("kind") === "links" &&
				url.searchParams.get("range") === "week" &&
				url.searchParams.get("sort") === "rank",
		).length;
		cleanup();
		render(<LinksRoute />);

		expect(screen.getByText("Example story")).toBeInTheDocument();
		expect(
			queryUrls.filter(
				(url) =>
					url.pathname === "/api/link-insights" &&
					url.searchParams.get("kind") === "links" &&
					url.searchParams.get("range") === "week" &&
					url.searchParams.get("sort") === "rank",
			),
		).toHaveLength(defaultCallsBeforeRemount);
		await waitFor(
			() => {
				const hydrationUrl = queryUrls.find(
					(url) => url.pathname === "/api/profile-hydrate",
				);
				expect(hydrationUrl?.searchParams.get("handles")).toBe("idris");
			},
			{ timeout: 3000 },
		);
		expect(screen.queryByText("Worth reading")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Show 1 comments/ }));
		expect(screen.getByText("Worth reading")).toBeInTheDocument();
		expect(screen.getByText("1 shares without comment")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Today" }));

		await waitFor(() => {
			expect(
				queryUrls.some((url) => url.searchParams.get("range") === "today"),
			).toBe(true);
		});
		fireEvent.click(screen.getByRole("button", { name: "videos" }));
		await waitFor(() => {
			expect(
				queryUrls.some(
					(url) =>
						url.searchParams.get("kind") === "videos" &&
						url.searchParams.get("range") === "today",
				),
			).toBe(true);
		});
		expect(await screen.findByAltText("YouTube demo")).toHaveAttribute(
			"src",
			"https://i.ytimg.com/vi/mCO-D3pkviM/hqdefault.jpg",
		);
		const requestsAfterPrefetch = queryUrls.length;
		fireEvent.click(screen.getByRole("button", { name: "links" }));
		fireEvent.click(screen.getByRole("button", { name: "videos" }));
		expect(queryUrls).toHaveLength(requestsAfterPrefetch);
		fireEvent.click(screen.getByRole("button", { name: "comments" }));
		await waitFor(() => {
			expect(
				queryUrls.some((url) => url.searchParams.get("sort") === "comments"),
			).toBe(true);
		});
	});

	it("shows a retryable error when link insights fail", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchMock = vi.fn(async () => {
			throw new Error("Insights unavailable");
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<LinksRoute />);

		expect(await screen.findByText("Could not load links")).toBeInTheDocument();
		expect(screen.getByText("Insights unavailable")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});
		expect(warnSpy).toHaveBeenCalledWith(
			"Link insights failed",
			expect.any(Error),
		);
	});
});
