import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ConversationSurfaceScope,
	loadConversationEffect,
	resetConversationSurface,
	useConversationSurface,
} from "./conversation-surface";
import type { EmbeddedTweet } from "./types";

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

function Probe({ tweetId }: { tweetId: string }) {
	const surface = useConversationSurface(tweetId);
	return (
		<div>
			<div data-testid="status">{surface.status}</div>
			<div data-testid="open">{surface.isOpen ? "open" : "closed"}</div>
			<div data-testid="items">{surface.items.length}</div>
			<div data-testid="error">{surface.error ?? ""}</div>
			<button onClick={surface.prefetch} type="button">
				prefetch
			</button>
			<button onClick={surface.toggle} type="button">
				toggle
			</button>
		</div>
	);
}

describe("conversation surface", () => {
	afterEach(() => {
		cleanup();
		resetConversationSurface();
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

		fireEvent.click(screen.getByRole("button", { name: "prefetch" }));
		fireEvent.click(screen.getByRole("button", { name: "prefetch" }));
		expect(fetchMock).toHaveBeenCalledTimes(1);

		await waitFor(() => {
			expect(screen.getByTestId("status")).toHaveTextContent("ready");
		});
		expect(screen.getByTestId("items")).toHaveTextContent("1");

		fireEvent.click(screen.getByRole("button", { name: "toggle" }));
		expect(screen.getByTestId("open")).toHaveTextContent("open");
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

		fireEvent.click(screen.getByRole("button", { name: "prefetch" }));
		fireEvent.click(screen.getByRole("button", { name: "toggle" }));
		fireEvent.click(screen.getByRole("button", { name: "toggle" }));
		fireEvent.click(screen.getByRole("button", { name: "toggle" }));

		expect(fetchMock).toHaveBeenCalledTimes(1);
		resolvePending({
			ok: true,
			json: async () => ({ items: [tweet], ok: true }),
		});

		await waitFor(() => {
			expect(screen.getByTestId("status")).toHaveTextContent("ready");
		});
	});

	it("exposes conversation loading as a lazy Effect program", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ items: [tweet], ok: true }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const effect = loadConversationEffect("tweet_1");

		expect(fetchMock).not.toHaveBeenCalled();
		await expect(Effect.runPromise(effect)).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledWith("/api/conversation?tweetId=tweet_1");
	});

	it("stores load errors and ignores results after reset", async () => {
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

		fireEvent.click(screen.getByRole("button", { name: "toggle" }));
		await waitFor(() => {
			expect(screen.getByTestId("status")).toHaveTextContent("error");
		});
		expect(screen.getByTestId("error")).toHaveTextContent("Tweet not found");

		fireEvent.click(screen.getByRole("button", { name: "prefetch" }));
		expect(screen.getByTestId("status")).toHaveTextContent("loading");
		resetConversationSurface();
		resolveStale({
			ok: true,
			json: async () => ({ items: [tweet], ok: true }),
		});

		await waitFor(() => {
			expect(screen.getByTestId("status")).toHaveTextContent("idle");
		});
	});
});
