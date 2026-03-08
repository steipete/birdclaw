// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const addBlockMock = vi.fn();
const createPostMock = vi.fn();
const createTweetReplyMock = vi.fn();
const createDmReplyMock = vi.fn();
const removeBlockMock = vi.fn();
const scoreInboxMock = vi.fn();

vi.mock("#/lib/blocks", () => ({
	addBlock: (...args: unknown[]) => addBlockMock(...args),
	removeBlock: (...args: unknown[]) => removeBlockMock(...args),
}));

vi.mock("#/lib/queries", () => ({
	createPost: (...args: unknown[]) => createPostMock(...args),
	createTweetReply: (...args: unknown[]) => createTweetReplyMock(...args),
	createDmReply: (...args: unknown[]) => createDmReplyMock(...args),
}));

vi.mock("#/lib/inbox", () => ({
	scoreInbox: (...args: unknown[]) => scoreInboxMock(...args),
}));

import { Route } from "./action";

describe("api action route", () => {
	beforeEach(() => {
		addBlockMock.mockReset();
		createPostMock.mockReset();
		createTweetReplyMock.mockReset();
		createDmReplyMock.mockReset();
		removeBlockMock.mockReset();
		scoreInboxMock.mockReset();
	});

	it("dispatches scoreInbox actions", async () => {
		scoreInboxMock.mockResolvedValue({ ok: true });
		const response = await Route.options.server.handlers.POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({
					kind: "scoreInbox",
					scoreKind: "mixed",
					limit: "4",
				}),
			}),
		});

		expect(scoreInboxMock).toHaveBeenCalledWith({ kind: "mixed", limit: 4 });
		expect(response.status).toBe(200);
	});

	it("dispatches post actions", async () => {
		createPostMock.mockResolvedValue({ ok: true, tweetId: "tweet_007" });
		const response = await Route.options.server.handlers.POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({
					kind: "post",
					accountId: "acct_studio",
					text: "Ship more local software",
				}),
			}),
		});

		expect(createPostMock).toHaveBeenCalledWith(
			"acct_studio",
			"Ship more local software",
		);
		expect(await response.json()).toEqual({ ok: true, tweetId: "tweet_007" });
	});

	it("dispatches tweet reply actions", async () => {
		createTweetReplyMock.mockResolvedValue({
			ok: true,
			replyId: "tweet_reply",
		});
		const response = await Route.options.server.handlers.POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({
					kind: "replyTweet",
					accountId: "acct_primary",
					tweetId: "tweet_004",
					text: "Worth replying fast.",
				}),
			}),
		});

		expect(createTweetReplyMock).toHaveBeenCalledWith(
			"acct_primary",
			"tweet_004",
			"Worth replying fast.",
		);
		expect(response.status).toBe(200);
	});

	it("dispatches dm reply actions", async () => {
		createDmReplyMock.mockResolvedValue({ ok: true, messageId: "msg_009" });
		const response = await Route.options.server.handlers.POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({
					kind: "replyDm",
					conversationId: "dm_003",
					text: "Send the mock.",
				}),
			}),
		});

		expect(createDmReplyMock).toHaveBeenCalledWith("dm_003", "Send the mock.");
		expect(response.status).toBe(200);
	});

	it("dispatches blocklist actions", async () => {
		addBlockMock.mockResolvedValue({ ok: true, action: "block" });
		removeBlockMock.mockResolvedValue({ ok: true, action: "unblock" });

		await Route.options.server.handlers.POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({
					kind: "blockProfile",
					accountId: "acct_primary",
					query: "@sam",
				}),
			}),
		});
		await Route.options.server.handlers.POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({
					kind: "unblockProfile",
					accountId: "acct_primary",
					query: "@sam",
				}),
			}),
		});

		expect(addBlockMock).toHaveBeenCalledWith("acct_primary", "@sam");
		expect(removeBlockMock).toHaveBeenCalledWith("acct_primary", "@sam");
	});

	it("rejects unknown actions", async () => {
		const response = await Route.options.server.handlers.POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({ kind: "wat" }),
			}),
		});

		expect(response.status).toBe(400);
	});

	it("uses fallback values when post payload fields are missing", async () => {
		createPostMock.mockResolvedValue({ ok: true });

		await Route.options.server.handlers.POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({ kind: "post" }),
			}),
		});

		expect(createPostMock).toHaveBeenCalledWith("acct_primary", "");
	});

	it("uses fallback values when tweet reply payload fields are missing", async () => {
		createTweetReplyMock.mockResolvedValue({ ok: true });

		await Route.options.server.handlers.POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({ kind: "replyTweet" }),
			}),
		});

		expect(createTweetReplyMock).toHaveBeenCalledWith("acct_primary", "", "");
	});

	it("uses fallback values when dm reply payload fields are missing", async () => {
		createDmReplyMock.mockResolvedValue({ ok: true });

		await Route.options.server.handlers.POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({ kind: "replyDm" }),
			}),
		});

		expect(createDmReplyMock).toHaveBeenCalledWith("", "");
	});

	it("uses score defaults when score payload fields are missing", async () => {
		scoreInboxMock.mockResolvedValue({ ok: true });

		await Route.options.server.handlers.POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({ kind: "scoreInbox" }),
			}),
		});

		expect(scoreInboxMock).toHaveBeenCalledWith({ kind: "mixed", limit: 8 });
	});

	it("uses fallback values when block payload fields are missing", async () => {
		addBlockMock.mockResolvedValue({ ok: true });
		removeBlockMock.mockResolvedValue({ ok: true });

		await Route.options.server.handlers.POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({ kind: "blockProfile" }),
			}),
		});
		await Route.options.server.handlers.POST({
			request: new Request("http://localhost/api/action", {
				method: "POST",
				body: JSON.stringify({ kind: "unblockProfile" }),
			}),
		});

		expect(addBlockMock).toHaveBeenCalledWith("acct_primary", "");
		expect(removeBlockMock).toHaveBeenCalledWith("acct_primary", "");
	});
});
