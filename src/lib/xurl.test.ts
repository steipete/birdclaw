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
				data: [{ id: "tweet_1", author_id: "42", text: "hello" }],
				includes: { users: [{ id: "42", username: "sam", name: "Sam" }] },
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
			data: [{ id: "tweet_1", author_id: "42", text: "hello" }],
			includes: { users: [{ id: "42", username: "sam", name: "Sam" }] },
			meta: { result_count: 1 },
		});
		expect(execFileAsyncMock).toHaveBeenCalledWith("xurl", [
			"/2/users/25401953/mentions?max_results=5&expansions=author_id&tweet.fields=created_at%2Cconversation_id%2Centities%2Cpublic_metrics&user.fields=description%2Cpublic_metrics%2Cprofile_image_url%2Ccreated_at%2Cverified",
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
			"/2/users/25401953/mentions?max_results=100&expansions=author_id&tweet.fields=created_at%2Cconversation_id%2Centities%2Cpublic_metrics&user.fields=description%2Cpublic_metrics%2Cprofile_image_url%2Ccreated_at%2Cverified&pagination_token=next-page",
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
			"/2/users/1/blocking?max_results=100&user.fields=description%2Cpublic_metrics%2Cprofile_image_url%2Ccreated_at",
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
			"/2/users/42/tweets?max_results=12&tweet.fields=created_at%2Cconversation_id%2Cpublic_metrics%2Creferenced_tweets&exclude=retweets",
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
			"/2/tweets?ids=tweet_1&expansions=author_id&tweet.fields=created_at%2Cconversation_id%2Centities%2Cpublic_metrics%2Creferenced_tweets&user.fields=description%2Cpublic_metrics%2Cprofile_image_url%2Ccreated_at%2Cverified",
		]);
	});

	it("lists liked and bookmarked tweets through raw Twitter endpoints", async () => {
		execFileAsyncMock
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ data: [{ id: "25401953" }] }),
				stderr: "",
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify({
					data: [{ id: "liked_1", author_id: "42", text: "liked" }],
					includes: { users: [{ id: "42", username: "sam", name: "Sam" }] },
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
			data: [{ id: "liked_1", author_id: "42", text: "liked" }],
			includes: { users: [{ id: "42", username: "sam", name: "Sam" }] },
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
			"/2/users/25401953/liked_tweets?max_results=5&expansions=author_id&tweet.fields=created_at%2Cconversation_id%2Centities%2Cpublic_metrics%2Creferenced_tweets&user.fields=description%2Cpublic_metrics%2Cprofile_image_url%2Ccreated_at%2Cverified",
		]);
		expect(execFileAsyncMock).toHaveBeenCalledWith("xurl", [
			"--auth",
			"oauth2",
			"/2/users/25401953/bookmarks?max_results=100&expansions=author_id&tweet.fields=created_at%2Cconversation_id%2Centities%2Cpublic_metrics%2Creferenced_tweets&user.fields=description%2Cpublic_metrics%2Cprofile_image_url%2Ccreated_at%2Cverified&pagination_token=next",
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
			"/2/users/42/tweets?max_results=50&tweet.fields=created_at%2Cconversation_id%2Cpublic_metrics%2Creferenced_tweets&pagination_token=next-page",
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
			"/2/users/1/blocking?max_results=100&user.fields=description%2Cpublic_metrics%2Cprofile_image_url%2Ccreated_at&pagination_token=next-page",
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
