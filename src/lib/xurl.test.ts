// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileAsyncMock = vi.fn();
const execFile = vi.fn();
Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), {
	value: execFileAsyncMock,
});

vi.mock("node:child_process", () => ({
	execFile,
}));

const RICH_USER_FIELDS =
	"description%2Centities%2Clocation%2Cpublic_metrics%2Cprofile_image_url%2Curl%2Ccreated_at%2Cverified%2Cverified_type";
const FOLLOW_USER_FIELDS =
	"id%2Cusername%2Cname%2Cdescription%2Cverified%2Cprotected%2Cpublic_metrics%2Cprofile_image_url%2Ccreated_at";
const AUTHOR_MEDIA_EXPANSIONS = "author_id%2Cattachments.media_keys";
const MEDIA_EXPANSION = "attachments.media_keys";
const MEDIA_FIELDS =
	"variants%2Cpreview_image_url%2Curl%2Cduration_ms%2Calt_text%2Ctype%2Cwidth%2Cheight%2Cpublic_metrics";
const THREAD_TWEET_FIELDS =
	"created_at%2Cconversation_id%2Centities%2Cpublic_metrics%2Creferenced_tweets%2Cin_reply_to_user_id%2Cattachments";
const PHOTO_MEDIA = {
	media_key: "photo_1",
	type: "photo",
	url: "https://pbs.twimg.com/media/photo_1.jpg",
} as const;
const VIDEO_MEDIA = {
	media_key: "video_1",
	type: "video",
	preview_image_url: "https://pbs.twimg.com/ext_tw_video_thumb/video_1.jpg",
	variants: [
		{
			url: "https://video.twimg.com/ext_tw_video/video_1.mp4",
			content_type: "video/mp4",
			bit_rate: 2176000,
		},
	],
} as const;

