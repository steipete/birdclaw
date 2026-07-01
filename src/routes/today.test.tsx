import {
	act,
	cleanup,
	fireEvent,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ndjsonResponse } from "#/test/ndjson";
import { renderWithQueryClient as render } from "#/test/render";
import { TodayRouteView as TodayRoute } from "./today";

const authorProfile = {
	id: "profile_alice",
	handle: "alice",
	displayName: "Alice",
	bio: "Builds useful things.",
	followersCount: 1200,
	followingCount: 200,
	avatarHue: 42,
	createdAt: "2020-01-01T00:00:00.000Z",
};

const hydratedAuthorProfile = {
	...authorProfile,
	displayName: "Alice Fresh",
	avatarUrl: "https://pbs.twimg.com/profile_images/alice/avatar.jpg",
};

function digestResult(label: string, markdown: string, includeDms = false) {
	return {
		context: {
			window: {
				label,
				since: "2026-05-16T00:00:00.000Z",
				until: "2026-05-16T12:00:00.000Z",
			},
			includeDms,
			counts: {
				home: 3,
				mentions: 2,
				authored: 1,
				likes: 1,
				bookmarks: 1,
				dms: includeDms ? 1 : 0,
				links: 4,
			},
			tweets: [
				{
					id: "tweet_1",
					url: "https://x.com/alice/status/tweet_1",
					source: "mentions",
					author: "alice",
					name: "Alice",
					authorProfile,
					createdAt: "2026-05-16T10:00:00.000Z",
					text: "Peter should see this.",
					likeCount: 12,
					liked: false,
					bookmarked: false,
					needsReply: true,
				},
			],
			dms: [],
			links: [],
			hash: label,
		},
		digest: {
			title: label,
			summary: `${label} summary`,
			keyTopics: [
				{
					title: "Useful signal",
					summary: "Alice shared something worth a reply.",
					tweetIds: ["tweet_1"],
					handles: ["@alice"],
				},
			],
			notableLinks: [
				{
					title: "Example",
					url: "https://example.com",
					why: "Worth reading.",
					sourceTweetIds: ["tweet_1"],
				},
				{
					title: "Unsafe",
					url: "javascript:alert(1)",
					why: "Should render as inert text.",
					sourceTweetIds: ["tweet_1"],
				},
			],
			people: [
				{ handle: "alice", name: "Alice", why: "Shared useful signal." },
			],
			actionItems: [
				{ kind: "reply", label: "Reply to Alice", tweetId: "tweet_1" },
			],
			sourceTweetIds: ["tweet_1"],
		},
		markdown,
		model: "gpt-5.5",
		reasoningEffort: "medium",
		serviceTier: "priority",
		cached: false,
		updatedAt: "2026-05-16T12:00:00.000Z",
	};
}

