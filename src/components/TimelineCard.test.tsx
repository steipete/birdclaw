import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConversationSurface } from "#/lib/conversation-surface";
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
				imageUrl: "https://example.com/preview.jpg",
				siteName: "Example",
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
	afterEach(() => {
		cleanup();
		resetConversationSurface();
		vi.unstubAllGlobals();
	});

	it("renders tweet metadata and replies", () => {
		const onReply = vi.fn();
		const { container } = render(
			<TimelineCard item={item} onReply={onReply} />,
		);

		expect(screen.getByText(/Ship with/)).toBeInTheDocument();
		expect(screen.getAllByText("@sam")[0]).toBeInTheDocument();
		expect(screen.getByText("Earlier tweet")).toBeInTheDocument();
		expect(screen.getAllByText("Quoted tweet")[1]).toBeInTheDocument();
		expect(screen.getByAltText("Demo image")).toBeInTheDocument();
		expect(screen.getByText("Demo link")).toBeInTheDocument();
		expect(
			screen.queryByRole("img", { name: "Demo link" }),
		).not.toBeInTheDocument();
		expect(container.querySelectorAll("header p")).toHaveLength(0);
		fireEvent.click(screen.getByRole("button", { name: "Reply" }));
		expect(onReply).toHaveBeenCalledWith("tweet_1");
	});

	it("renders retweets as the original tweet with repost attribution", () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ ok: true, anchorId: "tweet_original", items: [] }),
		});
		vi.stubGlobal("fetch", fetchMock);
		const onReply = vi.fn();
		const { container } = render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_rt",
					text: "RT @ava: Original app idea",
					entities: {},
					media: [],
					mediaCount: 0,
					replyToTweet: null,
					quotedTweet: null,
					retweetedTweet: {
						id: "tweet_original",
						text: "Original app idea",
						createdAt: "2026-03-08T11:55:00.000Z",
						isReplied: true,
						likeCount: 7,
						mediaCount: 0,
						bookmarked: false,
						liked: false,
						author: {
							id: "profile_3",
							handle: "ava",
							displayName: "Ava",
							bio: "Reporter",
							followersCount: 400,
							avatarHue: 120,
							avatarUrl: "https://example.com/ava.jpg",
							createdAt: "2026-03-08T09:00:00.000Z",
						},
						entities: {},
						media: [],
					},
				}}
				onReply={onReply}
			/>,
		);

		expect(screen.getByText("Sam Altman reposted")).toBeInTheDocument();
		expect(screen.getAllByAltText("Ava")[0]).toHaveAttribute(
			"src",
			expect.stringContaining("/api/avatar?profileId=profile_3&v="),
		);
		expect(screen.getByText("Original app idea")).toBeInTheDocument();
		expect(screen.getAllByText("@ava").length).toBeGreaterThan(0);
		expect(screen.getByLabelText("We replied")).toBeInTheDocument();
		expect(screen.getByText("7")).toBeInTheDocument();
		expect(screen.queryByText("not bookmarked")).not.toBeInTheDocument();
		expect(screen.queryByText("Reposted tweet")).not.toBeInTheDocument();
		expect(screen.queryByText(/RT @ava/)).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Reply" }));
		expect(onReply).toHaveBeenCalledWith("tweet_original");

		const row = container.querySelector("[data-perf='timeline-card']");
		if (!row) throw new Error("timeline card missing");
		fireEvent.click(row);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/conversation?tweetId=tweet_original",
		);
	});

	it("uses the wrapper tweet id for manual retweet interactions", () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ ok: true, anchorId: "tweet_manual", items: [] }),
		});
		vi.stubGlobal("fetch", fetchMock);
		const onReply = vi.fn();
		const { container } = render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_manual",
					text: "RT @ava: Original app idea",
					entities: {},
					media: [],
					mediaCount: 0,
					replyToTweet: null,
					quotedTweet: null,
					retweetedTweet: {
						id: "tweet_manual:retweeted",
						text: "Original app idea",
						createdAt: "2026-03-08T11:55:00.000Z",
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
				}}
				onReply={onReply}
			/>,
		);

		expect(screen.getByText("Original app idea")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Reply" }));
		expect(onReply).toHaveBeenCalledWith("tweet_manual");

		const row = container.querySelector("[data-perf='timeline-card']");
		if (!row) throw new Error("timeline card missing");
		fireEvent.click(row);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/conversation?tweetId=tweet_manual",
		);
	});

	it("keeps duplicate retweet rows independently expandable", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				ok: true,
				anchorId: "tweet_original",
				items: [
					{
						id: "tweet_original",
						text: "Original conversation",
						createdAt: "2026-03-08T11:55:00.000Z",
						replyToId: null,
						author: item.author,
						entities: {},
						media: [],
					},
					{
						id: "tweet_original_reply",
						text: "Reply in conversation",
						createdAt: "2026-03-08T11:56:00.000Z",
						replyToId: "tweet_original",
						author: item.author,
						entities: {},
						media: [],
					},
				],
			}),
		});
		vi.stubGlobal("fetch", fetchMock);
		const retweetedTweet = {
			id: "tweet_original",
			text: "Original app idea",
			createdAt: "2026-03-08T11:55:00.000Z",
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
		};
		const { container } = render(
			<>
				<TimelineCard
					item={{ ...item, id: "tweet_rt_a", retweetedTweet }}
					onReply={vi.fn()}
				/>
				<TimelineCard
					item={{ ...item, id: "tweet_rt_b", retweetedTweet }}
					onReply={vi.fn()}
				/>
			</>,
		);
		const rows = container.querySelectorAll("[data-perf='timeline-card']");
		const first = rows[0];
		const second = rows[1];
		if (!first || !second) throw new Error("timeline cards missing");

		fireEvent.click(first);

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/conversation?tweetId=tweet_original",
		);
		expect(
			within(first as HTMLElement).getByRole("button", {
				name: "Hide conversation",
			}),
		).toHaveAttribute("aria-expanded", "true");
		expect(
			within(second as HTMLElement).getByRole("button", {
				name: "Show conversation",
			}),
		).toHaveAttribute("aria-expanded", "false");
		expect(
			await screen.findByText("Original conversation"),
		).toBeInTheDocument();
	});

	it("keeps link preview cards on native retweets", () => {
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_retweet_link",
					text: "RT @ava: Original link https://t.co/orig",
					entities: {},
					media: [],
					mediaCount: 0,
					replyToTweet: null,
					quotedTweet: null,
					retweetedTweet: {
						id: "tweet_original_link",
						text: "Original link https://t.co/orig",
						createdAt: "2026-03-08T11:55:00.000Z",
						author: {
							id: "profile_3",
							handle: "ava",
							displayName: "Ava",
							bio: "Reporter",
							followersCount: 400,
							avatarHue: 120,
							createdAt: "2026-03-08T09:00:00.000Z",
						},
						entities: {
							urls: [
								{
									url: "https://t.co/orig",
									expandedUrl: "https://example.com/original",
									displayUrl: "example.com/original",
									start: 14,
									end: 31,
									title: "Original link preview",
									description: "Preview from original reposted tweet",
									siteName: "Example",
								},
							],
						},
						media: [],
					},
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(screen.getByText("Original link preview")).toBeInTheDocument();
		expect(
			document.querySelector("[data-perf='link-preview-card']"),
		).not.toBeNull();
	});

	it("hides empty passive metadata", () => {
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
		expect(screen.getByLabelText("We replied")).toBeInTheDocument();
		expect(screen.queryByText("not bookmarked")).not.toBeInTheDocument();
		expect(screen.queryByText("0 media")).not.toBeInTheDocument();
		expect(screen.queryByText("@steipete")).not.toBeInTheDocument();
	});

	it("does not render reply state or actions for likes and bookmarks", () => {
		const onReply = vi.fn();
		const { container, rerender } = render(
			<TimelineCard
				item={{
					...item,
					kind: "like",
					isReplied: false,
					replyToTweet: null,
					quotedTweet: null,
				}}
				onReply={onReply}
				showReplyControls={false}
			/>,
		);
		const queries = within(container);

		expect(queries.queryByText("needs reply")).not.toBeInTheDocument();
		expect(queries.queryByText("replied")).not.toBeInTheDocument();
		expect(queries.queryByText("open")).not.toBeInTheDocument();
		expect(
			queries.queryByRole("button", { name: "Reply" }),
		).not.toBeInTheDocument();

		rerender(
			<TimelineCard
				item={{
					...item,
					kind: "bookmark",
					isReplied: false,
					replyToTweet: null,
					quotedTweet: null,
				}}
				onReply={onReply}
				showReplyControls={false}
			/>,
		);

		expect(queries.queryByText("needs reply")).not.toBeInTheDocument();
		expect(
			queries.queryByRole("button", { name: "Reply" }),
		).not.toBeInTheDocument();
		expect(onReply).not.toHaveBeenCalled();
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

	it("renders direct image URL cards with the image immediately", () => {
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_4",
					text: "@steipete https://t.co/image",
					entities: {
						urls: [
							{
								url: "https://t.co/image",
								expandedUrl: "https://pbs.twimg.com/media/HIB4bvDXQAAUcO8.png",
								displayUrl: "t.co/image",
								start: 10,
								end: 28,
							},
						],
					},
					replyToTweet: null,
					quotedTweet: null,
					media: [],
					mediaCount: 1,
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(screen.getByRole("img", { name: "pbs.twimg.com" })).toHaveAttribute(
			"src",
			"https://pbs.twimg.com/media/HIB4bvDXQAAUcO8.png",
		);
		expect(screen.getAllByText("pbs.twimg.com").length).toBeGreaterThan(0);
	});

	it("does not duplicate media URLs as text links or preview cards", () => {
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_5",
					text: "Screenshot https://t.co/image",
					entities: {
						urls: [
							{
								url: "https://t.co/image",
								expandedUrl: "https://pbs.twimg.com/media/HIB4bvDXQAAUcO8.png",
								displayUrl: "t.co/image",
								start: 11,
								end: 29,
							},
						],
					},
					media: [
						{
							url: "https://pbs.twimg.com/media/HIB4bvDXQAAUcO8.png?format=png&name=large",
							type: "image",
							altText: "Screenshot",
							width: 1200,
							height: 900,
						},
					],
					mediaCount: 1,
					replyToTweet: null,
					quotedTweet: null,
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(screen.getByText("Screenshot")).toBeInTheDocument();
		expect(screen.getByAltText("Screenshot")).toBeInTheDocument();
		expect(screen.queryByText("t.co/image")).not.toBeInTheDocument();
		expect(screen.queryByText("pbs.twimg.com")).not.toBeInTheDocument();
		expect(screen.queryByRole("link", { name: /t\.co\/image/ })).toBeNull();
	});

	it("does not duplicate pic.twitter.com media URLs as text links or preview cards", () => {
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_6",
					text: "Photo https://t.co/pic",
					entities: {
						urls: [
							{
								url: "https://t.co/pic",
								expandedUrl: "https://x.com/ava/status/tweet_6/photo/1",
								displayUrl: "pic.twitter.com/demo",
								start: 6,
								end: 22,
							},
						],
					},
					media: [
						{
							url: "https://pbs.twimg.com/media/demo.jpg",
							type: "image",
							altText: "Photo media",
						},
					],
					mediaCount: 1,
					replyToTweet: null,
					quotedTweet: null,
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(screen.getByText("Photo")).toBeInTheDocument();
		expect(screen.getByAltText("Photo media")).toBeInTheDocument();
		expect(screen.queryByText("pic.twitter.com/demo")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: /pic\.twitter\.com/ }),
		).toBeNull();
	});

	it("hides unresolved t.co text and preview cards when media is attached", () => {
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_short_media",
					text: "t.co/QbCcJuNZjo",
					entities: {
						urls: [
							{
								url: "https://t.co/QbCcJuNZjo",
								expandedUrl: "https://t.co/QbCcJuNZjo",
								displayUrl: "t.co/QbCcJuNZjo",
								start: 0,
								end: 15,
							},
						],
					},
					media: [
						{
							url: "https://pbs.twimg.com/media/tall.jpg",
							type: "image",
							altText: "Tall screenshot",
							width: 768,
							height: 1600,
						},
					],
					mediaCount: 1,
					replyToTweet: null,
					quotedTweet: null,
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(screen.getByAltText("Tall screenshot")).toBeInTheDocument();
		expect(screen.queryByText("t.co/QbCcJuNZjo")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: /t\.co\/QbCcJuNZjo/ }),
		).toBeNull();
	});

	it("keeps unresolved t.co links when the media tweet has other text", () => {
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_short_media_caption",
					text: "Read this https://t.co/article",
					entities: {
						urls: [
							{
								url: "https://t.co/article",
								expandedUrl: "https://t.co/article",
								displayUrl: "t.co/article",
								start: 10,
								end: 30,
							},
						],
					},
					media: [
						{
							url: "https://pbs.twimg.com/media/article-card.jpg",
							type: "image",
							altText: "Article image",
						},
					],
					mediaCount: 1,
					replyToTweet: null,
					quotedTweet: null,
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(screen.getByText("Read this")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "t.co/article" })).toHaveAttribute(
			"href",
			"https://t.co/article",
		);
		expect(screen.getByAltText("Article image")).toBeInTheDocument();
	});

	it("does not render placeholder preview cards for unresolved t.co links", () => {
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_unresolved_link",
					text: "He can't stop\n\nhttps://t.co/1b11HHQIBA",
					entities: {
						urls: [
							{
								url: "https://t.co/1b11HHQIBA",
								expandedUrl: "https://t.co/1b11HHQIBA",
								displayUrl: "t.co/1b11HHQIBA",
								start: 15,
								end: 38,
							},
						],
					},
					media: [],
					mediaCount: 0,
					replyToTweet: null,
					quotedTweet: null,
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(
			screen.getByRole("link", { name: "t.co/1b11HHQIBA" }),
		).toHaveAttribute("href", "https://t.co/1b11HHQIBA");
		expect(
			document.querySelector("[data-perf='link-preview-card']"),
		).toBeNull();
	});

	it("tolerates archived media URL entities without display URLs", () => {
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_missing_display_url",
					text: "Photo https://t.co/pic",
					entities: {
						urls: [
							{
								url: "https://t.co/pic",
								expandedUrl:
									"https://x.com/ava/status/tweet_missing_display_url/photo/1",
								displayUrl: undefined as unknown as string,
								start: 6,
								end: 22,
							},
						],
					},
					media: [
						{
							url: "https://pbs.twimg.com/media/missing-display.jpg",
							type: "image",
							altText: "Archived media",
						},
					],
					mediaCount: 1,
					replyToTweet: null,
					quotedTweet: null,
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(screen.getByText("Photo")).toBeInTheDocument();
		expect(screen.getByAltText("Archived media")).toBeInTheDocument();
		expect(screen.queryByText("undefined")).not.toBeInTheDocument();
		expect(screen.queryByRole("link", { name: /x\.com\/ava/ })).toBeNull();
	});

	it("keeps self-permalink URL entities on media tweets", () => {
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_self_permalink",
					text: "Thread https://t.co/self",
					entities: {
						urls: [
							{
								url: "https://t.co/self",
								expandedUrl: "https://x.com/ava/status/tweet_self_permalink",
								displayUrl: "x.com/ava/status/tweet_self_permalink",
								start: 7,
								end: 24,
							},
						],
					},
					media: [
						{
							url: "https://pbs.twimg.com/media/self-permalink.jpg",
							type: "image",
							altText: "Attached media",
						},
					],
					mediaCount: 1,
					replyToTweet: null,
					quotedTweet: null,
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(screen.getByAltText("Attached media")).toBeInTheDocument();
		expect(
			screen.getAllByRole("link", {
				name: /x\.com\/ava\/status\/tweet_self_permalink/,
			}).length,
		).toBeGreaterThan(0);
	});

	it("keeps external status media links when the tweet has its own media", () => {
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_7",
					text: "Look https://t.co/other https://t.co/pic2",
					entities: {
						urls: [
							{
								url: "https://t.co/other",
								expandedUrl: "https://x.com/other/status/123/photo/1",
								displayUrl: "x.com/other/status/123/photo/1",
								start: 5,
								end: 23,
							},
							{
								url: "https://t.co/pic2",
								expandedUrl: "https://x.com/other/status/456/photo/1",
								displayUrl: "pic.twitter.com/other",
								start: 24,
								end: 41,
							},
						],
					},
					media: [
						{
							url: "https://pbs.twimg.com/media/own.jpg",
							type: "image",
							altText: "Own media",
						},
					],
					mediaCount: 1,
					replyToTweet: null,
					quotedTweet: null,
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(screen.getByAltText("Own media")).toBeInTheDocument();
		expect(
			screen.getAllByRole("link", { name: /x\.com\/other\/status\/123/ }),
		).toHaveLength(2);
		expect(
			screen.getByRole("link", { name: "pic.twitter.com/other" }),
		).toHaveAttribute("href", "https://x.com/other/status/456/photo/1");
	});

	it("does not toggle conversation when closing the media viewer backdrop", () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_8",
					entities: {},
					media: [
						{
							url: "https://example.com/demo.jpg",
							type: "image",
							altText: "Demo image",
						},
					],
					replyToTweet: null,
					quotedTweet: null,
				}}
				onReply={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Open tweet media 1" }));
		fireEvent.click(screen.getByRole("dialog"));

		expect(fetchMock).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("expands the archived conversation when the tweet row is clicked", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				ok: true,
				anchorId: "tweet_1",
				items: [
					{
						id: "tweet_parent",
						text: "Parent in thread",
						createdAt: "2026-03-08T11:30:00.000Z",
						replyToId: null,
						author: item.author,
						entities: {},
						media: [],
					},
					{
						id: "tweet_1",
						text: "Clicked tweet in thread",
						createdAt: "2026-03-08T12:00:00.000Z",
						replyToId: "tweet_parent",
						author: item.author,
						entities: {},
						media: [],
					},
				],
			}),
		});
		vi.stubGlobal("fetch", fetchMock);
		const { container } = render(
			<TimelineCard item={item} onReply={vi.fn()} />,
		);
		const row = container.querySelector("[data-perf='timeline-card']");
		if (!row) throw new Error("timeline card missing");

		fireEvent.click(row);

		expect(fetchMock).toHaveBeenCalledWith("/api/conversation?tweetId=tweet_1");
		expect(await screen.findByText("Parent in thread")).toBeInTheDocument();
		expect(screen.getByText("2 tweets in conversation")).toBeInTheDocument();
		expect(screen.getByText("selected")).toBeInTheDocument();
	});

	it("prefetches conversation context on hover and keeps one thread open", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const tweetId = new URL(
				String(input),
				"http://localhost",
			).searchParams.get("tweetId");
			return {
				ok: true,
				json: async () => ({
					ok: true,
					anchorId: tweetId,
					items: [
						{
							id: tweetId,
							text: `Conversation for ${tweetId}`,
							createdAt: "2026-03-08T12:00:00.000Z",
							replyToId: null,
							author: item.author,
							entities: {},
							media: [],
						},
						{
							id: `${tweetId}_reply`,
							text: `Reply for ${tweetId}`,
							createdAt: "2026-03-08T12:01:00.000Z",
							replyToId: tweetId,
							author: item.author,
							entities: {},
							media: [],
						},
					],
				}),
			};
		});
		vi.stubGlobal("fetch", fetchMock);
		const { container } = render(
			<>
				<TimelineCard item={{ ...item, id: "tweet_a" }} onReply={vi.fn()} />
				<TimelineCard item={{ ...item, id: "tweet_b" }} onReply={vi.fn()} />
			</>,
		);
		const rows = container.querySelectorAll("[data-perf='timeline-card']");
		const first = rows[0];
		const second = rows[1];
		if (!first || !second) throw new Error("timeline cards missing");

		fireEvent.mouseEnter(first);
		expect(fetchMock).toHaveBeenCalledWith("/api/conversation?tweetId=tweet_a");

		fireEvent.click(first);
		expect(
			await screen.findByText("Conversation for tweet_a"),
		).toBeInTheDocument();

		fireEvent.click(second);
		expect(
			await screen.findByText("Conversation for tweet_b"),
		).toBeInTheDocument();
		expect(
			screen.queryByText("Conversation for tweet_a"),
		).not.toBeInTheDocument();
	});
});
