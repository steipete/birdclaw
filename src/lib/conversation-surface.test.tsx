import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	conversationQueryOptions,
	ConversationSurfaceScope,
	useConversationSurface,
} from "./conversation-surface";
import type { EmbeddedTweet } from "./types";
import {
	createTestQueryClient,
	renderWithQueryClient as render,
} from "../test/render";

interface ConversationResponse {
	json: () => Promise<{ items: EmbeddedTweet[]; ok: true }>;
	ok: true;
}

const tweet: EmbeddedTweet = {
	author: {
		avatarHue: 120,
		bio: "",
		createdAt: "2026-03-08T11:00:00.000Z",
		displayName: "Ava",
		followersCount: 10,
		handle: "ava",
		id: "profile_ava",
	},
	createdAt: "2026-03-08T12:00:00.000Z",
	entities: {},
	id: "tweet_1",
	media: [],
	replyToId: null,
	text: "Conversation anchor",
};

function Probe({
	tweetId,
	fetchTweetId,
}: {
	tweetId: string;
	fetchTweetId?: string;
}) {
	const surface = useConversationSurface(tweetId, fetchTweetId);
	return (
		<div>
			<div data-testid={`${tweetId}-status`}>{surface.status}</div>
			<div data-testid={`${tweetId}-open`}>
				{surface.isOpen ? "open" : "closed"}
			</div>
			<div data-testid={`${tweetId}-items`}>{surface.items.length}</div>
			<div data-testid={`${tweetId}-error`}>{surface.error ?? ""}</div>
			<button onClick={surface.prefetch} type="button">
				prefetch {tweetId}
			</button>
			<button onClick={surface.toggle} type="button">
				toggle {tweetId}
			</button>
		</div>
	);
}

describe("conversation surface", () => {
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("caches ready conversations and skips pending prefetches", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ items: [tweet], ok: true }),
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<ConversationSurfaceScope>
				<Probe tweetId="tweet_1" />
			</ConversationSurfaceScope>,
		);

		fireEvent.click(screen.getByRole("button", { name: "prefetch tweet_1" }));
		fireEvent.click(screen.getByRole("button", { name: "prefetch tweet_1" }));
		expect(fetchMock).toHaveBeenCalledTimes(1);

		await waitFor(() => {
			expect(screen.getByTestId("tweet_1-status")).toHaveTextContent("ready");
		});
		expect(screen.getByTestId("tweet_1-items")).toHaveTextContent("1");

		fireEvent.click(screen.getByRole("button", { name: "toggle tweet_1" }));
		expect(screen.getByTestId("tweet_1-open")).toHaveTextContent("open");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("keeps the original in-flight load locked across duplicate open attempts", async () => {
		let resolvePending!: (value: ConversationResponse) => void;
		const pending = new Promise<ConversationResponse>((resolve) => {
			resolvePending = resolve;
		});
		const fetchMock = vi.fn().mockReturnValue(pending);
		vi.stubGlobal("fetch", fetchMock);

		render(
			<ConversationSurfaceScope>
				<Probe tweetId="tweet_1" />
			</ConversationSurfaceScope>,
		);

		fireEvent.click(screen.getByRole("button", { name: "prefetch tweet_1" }));
		fireEvent.click(screen.getByRole("button", { name: "toggle tweet_1" }));
		fireEvent.click(screen.getByRole("button", { name: "toggle tweet_1" }));
		fireEvent.click(screen.getByRole("button", { name: "toggle tweet_1" }));

		expect(fetchMock).toHaveBeenCalledTimes(1);
		resolvePending({
			ok: true,
			json: async () => ({ items: [tweet], ok: true }),
		});

		await waitFor(() => {
			expect(screen.getByTestId("tweet_1-status")).toHaveTextContent("ready");
		});
	});

	it("keeps row-open state separate from the fetched tweet id", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ items: [tweet], ok: true }),
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<ConversationSurfaceScope>
				<Probe fetchTweetId="tweet_original" tweetId="row_a" />
				<Probe fetchTweetId="tweet_original" tweetId="row_b" />
			</ConversationSurfaceScope>,
		);

		fireEvent.click(screen.getByRole("button", { name: "toggle row_a" }));

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/conversation?tweetId=tweet_original",
		);
		expect(screen.getByTestId("row_a-open")).toHaveTextContent("open");
		expect(screen.getByTestId("row_b-open")).toHaveTextContent("closed");

		await waitFor(() => {
			expect(screen.getByTestId("row_a-status")).toHaveTextContent("ready");
		});
		expect(screen.getByTestId("row_b-status")).toHaveTextContent("ready");
	});

	it("exposes a lazy React Query definition", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ items: [tweet], ok: true }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const options = conversationQueryOptions("tweet_1");
		const queryClient = createTestQueryClient();

		expect(fetchMock).not.toHaveBeenCalled();
		await expect(queryClient.fetchQuery(options)).resolves.toEqual({
			ok: true,
			anchorId: "",
			items: [tweet],
			truncated: false,
		});
		expect(fetchMock).toHaveBeenCalledWith("/api/conversation?tweetId=tweet_1");
	});

	it("stores load errors and retries failed prefetches", async () => {
		let resolveStale!: (value: ConversationResponse) => void;
		const staleResponse = new Promise<ConversationResponse>((resolve) => {
			resolveStale = resolve;
		});
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: false,
				json: async () => ({ error: "Tweet not found", ok: false }),
			})
			.mockReturnValueOnce(staleResponse);
		vi.stubGlobal("fetch", fetchMock);

		render(
			<ConversationSurfaceScope>
				<Probe tweetId="tweet_404" />
			</ConversationSurfaceScope>,
		);

		fireEvent.click(screen.getByRole("button", { name: "toggle tweet_404" }));
		await waitFor(() => {
			expect(screen.getByTestId("tweet_404-status")).toHaveTextContent("error");
		});
		expect(screen.getByTestId("tweet_404-error")).toHaveTextContent(
			"Tweet not found",
		);

		fireEvent.click(screen.getByRole("button", { name: "prefetch tweet_404" }));
		await waitFor(() => {
			expect(screen.getByTestId("tweet_404-status")).toHaveTextContent(
				"loading",
			);
		});
		resolveStale({
			ok: true,
			json: async () => ({ items: [tweet], ok: true }),
		});

		await waitFor(() => {
			expect(screen.getByTestId("tweet_404-status")).toHaveTextContent("ready");
		});
	});
});
