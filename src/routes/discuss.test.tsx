import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ndjsonResponse } from "#/test/ndjson";
import { DiscussRouteView as DiscussRoute } from "./discuss";

function discussionResult(markdown: string) {
	return {
		context: {
			query: "ChatGPT",
			source: "search",
			includeDms: true,
			counts: {
				search: 3,
				home: 1,
				mentions: 1,
				authored: 0,
				likes: 1,
				bookmarks: 0,
				dms: 2,
			},
			tweets: [
				{
					id: "tweet_1",
					url: "https://x.com/alice/status/tweet_1",
					source: "search",
					author: "alice",
					name: "Alice",
					authorProfile: {
						id: "profile_alice",
						handle: "alice",
						displayName: "Alice",
						bio: "Builds useful things.",
						followersCount: 12,
						followingCount: 3,
						avatarHue: 42,
						createdAt: "2026-01-01T00:00:00.000Z",
					},
					createdAt: "2026-05-23T08:18:00.000Z",
					text: "ChatGPT is useful for summaries.",
					likeCount: 4,
					liked: false,
					bookmarked: false,
					needsReply: false,
				},
			],
			dms: [],
			liveSearch: {
				ok: true,
				source: "bird",
				accountId: "acct_primary",
				query: "ChatGPT",
				count: 3,
				pageCount: 1,
				tweetIds: ["tweet_1"],
			},
			hash: "hash",
		},
		discussion: {
			title: "ChatGPT",
			summary: "People discuss practical AI workflows.",
			themes: [],
			tensions: [],
			followUps: [],
			sourceTweetIds: ["tweet_1"],
			sourceDmConversationIds: [],
		},
		markdown,
		model: "gpt-5.5",
		reasoningEffort: "low",
		serviceTier: "priority",
		cached: false,
		updatedAt: "2026-05-23T08:20:00.000Z",
	};
}

describe("discuss route", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("streams a keyword discussion and refreshes the submitted query", async () => {
		const urls: URL[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			urls.push(url);
			const query = url.searchParams.get("query") ?? "";
			const markdown = `# ${query}\n\n## Themes\n\n- Practical workflows`;
			return ndjsonResponse([
				{
					type: "start",
					context: discussionResult(markdown).context,
					cached: false,
				},
				{ type: "delta", delta: markdown },
				{ type: "done", result: discussionResult(markdown) },
			]);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<DiscussRoute />);

		expect(
			screen.getByRole("heading", { name: "Discuss", level: 1 }),
		).toBeInTheDocument();
		expect(screen.getByText("Search to begin.")).toBeInTheDocument();
		expect(screen.getByLabelText("Mode")).toHaveValue("xurl");

		fireEvent.change(screen.getByPlaceholderText("Keywords"), {
			target: { value: "ChatGPT" },
		});
		fireEvent.change(screen.getByPlaceholderText("Optional question"), {
			target: { value: "Useful takeaways" },
		});
		fireEvent.change(screen.getByLabelText("Mode"), {
			target: { value: "bird" },
		});
		fireEvent.change(screen.getByLabelText("Source"), {
			target: { value: "all" },
		});
		fireEvent.click(screen.getByLabelText("DMs"));
		fireEvent.click(screen.getByRole("button", { name: "Discuss" }));

		expect(
			await screen.findByRole("heading", { name: "ChatGPT", level: 1 }),
		).toBeInTheDocument();
		expect(screen.getByText("Practical workflows")).toBeInTheDocument();
		expect(
			screen.getByText(
				"bird 3 fetched · 3 search · 2 timeline · 1 saved · 2 DMs",
			),
		).toBeInTheDocument();
		expect(urls[0]?.searchParams.get("source")).toBe("all");
		expect(urls[0]?.searchParams.get("mode")).toBe("bird");
		expect(urls[0]?.searchParams.get("includeDms")).toBe("true");
		expect(urls[0]?.searchParams.get("question")).toBe("Useful takeaways");
		expect(urls[0]?.searchParams.get("limit")).toBe("20000");
		expect(urls[0]?.searchParams.get("maxPages")).toBe("200");
		expect(urls[0]?.searchParams.has("refresh")).toBe(false);

		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		expect(urls[1]?.searchParams.get("refresh")).toBe("true");

		fireEvent.click(screen.getByRole("button", { name: "Discuss" }));
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
		expect(urls[2]?.searchParams.has("refresh")).toBe(false);
	});

	it("renders request and stream errors", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ message: "no api key" }), {
					status: 500,
					statusText: "Server Error",
					headers: { "content-type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				ndjsonResponse([{ type: "error", error: "live failed" }]),
			);
		vi.stubGlobal("fetch", fetchMock);

		render(<DiscussRoute />);
		fireEvent.change(screen.getByPlaceholderText("Keywords"), {
			target: { value: "OpenAI" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Discuss" }));

		expect(
			await screen.findByText(
				"Discussion request failed (500 Server Error): no api key",
			),
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Discuss" }));
		expect(await screen.findByText("live failed")).toBeInTheDocument();
	});

	it("renders non-json and empty-body request failures", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response("plain failure", {
					status: 503,
					statusText: "",
				}),
			)
			.mockResolvedValueOnce(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);

		render(<DiscussRoute />);
		fireEvent.change(screen.getByPlaceholderText("Keywords"), {
			target: { value: "OpenAI" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Discuss" }));

		expect(
			await screen.findByText("Discussion request failed (503): plain failure"),
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Discuss" }));
		expect(
			await screen.findByText("Discussion request failed: empty response body"),
		).toBeInTheDocument();
	});

	it("renders json error payloads and malformed responses", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: "xurl unauthorized" }), {
					status: 401,
					statusText: "Unauthorized",
					headers: { "content-type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response("{not-json", {
					status: 502,
					statusText: "Bad Gateway",
					headers: { "content-type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(new Response("{not-json\n"));
		vi.stubGlobal("fetch", fetchMock);

		render(<DiscussRoute />);
		fireEvent.change(screen.getByPlaceholderText("Keywords"), {
			target: { value: "OpenAI" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Discuss" }));

		expect(
			await screen.findByText(
				"Discussion request failed (401 Unauthorized): xurl unauthorized",
			),
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Discuss" }));
		expect(
			await screen.findByText("Discussion request failed (502 Bad Gateway)"),
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Discuss" }));
		expect(
			await screen.findByText((content) =>
				/JSON|Unexpected|Expected|not valid/.test(content),
			),
		).toBeInTheDocument();
	});

	it("reports a stream that closes before a terminal event", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ndjsonResponse([{ type: "delta", delta: "partial" }])),
		);

		render(<DiscussRoute />);
		fireEvent.change(screen.getByPlaceholderText("Keywords"), {
			target: { value: "OpenAI" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Discuss" }));

		expect(
			await screen.findByText(
				"Discussion connection closed before completion. Retry to continue.",
			),
		).toBeInTheDocument();
	});
});
