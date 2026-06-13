// @vitest-environment node
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const queryResourceMock = vi.fn();
const isTweetInPublicTimelineMock = vi.fn();
const maybeAutoUpdateBackupMock = vi.fn();

vi.mock("#/lib/queries", () => ({
	isTweetInPublicTimeline: (...args: unknown[]) =>
		isTweetInPublicTimelineMock(...args),
	queryResource: (...args: unknown[]) => queryResourceMock(...args),
}));
vi.mock("#/lib/backup", () => ({
	maybeAutoUpdateBackup: () => maybeAutoUpdateBackupMock(),
	maybeAutoUpdateBackupEffect: () =>
		Effect.promise(() => Promise.resolve(maybeAutoUpdateBackupMock())),
}));

import { Route } from "./query";

const GET = getRouteHandler(Route, "GET");

describe("api query route", () => {
	beforeEach(() => {
		queryResourceMock.mockReset();
		isTweetInPublicTimelineMock.mockReset();
		isTweetInPublicTimelineMock.mockReturnValue(true);
		maybeAutoUpdateBackupMock.mockReset();
		maybeAutoUpdateBackupMock.mockResolvedValue({ skipped: true });
	});

	it("parses dm filters", async () => {
		queryResourceMock.mockReturnValue({ resource: "dms", items: [] });
		const response = await GET({
			request: new Request(
				"http://localhost/api/query?resource=dms&inbox=requests&replyFilter=unreplied&minFollowers=10&minInfluenceScore=90&sort=followers",
			),
		});

		expect(queryResourceMock).toHaveBeenCalledWith(
			"dms",
			expect.objectContaining({
				replyFilter: "unreplied",
				minFollowers: 10,
				minInfluenceScore: 90,
				sort: "followers",
				inbox: "requests",
			}),
		);
		expect(response.status).toBe(200);
	});

	it("accepts the legacy dm influence sort as followers", async () => {
		queryResourceMock.mockReturnValue({ resource: "dms", items: [] });
		await GET({
			request: new Request(
				"http://localhost/api/query?resource=dms&sort=influence",
			),
		});

		expect(queryResourceMock).toHaveBeenCalledWith(
			"dms",
			expect.objectContaining({
				sort: "followers",
			}),
		);
	});

	it("defaults invalid reply filters to all", async () => {
		queryResourceMock.mockReturnValue({ resource: "home", items: [] });
		await GET({
			request: new Request(
				"http://localhost/api/query?resource=home&replyFilter=bad&since=2020-01-01&until=2021-01-01&qualityFilter=summary&originalsOnly=true",
			),
		});

		expect(queryResourceMock).toHaveBeenCalledWith(
			"home",
			expect.objectContaining({
				replyFilter: "all",
				resource: "home",
				since: "2020-01-01",
				until: "2021-01-01",
				includeReplies: false,
				qualityFilter: "summary",
			}),
		);
	});

	it("drops invalid numeric filters and defaults sort", async () => {
		queryResourceMock.mockReturnValue({ resource: "dms", items: [] });
		await GET({
			request: new Request(
				"http://localhost/api/query?resource=dms&minFollowers=wat&maxFollowers=33&maxInfluenceScore=nope&sort=bad",
			),
		});

		expect(queryResourceMock).toHaveBeenCalledWith(
			"dms",
			expect.objectContaining({
				minFollowers: undefined,
				maxFollowers: 33,
				maxInfluenceScore: undefined,
				inbox: "all",
				sort: "recent",
			}),
		);
	});

	it("defaults to home when resource is omitted", async () => {
		queryResourceMock.mockReturnValue({ resource: "home", items: [] });

		await GET({
			request: new Request("http://localhost/api/query"),
		});

		expect(queryResourceMock).toHaveBeenCalledWith(
			"home",
			expect.objectContaining({
				resource: "home",
			}),
		);
	});

	it("denies private resources in public read-only mode", async () => {
		const originalProfile = process.env.BIRDCLAW_WEB_PROFILE;
		process.env.BIRDCLAW_WEB_PROFILE = "public-readonly";

		try {
			const response = await GET({
				request: new Request("http://localhost/api/query?resource=dms"),
			});
			const authoredResponse = await GET({
				request: new Request("http://localhost/api/query?resource=authored"),
			});
			const searchResponse = await GET({
				request: new Request("http://localhost/api/query?resource=search"),
			});

			expect(response.status).toBe(403);
			expect(authoredResponse.status).toBe(403);
			expect(searchResponse.status).toBe(403);
			expect(queryResourceMock).not.toHaveBeenCalled();
		} finally {
			if (originalProfile === undefined) {
				delete process.env.BIRDCLAW_WEB_PROFILE;
			} else {
				process.env.BIRDCLAW_WEB_PROFILE = originalProfile;
			}
		}
	});

	it("sanitizes timeline state and ignores private filters in public mode", async () => {
		const originalProfile = process.env.BIRDCLAW_WEB_PROFILE;
		process.env.BIRDCLAW_WEB_PROFILE = "public-readonly";
		queryResourceMock.mockReturnValue({
			resource: "home",
			items: [
				{
					id: "tweet_1",
					accountId: "acct_private",
					accountHandle: "@private",
					kind: "home",
					text: "hello",
					createdAt: "2026-06-13T12:00:00.000Z",
					isReplied: true,
					likeCount: 1,
					mediaCount: 0,
					bookmarked: true,
					liked: true,
					qualityReason: "private score",
					author: {},
					entities: {
						mentions: [
							{
								username: "private",
								start: 0,
								end: 8,
								profile: { id: "profile_private", bio: "private" },
							},
						],
					},
					media: [],
					replyToTweet: {
						id: "private_context",
						text: "private",
						createdAt: "2026-06-13T11:59:00.000Z",
						author: {},
						entities: {},
						media: [],
					},
				},
			],
		});
		isTweetInPublicTimelineMock.mockReturnValue(false);

		try {
			const response = await GET({
				request: new Request(
					"http://localhost/api/query?resource=home&account=acct_private&replyFilter=replied&liked=true&bookmarked=true",
				),
			});

			expect(queryResourceMock).toHaveBeenCalledWith(
				"home",
				expect.objectContaining({
					account: undefined,
					replyFilter: "all",
					likedOnly: false,
					bookmarkedOnly: false,
				}),
			);
			const body = (await response.json()) as {
				items: Array<Record<string, unknown>>;
			};
			expect(body).toMatchObject({
				items: [
					{
						accountId: "",
						accountHandle: "",
						isReplied: false,
						bookmarked: false,
						liked: false,
						replyToTweet: null,
					},
				],
			});
			expect(body.items[0]).not.toHaveProperty("qualityReason");
			const entities = body.items[0]?.entities as
				| { mentions?: Array<Record<string, unknown>> }
				| undefined;
			expect(entities?.mentions?.[0]).not.toHaveProperty("profile");
		} finally {
			if (originalProfile === undefined) {
				delete process.env.BIRDCLAW_WEB_PROFILE;
			} else {
				process.env.BIRDCLAW_WEB_PROFILE = originalProfile;
			}
		}
	});
});
