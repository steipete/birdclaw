import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileRouteView } from "./profiles.$handle";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function streamEvents(events: unknown[]) {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const event of events) {
				controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
			}
			controller.close();
		},
	});
}

function profileContext() {
	return {
		handle: "steipete",
		accountId: "account_steipete",
		accountHandle: "openclaw",
		profile: {
			id: "profile_steipete",
			handle: "steipete",
			displayName: "Peter Steinberger",
			bio: "Futurist 🦄\nChief Architect @openclaw 🦞\nWriter @forbes Tech Council\nAdjunct @MIT\nEx @Microsoft @Qantas\nContact hello@openai.com\nGithub: https://t.co/LZwHTUFwPq\nHuggingFace: https://t.co/sN2FFU8PVE",
			followersCount: 123456,
			followingCount: 987,
			avatarHue: 18,
			avatarUrl: "https://pbs.twimg.com/profile_images/1/avatar.jpg",
			entities: {
				description: {
					urls: [
						{
							start: 137,
							end: 160,
							url: "https://t.co/LZwHTUFwPq",
							expanded_url: "https://github.com/nousresearch/hermes-agent",
							display_url: "github.com/nousresearch/hermes-agent",
						},
						{
							start: 174,
							end: 197,
							url: "https://t.co/sN2FFU8PVE",
							expanded_url: "https://huggingface.co/NousResearch",
							display_url: "huggingface.co/NousResearch",
						},
					],
				},
			},
			createdAt: "2009-03-19T22:54:05.000Z",
		},
		externalUserId: "123",
		tweets: [],
		conversations: [],
		counts: {
			tweets: 42,
			tweetPages: 1,
			conversationsScanned: 3,
			conversationTweets: 9,
			conversationPages: 2,
		},
		fetchCached: true,
		hash: "context_hash",
	};
}

describe("profile route", () => {
	it("loads /profiles/:handle as a profile header with analysis", async () => {
		const context = profileContext();
		const hydratedProfiles = [
			{
				id: "profile_openclaw",
				handle: "openclaw",
				displayName: "OpenClaw",
				bio: "Agent tooling.",
				followersCount: 456,
				avatarHue: 210,
				createdAt: "2026-01-01T00:00:00.000Z",
			},
			{
				id: "profile_forbes",
				handle: "forbes",
				displayName: "Forbes",
				bio: "Business news.",
				followersCount: 123,
				avatarHue: 110,
				createdAt: "2009-01-01T00:00:00.000Z",
			},
			{
				id: "profile_mit",
				handle: "MIT",
				displayName: "MIT",
				bio: "Massachusetts Institute of Technology.",
				followersCount: 789,
				avatarHue: 20,
				createdAt: "2009-01-01T00:00:00.000Z",
			},
			{
				id: "profile_microsoft",
				handle: "Microsoft",
				displayName: "Microsoft",
				bio: "Technology company.",
				followersCount: 999,
				avatarHue: 220,
				createdAt: "2009-01-01T00:00:00.000Z",
			},
			{
				id: "profile_qantas",
				handle: "Qantas",
				displayName: "Qantas",
				bio: "Airline.",
				followersCount: 333,
				avatarHue: 300,
				createdAt: "2009-01-01T00:00:00.000Z",
			},
		];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://localhost");
			if (url.pathname === "/api/profile-hydrate") {
				return new Response(
					JSON.stringify({
						ok: true,
						results: hydratedProfiles.map((profile) => ({
							status: "hit",
							profile,
						})),
					}),
					{
						headers: { "content-type": "application/json" },
					},
				);
			}
			return new Response(
				streamEvents([
					{ type: "status", label: "Fetching profile tweets" },
					{ type: "start", context, cached: true },
					{
						type: "done",
						result: {
							context,
							analysis: {},
							markdown: "Peter ships agent tools with practical taste.",
							model: "gpt-5.5",
							reasoningEffort: "medium",
							serviceTier: "priority",
							cached: true,
							updatedAt: "2026-05-31T12:00:00.000Z",
						},
					},
				]),
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<ProfileRouteView handle="steipete" />);

		expect(await screen.findByText("Peter Steinberger")).toBeInTheDocument();
		expect(screen.getByTestId("profile-cover")).toHaveClass("h-32");
		expect(screen.getByTestId("profile-avatar-overlap")).toHaveClass("-mt-8");
		expect(screen.getByText("@steipete")).toBeInTheDocument();
		expect(screen.getByText(/Futurist/)).toBeInTheDocument();
		expect(screen.getByText(/Contact hello@openai\.com/)).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: "@openai" })).toBeNull();
		expect(screen.queryByText(/t\.co\/LZwHTUFwPq/)).toBeNull();
		expect(screen.queryByText(/t\.co\/sN2FFU8PVE/)).toBeNull();
		expect(
			screen.getByRole("link", {
				name: "https://github.com/nousresearch/hermes-agent",
			}),
		).toHaveAttribute("href", "https://github.com/nousresearch/hermes-agent");
		expect(
			screen.getByRole("link", {
				name: "https://huggingface.co/NousResearch",
			}),
		).toHaveAttribute("href", "https://huggingface.co/NousResearch");
		expect(screen.getByRole("link", { name: "@openclaw" })).toHaveAttribute(
			"href",
			"/profiles/openclaw",
		);
		expect(screen.getByRole("link", { name: "@forbes" })).toHaveAttribute(
			"href",
			"/profiles/forbes",
		);
		expect(screen.getByRole("link", { name: "@MIT" })).toHaveAttribute(
			"href",
			"/profiles/MIT",
		);
		expect(screen.getByRole("link", { name: "@Microsoft" })).toHaveAttribute(
			"href",
			"/profiles/Microsoft",
		);
		expect(screen.getByRole("link", { name: "@Qantas" })).toHaveAttribute(
			"href",
			"/profiles/Qantas",
		);
		for (const [handle, bio] of [
			["@openclaw", "Agent tooling."],
			["@forbes", "Business news."],
			["@MIT", "Massachusetts Institute of Technology."],
			["@Microsoft", "Technology company."],
			["@Qantas", "Airline."],
		] as const) {
			const link = screen.getByRole("link", { name: handle });
			fireEvent.pointerEnter(link.parentElement as Element);
			expect(screen.getByText(bio)).toBeInTheDocument();
		}
		expect(
			await screen.findByText("Peter ships agent tools with practical taste."),
		).toBeInTheDocument();
		await waitFor(() => {
			const calls = fetchMock.mock.calls as unknown as Array<
				[RequestInfo | URL]
			>;
			const firstInput = calls[0]?.[0];
			expect(firstInput).toBeDefined();
			const url = new URL(String(firstInput), "http://localhost");
			expect(url.pathname).toBe("/api/profile-analysis");
			expect(url.searchParams.get("handle")).toBe("steipete");
		});
		const hydrateCall = fetchMock.mock.calls.find(([input]) =>
			String(input).includes("/api/profile-hydrate"),
		);
		expect(hydrateCall).toBeDefined();
		const hydrateUrl = new URL(String(hydrateCall?.[0]), "http://localhost");
		expect(hydrateUrl.searchParams.get("handles")).toBe(
			"openclaw,forbes,mit,microsoft,qantas",
		);
	});
});
