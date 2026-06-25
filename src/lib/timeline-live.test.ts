// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { listTimelineItems } from "./queries";

const getAuthenticatedBirdAccountMock = vi.fn();
const listHomeTimelineViaBirdMock = vi.fn();
const listHomeTimelineViaXurlMock = vi.fn();

vi.mock("./bird", async () => {
	const { Effect } = await import("effect");
	return {
		listHomeTimelineViaBird: (...args: unknown[]) =>
			listHomeTimelineViaBirdMock(...args),
		listHomeTimelineViaBirdEffect: (...args: unknown[]) =>
			Effect.tryPromise({
				try: () => listHomeTimelineViaBirdMock(...args),
				catch: (error) => error,
			}),
		getAuthenticatedBirdAccountEffect: (...args: unknown[]) =>
			Effect.tryPromise({
				try: () => getAuthenticatedBirdAccountMock(...args),
				catch: (error) => error,
			}),
	};
});

vi.mock("./xurl", async () => {
	const { Effect } = await import("effect");
	return {
		listHomeTimelineViaXurlEffect: (...args: unknown[]) =>
			Effect.tryPromise({
				try: () => listHomeTimelineViaXurlMock(...args),
				catch: (error) => error,
			}),
	};
});

const tempDirs: string[] = [];

