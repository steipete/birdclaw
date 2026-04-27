// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileAsyncMock = vi.fn();

vi.mock("node:child_process", () => ({
	execFile: Object.assign(vi.fn(), {
		[Symbol.for("nodejs.util.promisify.custom")]: execFileAsyncMock,
	}),
}));

describe("bird transport wrapper", () => {
	afterEach(() => {
		vi.resetModules();
		execFileAsyncMock.mockReset();
		delete process.env.BIRDCLAW_BIRD_COMMAND;
	});

	it("maps bird mentions json into xurl-compatible payloads", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		execFileAsyncMock.mockResolvedValue({
			stdout: JSON.stringify([
				{
					id: "tweet_1",
					text: "hello from bird",
					createdAt: "Fri Mar 13 02:01:58 +0000 2026",
					replyCount: 1,
					retweetCount: 2,
					likeCount: 3,
					conversationId: "tweet_root_1",
					authorId: "42",
					author: {
						username: "sam",
						name: "Sam",
					},
					media: [
						{
							type: "photo",
							url: "https://pbs.twimg.com/media/demo.jpg",
						},
					],
				},
			]),
		});
		const { listMentionsViaBird } = await import("./bird");

		const payload = await listMentionsViaBird({
			maxResults: 12,
		});

		expect(execFileAsyncMock).toHaveBeenCalledWith(
			"/tmp/bird",
			["mentions", "-n", "12", "--json"],
			expect.objectContaining({ maxBuffer: expect.any(Number) }),
		);
		expect(payload).toEqual({
			data: [
				expect.objectContaining({
					id: "tweet_1",
					author_id: "42",
					text: "hello from bird",
					conversation_id: "tweet_root_1",
					public_metrics: expect.objectContaining({
						reply_count: 1,
						retweet_count: 2,
						like_count: 3,
					}),
					entities: expect.objectContaining({
						urls: [
							expect.objectContaining({
								url: "https://pbs.twimg.com/media/demo.jpg",
								media_key: "bird_media_0",
							}),
						],
					}),
				}),
			],
			includes: {
				users: [
					{
						id: "42",
						username: "sam",
						name: "Sam",
					},
				],
			},
			meta: expect.objectContaining({
				result_count: 1,
				page_count: 1,
				next_token: null,
			}),
		});
	});

	it("maps mention fallbacks and empty mention payloads", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		execFileAsyncMock
			.mockResolvedValueOnce({
				stdout: JSON.stringify([
					{
						id: "tweet_2",
						text: "fallback author",
						createdAt: "not a date",
						media: [],
					},
					{
						id: "tweet_3",
						text: "username author",
						createdAt: "2026-01-02T03:04:05.000Z",
						author: { username: "max" },
						replyCount: "4",
						retweetCount: "5",
						likeCount: "6",
						media: [
							{ type: "photo", url: "" },
							{ type: "photo", url: "https://pbs.twimg.com/media/other.jpg" },
						],
					},
				]),
			})
			.mockResolvedValueOnce({ stdout: "[]" });

		const { listMentionsViaBird } = await import("./bird");

		await expect(listMentionsViaBird({ maxResults: 2 })).resolves.toEqual({
			data: [
				expect.objectContaining({
					id: "tweet_2",
					author_id: "unknown",
					created_at: "not a date",
					conversation_id: "tweet_2",
					entities: undefined,
					public_metrics: {
						reply_count: 0,
						retweet_count: 0,
						like_count: 0,
					},
				}),
				expect.objectContaining({
					id: "tweet_3",
					author_id: "max",
					conversation_id: "tweet_3",
					entities: {
						urls: [
							{
								start: 0,
								end: 0,
								url: "https://pbs.twimg.com/media/other.jpg",
								expanded_url: "https://pbs.twimg.com/media/other.jpg",
								display_url: "https://pbs.twimg.com/media/other.jpg",
								media_key: "bird_media_0",
							},
						],
					},
					public_metrics: {
						reply_count: 4,
						retweet_count: 5,
						like_count: 6,
					},
				}),
			],
			includes: {
				users: [
					{ id: "unknown", username: "user_unknown", name: "user_unknown" },
					{ id: "max", username: "max", name: "max" },
				],
			},
			meta: {
				result_count: 2,
				page_count: 1,
				next_token: null,
				newest_id: "tweet_2",
				oldest_id: "tweet_3",
			},
		});

		await expect(listMentionsViaBird({ maxResults: 0 })).resolves.toEqual({
			data: [],
			includes: undefined,
			meta: {
				result_count: 0,
				page_count: 1,
				next_token: null,
			},
		});
	});

	it("rejects unexpected mention json", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		execFileAsyncMock.mockResolvedValue({ stdout: "{}" });

		const { listMentionsViaBird } = await import("./bird");

		await expect(listMentionsViaBird({ maxResults: 10 })).rejects.toThrow(
			"bird mentions returned unexpected JSON",
		);
	});

	it("explains how to configure bird when the binary is missing", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/missing/bird";
		execFileAsyncMock.mockRejectedValue(
			Object.assign(new Error("spawn /missing/bird ENOENT"), {
				code: "ENOENT",
			}),
		);

		const { listMentionsViaBird } = await import("./bird");

		await expect(listMentionsViaBird({ maxResults: 10 })).rejects.toThrow(
			"bird CLI not found at /missing/bird",
		);
	});

	it("tolerates bird json with raw newlines inside tweet text", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		execFileAsyncMock.mockResolvedValue({
			stdout:
				'[{ "id": "tweet_1", "text": "first line\nsecond line", "createdAt": "2026-04-26T13:43:34.000Z", "authorId": "42", "author": { "username": "sam", "name": "Sam" } }]',
		});
		const { listLikedTweetsViaBird } = await import("./bird");

		await expect(listLikedTweetsViaBird({ maxResults: 1 })).resolves.toEqual(
			expect.objectContaining({
				data: [
					expect.objectContaining({
						id: "tweet_1",
						text: "first line\nsecond line",
					}),
				],
			}),
		);
	});

	it("returns bird direct messages payloads", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		const payload = {
			success: true,
			conversations: [
				{
					id: "dm_1",
					participants: [{ id: "42", username: "sam", name: "Sam" }],
					messages: [{ id: "event_1", text: "hello" }],
				},
			],
			events: [{ id: "event_1", text: "hello" }],
		};
		execFileAsyncMock.mockResolvedValue({ stdout: JSON.stringify(payload) });

		const { listDirectMessagesViaBird } = await import("./bird");

		await expect(listDirectMessagesViaBird({ maxResults: 5 })).resolves.toEqual(
			payload,
		);
		expect(execFileAsyncMock).toHaveBeenCalledWith(
			"/tmp/bird",
			["dms", "-n", "5", "--json"],
			expect.objectContaining({ maxBuffer: expect.any(Number) }),
		);
	});

	it("maps bird likes and bookmarks json into xurl-compatible payloads", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		execFileAsyncMock
			.mockResolvedValueOnce({
				stdout: JSON.stringify([
					{
						id: "liked_1",
						text: "liked from bird",
						createdAt: "2026-04-26T13:43:34.000Z",
						authorId: "42",
						author: { username: "sam", name: "Sam" },
					},
				]),
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify([
					{
						id: "bookmark_1",
						text: "saved from bird",
						createdAt: "2026-04-26T13:43:34.000Z",
						authorId: "43",
						author: { username: "amelia", name: "Amelia" },
					},
				]),
			});
		const { listBookmarkedTweetsViaBird, listLikedTweetsViaBird } =
			await import("./bird");

		await expect(listLikedTweetsViaBird({ maxResults: 5 })).resolves.toEqual({
			data: [expect.objectContaining({ id: "liked_1", author_id: "42" })],
			includes: { users: [{ id: "42", username: "sam", name: "Sam" }] },
			meta: expect.objectContaining({ result_count: 1 }),
		});
		await expect(
			listBookmarkedTweetsViaBird({
				maxResults: 7,
				all: true,
				maxPages: 2,
			}),
		).resolves.toEqual({
			data: [expect.objectContaining({ id: "bookmark_1", author_id: "43" })],
			includes: { users: [{ id: "43", username: "amelia", name: "Amelia" }] },
			meta: expect.objectContaining({ result_count: 1 }),
		});
		expect(execFileAsyncMock).toHaveBeenNthCalledWith(
			1,
			"/tmp/bird",
			["likes", "-n", "5", "--json"],
			expect.objectContaining({ maxBuffer: expect.any(Number) }),
		);
		expect(execFileAsyncMock).toHaveBeenNthCalledWith(
			2,
			"/tmp/bird",
			["bookmarks", "-n", "7", "--json", "--all", "--max-pages", "2"],
			expect.objectContaining({ maxBuffer: expect.any(Number) }),
		);
	});

	it("accepts current bird collection objects", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		execFileAsyncMock.mockResolvedValue({
			stdout: JSON.stringify({
				tweets: [
					{
						id: "bookmark_2",
						text: "saved object shape",
						createdAt: "2026-04-26T13:43:34.000Z",
						authorId: "44",
						author: { username: "jules", name: "Jules" },
					},
				],
				nextCursor: null,
			}),
		});
		const { listBookmarkedTweetsViaBird } = await import("./bird");

		await expect(
			listBookmarkedTweetsViaBird({ maxResults: 5, all: true }),
		).resolves.toEqual({
			data: [expect.objectContaining({ id: "bookmark_2", author_id: "44" })],
			includes: { users: [{ id: "44", username: "jules", name: "Jules" }] },
			meta: expect.objectContaining({ result_count: 1 }),
		});
	});

	it("rejects unexpected direct messages json", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		execFileAsyncMock
			.mockResolvedValueOnce({
				stdout: JSON.stringify({
					success: false,
					conversations: [],
					events: [],
				}),
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify({
					success: true,
					conversations: {},
					events: [],
				}),
			});

		const { listDirectMessagesViaBird } = await import("./bird");

		await expect(listDirectMessagesViaBird({ maxResults: 5 })).rejects.toThrow(
			"bird dms returned unexpected JSON",
		);
		await expect(listDirectMessagesViaBird({ maxResults: 5 })).rejects.toThrow(
			"bird dms returned unexpected JSON",
		);
	});
});
