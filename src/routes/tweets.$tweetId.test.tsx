import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TweetRouteView } from "./tweets.$tweetId";
import { conversationQueryOptions } from "#/lib/conversation-surface";
import { renderWithQueryClient, createTestQueryClient } from "#/test/render";

const tweet = (id: string, text = id) => ({
	id,
	text,
	createdAt: "2026-09-01T10:00:00.000Z",
	entities: {},
	media: [],
	author: {
		id: "fixture_author",
		handle: "avery",
		displayName: "Avery Finch",
		bio: "",
		avatarHue: 20,
		followersCount: 10,
		createdAt: "2026-01-01",
	},
});
const response = (
	anchorId = "reply",
	items = [tweet("parent"), tweet(anchorId)],
	truncated = false,
) => Response.json({ ok: true, anchorId, items, truncated });
const scroll = vi.fn();
const scrollDescriptor = Object.getOwnPropertyDescriptor(
	HTMLElement.prototype,
	"scrollIntoView",
);
const clipboardDescriptor = Object.getOwnPropertyDescriptor(
	navigator,
	"clipboard",
);

beforeEach(() => {
	scroll.mockClear();
	Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
		configurable: true,
		value: scroll,
	});
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	if (scrollDescriptor)
		Object.defineProperty(
			HTMLElement.prototype,
			"scrollIntoView",
			scrollDescriptor,
		);
	else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
	if (clipboardDescriptor)
		Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
	else Reflect.deleteProperty(navigator, "clipboard");
});

describe("tweet permalinks", () => {
	it("loads the requested reply directly, highlights it, and focuses its archived context", async () => {
		const fetch = vi.fn().mockResolvedValue(response());
		vi.stubGlobal("fetch", fetch);
		renderWithQueryClient(<TweetRouteView tweetId="reply" />, {
			readOnly: true,
		});
		const selected = await screen.findByRole("article", {
			name: "Selected post",
		});
		expect(selected).toHaveAttribute("data-tweet-id", "reply");
		expect(selected).toHaveAttribute("aria-current", "true");
		expect(selected).toHaveFocus();
		expect(scroll).toHaveBeenCalledWith({ block: "center" });
		expect(fetch).toHaveBeenCalledWith("/api/conversation?tweetId=reply");
		expect(
			screen
				.getAllByRole("link", { name: "Open archived post" })
				.map((link) => link.getAttribute("href")),
		).toEqual(["/tweets/parent", "/tweets/reply"]);
		expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
	});

	it("renders a standalone post and exposes bounded conversation context", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(response("solo", [tweet("solo")], true)),
		);
		renderWithQueryClient(<TweetRouteView tweetId="solo" />);
		expect(
			await screen.findByRole("article", { name: "Selected post" }),
		).toHaveTextContent("solo");
		expect(screen.getByText("1 tweet in conversation")).toBeVisible();
		expect(
			screen.getByText(
				"Showing a limited portion of the archived conversation.",
			),
		).toBeVisible();
	});

	it("shows a loading state until the requested conversation arrives", async () => {
		let resolve!: (value: Response) => void;
		vi.stubGlobal(
			"fetch",
			vi.fn().mockReturnValue(
				new Promise<Response>((done) => {
					resolve = done;
				}),
			),
		);
		renderWithQueryClient(<TweetRouteView tweetId="reply" />);
		expect(screen.getByText("Loading conversation")).toBeVisible();
		expect(scroll).not.toHaveBeenCalled();
		resolve(response());
		expect(
			await screen.findByRole("article", { name: "Selected post" }),
		).toHaveFocus();
	});

	it("uses a prefetched conversation without issuing a duplicate request", async () => {
		const fetch = vi.fn().mockResolvedValue(response());
		vi.stubGlobal("fetch", fetch);
		const queryClient = createTestQueryClient();
		await queryClient.fetchQuery(conversationQueryOptions("reply"));
		renderWithQueryClient(<TweetRouteView tweetId="reply" />, { queryClient });
		expect(
			await screen.findByRole("article", { name: "Selected post" }),
		).toHaveFocus();
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("does not show a previous reply after navigation to a missing post", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(response())
			.mockResolvedValueOnce(
				Response.json({ ok: false, error: "Tweet not found" }, { status: 404 }),
			);
		vi.stubGlobal("fetch", fetch);
		const { rerender } = renderWithQueryClient(
			<TweetRouteView key="reply" tweetId="reply" />,
		);
		await screen.findByRole("article", { name: "Selected post" });
		rerender(<TweetRouteView key="missing" tweetId="missing" />);
		expect(await screen.findByText("Post not found")).toBeVisible();
		expect(screen.queryByRole("article", { name: "Selected post" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
	});

	it("retries a failed read without starting a live sync", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({ error: "Temporarily unavailable" }, { status: 503 }),
			)
			.mockResolvedValueOnce(response());
		vi.stubGlobal("fetch", fetch);
		renderWithQueryClient(<TweetRouteView tweetId="reply" />);
		fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
		expect(
			await screen.findByRole("article", { name: "Selected post" }),
		).toHaveFocus();
		expect(fetch.mock.calls.map((call) => call[0])).toEqual([
			"/api/conversation?tweetId=reply",
			"/api/conversation?tweetId=reply",
		]);
	});

	it("copies a canonical URL and reports a clipboard failure", async () => {
		const writeText = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("Clipboard denied"));
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
		renderWithQueryClient(<TweetRouteView tweetId="reply" />);
		await screen.findByRole("article", { name: "Selected post" });
		fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
		await screen.findByRole("button", { name: "Copied" });
		expect(writeText).toHaveBeenCalledWith(
			new URL("/tweets/reply", window.location.origin).href,
		);
		fireEvent.click(screen.getByRole("button", { name: "Copied" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Could not copy automatically",
		);
		expect(screen.getByRole("textbox", { name: "Post permalink" })).toHaveValue(
			new URL("/tweets/reply", window.location.origin).href,
		);
	});

	it("refuses to present a successful response that omits its selected post", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(response("missing", [tweet("parent")])),
		);
		renderWithQueryClient(<TweetRouteView tweetId="missing" />);
		expect(await screen.findByText("Post not found")).toBeVisible();
		expect(screen.queryByRole("article")).toBeNull();
	});
});
