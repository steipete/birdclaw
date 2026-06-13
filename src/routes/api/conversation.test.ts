// @vitest-environment node
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const getTweetConversationMock = vi.fn();
const isTweetInPublicTimelineMock = vi.fn();
const maybeAutoUpdateBackupMock = vi.fn();

vi.mock("#/lib/queries", () => ({
	getTweetConversation: (...args: unknown[]) =>
		getTweetConversationMock(...args),
	isTweetInPublicTimeline: (...args: unknown[]) =>
		isTweetInPublicTimelineMock(...args),
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
		isTweetInPublicTimelineMock.mockReset();
		isTweetInPublicTimelineMock.mockReturnValue(true);
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

	it("hides conversations outside public timelines in public mode", async () => {
		const originalProfile = process.env.BIRDCLAW_WEB_PROFILE;
		process.env.BIRDCLAW_WEB_PROFILE = "public-readonly";
		isTweetInPublicTimelineMock.mockReturnValue(false);

		try {
			const response = await GET({
				request: new Request(
					"http://localhost/api/conversation?tweetId=private_tweet",
				),
			});

			expect(response.status).toBe(404);
			expect(isTweetInPublicTimelineMock).toHaveBeenCalledWith("private_tweet");
			expect(getTweetConversationMock).not.toHaveBeenCalled();
			expect(maybeAutoUpdateBackupMock).not.toHaveBeenCalled();
		} finally {
			if (originalProfile === undefined) {
				delete process.env.BIRDCLAW_WEB_PROFILE;
			} else {
				process.env.BIRDCLAW_WEB_PROFILE = originalProfile;
			}
		}
	});

	it("filters private thread context from public conversations", async () => {
		const originalProfile = process.env.BIRDCLAW_WEB_PROFILE;
		process.env.BIRDCLAW_WEB_PROFILE = "public-readonly";
		isTweetInPublicTimelineMock.mockImplementation(
			(tweetId: string) => tweetId !== "private_context",
		);
		getTweetConversationMock.mockReturnValue({
			anchorId: "public_anchor",
			items: [
				{
					id: "private_context",
					text: "private",
					isReplied: true,
					bookmarked: true,
					liked: true,
					entities: {},
				},
				{
					id: "public_anchor",
					text: "public",
					isReplied: true,
					bookmarked: true,
					liked: true,
					entities: {},
				},
			],
		});

		try {
			const response = await GET({
				request: new Request(
					"http://localhost/api/conversation?tweetId=public_anchor",
				),
			});
			const body = (await response.json()) as {
				items: Array<Record<string, unknown>>;
			};

			expect(body.items).toEqual([
				expect.objectContaining({
					id: "public_anchor",
					isReplied: false,
					bookmarked: false,
					liked: false,
				}),
			]);
		} finally {
			if (originalProfile === undefined) {
				delete process.env.BIRDCLAW_WEB_PROFILE;
			} else {
				process.env.BIRDCLAW_WEB_PROFILE = originalProfile;
			}
		}
	});
});
