// @vitest-environment node
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { useTestHome } from "../test/test-home";
import { createRuntimeServices } from "./runtime-services";
import {
	FXTWITTER_ORIGIN,
	getTweetByIdViaFxTwitterEffect,
	importTweetsViaFxTwitterEffect,
	parseFxTwitterTweetId,
} from "./fxtwitter";

const testHome = useTestHome({ prefix: "birdclaw-fxtwitter-" });

function fxResponse(status: Record<string, unknown>, code = 200) {
	return new Response(JSON.stringify({ status, code }), {
		status: code,
		headers: { "content-type": "application/json" },
	});
}

function fixtureStatus(id = "20") {
	return {
		type: "status",
		id,
		text: "public tweet",
		created_at: "Tue Mar 21 20:50:14 +0000 2006",
		replies: 3,
		reposts: 4,
		likes: 5,
		bookmarks: 6,
		quotes: 7,
		views: 8,
		replying_to: { status: "10", user_id: "34" },
		author: {
			type: "profile",
			id: "12",
			screen_name: "jack",
			name: "Jack",
			description: "public profile",
			location: "",
			avatar_url: "https://pbs.twimg.com/profile_images/12/avatar_200x200.jpg",
			followers: 100,
			following: 2,
			statuses: 50,
			joined: "Tue Mar 21 20:50:14 +0000 2006",
			verification: { verified: true, type: "individual" },
		},
		media: {
			all: [
				{
					type: "photo",
					id: "99",
					url: "https://pbs.twimg.com/media/example.jpg?name=orig",
					width: 1200,
					height: 800,
				},
				{
					type: "photo",
					id: "100",
					url: "https://attacker.example/private.jpg",
				},
			],
		},
		quote: {
			type: "status",
			id: "56",
			text: "quoted public tweet",
			created_at: "Wed Mar 22 20:50:14 +0000 2006",
			author: {
				type: "profile",
				id: "34",
				screen_name: "quoted",
				name: "Quoted",
			},
			media: {},
		},
	};
}

describe("FxTwitter public tweet transport", () => {
	it("accepts only numeric IDs and canonical public status URLs", () => {
		expect(parseFxTwitterTweetId("20")).toBe("20");
		expect(parseFxTwitterTweetId("https://x.com/jack/status/20")).toBe("20");
		expect(
			parseFxTwitterTweetId("https://www.twitter.com/jack/status/20/"),
		).toBe("20");

		for (const unsafe of [
			"1",
			"https://api.fxtwitter.com/2/status/20",
			"http://x.com/jack/status/20",
			"https://x.com@127.0.0.1/jack/status/20",
			"https://x.com/jack/status/20?endpoint=http://127.0.0.1",
			"https://x.com/i/web/status/20",
		]) {
			expect(() => parseFxTwitterTweetId(unsafe)).toThrow(
				/canonical|only a tweet ID/,
			);
		}
	});

	it("uses the fixed endpoint, rejects redirects, and marks normalized rows", async () => {
		const fetch = vi.fn().mockResolvedValue(fxResponse(fixtureStatus()));
		const result = await Effect.runPromise(
			getTweetByIdViaFxTwitterEffect(
				"https://x.com/jack/status/20",
				createRuntimeServices({ fetch }),
			),
		);

		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch).toHaveBeenCalledWith(`${FXTWITTER_ORIGIN}/2/status/20`, {
			method: "GET",
			headers: {
				Accept: "application/json",
				"User-Agent": "birdclaw/fxtwitter-read-only",
			},
			redirect: "error",
			signal: expect.any(AbortSignal),
		});
		expect(result.payload).toMatchObject({
			data: [
				{
					id: "20",
					author_id: "12",
					text: "public tweet",
					referenced_tweets: [
						{ type: "replied_to", id: "10" },
						{ type: "quoted", id: "56" },
					],
					public_metrics: { like_count: 5, impression_count: 8 },
				},
			],
			includes: {
				tweets: [{ id: "56", author_id: "34" }],
				users: [{ id: "12", username: "jack" }, { id: "34" }],
				media: [
					{
						media_key: "fxtwitter:20:99",
						url: "https://pbs.twimg.com/media/example.jpg?name=orig",
					},
				],
			},
			meta: {
				source: "fxtwitter",
				endpoint: FXTWITTER_ORIGIN,
				read_only: true,
			},
		});
		expect([...result.provenance.entries()]).toEqual([
			["56", `${FXTWITTER_ORIGIN}/2/status/20`],
			["20", `${FXTWITTER_ORIGIN}/2/status/20`],
		]);
	});

	it("validates all inputs before making any request", async () => {
		const fetch = vi.fn();
		await expect(
			Effect.runPromise(
				importTweetsViaFxTwitterEffect(
					["20", "https://private.example/status/30"],
					createRuntimeServices({ fetch }),
				),
			),
		).rejects.toThrow(/only a tweet ID/);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects unavailable, mismatched, and oversized responses", async () => {
		const unavailable = createRuntimeServices({
			fetch: vi
				.fn()
				.mockResolvedValue(
					fxResponse(
						{ type: "tombstone", id: "20", reason: "unavailable" },
						404,
					),
				),
		});
		await expect(
			Effect.runPromise(getTweetByIdViaFxTwitterEffect("20", unavailable)),
		).rejects.toThrow(/status 404/);

		const mismatched = createRuntimeServices({
			fetch: vi.fn().mockResolvedValue(fxResponse(fixtureStatus("21"))),
		});
		await expect(
			Effect.runPromise(getTweetByIdViaFxTwitterEffect("20", mismatched)),
		).rejects.toThrow(/returned tweet 21/);

		const oversized = createRuntimeServices({
			fetch: vi.fn().mockResolvedValue(
				new Response("{}", {
					headers: { "content-length": String(2 * 1024 * 1024 + 1) },
				}),
			),
		});
		await expect(
			Effect.runPromise(getTweetByIdViaFxTwitterEffect("20", oversized)),
		).rejects.toThrow(/too large/);
	});

	it("persists canonical tweets with durable FxTwitter provenance", async () => {
		const fetch = vi.fn().mockResolvedValue(fxResponse(fixtureStatus()));
		const result = await Effect.runPromise(
			importTweetsViaFxTwitterEffect(["20"], createRuntimeServices({ fetch })),
		);

		expect(result).toMatchObject({
			ok: true,
			readOnlyTransport: true,
			source: "fxtwitter",
			endpoint: FXTWITTER_ORIGIN,
			requestedCount: 1,
			importedCount: 1,
			items: [
				{
					tweetId: "20",
					source: "fxtwitter",
					sourceUrl: `${FXTWITTER_ORIGIN}/2/status/20`,
				},
			],
		});
		expect(
			testHome()
				.db.prepare(
					"select tweet_id, source, source_url from tweet_sources order by tweet_id",
				)
				.all(),
		).toEqual([
			{
				tweet_id: "20",
				source: "fxtwitter",
				source_url: `${FXTWITTER_ORIGIN}/2/status/20`,
			},
			{
				tweet_id: "56",
				source: "fxtwitter",
				source_url: `${FXTWITTER_ORIGIN}/2/status/20`,
			},
		]);
		expect(
			testHome().db.prepare("select id, text from tweets order by id").all(),
		).toEqual([
			{ id: "20", text: "public tweet" },
			{ id: "56", text: "quoted public tweet" },
		]);
	});
});
