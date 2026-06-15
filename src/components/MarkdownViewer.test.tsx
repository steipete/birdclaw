import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PeriodDigestContext } from "#/lib/period-digest";
import type { ProfileAnalysisContext } from "#/lib/profile-analysis";
import { MarkdownViewer } from "./MarkdownViewer";

const authorProfile = {
	id: "profile_chainzenit",
	handle: "ChainZenit",
	displayName: "Strata",
	bio: "",
	followersCount: 0,
	avatarHue: 280,
	createdAt: "2026-05-18T08:00:00.000Z",
};

const context = {
	window: {
		label: "Today",
		since: "2026-05-18T00:00:00.000Z",
		until: "2026-05-18T12:00:00.000Z",
	},
	includeDms: false,
	counts: {
		home: 1,
		mentions: 1,
		authored: 0,
		likes: 0,
		bookmarks: 0,
		dms: 0,
		links: 0,
	},
	tweets: [
		{
			id: "2056286865875935400",
			url: "https://x.com/ChainZenit/status/2056286865875935400",
			source: "mentions",
			author: "ChainZenit",
			name: "Strata",
			authorProfile,
			createdAt: "2026-05-18T09:12:00.000Z",
			text: "@GOATNetwork @openclaw oh nice, autonomous agents running on goAT https://t.co/goat",
			entities: {
				urls: [
					{
						url: "https://t.co/goat",
						expandedUrl: "https://goat.network/agents",
						displayUrl: "goat.network/agents",
						start: 66,
						end: 83,
					},
				],
			},
			likeCount: 0,
			liked: false,
			bookmarked: false,
			needsReply: true,
		},
		{
			id: "2057574939775938900",
			url: "https://x.com/kilocode/status/2057574939775938900",
			source: "home",
			author: "kilocode",
			name: "Kilo Code",
			authorProfile: {
				...authorProfile,
				id: "profile_kilocode",
				handle: "kilocode",
				displayName: "Kilo Code",
			},
			createdAt: "2026-05-18T10:12:00.000Z",
			text: "StepFun Step 3.5 Flash is the most-used free model in Kilo modes.",
			likeCount: 42,
			liked: false,
			bookmarked: false,
			needsReply: false,
		},
		{
			id: "2057578665408434460",
			url: "https://x.com/kilocode/status/2057578665408434460",
			source: "home",
			author: "kilocode",
			name: "Kilo Code",
			authorProfile: {
				...authorProfile,
				id: "profile_kilocode",
				handle: "kilocode",
				displayName: "Kilo Code",
			},
			createdAt: "2026-05-18T10:15:00.000Z",
			text: "BYOK access reaches Opus, GPT-5.5, Gemini 3, and more.",
			likeCount: 43,
			liked: false,
			bookmarked: false,
			needsReply: false,
		},
	],
	dms: [],
	links: [],
	hash: "demo",
} satisfies PeriodDigestContext;