describe("xurl transport wrapper", () => {
	beforeEach(() => {
		vi.resetModules();
		execFile.mockReset();
		execFileAsyncMock.mockReset();
		delete process.env.BIRDCLAW_DISABLE_LIVE_WRITES;
		delete process.env.BIRDCLAW_XURL_RETRY_BASE_MS;
	});

	it("falls back to local mode when xurl is missing", async () => {
		execFileAsyncMock.mockRejectedValue(new Error("missing"));
		const { getTransportStatus } = await import("./xurl");

		const result = await getTransportStatus();

		expect(result.availableTransport).toBe("local");
		expect(result.installed).toBe(false);
	});

	it("reports xurl auth state when available", async () => {
		execFileAsyncMock
			.mockResolvedValueOnce({ stdout: "xurl 1.0", stderr: "" })
			.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
		const { getTransportStatus } = await import("./xurl");

		const result = await getTransportStatus();

		expect(result).toMatchObject({
			installed: true,
			availableTransport: "xurl",
			rawStatus: "ok",
		});
		expect(execFileAsyncMock).toHaveBeenNthCalledWith(1, "xurl", ["version"]);
	});

	it("falls back to local mode when xurl has no registered apps", async () => {
		execFileAsyncMock
			.mockResolvedValueOnce({ stdout: "xurl 1.0", stderr: "" })
			.mockResolvedValueOnce({
				stdout:
					"No apps registered. Use 'xurl auth apps add' to register one.\n",
				stderr: "",
			});
		const { getTransportStatus } = await import("./xurl");

		const result = await getTransportStatus();

		expect(result.installed).toBe(true);
		expect(result.availableTransport).toBe("local");
		expect(result.statusText).toContain("not authenticated");
		expect(result.rawStatus).toContain("No apps registered");
	});

	it("falls back to local mode when xurl has no authenticated user", async () => {
		execFileAsyncMock
			.mockResolvedValueOnce({ stdout: "xurl 1.0", stderr: "" })
			.mockResolvedValueOnce({
				stdout: "No authenticated user. Run xurl auth login.\n",
				stderr: "",
			});
		const { getTransportStatus } = await import("./xurl");

		const result = await getTransportStatus();

		expect(result.installed).toBe(true);
		expect(result.availableTransport).toBe("local");
		expect(result.statusText).toContain("not authenticated");
		expect(result.rawStatus).toContain("No authenticated user");
	});

	it("caches transport status for repeated callers", async () => {
		execFileAsyncMock
			.mockResolvedValueOnce({ stdout: "xurl 1.0", stderr: "" })
			.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
		const { getTransportStatus } = await import("./xurl");

		const first = await getTransportStatus();
		const second = await getTransportStatus();

		expect(first).toEqual(second);
		expect(execFileAsyncMock).toHaveBeenCalledTimes(2);
	});

	it("falls back to local mode when xurl auth is broken", async () => {
		execFileAsyncMock
			.mockResolvedValueOnce({ stdout: "xurl 1.0", stderr: "" })
			.mockRejectedValueOnce(new Error("auth unavailable"));
		const { getTransportStatus } = await import("./xurl");

		const result = await getTransportStatus();

		expect(result.installed).toBe(true);
		expect(result.availableTransport).toBe("local");
		expect(result.statusText).toContain("auth unavailable");
	});

	it("uses an unknown-error fallback for non-Error auth failures", async () => {
		execFileAsyncMock
			.mockResolvedValueOnce({ stdout: "xurl 1.0", stderr: "" })
			.mockRejectedValueOnce("bad auth");
		const { getTransportStatus } = await import("./xurl");

		const result = await getTransportStatus();

		expect(result.availableTransport).toBe("local");
		expect(result.statusText).toContain("unknown error");
	});

	it("looks up users and the authenticated account via raw json endpoints", async () => {
		execFileAsyncMock
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ data: [{ id: "42", username: "sam" }] }),
				stderr: "",
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ data: { id: "1", username: "steipete" } }),
				stderr: "",
			});
		const { lookupAuthenticatedUser, lookupUsersByIds } =
			await import("./xurl");

		await expect(lookupUsersByIds(["42"])).resolves.toEqual([
			{ id: "42", username: "sam" },
		]);
		await expect(lookupAuthenticatedUser()).resolves.toEqual({
			id: "1",
			username: "steipete",
		});
	});

	it("returns an empty user list when lookup payload data is not an array", async () => {
		execFileAsyncMock.mockResolvedValueOnce({
			stdout: JSON.stringify({ data: { id: "42" } }),
			stderr: "",
		});
		const { lookupUsersByIds } = await import("./xurl");

		await expect(lookupUsersByIds(["42"])).resolves.toEqual([]);
	});

	it("looks up users by handle", async () => {
		execFileAsyncMock.mockResolvedValueOnce({
			stdout: JSON.stringify({ data: [{ id: "7", username: "amelia" }] }),
			stderr: "",
		});
		const { lookupUsersByHandles } = await import("./xurl");

		await expect(lookupUsersByHandles(["@amelia"])).resolves.toEqual([
			{ id: "7", username: "amelia" },
		]);
	});

	it("lists mentions via the xurl users mentions endpoint", async () => {
		execFileAsyncMock.mockResolvedValueOnce({
			stdout: JSON.stringify({ data: [{ id: "25401953" }] }),
			stderr: "",
		});
		execFileAsyncMock.mockResolvedValueOnce({
			stdout: JSON.stringify({
				data: [
					{
						id: "tweet_1",
						author_id: "42",
						text: "hello",
						attachments: { media_keys: ["photo_1", "video_1"] },
					},
				],
				includes: {
					users: [{ id: "42", username: "sam", name: "Sam" }],
					media: [PHOTO_MEDIA, VIDEO_MEDIA],
				},
				meta: { result_count: 1 },
			}),
			stderr: "",
		});
		const { listMentionsViaXurl } = await import("./xurl");

		await expect(
			listMentionsViaXurl({
				maxResults: 5,
				username: "steipete",
			}),
		).resolves.toEqual({
			data: [
				{
					id: "tweet_1",
					author_id: "42",
					text: "hello",
					attachments: { media_keys: ["photo_1", "video_1"] },
				},
			],
			includes: {
				users: [{ id: "42", username: "sam", name: "Sam" }],
				media: [PHOTO_MEDIA, VIDEO_MEDIA],
			},
			meta: { result_count: 1 },
		});
		expect(execFileAsyncMock).toHaveBeenCalledWith("xurl", [
			`/2/users/25401953/mentions?max_results=5&expansions=${AUTHOR_MEDIA_EXPANSIONS}&tweet.fields=created_at%2Cconversation_id%2Centities%2Cpublic_metrics&media.fields=${MEDIA_FIELDS}&user.fields=${RICH_USER_FIELDS}`,
		]);
	});

	it("passes pagination tokens for mention scans when present", async () => {
		execFileAsyncMock.mockResolvedValueOnce({
			stdout: JSON.stringify({
				data: [],
				meta: { next_token: "next-page" },
			}),
			stderr: "",
		});
		const { listMentionsViaXurl } = await import("./xurl");

		await expect(
			listMentionsViaXurl({
				maxResults: 100,
				userId: "25401953",
				paginationToken: "next-page",
			}),
		).resolves.toEqual({
			data: [],
			meta: { next_token: "next-page" },
		});
		expect(execFileAsyncMock).toHaveBeenCalledWith("xurl", [
			`/2/users/25401953/mentions?max_results=100&expansions=${AUTHOR_MEDIA_EXPANSIONS}&tweet.fields=created_at%2Cconversation_id%2Centities%2Cpublic_metrics&media.fields=${MEDIA_FIELDS}&user.fields=${RICH_USER_FIELDS}&pagination_token=next-page`,
		]);
	});

	it("passes start_time for mention backfills when present", async () => {
		execFileAsyncMock.mockResolvedValueOnce({
			stdout: JSON.stringify({
				data: [],
				meta: { result_count: 0 },
			}),
			stderr: "",
		});
		const { listMentionsViaXurl } = await import("./xurl");

		await listMentionsViaXurl({
			maxResults: 100,
			userId: "25401953",
			startTime: "2026-03-01T00:00:00Z",
		});

		expect(execFileAsyncMock).toHaveBeenCalledWith("xurl", [
			`/2/users/25401953/mentions?max_results=100&expansions=${AUTHOR_MEDIA_EXPANSIONS}&tweet.fields=created_at%2Cconversation_id%2Centities%2Cpublic_metrics&media.fields=${MEDIA_FIELDS}&user.fields=${RICH_USER_FIELDS}&start_time=2026-03-01T00%3A00%3A00Z`,
		]);
	});

	it("returns null when whoami payload is not an object", async () => {
		execFileAsyncMock.mockResolvedValueOnce({
			stdout: JSON.stringify({ data: "not-an-object" }),
			stderr: "",
		});
		const { lookupAuthenticatedUser } = await import("./xurl");

		await expect(lookupAuthenticatedUser()).resolves.toBeNull();
	});

	it("caches authenticated user lookups for repeated callers", async () => {
		execFileAsyncMock.mockResolvedValueOnce({
			stdout: JSON.stringify({ data: { id: "1", username: "steipete" } }),
			stderr: "",
		});
		const { lookupAuthenticatedUser, resetAuthenticatedUserCache } =
			await import("./xurl");

		const first = await lookupAuthenticatedUser();
		const second = await lookupAuthenticatedUser();

		expect(first).toEqual({ id: "1", username: "steipete" });
		expect(second).toEqual(first);
		expect(execFileAsyncMock).toHaveBeenCalledTimes(1);

		resetAuthenticatedUserCache();
		execFileAsyncMock.mockResolvedValueOnce({
			stdout: JSON.stringify({ data: { id: "2", username: "other" } }),
			stderr: "",
		});
		await expect(lookupAuthenticatedUser()).resolves.toEqual({
			id: "2",
			username: "other",
		});
		expect(execFileAsyncMock).toHaveBeenCalledTimes(2);
	});

	it("lists blocked users and returns the next page token", async () => {
		execFileAsyncMock.mockResolvedValueOnce({
			stdout: JSON.stringify({
				data: [{ id: "7", username: "amelia" }],
				meta: { next_token: "next" },
			}),
			stderr: "",
		});
		const { listBlockedUsers } = await import("./xurl");

		await expect(listBlockedUsers("1")).resolves.toEqual({
			items: [{ id: "7", username: "amelia" }],
			nextToken: "next",
		});
		expect(execFileAsyncMock).toHaveBeenCalledWith("xurl", [
			`/2/users/1/blocking?max_results=100&user.fields=${RICH_USER_FIELDS}`,
		]);
	});

	it("lists recent user tweets for profile inspection", async () => {
		execFileAsyncMock.mockResolvedValueOnce({
			stdout: JSON.stringify({
				data: [
					{
						id: "tweet_1",
						text: "@sam hi",
						created_at: "2026-03-09T00:00:00.000Z",
					},
				],
				meta: { next_token: "next" },
			}),
			stderr: "",
		});
		const { listUserTweets } = await import("./xurl");

		await expect(
			listUserTweets("42", {
				maxResults: 12,
				excludeRetweets: true,
			}),
		).resolves.toEqual({
			items: [
				{
					id: "tweet_1",
					text: "@sam hi",
					created_at: "2026-03-09T00:00:00.000Z",
				},
			],
			nextToken: "next",
		});
		expect(execFileAsyncMock).toHaveBeenCalledWith("xurl", [
			`/2/users/42/tweets?max_results=12&expansions=${MEDIA_EXPANSION}&tweet.fields=created_at%2Cconversation_id%2Cpublic_metrics%2Creferenced_tweets&media.fields=${MEDIA_FIELDS}&exclude=retweets`,
		]);
	});

	it("looks up tweets by id through the raw tweet endpoint", async () => {
		execFileAsyncMock.mockResolvedValueOnce({
			stdout: JSON.stringify({
				data: [
					{
						id: "tweet_1",
						author_id: "42",
						text: "hello",
						created_at: "2026-03-09T00:00:00.000Z",
						referenced_tweets: [{ type: "replied_to", id: "tweet_root" }],
					},
				],
				includes: {
					users: [{ id: "42", username: "sam", name: "Sam" }],
				},
				meta: { result_count: 1 },
			}),
			stderr: "",
		});
		const { lookupTweetsByIds } = await import("./xurl");

		await expect(lookupTweetsByIds(["tweet_1"])).resolves.toEqual({
			data: [
				{
					id: "tweet_1",
					author_id: "42",
					text: "hello",
					created_at: "2026-03-09T00:00:00.000Z",
					referenced_tweets: [{ type: "replied_to", id: "tweet_root" }],
				},
			],
			includes: {
				users: [{ id: "42", username: "sam", name: "Sam" }],
			},
			meta: { result_count: 1 },
		});
		expect(execFileAsyncMock).toHaveBeenCalledWith("xurl", [
			`/2/tweets?ids=tweet_1&expansions=${AUTHOR_MEDIA_EXPANSIONS}&tweet.fields=created_at%2Cconversation_id%2Centities%2Cpublic_metrics%2Creferenced_tweets&media.fields=${MEDIA_FIELDS}&user.fields=${RICH_USER_FIELDS}`,
		]);
	});

	it("reads conversation search and individual tweets with parent-walk fields", async () => {
		execFileAsyncMock
			.mockResolvedValueOnce({
				stdout: JSON.stringify({
					data: [{ id: "tweet_1", author_id: "42", text: "hello" }],
					meta: { next_token: "next" },
				}),
				stderr: "",
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify({
					data: {
						id: "tweet_1",
						author_id: "42",
						text: "hello",
						in_reply_to_user_id: "7",
					},
				}),
				stderr: "",
			});
		const { getTweetById, searchRecentByConversationId } =
			await import("./xurl");

		await searchRecentByConversationId("123", {
			maxResults: 100,
			paginationToken: "cursor",
		});
		await getTweetById("tweet_1");
		expect(execFileAsyncMock).toHaveBeenNthCalledWith(1, "xurl", [
			`/2/tweets/search/recent?query=conversation_id%3A123&max_results=100&expansions=${AUTHOR_MEDIA_EXPANSIONS}&tweet.fields=${THREAD_TWEET_FIELDS}&media.fields=${MEDIA_FIELDS}&user.fields=${RICH_USER_FIELDS}&pagination_token=cursor`,
		]);
		expect(execFileAsyncMock).toHaveBeenNthCalledWith(2, "xurl", [
			`/2/tweets/tweet_1?expansions=${AUTHOR_MEDIA_EXPANSIONS}&tweet.fields=${THREAD_TWEET_FIELDS}&media.fields=${MEDIA_FIELDS}&user.fields=${RICH_USER_FIELDS}`,
		]);
	});

	it("aborts thread lookups when a timeout is provided", async () => {
		vi.useFakeTimers();
		try {
			execFileAsyncMock.mockImplementation(
				(
					_command: string,
					_args: string[],
					options?: { signal?: AbortSignal },
				) =>
					new Promise((_resolve, reject) => {
						options?.signal?.addEventListener("abort", () => {
							reject(new Error("aborted"));
						});
					}),
			);
			const { getTweetById } = await import("./xurl");

			let rejected: unknown;
			const result = getTweetById("tweet_1", { timeoutMs: 1000 }).catch(
				(error: unknown) => {
					rejected = error;
				},
			);
			await vi.advanceTimersByTimeAsync(1000);

			await result;
			expect(rejected).toEqual(expect.any(Error));
			expect(String((rejected as Error).message)).toContain("aborted");
			expect(execFileAsyncMock).toHaveBeenCalledWith(
				"xurl",
				[
					`/2/tweets/tweet_1?expansions=${AUTHOR_MEDIA_EXPANSIONS}&tweet.fields=${THREAD_TWEET_FIELDS}&media.fields=${MEDIA_FIELDS}&user.fields=${RICH_USER_FIELDS}`,
				],
				expect.objectContaining({ signal: expect.any(Object) }),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not retry rate-limited thread lookups past the timeout budget", async () => {
		process.env.BIRDCLAW_XURL_RETRY_BASE_MS = "2000";
		execFileAsyncMock.mockRejectedValueOnce(
			Object.assign(new Error("rate limited"), {
				stdout: JSON.stringify({ status: 429 }),
			}),
		);
		const { getTweetById } = await import("./xurl");

		await expect(getTweetById("tweet_1", { timeoutMs: 1000 })).rejects.toThrow(
			"rate limited",
		);
		expect(execFileAsyncMock).toHaveBeenCalledTimes(1);
	});

	it("lists liked and bookmarked tweets through raw Twitter endpoints", async () => {
		execFileAsyncMock
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ data: [{ id: "25401953" }] }),
				stderr: "",
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify({
					data: [
						{
							id: "liked_1",
							author_id: "42",
							text: "liked",
							attachments: { media_keys: ["photo_1", "video_1"] },
						},
					],
					includes: {
						users: [{ id: "42", username: "sam", name: "Sam" }],
						media: [PHOTO_MEDIA, VIDEO_MEDIA],
					},
					meta: { result_count: 1 },
				}),
				stderr: "",
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify({
					data: [{ id: "bookmark_1", author_id: "43", text: "saved" }],
					meta: { next_token: "next" },
				}),
				stderr: "",
			});
		const { listBookmarkedTweetsViaXurl, listLikedTweetsViaXurl } =
			await import("./xurl");

		await expect(
			listLikedTweetsViaXurl({
				maxResults: 5,
				username: "steipete",
			}),
		).resolves.toEqual({
			data: [
				{
					id: "liked_1",
					author_id: "42",
					text: "liked",
					attachments: { media_keys: ["photo_1", "video_1"] },
				},
			],
			includes: {
				users: [{ id: "42", username: "sam", name: "Sam" }],
				media: [PHOTO_MEDIA, VIDEO_MEDIA],
			},
			meta: { result_count: 1 },
		});
		await expect(
			listBookmarkedTweetsViaXurl({
				maxResults: 100,
				userId: "25401953",
				paginationToken: "next",
			}),
		).resolves.toEqual({
			data: [{ id: "bookmark_1", author_id: "43", text: "saved" }],
			meta: { next_token: "next" },
		});
		expect(execFileAsyncMock).toHaveBeenCalledWith("xurl", [
			"--auth",
			"oauth2",
			`/2/users/25401953/liked_tweets?max_results=5&expansions=${AUTHOR_MEDIA_EXPANSIONS}&tweet.fields=created_at%2Cconversation_id%2Centities%2Cpublic_metrics%2Creferenced_tweets&media.fields=${MEDIA_FIELDS}&user.fields=${RICH_USER_FIELDS}`,
		]);
		expect(execFileAsyncMock).toHaveBeenCalledWith("xurl", [
			"--auth",
			"oauth2",
			`/2/users/25401953/bookmarks?max_results=100&expansions=${AUTHOR_MEDIA_EXPANSIONS}&tweet.fields=created_at%2Cconversation_id%2Centities%2Cpublic_metrics%2Creferenced_tweets&media.fields=${MEDIA_FIELDS}&user.fields=${RICH_USER_FIELDS}&pagination_token=next`,
		]);
	});

	it("caps bookmark max_results only for paginated walks", async () => {
		execFileAsyncMock
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ data: [] }),
				stderr: "",
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ data: [] }),
				stderr: "",
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ data: [] }),
				stderr: "",
			});
		const { listBookmarkedTweetsViaXurl, listLikedTweetsViaXurl } =
			await import("./xurl");

		await listBookmarkedTweetsViaXurl({
			maxResults: 100,
			userId: "25401953",
			isPaginatedWalk: true,
		});
		await listBookmarkedTweetsViaXurl({
			maxResults: 100,
			userId: "25401953",
		});
		await listLikedTweetsViaXurl({
			maxResults: 100,
			userId: "25401953",
		});

		expect(execFileAsyncMock).toHaveBeenNthCalledWith(1, "xurl", [
			"--auth",
			"oauth2",
			`/2/users/25401953/bookmarks?max_results=90&expansions=${AUTHOR_MEDIA_EXPANSIONS}&tweet.fields=created_at%2Cconversation_id%2Centities%2Cpublic_metrics%2Creferenced_tweets&media.fields=${MEDIA_FIELDS}&user.fields=${RICH_USER_FIELDS}`,
		]);
		expect(execFileAsyncMock).toHaveBeenNthCalledWith(2, "xurl", [
			"--auth",
			"oauth2",
			`/2/users/25401953/bookmarks?max_results=100&expansions=${AUTHOR_MEDIA_EXPANSIONS}&tweet.fields=created_at%2Cconversation_id%2Centities%2Cpublic_metrics%2Creferenced_tweets&media.fields=${MEDIA_FIELDS}&user.fields=${RICH_USER_FIELDS}`,
		]);
		expect(execFileAsyncMock).toHaveBeenNthCalledWith(3, "xurl", [
			"--auth",
			"oauth2",
			`/2/users/25401953/liked_tweets?max_results=100&expansions=${AUTHOR_MEDIA_EXPANSIONS}&tweet.fields=created_at%2Cconversation_id%2Centities%2Cpublic_metrics%2Creferenced_tweets&media.fields=${MEDIA_FIELDS}&user.fields=${RICH_USER_FIELDS}`,
		]);
	});

	it("lists follow users through OAuth2 endpoints with pagination", async () => {
		execFileAsyncMock.mockResolvedValueOnce({
			stdout: JSON.stringify({
				data: [{ id: "42", username: "sam" }],
				meta: { next_token: "next-page" },
			}),
			stderr: "",
		});
		const { listFollowUsersViaXurl } = await import("./xurl");

		await expect(
			listFollowUsersViaXurl({
				direction: "followers",
				userId: "25401953",
				maxResults: 1000,
				paginationToken: "cursor",
			}),
		).resolves.toEqual({
			data: [{ id: "42", username: "sam" }],
			meta: { next_token: "next-page" },
		});
		expect(execFileAsyncMock).toHaveBeenCalledWith("xurl", [
			"--auth",
			"oauth2",
			`/2/users/25401953/followers?max_results=1000&user.fields=${FOLLOW_USER_FIELDS}&pagination_token=cursor`,
		]);
	});

	it("resolves handles for following reads and tolerates empty follow payloads", async () => {
		execFileAsyncMock
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ data: [{ id: "7", username: "amelia" }] }),
				stderr: "",
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ data: null, meta: null }),
				stderr: "",
			});
		const { listFollowUsersViaXurl } = await import("./xurl");

		await expect(
			listFollowUsersViaXurl({
				direction: "following",
				username: "@amelia",
				maxResults: 50,
			}),
		).resolves.toEqual({
			data: [],
			meta: undefined,
		});
		expect(execFileAsyncMock).toHaveBeenNthCalledWith(2, "xurl", [
			"--auth",
			"oauth2",
			`/2/users/7/following?max_results=50&user.fields=${FOLLOW_USER_FIELDS}`,
		]);
	});

	it("uses the authenticated user for follow reads when no user is provided", async () => {
		execFileAsyncMock
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ data: { id: "1", username: "steipete" } }),
				stderr: "",
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ data: [] }),
				stderr: "",
			});
		const { listFollowUsersViaXurl } = await import("./xurl");

		await expect(
			listFollowUsersViaXurl({
				direction: "followers",
				maxResults: 10,
			}),
		).resolves.toEqual({
			data: [],
			meta: undefined,
		});
		expect(execFileAsyncMock).toHaveBeenNthCalledWith(2, "xurl", [
			"--auth",
			"oauth2",
			`/2/users/1/followers?max_results=10&user.fields=${FOLLOW_USER_FIELDS}`,
		]);
	});

	it("passes pagination tokens for user tweet scans and can keep retweets", async () => {
		execFileAsyncMock.mockResolvedValueOnce({
			stdout: JSON.stringify({ data: null, meta: null }),
			stderr: "",
		});
		const { listUserTweets } = await import("./xurl");

		await expect(
			listUserTweets("42", {
				maxResults: 50,
				paginationToken: "next-page",
				excludeRetweets: false,
			}),
		).resolves.toEqual({
			items: [],
			nextToken: null,
		});
		expect(execFileAsyncMock).toHaveBeenCalledWith("xurl", [
			`/2/users/42/tweets?max_results=50&expansions=${MEDIA_EXPANSION}&tweet.fields=created_at%2Cconversation_id%2Cpublic_metrics%2Creferenced_tweets&media.fields=${MEDIA_FIELDS}&pagination_token=next-page`,
		]);
	});

	it("passes rich user tweet scan params through to xurl", async () => {
		execFileAsyncMock.mockResolvedValueOnce({
			stdout: JSON.stringify({
				data: [{ id: "tweet_1", author_id: "42", text: "hello" }],
				includes: {
					users: [{ id: "42", username: "sam", name: "Sam" }],
					media: [{ media_key: "media_1", type: "photo" }],
				},
				meta: { next_token: "next" },
			}),
			stderr: "",
		});
		const { listUserTweets } = await import("./xurl");

		await expect(
			listUserTweets("42", {
				maxResults: 100,
				paginationToken: "page",
				excludeRetweets: false,
				sinceId: "10",
				untilId: "20",
				tweetFields: ["author_id", "created_at"],
				expansions: ["author_id", "attachments.media_keys"],
				userFields: ["id", "username"],
				mediaFields: ["media_key", "type"],
				auth: "oauth2",
			}),
		).resolves.toEqual({
			items: [{ id: "tweet_1", author_id: "42", text: "hello" }],
			nextToken: "next",
			includes: {
				users: [{ id: "42", username: "sam", name: "Sam" }],
				media: [{ media_key: "media_1", type: "photo" }],
			},
		});
		expect(execFileAsyncMock).toHaveBeenCalledWith("xurl", [
			"--auth",
			"oauth2",
			"/2/users/42/tweets?max_results=100&expansions=author_id%2Cattachments.media_keys&tweet.fields=author_id%2Ccreated_at&media.fields=media_key%2Ctype&user.fields=id%2Cusername&since_id=10&until_id=20&pagination_token=page",
		]);
	});

	it("passes pagination tokens and tolerates empty block payloads", async () => {
		execFileAsyncMock.mockResolvedValueOnce({
			stdout: JSON.stringify({ data: null, meta: null }),
			stderr: "",
		});
		const { listBlockedUsers } = await import("./xurl");

		await expect(listBlockedUsers("1", "next-page")).resolves.toEqual({
			items: [],
			nextToken: null,
		});
		expect(execFileAsyncMock).toHaveBeenCalledWith("xurl", [
			`/2/users/1/blocking?max_results=100&user.fields=${RICH_USER_FIELDS}&pagination_token=next-page`,
		]);
	});

	it("retries json reads when xurl returns a rate limit error", async () => {
		process.env.BIRDCLAW_XURL_RETRY_BASE_MS = "0";
		const rateLimitError = Object.assign(new Error("request failed"), {
			stdout: JSON.stringify({
				title: "Too Many Requests",
				detail: "Too Many Requests",
				status: 429,
			}),
		});
		execFileAsyncMock
			.mockRejectedValueOnce(rateLimitError)
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ data: [{ id: "7", username: "amelia" }] }),
				stderr: "",
			});
		const { listBlockedUsers } = await import("./xurl");

		await expect(listBlockedUsers("1")).resolves.toEqual({
			items: [{ id: "7", username: "amelia" }],
			nextToken: null,
		});
		expect(execFileAsyncMock).toHaveBeenCalledTimes(2);
	});

	it("does not retry non-rate-limited json failures", async () => {
		execFileAsyncMock.mockRejectedValueOnce(new Error("bad json"));
		const { lookupUsersByIds } = await import("./xurl");

		await expect(lookupUsersByIds(["42"])).rejects.toThrow("bad json");
		expect(execFileAsyncMock).toHaveBeenCalledTimes(1);
	});

	it("includes stdout and stderr details for json command failures", async () => {
		execFileAsyncMock.mockRejectedValueOnce(
			Object.assign(new Error("Command failed: xurl whoami"), {
				stdout: '{"title":"Unauthorized","detail":"OAuth token expired"}',
				stderr: "run xurl auth oauth2",
			}),
		);
		const { lookupAuthenticatedUser } = await import("./xurl");

		await expect(lookupAuthenticatedUser()).rejects.toThrow(
			'Command failed: xurl whoami\n{"title":"Unauthorized","detail":"OAuth token expired"}\nrun xurl auth oauth2',
		);
	});

	it("does not retry malformed or exhausted rate limit failures", async () => {
		process.env.BIRDCLAW_XURL_RETRY_BASE_MS = "-1";
		execFileAsyncMock.mockRejectedValueOnce(
			Object.assign(new Error("wrapped"), {
				stdout: "prefix {not json} suffix",
			}),
		);
		const { lookupTweetsByIds } = await import("./xurl");

		await expect(lookupTweetsByIds(["tweet_1"])).rejects.toThrow("wrapped");
		expect(execFileAsyncMock).toHaveBeenCalledTimes(1);

		process.env.BIRDCLAW_XURL_RETRY_BASE_MS = "0";
		execFileAsyncMock.mockReset();
		execFileAsyncMock.mockRejectedValue(
			Object.assign(new Error("still limited"), {
				stdout: JSON.stringify({ status: 429 }),
			}),
		);

		await expect(lookupTweetsByIds(["tweet_1"])).rejects.toThrow(
			"still limited",
		);
		expect(execFileAsyncMock).toHaveBeenCalledTimes(6);
	});

	it("reports user id resolution failures for xurl timeline reads", async () => {
		execFileAsyncMock
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ data: [] }),
				stderr: "",
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ data: null }),
				stderr: "",
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ data: [] }),
				stderr: "",
			});
		const {
			listBookmarkedTweetsViaXurl,
			listFollowUsersViaXurl,
			listMentionsViaXurl,
		} = await import("./xurl");

		await expect(
			listMentionsViaXurl({ username: "missing", maxResults: 5 }),
		).rejects.toThrow("Could not resolve Twitter user id for @missing");
		await expect(
			listBookmarkedTweetsViaXurl({ maxResults: 5 }),
		).rejects.toThrow("Could not resolve authenticated Twitter user id");
		await expect(
			listFollowUsersViaXurl({ maxResults: 5, direction: "followers" }),
		).rejects.toThrow("Could not resolve authenticated Twitter user id");
		await expect(
			listFollowUsersViaXurl({
				username: "missing",
				maxResults: 5,
				direction: "followers",
			}),
		).rejects.toThrow("Could not resolve Twitter user id for @missing");
	});

	it("returns an empty handle list when asked to resolve nothing", async () => {
		const { lookupUsersByHandles } = await import("./xurl");

		await expect(lookupUsersByHandles([])).resolves.toEqual([]);
		expect(execFileAsyncMock).not.toHaveBeenCalled();
	});

	it("returns an empty user list when asked to hydrate nothing", async () => {
		const { lookupUsersByIds } = await import("./xurl");

		await expect(lookupUsersByIds([])).resolves.toEqual([]);
		expect(execFileAsyncMock).not.toHaveBeenCalled();
	});

	it("returns an empty tweet lookup response when asked to hydrate no tweets", async () => {
		const { lookupTweetsByIds } = await import("./xurl");

		await expect(lookupTweetsByIds([])).resolves.toEqual({ data: [] });
		expect(execFileAsyncMock).not.toHaveBeenCalled();
	});

	it("formats dm handles with @", async () => {
		execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "sent" });
		const { dmViaXurl } = await import("./xurl");

		const result = await dmViaXurl("sam", "hello");

		expect(execFileAsyncMock).toHaveBeenCalledWith("xurl", [
			"dm",
			"@sam",
			"hello",
		]);
		expect(result).toEqual({ ok: true, output: "sent" });
	});

	it("passes through existing @ handles and reports shortcut failures", async () => {
		execFileAsyncMock.mockRejectedValue(new Error("bad shortcut"));
		const { dmViaXurl, postViaXurl, replyViaXurl } = await import("./xurl");

		await expect(dmViaXurl("@sam", "hello")).resolves.toEqual({
			ok: false,
			output: "bad shortcut",
		});
		await expect(postViaXurl("ship")).resolves.toEqual({
			ok: false,
			output: "bad shortcut",
		});
		await expect(replyViaXurl("tweet_1", "reply")).resolves.toEqual({
			ok: false,
			output: "bad shortcut",
		});
		expect(execFileAsyncMock).toHaveBeenCalledWith("xurl", [
			"dm",
			"@sam",
			"hello",
		]);
	});

	it("suppresses live write shortcuts when disabled", async () => {
		process.env.BIRDCLAW_DISABLE_LIVE_WRITES = "1";
		const {
			blockUserViaXurl,
			dmViaXurl,
			muteUserViaXurl,
			postViaXurl,
			replyViaXurl,
			unblockUserViaXurl,
			unmuteUserViaXurl,
		} = await import("./xurl");

		await expect(postViaXurl("ship")).resolves.toEqual({
			ok: true,
			output: "live writes disabled",
		});
		await expect(replyViaXurl("tweet_1", "reply")).resolves.toEqual({
			ok: true,
			output: "live writes disabled",
		});
		await expect(dmViaXurl("@sam", "hello")).resolves.toEqual({
			ok: true,
			output: "live writes disabled",
		});
		await expect(blockUserViaXurl("1", "2")).resolves.toEqual({
			ok: true,
			output: "live writes disabled",
		});
		await expect(unblockUserViaXurl("1", "2")).resolves.toEqual({
			ok: true,
			output: "live writes disabled",
		});
		await expect(muteUserViaXurl("1", "2")).resolves.toEqual({
			ok: true,
			output: "live writes disabled",
		});
		await expect(unmuteUserViaXurl("1", "2")).resolves.toEqual({
			ok: true,
			output: "live writes disabled",
		});
		expect(execFileAsyncMock).not.toHaveBeenCalled();
	});

	it("blocks and unblocks users via raw endpoints", async () => {
		execFileAsyncMock
			.mockResolvedValueOnce({ stdout: '{"data":true}', stderr: "" })
			.mockResolvedValueOnce({ stdout: "", stderr: "deleted" });
		const { blockUserViaXurl, unblockUserViaXurl } = await import("./xurl");

		await expect(blockUserViaXurl("1", "2")).resolves.toEqual({
			ok: true,
			output: '{"data":true}',
		});
		await expect(unblockUserViaXurl("1", "2")).resolves.toEqual({
			ok: true,
			output: "deleted",
		});
		expect(execFileAsyncMock).toHaveBeenNthCalledWith(1, "xurl", [
			"-X",
			"POST",
			"/2/users/1/blocking",
			"-d",
			'{"target_user_id":"2"}',
		]);
		expect(execFileAsyncMock).toHaveBeenNthCalledWith(2, "xurl", [
			"-X",
			"DELETE",
			"/2/users/1/blocking/2",
		]);
	});

	it("reports block transport failures", async () => {
		execFileAsyncMock.mockRejectedValue(new Error("transport down"));
		const {
			blockUserViaXurl,
			muteUserViaXurl,
			unblockUserViaXurl,
			unmuteUserViaXurl,
		} = await import("./xurl");

		await expect(blockUserViaXurl("1", "2")).resolves.toEqual({
			ok: false,
			output: "transport down",
		});
		await expect(unblockUserViaXurl("1", "2")).resolves.toEqual({
			ok: false,
			output: "transport down",
		});
		await expect(muteUserViaXurl("1", "2")).resolves.toEqual({
			ok: false,
			output: "transport down",
		});
		await expect(unmuteUserViaXurl("1", "2")).resolves.toEqual({
			ok: false,
			output: "transport down",
		});
	});

	it("includes stdout and stderr details for mutation failures", async () => {
		const error = Object.assign(new Error("Command failed: xurl"), {
			stdout:
				'{"title":"Forbidden","detail":"You are not permitted to use OAuth2 on this endpoint"}',
			stderr: "verbose trace",
		});
		execFileAsyncMock.mockRejectedValue(error);
		const { blockUserViaXurl } = await import("./xurl");

		await expect(blockUserViaXurl("1", "2")).resolves.toEqual({
			ok: false,
			output:
				'Command failed: xurl\n{"title":"Forbidden","detail":"You are not permitted to use OAuth2 on this endpoint"}\nverbose trace',
		});
	});

	it("uses ok as the default mutation output", async () => {
		execFileAsyncMock
			.mockResolvedValueOnce({ stdout: "", stderr: "" })
			.mockResolvedValueOnce({ stdout: "", stderr: "" });
		const { blockUserViaXurl, muteUserViaXurl } = await import("./xurl");

		await expect(blockUserViaXurl("1", "2")).resolves.toEqual({
			ok: true,
			output: "ok",
		});
		await expect(muteUserViaXurl("1", "2")).resolves.toEqual({
			ok: true,
			output: "ok",
		});
	});

	it("mutes and unmutes users via raw endpoints", async () => {
		execFileAsyncMock
			.mockResolvedValueOnce({ stdout: '{"data":true}', stderr: "" })
			.mockResolvedValueOnce({ stdout: "", stderr: "deleted" });
		const { muteUserViaXurl, unmuteUserViaXurl } = await import("./xurl");

		await expect(muteUserViaXurl("1", "2")).resolves.toEqual({
			ok: true,
			output: '{"data":true}',
		});
		await expect(unmuteUserViaXurl("1", "2")).resolves.toEqual({
			ok: true,
			output: "deleted",
		});
		expect(execFileAsyncMock).toHaveBeenNthCalledWith(1, "xurl", [
			"-X",
			"POST",
			"/2/users/1/muting",
			"-d",
			'{"target_user_id":"2"}',
		]);
		expect(execFileAsyncMock).toHaveBeenNthCalledWith(2, "xurl", [
			"-X",
			"DELETE",
			"/2/users/1/muting/2",
		]);
	});
});