describe("today route", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("streams a digest and reloads when controls change", async () => {
		const urls: URL[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			urls.push(url);
			if (url.pathname === "/api/profile-hydrate") {
				return new Response(
					JSON.stringify({
						ok: true,
						results: [
							{
								handle: "alice",
								status: "hit",
								source: "bird",
								profile: hydratedAuthorProfile,
							},
						],
					}),
					{ headers: { "content-type": "application/json" } },
				);
			}
			const period = url.searchParams.get("period") ?? "today";
			const includeDms = url.searchParams.get("includeDms") === "true";
			const label = period === "week" ? "Last 7 days" : "Today";
			const markdown = includeDms
				? "# With DMs\n\n## What people are talking about\n\n- **Reply:** ask @alice about tweet_1"
				: `# ${label}\n\n## What people are talking about\n\n- **Reply:** ask @alice about tweet_1`;
			return ndjsonResponse([
				{ type: "delta", delta: `${markdown}\n` },
				{ type: "done", result: digestResult(label, markdown, includeDms) },
			]);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<TodayRoute />);

		expect(
			await screen.findByRole("heading", { name: "Today", level: 1 }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", {
				name: "What people are talking about",
				level: 2,
			}),
		).toBeInTheDocument();
		expect(screen.queryByText("Today summary")).toBeNull();
		expect(screen.queryByText("Useful signal")).toBeNull();
		expect(screen.queryByText(/Action items/i)).toBeNull();
		expect(screen.queryByText("# Today")).not.toBeInTheDocument();
		expect(screen.getByText("Reply:")).toBeInTheDocument();
		const aliceLink = screen.getByRole("link", { name: "@alice" });
		expect(aliceLink).toHaveAttribute("href", "/profiles/alice");
		expect(screen.getByRole("link", { name: "tweet_1" })).toHaveAttribute(
			"href",
			"https://x.com/alice/status/tweet_1",
		);
		expect(
			screen.getByText("3 home · 2 mentions · 4 links"),
		).toBeInTheDocument();
		const todayButton = screen.getByRole("button", { name: "Today" });
		const weekButton = screen.getByRole("button", { name: "Week" });
		expect(todayButton).toHaveAttribute("aria-pressed", "true");
		expect(todayButton).toHaveClass(
			"bg-[var(--accent-soft)]!",
			"text-[var(--accent)]!",
		);
		expect(weekButton).toHaveAttribute("aria-pressed", "false");
		await waitFor(() =>
			expect(urls.some((url) => url.pathname === "/api/profile-hydrate")).toBe(
				true,
			),
		);
		fireEvent.pointerEnter(aliceLink.parentElement as Element);
		await screen.findByText("Alice Fresh");
		expect(screen.getByRole("img", { name: "Alice Fresh" })).toHaveAttribute(
			"src",
			expect.stringContaining("/api/avatar?profileId=profile_alice&v="),
		);

		fireEvent.click(screen.getByRole("button", { name: "Week" }));
		expect(
			await screen.findByRole("heading", { name: "Last 7 days", level: 1 }),
		).toBeInTheDocument();
		expect(todayButton).toHaveAttribute("aria-pressed", "false");
		expect(weekButton).toHaveAttribute("aria-pressed", "true");
		expect(weekButton).toHaveClass(
			"bg-[var(--accent-soft)]!",
			"text-[var(--accent)]!",
		);

		fireEvent.click(screen.getByLabelText("DMs"));
		expect(
			await screen.findByRole("heading", { name: "With DMs", level: 1 }),
		).toBeInTheDocument();
		expect(
			screen.getByText("3 home · 2 mentions · 4 links · 1 DMs"),
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
		await waitFor(() =>
			expect(
				urls.some((url) => url.searchParams.get("refresh") === "true"),
			).toBe(true),
		);
		expect(
			urls.some(
				(url) =>
					url.searchParams.get("period") === "week" &&
					url.searchParams.get("includeDms") === "true" &&
					url.searchParams.get("liveSync") === "false",
			),
		).toBe(true);
	});

	it("exports a completed digest through the browser PDF flow", async () => {
		document.title = "birdclaw";
		const printMock = vi.spyOn(window, "print").mockImplementation(() => {
			expect(document.title).toBe("BirdClaw Today digest");
			window.dispatchEvent(new Event("afterprint"));
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				if (url.pathname === "/api/profile-hydrate") {
					return new Response(JSON.stringify({ ok: true, results: [] }), {
						headers: { "content-type": "application/json" },
					});
				}
				const markdown = "# Today\n\nDone.";
				return ndjsonResponse([
					{ type: "delta", delta: markdown },
					{ type: "done", result: digestResult("Today", markdown) },
				]);
			}),
		);

		render(<TodayRoute />);

		await screen.findByRole("heading", { name: "Today", level: 1 });
		const exportButton = screen.getByRole("button", { name: "Export PDF" });
		expect(exportButton).toBeEnabled();

		fireEvent.click(exportButton);

		expect(printMock).toHaveBeenCalledTimes(1);
		expect(document.title).toBe("birdclaw");
	});

	it("does not export a partial digest after the stream fails", async () => {
		const printMock = vi.spyOn(window, "print").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				ndjsonResponse([
					{ type: "delta", delta: "# Partial digest" },
					{ type: "error", error: "Digest generation failed" },
				]),
			),
		);

		render(<TodayRoute />);

		await screen.findByRole("heading", { name: "Partial digest", level: 1 });
		await screen.findByRole("alert");
		expect(screen.queryByRole("button", { name: "Export PDF" })).toBeNull();
		expect(printMock).not.toHaveBeenCalled();
	});

	it("shows request errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							ok: false,
							message:
								"Remote API access requires BIRDCLAW_ALLOW_REMOTE_WEB=1 for a trusted private proxy, or BIRDCLAW_WEB_TOKEN for tokened access",
						}),
						{
							headers: { "content-type": "application/json" },
							status: 403,
						},
					),
			),
		);

		render(<TodayRoute />);

		expect(
			await screen.findByText(
				"Digest request failed (403): Remote API access requires BIRDCLAW_ALLOW_REMOTE_WEB=1 for a trusted private proxy, or BIRDCLAW_WEB_TOKEN for tokened access",
			),
		).toBeInTheDocument();
	});

	it("shows an actionable message when the digest connection drops", async () => {
		const fetchMock = vi.fn(async () => {
			throw new TypeError("network error");
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<TodayRoute />);

		expect(
			await screen.findByText(
				"Digest connection was interrupted while starting digest. Retry to continue.",
			),
		).toBeInTheDocument();
		expect(screen.getByText("Digest failed")).toBeInTheDocument();
		expect(
			screen.getByText("No digest was generated. Retry to start a new run."),
		).toBeInTheDocument();
		expect(
			screen.queryByText("Waiting for the first tokens..."),
		).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
	});

	it("shows fetch status before the first markdown token", async () => {
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		const encoder = new TextEncoder();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				if (url.pathname === "/api/profile-hydrate") {
					return new Response(JSON.stringify({ ok: true, results: [] }), {
						headers: { "content-type": "application/json" },
					});
				}
				return new Response(
					new ReadableStream<Uint8Array>({
						start(streamController) {
							controller = streamController;
							streamController.enqueue(
								encoder.encode(
									`${JSON.stringify({
										type: "status",
										label: "Fetching home timeline from X",
									})}\n`,
								),
							);
						},
					}),
					{ headers: { "content-type": "application/x-ndjson" } },
				);
			}),
		);

		render(<TodayRoute />);

		expect(
			await screen.findAllByText("Fetching home timeline from X"),
		).not.toHaveLength(0);

		const markdown = "# Today\n\nDone.";
		await act(async () => {
			controller?.enqueue(
				encoder.encode(
					[
						JSON.stringify({ type: "delta", delta: markdown }),
						JSON.stringify({
							type: "done",
							result: digestResult("Today", markdown),
						}),
						"",
					].join("\n"),
				),
			);
			controller?.close();
		});

		expect(
			await screen.findByRole("heading", { name: "Today", level: 1 }),
		).toBeInTheDocument();
	});

	it("shows streamed error events", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				ndjsonResponse([{ type: "error", error: "model failed" }]),
			),
		);

		render(<TodayRoute />);

		expect(await screen.findByText("model failed")).toBeInTheDocument();
	});
});