function makeTempHome() {
	const tempDir = mkdtempSync(
		path.join(os.tmpdir(), "birdclaw-timeline-live-"),
	);
	tempDirs.push(tempDir);
	process.env.BIRDCLAW_HOME = tempDir;
	const db = getNativeDb();
	db.prepare("update accounts set bird_profile_name = ? where id = ?").run(
		"profile-primary",
		"acct_primary",
	);
	db.prepare("update accounts set bird_profile_name = ? where id = ?").run(
		"profile-studio",
		"acct_studio",
	);
	getAuthenticatedBirdAccountMock.mockImplementation((profileName: string) => {
		if (profileName === "profile-studio") {
			return Promise.resolve({
				username: "birdclaw_lab",
			});
		}
		return Promise.resolve({
			id: "25401953",
			username: "steipete",
		});
	});
	return tempDir;
}

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	getAuthenticatedBirdAccountMock.mockReset();
	listHomeTimelineViaBirdMock.mockReset();
	listHomeTimelineViaXurlMock.mockReset();

	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("live home timeline sync", () => {
	it("keeps home timeline sync effects lazy", async () => {
		makeTempHome();
		listHomeTimelineViaBirdMock.mockResolvedValueOnce({
			data: [],
			meta: { result_count: 0 },
		});
		const { syncHomeTimelineEffect } = await import("./timeline-live");
		const progress: unknown[] = [];

		const effect = syncHomeTimelineEffect({
			account: "acct_primary",
			limit: 5,
			refresh: true,
			onProgress: (value) => progress.push(value),
		});

		expect(listHomeTimelineViaBirdMock).not.toHaveBeenCalled();
		await expect(Effect.runPromise(effect)).resolves.toMatchObject({
			source: "bird",
			count: 0,
		});
		expect(progress).toEqual([
			expect.objectContaining({
				source: "bird",
				fetched: 0,
				total: 5,
				done: true,
			}),
		]);
		expect(listHomeTimelineViaBirdMock).toHaveBeenCalledTimes(1);
	});

	it("stores account-scoped home timeline edges without moving canonical tweets", async () => {
		makeTempHome();
		const db = getNativeDb(		);
		listHomeTimelineViaBirdMock.mockResolvedValueOnce({
			data: [
				{
					id: "tweet_001",
					author_id: "42",
					text: "same canonical tweet, another account timeline",
					created_at: "2026-04-26T13:43:34.000Z",
					public_metrics: { like_count: 12 },
				},
			],
			includes: {
				users: [
					{
						id: "42",
						username: "sam",
						name: "Sam",
						profile_image_url:
							"https://pbs.twimg.com/profile_images/42/avatar_normal.jpg",
					},
				],
			},
			meta: { result_count: 1 },
		});
		const { syncHomeTimeline } = await import("./timeline-live");

		await syncHomeTimeline({
			account: "acct_studio",
			limit: 5,
			refresh: true,
		});

		expect(
			db.prepare("select id from tweets where id = ?").get("tweet_001"),
		).toEqual({ id: "tweet_001" });
		expect(
			db
				.prepare(
					"select account_id, kind from tweet_account_edges where tweet_id = ? and account_id = ?",
				)
				.get("tweet_001", "acct_primary"),
		).toEqual({ account_id: "acct_primary", kind: "home" });
		expect(
			db.prepare("select avatar_url from profiles where handle = ?").get("sam"),
		).toEqual({
			avatar_url: "https://pbs.twimg.com/profile_images/42/avatar.jpg",
		});
		expect(
			db
				.prepare(
					"select account_id, kind, source from tweet_account_edges where tweet_id = ? and account_id = ?",
				)
				.get("tweet_001", "acct_studio"),
		).toEqual({
			account_id: "acct_studio",
			kind: "home",
			source: "bird",
		});
		expect(
			listTimelineItems({
				resource: "home",
				account: "acct_studio",
				search: "canonical",
				limit: 5,
			}),
		).toEqual([
			expect.objectContaining({
				id: "tweet_001",
				accountId: "acct_studio",
			}),
		]);
	});

	it("preserves existing media_json when home payload omits media details", async () => {
		makeTempHome();
		const db = getNativeDb();
		const existingMediaJson = JSON.stringify([
			{
				url: "https://pbs.twimg.com/media/existing.jpg",
				type: "image",
				variants: [{ url: "https://video.twimg.com/existing.mp4" }],
			},
		]);
		db.prepare(
			`
      insert into tweets (
		id, author_profile_id, text, created_at,
		is_replied, reply_to_id, like_count, media_count,
		entities_json, media_json, quoted_tweet_id
	  ) values (?, 'profile_user_42', ?, ?, 0, null, 0, 1, '{}', ?, null)
      `,
		).run(
			"home_partial_media",
			"old home media",
			"2026-04-26T13:00:00.000Z",
			existingMediaJson,
		);
		listHomeTimelineViaBirdMock.mockResolvedValueOnce({
			data: [
				{
					id: "home_partial_media",
					author_id: "42",
					text: "partial home media",
					created_at: "2026-04-26T13:43:34.000Z",
				},
			],
			includes: {
				users: [{ id: "42", username: "sam", name: "Sam" }],
			},
			meta: { result_count: 1 },
		});
		const { syncHomeTimeline } = await import("./timeline-live");

		await syncHomeTimeline({
			account: "acct_primary",
			limit: 5,
			refresh: true,
		});
		const row = db
			.prepare("select media_count, media_json from tweets where id = ?")
			.get("home_partial_media") as {
			media_count: number;
			media_json: string;
		};

		expect(row.media_count).toBe(1);
		expect(row.media_json).toBe(existingMediaJson);
	});

	it("persists Twitter Article metadata for timeline cards and popovers", async () => {
		makeTempHome();
		listHomeTimelineViaBirdMock.mockResolvedValueOnce({
			data: [
				{
					id: "2066182223213293753",
					author_id: "20571756",
					text: "A frontier without an ecosystem is not stable",
					created_at: "2026-06-14T15:33:24.000Z",
					entities: {
						article: {
							title: "A frontier without an ecosystem is not stable",
							previewText: "I have been thinking about the future of the firm.",
							url: "https://x.com/satyanadella/status/2066182223213293753",
						},
					},
				},
			],
			includes: {
				users: [
					{
						id: "20571756",
						username: "satyanadella",
						name: "Satya Nadella",
					},
				],
			},
			meta: { result_count: 1 },
		});
		const { syncHomeTimeline } = await import("./timeline-live");

		await syncHomeTimeline({
			account: "acct_primary",
			limit: 5,
			refresh: true,
		});

		expect(
			listTimelineItems({
				resource: "home",
				account: "acct_primary",
				search: "frontier",
				limit: 5,
			}),
		).toEqual([
			expect.objectContaining({
				id: "2066182223213293753",
				entities: expect.objectContaining({
					article: {
						title: "A frontier without an ecosystem is not stable",
						previewText: "I have been thinking about the future of the firm.",
						url: "https://x.com/satyanadella/status/2066182223213293753",
					},
				}),
			}),
		]);
	});

	it("fetches paginated xurl home timeline and stores reply context", async () => {
		makeTempHome();
		const db = getNativeDb();
		listHomeTimelineViaXurlMock
			.mockResolvedValueOnce({
				data: [
					{
						id: "home_xurl_reply",
						author_id: "42",
						text: "reply from the live timeline",
						created_at: "2026-04-26T13:43:34.000Z",
						referenced_tweets: [{ type: "replied_to", id: "tweet_001" }],
						public_metrics: { like_count: 12 },
					},
				],
				includes: {
					users: [{ id: "42", username: "sam", name: "Sam" }],
				},
				meta: { next_token: "next-page" },
			})
			.mockResolvedValueOnce({
				data: [
					{
						id: "home_xurl_2",
						author_id: "43",
						text: "second page item",
						created_at: "2026-04-26T13:40:34.000Z",
					},
				],
				includes: {
					users: [{ id: "43", username: "lee", name: "Lee" }],
				},
				meta: { next_token: "unused-page" },
			});
		const { syncHomeTimeline } = await import("./timeline-live");
		const progress: unknown[] = [];

		const result = await syncHomeTimeline({
			account: "acct_primary",
			mode: "xurl",
			limit: 3,
			maxPages: 2,
			refresh: true,
			onProgress: (value) => progress.push(value),
		});

		expect(result).toMatchObject({ source: "xurl", count: 2 });
		expect(progress).toEqual([
			expect.objectContaining({
				source: "xurl",
				fetched: 1,
				total: 3,
				page: 1,
				maxPages: 2,
				done: false,
			}),
			expect.objectContaining({
				source: "xurl",
				fetched: 2,
				total: 3,
				page: 2,
				maxPages: 2,
				done: true,
			}),
		]);
		expect(listHomeTimelineViaXurlMock).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				maxResults: 5,
				userId: "25401953",
				username: "steipete",
			}),
		);
		expect(listHomeTimelineViaXurlMock).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ paginationToken: "next-page" }),
		);
		expect(
			db
				.prepare(
					"select reply_to_id, is_replied from tweets where id = 'home_xurl_reply'",
				)
				.get(),
		).toEqual({ reply_to_id: "tweet_001", is_replied: 0 });
		expect(
			db
				.prepare(
					"select source from tweet_account_edges where tweet_id = 'home_xurl_reply'",
				)
				.get(),
		).toEqual({ source: "xurl" });
	});

	it("walks xurl home timeline until the selected start time without a page cap", async () => {
		makeTempHome();
		listHomeTimelineViaXurlMock
			.mockResolvedValueOnce({
				data: [
					{
						id: "home_recent",
						author_id: "42",
						text: "recent timeline item",
						created_at: "2026-04-26T13:43:34.000Z",
					},
				],
				includes: {
					users: [{ id: "42", username: "sam", name: "Sam" }],
				},
				meta: { next_token: "page-2" },
			})
			.mockResolvedValueOnce({
				data: [
					{
						id: "home_boundary",
						author_id: "43",
						text: "boundary timeline item",
						created_at: "2026-04-25T23:59:00.000Z",
					},
				],
				includes: {
					users: [{ id: "43", username: "lee", name: "Lee" }],
				},
				meta: { next_token: "page-3" },
			});
		const { syncHomeTimeline } = await import("./timeline-live");

		const result = await syncHomeTimeline({
			account: "acct_primary",
			mode: "xurl",
			startTime: "2026-04-26T00:00:00.000Z",
			refresh: true,
		});

		expect(result).toMatchObject({ source: "xurl", count: 2 });
		expect(listHomeTimelineViaXurlMock).toHaveBeenCalledTimes(2);
		expect(listHomeTimelineViaXurlMock).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ maxResults: 100 }),
		);
		expect(listHomeTimelineViaXurlMock).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ paginationToken: "page-2" }),
		);
	});

	it("rejects bird imports when a selected start time is present", async () => {
		makeTempHome();
		const { syncHomeTimeline } = await import("./timeline-live");

		await expect(
			syncHomeTimeline({
				account: "acct_primary",
				mode: "bird",
				startTime: "2026-04-26T00:00:00.000Z",
				refresh: true,
			}),
		).rejects.toThrow("bird home timeline mode does not support --start-time");
		expect(listHomeTimelineViaBirdMock).not.toHaveBeenCalled();
	});

	it("rejects bird home timeline sync when the authenticated account mismatches", async () => {
		makeTempHome();
		getAuthenticatedBirdAccountMock.mockResolvedValueOnce({
			id: "1995710751097659392",
			username: "wrong_account",
		});
		const { syncHomeTimeline } = await import("./timeline-live");

		await expect(
			syncHomeTimeline({
				account: "acct_primary",
				mode: "bird",
				limit: 5,
				refresh: true,
			}),
		).rejects.toThrow(
			"bird is authenticated as user 1995710751097659392; refusing to sync into acct_primary (25401953)",
		);
		expect(getAuthenticatedBirdAccountMock).toHaveBeenCalledWith(
			"profile-primary",
		);
		expect(listHomeTimelineViaBirdMock).not.toHaveBeenCalled();
	});

	it("uses bird directly for auto mode and rejects xurl for-you imports", async () => {
		makeTempHome();
		listHomeTimelineViaBirdMock.mockResolvedValueOnce({
			data: [],
			meta: { result_count: 0 },
		});
		const { syncHomeTimeline } = await import("./timeline-live");

		await expect(
			syncHomeTimeline({
				account: "acct_primary",
				mode: "auto",
				limit: 5,
				refresh: true,
			}),
		).resolves.toMatchObject({ source: "bird" });
		expect(listHomeTimelineViaXurlMock).not.toHaveBeenCalled();
		await expect(
			syncHomeTimeline({
				account: "acct_primary",
				mode: "xurl",
				limit: 5,
				following: false,
				refresh: true,
			}),
		).rejects.toThrow("xurl home timeline mode does not support --for-you");
	});

	it("stops bird following timeline early when a fetched page is already local", async () => {
		makeTempHome();
		const db = getNativeDb();
		db.prepare(
			`
      insert into tweets (
        id, author_profile_id, text, created_at,
        is_replied, reply_to_id, like_count, media_count,
        entities_json, media_json, quoted_tweet_id
      ) values (?, 'profile_user_42', ?, ?, 0, null, 0, 0, '{}', '[]', null)
      `,
		).run(
			"home_existing_boundary",
			"existing boundary",
			"2026-04-26T13:43:34.000Z",
		);
		db.prepare(
			`
      insert into tweet_account_edges (
        account_id, tweet_id, kind, source, raw_json, first_seen_at, last_seen_at, seen_count, updated_at
      ) values ('acct_primary', 'home_existing_boundary', 'home', 'bird', '{}', ?, ?, 1, ?)
      `,
		).run(
			"2026-04-26T13:43:34.000Z",
			"2026-04-26T13:43:34.000Z",
			"2026-04-26T13:43:34.000Z",
		);
		listHomeTimelineViaBirdMock.mockResolvedValueOnce({
			data: [
				{
					id: "home_existing_boundary",
					author_id: "42",
					text: "existing boundary",
					created_at: "2026-04-26T13:43:34.000Z",
				},
			],
			includes: { users: [{ id: "42", username: "sam", name: "Sam" }] },
			meta: { result_count: 1, next_token: "older-page" },
		});
		const { syncHomeTimeline } = await import("./timeline-live");

		const result = await syncHomeTimeline({
			account: "acct_primary",
			mode: "bird",
			limit: 5,
			maxPages: 3,
			earlyStop: true,
			refresh: true,
		});

		expect(result).toMatchObject({ source: "bird", count: 0 });
		expect(listHomeTimelineViaBirdMock).toHaveBeenCalledTimes(1);
		expect(listHomeTimelineViaBirdMock).toHaveBeenCalledWith({
			maxResults: 5,
			following: true,
			all: true,
			maxPages: 1,
			profileName: "profile-primary",
		});
	});

	it("uses bird directly for non-default account auto syncs", async () => {
		makeTempHome();
		listHomeTimelineViaBirdMock.mockResolvedValueOnce({
			data: [],
			meta: { result_count: 0 },
		});
		const { syncHomeTimeline } = await import("./timeline-live");

		await expect(
			syncHomeTimeline({
				account: "acct_studio",
				mode: "auto",
				limit: 5,
				refresh: true,
			}),
		).resolves.toMatchObject({ source: "bird" });
		expect(listHomeTimelineViaXurlMock).not.toHaveBeenCalled();
		expect(listHomeTimelineViaBirdMock).toHaveBeenCalledTimes(1);
	});
});
