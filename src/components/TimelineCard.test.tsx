import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TimelineCard } from "./TimelineCard";

const item = {
	id: "tweet_1",
	accountId: "acct_primary",
	accountHandle: "@steipete",
	kind: "home" as const,
	text: "Ship with @sam https://t.co/demo",
	createdAt: "2026-03-08T12:00:00.000Z",
	isReplied: false,
	likeCount: 12,
	mediaCount: 1,
	bookmarked: true,
	liked: true,
	author: {
		id: "profile_1",
		handle: "sam",
		displayName: "Sam Altman",
		bio: "bio",
		followersCount: 12345,
		avatarHue: 210,
		createdAt: "2026-03-08T12:00:00.000Z",
	},
	entities: {
		mentions: [
			{
				username: "sam",
				id: "profile_1",
				start: 10,
				end: 14,
				profile: {
					id: "profile_1",
					handle: "sam",
					displayName: "Sam Altman",
					bio: "bio",
					followersCount: 12345,
					avatarHue: 210,
					createdAt: "2026-03-08T12:00:00.000Z",
				},
			},
		],
		urls: [
			{
				url: "https://t.co/demo",
				expandedUrl: "https://example.com/demo",
				displayUrl: "example.com/demo",
				start: 15,
				end: 32,
				title: "Demo link",
				description: "Link preview card",
			},
		],
	},
	media: [
		{
			url: "https://example.com/demo.jpg",
			type: "image" as const,
			altText: "Demo image",
		},
	],
	replyToTweet: {
		id: "tweet_0",
		text: "Earlier tweet",
		createdAt: "2026-03-08T11:00:00.000Z",
		author: {
			id: "profile_2",
			handle: "destraynor",
			displayName: "Des Traynor",
			bio: "Product",
			followersCount: 200,
			avatarHue: 90,
			createdAt: "2026-03-08T10:00:00.000Z",
		},
		entities: {},
		media: [],
	},
	quotedTweet: {
		id: "tweet_q",
		text: "Quoted tweet",
		createdAt: "2026-03-08T10:00:00.000Z",
		author: {
			id: "profile_3",
			handle: "ava",
			displayName: "Ava",
			bio: "Reporter",
			followersCount: 400,
			avatarHue: 120,
			createdAt: "2026-03-08T09:00:00.000Z",
		},
		entities: {},
		media: [],
	},
};

describe("TimelineCard", () => {
	it("renders tweet metadata and replies", () => {
		const onReply = vi.fn();
		const { container } = render(<TimelineCard item={item} onReply={onReply} />);

		expect(screen.getByText(/Ship with/)).toBeInTheDocument();
		expect(screen.getAllByText("@sam")[0]).toBeInTheDocument();
		expect(screen.getByText("Earlier tweet")).toBeInTheDocument();
		expect(screen.getAllByText("Quoted tweet")[1]).toBeInTheDocument();
		expect(screen.getByAltText("Demo image")).toBeInTheDocument();
		expect(screen.getByText("Demo link")).toBeInTheDocument();
		expect(container.querySelectorAll("header p")).toHaveLength(0);
		fireEvent.click(screen.getByRole("button", { name: "Reply" }));
		expect(onReply).toHaveBeenCalledWith("tweet_1");
	});

	it("renders replied and unbookmarked state", () => {
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_2",
					isReplied: true,
					bookmarked: false,
					mediaCount: 0,
					media: [],
					replyToTweet: null,
					quotedTweet: null,
					entities: {},
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(screen.getByText("replied")).toBeInTheDocument();
		expect(screen.getByText("not bookmarked")).toBeInTheDocument();
		expect(screen.getByText("0 media")).toBeInTheDocument();
	});

	it("filters quoted tweet urls and falls back to display urls in previews", () => {
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_3",
					entities: {
						urls: [
							{
								url: "https://t.co/quote",
								expandedUrl: "https://x.com/ava/status/tweet_q",
								displayUrl: "x.com/ava/status/tweet_q",
								start: 0,
								end: 10,
							},
							{
								url: "https://t.co/kept",
								expandedUrl: "https://example.com/kept",
								displayUrl: "example.com/kept",
								start: 11,
								end: 20,
							},
						],
					},
					replyToTweet: null,
					media: [],
					mediaCount: 0,
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(
			screen.getByRole("link", { name: "example.com/kept" }),
		).toBeInTheDocument();
		expect(screen.getAllByText("example.com/kept").length).toBeGreaterThan(1);
	});
});
