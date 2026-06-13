// @vitest-environment node
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const getTweetConversationMock = vi.fn();
const maybeAutoUpdateBackupMock = vi.fn();

vi.mock("#/lib/queries", () => ({
	getTweetConversation: (...args: unknown[]) =>
		getTweetConversationMock(...args),
}));
vi.mock("#/lib/backup", () => ({
	maybeAutoUpdateBackup: () => maybeAutoUpdateBackupMock(),
	maybeAutoUpdateBackupEffect: () =>
		Effect.promise(() => Promise.resolve(maybeAutoUpdateBackupMock())),
}));

import { Route } from "./conversation";

const GET = getRouteHandler(Route, "GET");

describe("api conversation route", () => {
	beforeEach(() => {
		getTweetConversationMock.mockReset();
		maybeAutoUpdateBackupMock.mockReset();
		maybeAutoUpdateBackupMock.mockResolvedValue({ skipped: true });
	});

	it("returns a tweet conversation", async () => {
		getTweetConversationMock.mockReturnValue({
			anchorId: "tweet_1",
			items: [{ id: "tweet_1", text: "hello" }],
		});

		const response = await GET({
			request: new Request("http://localhost/api/conversation?tweetId=tweet_1"),
		});
		const body = (await response.json()) as { ok: boolean; anchorId: string };

		expect(getTweetConversationMock).toHaveBeenCalledWith("tweet_1");
		expect(response.status).toBe(200);
		expect(body).toMatchObject({ ok: true, anchorId: "tweet_1" });
	});

	it("validates missing and unknown tweets", async () => {
		const missing = await GET({
			request: new Request("http://localhost/api/conversation"),
		});
		expect(missing.status).toBe(400);

		getTweetConversationMock.mockReturnValue(null);
		const unknown = await GET({
			request: new Request("http://localhost/api/conversation?tweetId=missing"),
		});
		expect(unknown.status).toBe(404);
	});
});
