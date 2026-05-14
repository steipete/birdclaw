// @vitest-environment node
import { describe, expect, it } from "vitest";
import { __test__ as birdTest } from "./bird";
import { buildMediaJsonFromIncludes, countTweetMedia } from "./media-includes";
import type { XurlMediaItem } from "./types";

const photo: XurlMediaItem = {
	media_key: "photo_1",
	type: "photo",
	url: "https://pbs.twimg.com/media/photo_1.jpg",
	alt_text: "diagram",
	width: 1200,
	height: 800,
};
const video: XurlMediaItem = {
	media_key: "video_1",
	type: "video",
	preview_image_url: "https://pbs.twimg.com/ext_tw_video_thumb/v.jpg",
	duration_ms: 46947,
	variants: [
		{
			url: "https://video.twimg.com/low.mp4",
			content_type: "video/mp4",
			bit_rate: 832000,
		},
		{
			url: "https://video.twimg.com/high.mp4",
			content_type: "video/mp4",
			bit_rate: 2176000,
		},
		{
			url: "https://video.twimg.com/playlist.m3u8",
			content_type: "application/x-mpegURL",
		},
	],
};
const gif: XurlMediaItem = {
	media_key: "gif_1",
	type: "animated_gif",
	preview_image_url: "https://pbs.twimg.com/tweet_video_thumb/g.jpg",
	variants: [
		{ url: "https://video.twimg.com/gif.mp4", content_type: "video/mp4" },
	],
};

function media(keys: string[], includes: XurlMediaItem[]) {
	return JSON.parse(
		buildMediaJsonFromIncludes({ attachments: { media_keys: keys } }, includes),
	);
}

describe("media includes mapping", () => {
	it("serializes photos", () => {
		expect(media(["photo_1"], [photo])).toEqual([
			{
				url: photo.url,
				type: "image",
				altText: "diagram",
				width: 1200,
				height: 800,
			},
		]);
	});

	it("serializes video mp4 variants in highest bitrate order", () => {
		expect(media(["video_1"], [video])[0]).toMatchObject({
			url: video.preview_image_url,
			type: "video",
			thumbnailUrl: video.preview_image_url,
			durationMs: 46947,
			variants: [
				{ url: "https://video.twimg.com/high.mp4", bitRate: 2176000 },
				{ url: "https://video.twimg.com/low.mp4", bitRate: 832000 },
			],
		});
	});

	it("serializes animated gifs as local gif media with mp4 variants", () => {
		expect(media(["gif_1"], [gif])[0]).toMatchObject({
			url: gif.preview_image_url,
			type: "gif",
			variants: [{ url: "https://video.twimg.com/gif.mp4" }],
		});
	});

	it("maps unknown remote media types to local unknown media", () => {
		expect(
			media(
				["space_1"],
				[
					{
						media_key: "space_1",
						type: "audio_space",
						url: "https://pbs.twimg.com/media/space.jpg",
					},
				],
			),
		).toEqual([
			{
				url: "https://pbs.twimg.com/media/space.jpg",
				type: "unknown",
			},
		]);
	});

	it("preserves mixed media order from tweet attachments", () => {
		expect(
			media(["video_1", "photo_1"], [photo, video]).map(
				(item: { type: string }) => item.type,
			),
		).toEqual(["video", "image"]);
	});

	it("returns empty JSON when there are no media keys", () => {
		expect(buildMediaJsonFromIncludes({}, [])).toBe("[]");
		expect(countTweetMedia({})).toBe(0);
	});

	it("skips dangling media keys but still counts them as tweet media", () => {
		const tweet = { attachments: { media_keys: ["missing"] } };
		expect(buildMediaJsonFromIncludes(tweet, [])).toBe("[]");
		expect(countTweetMedia(tweet)).toBe(1);
	});

	it("rejects shortlink and non-media entity fallback urls", () => {
		const tweet = {
			entities: {
				urls: [
					{
						media_key: "3_123",
						url: "https://t.co/photo",
						expanded_url: "https://example.com/not-media",
						images: [
							{ url: "https://t.co/image" },
							{ url: "https://example.com/card.jpg" },
						],
					},
				],
			},
		};

		expect(countTweetMedia(tweet)).toBe(1);
		expect(buildMediaJsonFromIncludes(tweet, [])).toBe("[]");
	});

	it("rejects non-https and malformed entity fallback urls", () => {
		const tweet = {
			entities: {
				urls: [
					{
						media_key: "3_123",
						url: "http://pbs.twimg.com/media/insecure.jpg",
						expanded_url: "not a url",
					},
				],
			},
		};

		expect(buildMediaJsonFromIncludes(tweet, [])).toBe("[]");
	});

	it("accepts known media CDN entity fallback urls", () => {
		expect(
			JSON.parse(
				buildMediaJsonFromIncludes(
					{
						entities: {
							urls: [
								{
									media_key: "3_123",
									url: "https://t.co/photo",
									expanded_url: "https://pbs.twimg.com/media/photo_123.jpg",
								},
							],
						},
					},
					[],
				),
			),
		).toEqual([
			{
				url: "https://pbs.twimg.com/media/photo_123.jpg",
				type: "image",
			},
		]);
		expect(
			JSON.parse(
				buildMediaJsonFromIncludes(
					{
						entities: {
							urls: [
								{
									media_key: "3_456",
									url: "https://t.co/photo",
									images: [
										{
											url: "https://pbs.twimg.com/card_img/photo_456.jpg",
										},
									],
								},
							],
						},
					},
					[],
				),
			),
		).toEqual([
			{
				url: "https://pbs.twimg.com/card_img/photo_456.jpg",
				type: "image",
			},
		]);
	});

	it("serializes bird-normalized entity media URLs", () => {
		const tweet = birdTest.normalizeBirdTweets([
			{
				id: "bird_1",
				text: "bird photo",
				createdAt: "2026-05-01T00:00:00.000Z",
				media: [{ url: "https://pbs.twimg.com/media/bird_photo.jpg" }],
			},
		]).data[0];

		expect(countTweetMedia(tweet)).toBe(1);
		expect(JSON.parse(buildMediaJsonFromIncludes(tweet, []))).toEqual([
			{
				url: "https://pbs.twimg.com/media/bird_photo.jpg",
				type: "image",
			},
		]);
	});
});