const profileAnalysisContext = {
	handle: "steipete",
	accountId: "account_steipete",
	accountHandle: "steipete",
	profile: {
		id: "profile_steipete",
		handle: "steipete",
		displayName: "Peter Steinberger",
		bio: "Builder",
		followersCount: 123,
		avatarHue: 18,
		createdAt: "2009-03-19T22:54:05.000Z",
	},
	profiles: [
		{
			id: "profile_openai",
			handle: "OpenAI",
			displayName: "OpenAI",
			bio: "AI research and products.",
			followersCount: 7_000_000,
			avatarHue: 160,
			avatarUrl: "https://pbs.twimg.com/profile_images/openai_normal.jpg",
			createdAt: "2015-12-11T00:00:00.000Z",
		},
	],
	externalUserId: "123",
	tweets: [
		{
			id: "2055621934319030779",
			url: "https://x.com/steipete/status/2055621934319030779",
			author: "steipete",
			createdAt: "2026-05-28T09:12:00.000Z",
			text: "I work at OpenAI and build coding agents.",
			likeCount: 50,
			replyCount: 4,
			retweetCount: 3,
			quoteCount: 1,
			bookmarkedCount: 9,
		},
	],
	conversations: [
		{
			id: "2055858095759229148",
			url: "https://x.com/openclaw/status/2055858095759229148",
			author: "openclaw",
			createdAt: "2026-05-28T10:12:00.000Z",
			text: "OpenClaw Foundation/team context.",
			likeCount: 12,
			replyCount: 2,
			retweetCount: 1,
			quoteCount: 0,
			bookmarkedCount: 3,
			conversationRootId: "2055858095759229148",
			profileId: "profile_user_42",
			name: "OpenClaw",
			bio: "Agent tooling",
			followersCount: 456,
			avatarUrl: "https://pbs.twimg.com/profile_images/openclaw_normal.jpg",
		},
		{
			id: "2061001416454439313",
			url: "https://x.com/vincent_koc/status/2061001416454439313",
			author: "vincent_koc",
			createdAt: "2026-05-30T10:12:00.000Z",
			text: "Users ask for support in replies.",
			likeCount: 3,
			replyCount: 1,
			retweetCount: 0,
			quoteCount: 0,
			bookmarkedCount: 1,
			conversationRootId: "2061001416454439313",
			profileId: "profile_user_99",
			name: "Vincent Koc",
			bio: "Builder",
			followersCount: 789,
			avatarUrl: "https://pbs.twimg.com/profile_images/vincent_normal.jpg",
		},
	],
	counts: {
		tweets: 1,
		tweetPages: 1,
		conversationsScanned: 1,
		conversationTweets: 1,
		conversationPages: 1,
	},
	fetchCached: true,
	hash: "profile-demo",
} satisfies ProfileAnalysisContext;

describe("MarkdownViewer", () => {
	afterEach(cleanup);

	it("uses compact report spacing", () => {
		const { container } = render(
			<MarkdownViewer
				context={context}
				markdown={"Opening summary.\n\n## Themes\n\n- First item"}
			/>,
		);

		expect(container.querySelector("article")).toHaveClass("leading-[1.55]");
		expect(screen.getByText("Opening summary.")).toHaveClass("first:mt-0");
		expect(screen.getByText("Themes")).toHaveClass("first:mt-0");
	});

	it("links generated tweet citations without showing raw ids", () => {
		render(
			<MarkdownViewer
				context={context}
				markdown={
					"ChainZenit reacted positively to “autonomous agents running on goAT” (tweet_2056286865875935400)."
				}
			/>,
		);

		expect(
			screen.queryByText(/tweet_2056286865875935400/),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("link", {
				name: "“autonomous agents running on goAT”",
			}),
		).toHaveAttribute(
			"href",
			"https://x.com/ChainZenit/status/2056286865875935400",
		);
		expect(
			screen.getByRole("link", {
				name: "“autonomous agents running on goAT”",
			}),
		).not.toHaveClass("font-mono");
	});

	it("links profile analysis numeric citations from its profile context", () => {
		render(
			<MarkdownViewer
				context={profileAnalysisContext}
				markdown={
					"Peter explicitly says he works at OpenAI and describes the OpenClaw team structure (2055621934319030779) (2055858095759229148)."
				}
			/>,
		);

		expect(screen.queryByText(/2055621934319030779/)).not.toBeInTheDocument();
		expect(screen.queryByText(/2055858095759229148/)).not.toBeInTheDocument();
		expect(
			screen.getByRole("link", {
				name: "Peter explicitly says he works at OpenAI",
			}),
		).toHaveAttribute(
			"href",
			"https://x.com/steipete/status/2055621934319030779",
		);
		const openClawCitation = screen.getByRole("link", {
			name: "describes the OpenClaw team structure",
		});
		expect(openClawCitation).toHaveAttribute(
			"href",
			"https://x.com/openclaw/status/2055858095759229148",
		);
		fireEvent.pointerEnter(openClawCitation.parentElement as Element);
		expect(screen.getByAltText("OpenClaw")).toHaveAttribute(
			"src",
			"/api/avatar?profileId=profile_user_42&v=https%3A%2F%2Fpbs.twimg.com%2Fprofile_images%2Fopenclaw_normal.jpg",
		);
	});

	it("renders normal markdown links without changing the surrounding text font", () => {
		render(
			<MarkdownViewer
				context={context}
				markdown={
					"- [Kilo update](https://example.com/kilo) mattered because BYOK access broadened (tweet_2057578665408434460)."
				}
			/>,
		);

		const link = screen.getByRole("link", { name: "Kilo update" });
		expect(link).toHaveAttribute("href", "https://example.com/kilo");
		expect(link).not.toHaveClass("font-mono");
		expect(
			screen.getByRole("link", {
				name: "mattered because BYOK access broadened",
			}),
		).toHaveAttribute(
			"href",
			"https://x.com/kilocode/status/2057578665408434460",
		);
	});

	it("renders model-emitted markdown links with spaces or wrapped URLs", () => {
		render(
			<MarkdownViewer
				context={context}
				markdown={[
					"- [Lucid Windows accessibility tool announcement] (https://x.com/zhangdao439566/status/2057755065876938783) connects desktop control to accessibility use cases.",
					"- [Kitze’s Benji rewrite thread]",
					"(https://x.com/thekitze/status/2057748944592277563) is useful for long-running product iteration.",
				].join("\n")}
			/>,
		);

		expect(
			screen.getByRole("link", {
				name: "Lucid Windows accessibility tool announcement",
			}),
		).toHaveAttribute(
			"href",
			"https://x.com/zhangdao439566/status/2057755065876938783",
		);
		expect(
			screen.getByRole("link", { name: "Kitze’s Benji rewrite thread" }),
		).toHaveAttribute(
			"href",
			"https://x.com/thekitze/status/2057748944592277563",
		);
		expect(screen.queryByText("[Kitze’s Benji rewrite thread]")).toBeNull();
	});

	it("links comma-separated tweet citations to nearby readable text", () => {
		render(
			<MarkdownViewer
				context={context}
				markdown={
					"@kilocode says StepFun is widely used, with BYOK access to Opus, GPT-5.5, Gemini 3, and 500+ models at provider cost (tweet_2057574939775938900, tweet_2057578665408434460)."
				}
			/>,
		);

		expect(
			screen.queryByText(/tweet_2057574939775938900/),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText(/tweet_2057578665408434460/),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("link", {
				name: "says StepFun is widely used, with BYOK access to Opus, GPT-5.5, Gemini 3",
			}),
		).toHaveAttribute(
			"href",
			"https://x.com/kilocode/status/2057574939775938900",
		);
		expect(
			screen.getByRole("link", {
				name: "500+ models at provider cost",
			}),
		).toHaveAttribute(
			"href",
			"https://x.com/kilocode/status/2057578665408434460",
		);
		expect(screen.queryByRole("link", { name: "source 2" })).toBeNull();
	});

	it("keeps mixed unresolved grouped tweet citations visible", () => {
		render(
			<MarkdownViewer
				context={context}
				markdown={
					"@kilocode says StepFun is widely used (tweet_2057574939775938900, tweet_missing)."
				}
			/>,
		);

		expect(
			screen.getByText("(tweet_2057574939775938900, tweet_missing)", {
				exact: false,
			}),
		).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: "source 2" })).toBeNull();
	});

	it("keeps adjacent mixed unresolved tweet citations visible", () => {
		render(
			<MarkdownViewer
				context={context}
				markdown={
					"@kilocode says StepFun is widely used (tweet_2057574939775938900) (tweet_missing)."
				}
			/>,
		);

		expect(
			screen.queryByText(/tweet_2057574939775938900/),
		).not.toBeInTheDocument();
		expect(
			screen.getByText("(tweet_missing)", { exact: false }),
		).toBeInTheDocument();
	});

	it("links unresolved numeric citations without leaking raw ids", () => {
		render(
			<MarkdownViewer
				context={profileAnalysisContext}
				markdown={
					"People ask for product support inline source (2069999999999999999) source source."
				}
			/>,
		);

		expect(screen.queryByText(/2069999999999999999/)).not.toBeInTheDocument();
		expect(
			screen.getByRole("link", {
				name: "People ask for product support inline source",
			}),
		).toHaveAttribute("href", "https://x.com/i/status/2069999999999999999");
		expect(screen.queryByText(" source source.")).toBeNull();
	});

	it("links unresolved prefixed tweet citations without leaking raw ids", () => {
		const { container } = render(
			<MarkdownViewer
				context={context}
				markdown={
					"- **“Don’t trust the agent blindly” became the dominant AI-coding take.** Systems understanding still matters. (tweet_2060088112257372610, tweet_2060279326134747518, tweet_2060263961975480675)"
				}
			/>,
		);

		expect(screen.queryByText(/tweet_2060088112257372610/)).toBeNull();
		expect(screen.queryByText(/tweet_2060279326134747518/)).toBeNull();
		expect(screen.queryByText(/tweet_2060263961975480675/)).toBeNull();
		expect(
			container.querySelector(
				'a[href="https://x.com/i/status/2060088112257372610"]',
			),
		).not.toBeNull();
		expect(
			container.querySelector(
				'a[href="https://x.com/i/status/2060279326134747518"]',
			),
		).not.toBeNull();
		expect(
			container.querySelector(
				'a[href="https://x.com/i/status/2060263961975480675"]',
			),
		).not.toBeNull();
	});

	it("groups adjacent numeric profile citations", () => {
		render(
			<MarkdownViewer
				context={profileAnalysisContext}
				markdown={
					"Peter describes OpenAI and OpenClaw roles (2055621934319030779) (2055858095759229148) (2061001416454439313)."
				}
			/>,
		);

		expect(screen.queryByText(/2055621934319030779/)).not.toBeInTheDocument();
		expect(screen.queryByText(/2055858095759229148/)).not.toBeInTheDocument();
		expect(screen.queryByText(/2061001416454439313/)).not.toBeInTheDocument();
		expect(
			screen.getByRole("link", {
				name: "Peter describes OpenAI and OpenClaw roles",
			}),
		).toHaveAttribute(
			"href",
			"https://x.com/steipete/status/2055621934319030779",
		);
		expect(screen.getByRole("link", { name: "source 2" })).toHaveAttribute(
			"href",
			"https://x.com/openclaw/status/2055858095759229148",
		);
		expect(screen.getByRole("link", { name: "source 3" })).toHaveAttribute(
			"href",
			"https://x.com/vincent_koc/status/2061001416454439313",
		);
		expect(screen.queryByRole("link", { name: "source" })).toBeNull();
	});

	it("links adjacent profile citations to readable clauses when possible", () => {
		render(
			<MarkdownViewer
				context={profileAnalysisContext}
				markdown={
					"Peter discusses OpenAI, OpenClaw, and support workflows (2055621934319030779) (2055858095759229148) (2061001416454439313)."
				}
			/>,
		);

		expect(
			screen.getByRole("link", { name: "Peter discusses OpenAI" }),
		).toHaveAttribute(
			"href",
			"https://x.com/steipete/status/2055621934319030779",
		);
		expect(screen.getByRole("link", { name: "OpenClaw" })).toHaveAttribute(
			"href",
			"https://x.com/openclaw/status/2055858095759229148",
		);
		expect(
			screen.getByRole("link", { name: "support workflows" }),
		).toHaveAttribute(
			"href",
			"https://x.com/vincent_koc/status/2061001416454439313",
		);
		expect(screen.queryByRole("link", { name: "source 2" })).toBeNull();
		expect(screen.queryByRole("link", { name: "source 3" })).toBeNull();
	});

	it("renders hydrated profile mentions with profile previews", () => {
		render(
			<MarkdownViewer
				context={profileAnalysisContext}
				markdown={"He works with @OpenAI and @openclaw on agent tooling."}
			/>,
		);

		const openAiLink = screen.getByRole("link", { name: "@OpenAI" });
		expect(openAiLink).toHaveAttribute("href", "/profiles/OpenAI");
		const openClawLink = screen.getByRole("link", { name: "@openclaw" });
		expect(openClawLink).toHaveAttribute("href", "/profiles/openclaw");
		fireEvent.pointerEnter(openAiLink.parentElement as Element);
		expect(screen.getByText("AI research and products.")).toBeInTheDocument();
		fireEvent.pointerEnter(openClawLink.parentElement as Element);
		expect(screen.getByText("Agent tooling")).toBeInTheDocument();
	});

	it("links standalone unresolved numeric citations", () => {
		render(
			<MarkdownViewer
				context={profileAnalysisContext}
				markdown={"**Evidence:** (2069999999999999999)"}
			/>,
		);

		expect(screen.queryByText(/2069999999999999999/)).not.toBeInTheDocument();
		expect(screen.getByRole("link", { name: "source" })).toHaveAttribute(
			"href",
			"https://x.com/i/status/2069999999999999999",
		);
	});

	it("keeps real source-prefixed prose after citations", () => {
		render(
			<MarkdownViewer
				context={context}
				markdown={"Claim (tweet_2056286865875935400) source code is available."}
			/>,
		);

		expect(screen.getByText(/source code is available/)).toBeInTheDocument();
	});

	it("links full claims that legitimately end in source", () => {
		render(
			<MarkdownViewer
				context={context}
				markdown={"The project is open source (tweet_2056286865875935400)."}
			/>,
		);

		expect(
			screen.getByRole("link", { name: "The project is open source" }),
		).toHaveAttribute(
			"href",
			"https://x.com/ChainZenit/status/2056286865875935400",
		);
	});

	it("links unresolved source-ending claims without collapsing the label", () => {
		render(
			<MarkdownViewer
				context={profileAnalysisContext}
				markdown={"The project is open source (2069999999999999999) source."}
			/>,
		);

		expect(
			screen.getByRole("link", { name: "The project is open source" }),
		).toHaveAttribute("href", "https://x.com/i/status/2069999999999999999");
		expect(screen.queryByText(" source.")).toBeNull();
	});

	it("does not link arbitrary standalone long numbers", () => {
		render(
			<MarkdownViewer
				context={profileAnalysisContext}
				markdown={"Customer 123456789012345 remains pending."}
			/>,
		);

		expect(screen.getByText(/123456789012345/)).toBeInTheDocument();
		expect(screen.queryByRole("link")).toBeNull();
	});

	it("renders all grouped citation links when no readable text precedes", () => {
		render(
			<MarkdownViewer
				context={context}
				markdown={
					"**Kilo:** (tweet_2057574939775938900, tweet_2057578665408434460)."
				}
			/>,
		);

		expect(screen.getByRole("link", { name: "source 1" })).toHaveAttribute(
			"href",
			"https://x.com/kilocode/status/2057574939775938900",
		);
		expect(screen.getByRole("link", { name: "source 2" })).toHaveAttribute(
			"href",
			"https://x.com/kilocode/status/2057578665408434460",
		);
		expect(
			screen.queryByText(/tweet_2057574939775938900/),
		).not.toBeInTheDocument();
	});

	it("closes a tweet preview after opening the tweet link", () => {
		render(
			<MarkdownViewer
				context={context}
				markdown={
					"ChainZenit reacted positively to “autonomous agents running on goAT” (tweet_2056286865875935400)."
				}
			/>,
		);

		const link = screen.getByRole("link", {
			name: "“autonomous agents running on goAT”",
		});
		const wrapper = link.parentElement;
		expect(wrapper).not.toBeNull();
		expect(screen.queryByText(/https:\/\/goat\.network\/agents/)).toBeNull();

		fireEvent.pointerEnter(wrapper as Element);
		expect(screen.getByRole("tooltip")).toHaveTextContent(
			/https:\/\/goat\.network\/agents/,
		);

		fireEvent.click(link, { metaKey: true });
		expect(screen.queryByRole("tooltip")).toBeNull();
	});

	it("expands Twitter Articles inside citation popovers", () => {
		const articleContext = {
			...context,
			tweets: [
				{
					...context.tweets[0],
					id: "2066182223213293753",
					url: "https://x.com/satyanadella/status/2066182223213293753",
					author: "satyanadella",
					name: "Satya Nadella",
					text: "https://t.co/vLmiBKTtX3",
					entities: {
						article: {
							title: "A frontier without an ecosystem is not stable",
							previewText: "I have been thinking about the future of the firm.",
							url: "https://x.com/satyanadella/status/2066182223213293753",
						},
					},
				},
			],
		} satisfies PeriodDigestContext;
		render(
			<MarkdownViewer
				context={articleContext}
				markdown={"Satya published a new essay (2066182223213293753)."}
			/>,
		);

		const link = screen.getByRole("link", {
			name: "Satya published a new essay",
		});
		fireEvent.pointerEnter(link.parentElement as Element);

		expect(screen.getByRole("tooltip")).toHaveTextContent(
			"A frontier without an ecosystem is not stable",
		);
		expect(screen.getByRole("tooltip")).toHaveTextContent(
			"I have been thinking about the future of the firm.",
		);
		expect(screen.getByRole("tooltip")).not.toHaveTextContent("t.co");
	});
});
