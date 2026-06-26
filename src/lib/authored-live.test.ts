// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { listTimelineItems } from "./queries";

const mocks = vi.hoisted(() => ({
	getAuthenticatedBirdAccount: vi.fn(),
	getTransportStatus: vi.fn(),
	listUserTweetsViaBird: vi.fn(),
	listUserTweets: vi.fn(),
	lookupAuthenticatedUser: vi.fn(),
}));

vi.mock("./bird", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./bird")>();
	const { Effect } = await import("effect");
	const toError = (error: unknown) =>
		error instanceof Error ? error : new Error(String(error));
	return {
		...actual,
		getAuthenticatedBirdAccount: () => mocks.getAuthenticatedBirdAccount(),
		getAuthenticatedBirdAccountEffect: () =>
			Effect.tryPromise({
				try: () => mocks.getAuthenticatedBirdAccount(),
				catch: toError,
			}),
		listUserTweetsViaBird: (...args: unknown[]) =>
			mocks.listUserTweetsViaBird(...args),
		listUserTweetsViaBirdEffect: (...args: unknown[]) =>
			Effect.tryPromise({
				try: () => mocks.listUserTweetsViaBird(...args),
				catch: toError,
			}),
	};
});

vi.mock("./xurl", () => ({
	getTransportStatus: (...args: unknown[]) => mocks.getTransportStatus(...args),
	listUserTweets: (...args: unknown[]) => mocks.listUserTweets(...args),
	lookupAuthenticatedUser: (...args: unknown[]) =>
		mocks.lookupAuthenticatedUser(...args),
}));

const tempDirs: string[] = [];

function makeTempHome() {
	const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-authored-"));
	tempDirs.push(tempDir);
	process.env.BIRDCLAW_HOME = tempDir;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
	const db = getNativeDb();
	db.prepare("update accounts set bird_profile_name = ? where id = ?").run(
		"profile-primary",
		"acct_primary",
	);
	db.prepare("update accounts set bird_profile_name = ? where id = ?").run(
		"profile-studio",
		"acct_studio",
	);
}

function makeArchiveWithTweet(id: string) {
	const root = mkdtempSync(
		path.join(os.tmpdir(), "birdclaw-authored-archive-"),
	);
	tempDirs.push(root);
	const archiveDir = path.join(root, "sample", "data");
	mkdirSync(archiveDir, { recursive: true });
	writeFileSync(
		path.join(archiveDir, "account.js"),
		`window.YTD.account.part0 = [
  { "account": { "accountId": "25401953", "username": "steipete", "accountDisplayName": "Peter Steinberger", "createdAt": "2009-03-19T22:54:05.000Z" } }
]`,
	);
	writeFileSync(
		path.join(archiveDir, "tweets.js"),
		`window.YTD.tweets.part0 = [
  { "tweet": { "id_str": "${id}", "created_at": "Tue Jun 03 19:32:20 +0000 2025", "full_text": "archive baseline ${id}", "favorite_count": "0" } }
]`,
	);
	const archivePath = path.join(root, "archive.zip");
	execFileSync("zip", ["-qr", archivePath, "sample"], { cwd: root });
	return archivePath;
}

function authoredTweet(id: string, text = id) {
	return {
		id,
		author_id: "25401953",
		text,
		created_at: "2026-05-11T12:00:00.000Z",
	};
}

function authoredPage(id: string, nextToken: string | null = null) {
	return {
		items: [authoredTweet(id)],
		nextToken,
	};
}

function authoredEdgeCount(tweetId?: string) {
	const where = tweetId ? "tweet_id = ? and kind = ?" : "kind = ?";
	return getNativeDb()
		.prepare(`select count(*) as count from tweet_account_edges where ${where}`)
		.get(...(tweetId ? [tweetId, "authored"] : ["authored"]));
}

function authoredCursor(accountId = "acct_primary", source = "xurl") {
	const row = getNativeDb()
		.prepare("select value_json from sync_cache where cache_key = ?")
		.get(`authored:${source}:${accountId}:cursor`) as
		| { value_json: string }
		| undefined;
	return row ? JSON.parse(row.value_json) : null;
}

function insertLocalAuthoredHomeTweet({
	id,
	source = "archive",
	edgeAccountId = "acct_primary",
}: {
	id: string;
	source?: string;
	edgeAccountId?: string;
}) {
	getNativeDb()
		.prepare(
			`
      insert into tweets (
        id, author_profile_id, text, created_at, is_replied,
        reply_to_id, like_count, media_count, entities_json,
        media_json, quoted_tweet_id
      ) values (?, 'profile_user_25401953', ?, ?, 0, null, 0, 0, '{}', '[]', null)
      `,
		)
		.run(id, `archive tweet ${id}`, "2026-05-10T12:00:00.000Z");
	getNativeDb()
		.prepare(
			`
      insert into tweet_account_edges (
        account_id, tweet_id, kind, first_seen_at, last_seen_at, seen_count,
        source, raw_json, updated_at
      ) values (?, ?, 'home', ?, ?, 1, ?, '{}', ?)
      `,
		)
		.run(
			edgeAccountId,
			id,
			"2026-05-10T12:00:00.000Z",
			"2026-05-10T12:00:00.000Z",
			source,
			"2026-05-10T12:00:00.000Z",
		);
}

function insertAuthoredEdge(
	tweetId: string,
	accountId = "acct_primary",
	source = "xurl",
) {
	getNativeDb()
		.prepare(
			`
      insert into tweet_account_edges (
        account_id, tweet_id, kind, first_seen_at, last_seen_at, seen_count,
        source, raw_json, updated_at
      ) values (?, ?, 'authored', ?, ?, 1, ?, '{}', ?)
      `,
		)
		.run(
			accountId,
			tweetId,
			"2026-05-10T12:00:00.000Z",
			"2026-05-10T12:00:00.000Z",
			source,
			"2026-05-10T12:00:00.000Z",
		);
}

describe("live authored tweet sync", () => {
	beforeEach(() => {
		mocks.getAuthenticatedBirdAccount.mockResolvedValue({
			id: "25401953",
			username: "steipete",
		});
		mocks.getTransportStatus.mockResolvedValue({
			installed: true,
			availableTransport: "xurl",
			statusText: "xurl available",
		});
		mocks.lookupAuthenticatedUser.mockResolvedValue({
			id: "25401953",
			username: "steipete",
			name: "Peter Steinberger",
		});
	});

	afterEach(() => {
		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		delete process.env.BIRDCLAW_HOME;
		for (const mock of Object.values(mocks)) {
			mock.mockReset();
		}
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("builds authored sync effects lazily", async () => {
		makeTempHome();
		mocks.listUserTweets.mockResolvedValueOnce({
			items: [authoredTweet("99", "lazy authored")],
			nextToken: null,
		});
		const { syncAuthoredTweetsEffect } = await import("./authored-live");

		const effect = syncAuthoredTweetsEffect({ limit: 5 });

		expect(mocks.getTransportStatus).not.toHaveBeenCalled();
		expect(mocks.listUserTweets).not.toHaveBeenCalled();
		await expect(Effect.runPromise(effect)).resolves.toMatchObject({
			ok: true,
			kind: "authored",
			count: 1,
			nextSinceId: "99",
		});
		expect(mocks.listUserTweets).toHaveBeenCalledTimes(1);
	});

	it("syncs authored tweets through bird without spending xurl", async () => {
		makeTempHome();
		mocks.listUserTweetsViaBird.mockResolvedValueOnce({
			items: [authoredTweet("bird_authored_1", "bird authored")],
			includes: {
				users: [{ id: "25401953", username: "steipete", name: "Peter" }],
			},
			nextToken: null,
		});
		const { syncAuthoredTweets } = await import("./authored-live");

		const result = await syncAuthoredTweets({ mode: "bird", limit: 5 });

		expect(result).toMatchObject({
			ok: true,
			kind: "authored",
			source: "bird",
			count: 1,
			nextSinceId: "bird_authored_1",
		});
		expect(mocks.getTransportStatus).not.toHaveBeenCalled();
		expect(mocks.listUserTweets).not.toHaveBeenCalled();
		expect(mocks.getAuthenticatedBirdAccount).toHaveBeenCalledTimes(1);
		expect(mocks.listUserTweetsViaBird).toHaveBeenCalledWith(
			"steipete",
			expect.objectContaining({ maxResults: 5 }),
		);
		expect(authoredEdgeCount("bird_authored_1")).toEqual({ count: 1 });
		expect(
			getNativeDb()
				.prepare(
					"select source from tweet_account_edges where tweet_id = ? and kind = ?",
				)
				.get("bird_authored_1", "authored"),
		).toEqual({ source: "bird" });
	});

	it("stores and resumes authored bird cursors", async () => {
		makeTempHome();
		mocks.listUserTweetsViaBird
			.mockResolvedValueOnce({
				items: [authoredTweet("bird_cursor_2", "newest bird page")],
				nextToken: "cursor-2",
			})
			.mockResolvedValueOnce({
				items: [],
				nextToken: null,
			});
		const { syncAuthoredTweets } = await import("./authored-live");

		const partial = await syncAuthoredTweets({
			mode: "bird",
			limit: 5,
			maxPages: 1,
		});
		const resumed = await syncAuthoredTweets({ mode: "bird", limit: 5 });

		expect(partial).toMatchObject({
			ok: false,
			partial: true,
			source: "bird",
			nextToken: "cursor-2",
			cursor: { paginationToken: "cursor-2", pending: true },
		});
		expect(resumed).toMatchObject({
			ok: true,
			source: "bird",
			sinceId: null,
		});
		expect(mocks.getTransportStatus).not.toHaveBeenCalled();
		expect(mocks.listUserTweets).not.toHaveBeenCalled();
		expect(mocks.listUserTweetsViaBird).toHaveBeenNthCalledWith(
			1,
			"steipete",
			expect.objectContaining({ maxResults: 5, maxPages: 1 }),
		);
		expect(mocks.listUserTweetsViaBird).toHaveBeenNthCalledWith(
			2,
			"steipete",
			expect.objectContaining({ cursor: "cursor-2" }),
		);
		expect(authoredCursor("acct_primary", "bird")).toEqual({
			state: "committed",
			sinceId: "bird_cursor_2",
		});
	});

	it("validates authored sync effects only when run", async () => {
		makeTempHome();
		const { syncAuthoredTweetsEffect } = await import("./authored-live");

		const effect = syncAuthoredTweetsEffect({ limit: 4 });

		await expect(Effect.runPromise(effect)).rejects.toThrow(
			"xurl mode requires --limit between 5 and 100",
		);
		expect(mocks.getTransportStatus).not.toHaveBeenCalled();
		expect(mocks.listUserTweets).not.toHaveBeenCalled();
	});

	it("stops bird authored sync when it reaches the stored newest tweet", async () => {
		makeTempHome();
		mocks.listUserTweetsViaBird
			.mockResolvedValueOnce({
				items: [authoredTweet("300", "newest known")],
				nextToken: null,
			})
			.mockResolvedValueOnce({
				items: [
					authoredTweet("400", "new tweet"),
					authoredTweet("300", "newest known"),
					authoredTweet("250", "older"),
				],
				nextToken: "older-cursor",
			});
		const { syncAuthoredTweets } = await import("./authored-live");

		await syncAuthoredTweets({ mode: "bird", limit: 5 });
		const result = await syncAuthoredTweets({ mode: "bird", limit: 5 });

		expect(result).toMatchObject({
			ok: true,
			source: "bird",
			nextSinceId: "400",
			nextToken: "older-cursor",
			partial: false,
			cursor: { paginationToken: "older-cursor", pending: false },
		});
		expect(authoredCursor("acct_primary", "bird")).toEqual({
			state: "committed",
			sinceId: "400",
		});
	});

	it("handles an empty authored response without moving the cursor", async () => {
		makeTempHome();
		mocks.listUserTweets.mockResolvedValueOnce({
			items: [],
			nextToken: null,
		});
		const { syncAuthoredTweets } = await import("./authored-live");

		const result = await syncAuthoredTweets({ limit: 5 });

		expect(result).toMatchObject({
			ok: true,
			kind: "authored",
			source: "xurl",
			count: 0,
			pages: 1,
			sinceId: null,
			nextSinceId: null,
			partial: false,
		});
		expect(mocks.listUserTweets).toHaveBeenCalledWith(
			"25401953",
			expect.objectContaining({
				maxResults: 5,
				excludeRetweets: false,
				auth: "oauth2",
			}),
		);
		expect(
			getNativeDb()
				.prepare(
					"select count(*) as count from tweet_account_edges where kind = ?",
				)
				.get("authored"),
		).toEqual({ count: 0 });
	});

	it("syncs a single authored page into canonical tweets, profiles, FTS, and edges", async () => {
		makeTempHome();
		mocks.listUserTweets.mockResolvedValueOnce({
			items: [
				{
					id: "100",
					author_id: "25401953",
					text: "hello authored sync",
					created_at: "2026-05-11T12:00:00.000Z",
					conversation_id: "100",
					attachments: { media_keys: ["media_1"] },
					entities: {
						urls: [
							{
								url: "https://t.co/a",
								expanded_url: "https://example.com/a",
								display_url: "example.com/a",
								start: 20,
								end: 43,
							},
						],
					},
					public_metrics: { like_count: 9 },
					referenced_tweets: [{ type: "quoted", id: "90" }],
				},
			],
			includes: {
				users: [
					{
						id: "25401953",
						username: "steipete",
						name: "Peter Steinberger",
						description: "builder",
						public_metrics: { followers_count: 10 },
					},
					{ id: "42", username: "sam", name: "Sam" },
				],
				tweets: [
					{
						id: "90",
						author_id: "42",
						text: "quoted context",
						created_at: "2026-05-10T12:00:00.000Z",
					},
				],
				media: [
					{
						media_key: "media_1",
						type: "photo",
						url: "https://pbs.twimg.com/media/a.jpg",
						alt_text: "Archive chart",
						width: 1200,
						height: 800,
					},
				],
			},
			nextToken: null,
		});
		const { syncAuthoredTweets } = await import("./authored-live");

		const result = await syncAuthoredTweets({ limit: 5 });
		const db = getNativeDb();
		const authored = listTimelineItems({
			resource: "authored",
			search: "hello",
			limit: 5,
		});

		expect(result).toMatchObject({
			ok: true,
			count: 1,
			nextSinceId: "100",
			payload: { meta: { newest_id: "100", oldest_id: "100" } },
		});
		expect(authored).toEqual([
			expect.objectContaining({
				id: "100",
				kind: "authored",
				accountId: "acct_primary",
				author: expect.objectContaining({
					handle: "steipete",
					displayName: "Peter Steinberger",
					followersCount: 10,
				}),
				quotedTweet: expect.objectContaining({
					id: "90",
					text: "quoted context",
				}),
				media: [
					expect.objectContaining({
						type: "image",
						altText: "Archive chart",
					}),
				],
			}),
		]);
		expect(
			db
				.prepare(
					"select kind, source, raw_json from tweet_account_edges where account_id = ? and tweet_id = ?",
				)
				.get("acct_primary", "100"),
		).toEqual(
			expect.objectContaining({
				kind: "authored",
				source: "xurl",
				raw_json: expect.stringContaining('"type":"quoted"'),
			}),
		);
		expect(
			db
				.prepare("select count(*) as count from tweets_fts where tweet_id = ?")
				.get("100"),
		).toEqual({ count: 1 });
	});

	it("does not overwrite hydrated source profile from fallback user data", async () => {
		makeTempHome();
		const db = getNativeDb();
		db.prepare(
			"update profiles set bio = ?, followers_count = ? where id = ?",
		).run("Hydrated archive bio", 123, "profile_me");
		mocks.listUserTweets.mockResolvedValueOnce({
			items: [
				{
					id: "101",
					author_id: "25401953",
					text: "sparse authored page",
					created_at: "2026-05-11T12:00:00.000Z",
				},
			],
			nextToken: null,
		});
		const { syncAuthoredTweets } = await import("./authored-live");

		await syncAuthoredTweets({ limit: 5 });

		expect(
			db
				.prepare(
					"select bio, followers_count from profiles where id = 'profile_me'",
				)
				.get(),
		).toEqual({
			bio: "Hydrated archive bio",
			followers_count: 123,
		});
		expect(
			db
				.prepare("select author_profile_id from tweets where id = ?")
				.get("101"),
		).toEqual({ author_profile_id: "profile_me" });
	});

	it("paginates authored tweets and deduplicates users", async () => {
		makeTempHome();
		mocks.listUserTweets
			.mockResolvedValueOnce({
				items: [
					{
						id: "102",
						author_id: "25401953",
						text: "newest",
						created_at: "2026-05-11T12:02:00.000Z",
					},
				],
				includes: {
					users: [{ id: "25401953", username: "steipete", name: "Peter" }],
				},
				nextToken: "next-page",
			})
			.mockResolvedValueOnce({
				items: [
					{
						id: "101",
						author_id: "25401953",
						text: "older",
						created_at: "2026-05-11T12:01:00.000Z",
					},
				],
				includes: {
					users: [{ id: "25401953", username: "steipete", name: "Peter" }],
				},
				nextToken: null,
			});
		const { syncAuthoredTweets } = await import("./authored-live");

		const result = await syncAuthoredTweets({ limit: 5 });

		expect(result).toMatchObject({
			ok: true,
			count: 2,
			pages: 2,
			nextSinceId: "102",
			payload: {
				includes: { users: [expect.objectContaining({ id: "25401953" })] },
				meta: { page_count: 2 },
			},
		});
		expect(mocks.listUserTweets).toHaveBeenNthCalledWith(
			2,
			"25401953",
			expect.objectContaining({ paginationToken: "next-page" }),
		);
		expect(
			getNativeDb()
				.prepare(
					"select count(*) as count from tweet_account_edges where kind = ?",
				)
				.get("authored"),
		).toEqual({ count: 2 });
	});

	it("marks a max-pages cap as partial and persists the resume token", async () => {
		makeTempHome();
		mocks.listUserTweets
			.mockResolvedValueOnce(authoredPage("200", "resume-page"))
			.mockResolvedValueOnce({
				items: [],
				nextToken: null,
			});
		const { syncAuthoredTweets } = await import("./authored-live");

		const partial = await syncAuthoredTweets({ limit: 5, maxPages: 1 });
		const resumed = await syncAuthoredTweets({ limit: 5 });

		expect(partial).toMatchObject({
			ok: false,
			partial: true,
			count: 1,
			nextToken: "resume-page",
			cursor: { paginationToken: "resume-page", pending: true },
		});
		expect(resumed).toMatchObject({ ok: true, sinceId: null });
		expect(mocks.listUserTweets).toHaveBeenNthCalledWith(
			2,
			"25401953",
			expect.objectContaining({ paginationToken: "resume-page" }),
		);
		expect(authoredEdgeCount()).toEqual({ count: 1 });
	});

	it("keeps successful pages when a later authored page fails", async () => {
		makeTempHome();
		mocks.listUserTweets
			.mockResolvedValueOnce(authoredPage("250", "page-2"))
			.mockRejectedValueOnce(new Error("rate limited"));
		const { syncAuthoredTweets } = await import("./authored-live");

		const result = await syncAuthoredTweets({ limit: 5 });

		expect(result).toMatchObject({
			ok: false,
			partial: true,
			count: 1,
			error: "rate limited",
			nextToken: "page-2",
		});
		expect(authoredEdgeCount("250")).toEqual({ count: 1 });
	});

	it("uses an explicit account external id without calling whoami", async () => {
		makeTempHome();
		mocks.listUserTweets.mockResolvedValueOnce({
			items: [],
			nextToken: null,
		});
		const { syncAuthoredTweets } = await import("./authored-live");

		await syncAuthoredTweets({ account: "acct_primary", limit: 5 });

		expect(mocks.lookupAuthenticatedUser).not.toHaveBeenCalled();
		expect(mocks.listUserTweets).toHaveBeenCalledWith(
			"25401953",
			expect.objectContaining({ maxResults: 5 }),
		);
	});

	it("links a missing account external id when xurl whoami matches", async () => {
		makeTempHome();
		getNativeDb()
			.prepare("update accounts set external_user_id = null where id = ?")
			.run("acct_primary");
		mocks.listUserTweets.mockResolvedValueOnce({
			items: [],
			nextToken: null,
		});
		const { syncAuthoredTweets } = await import("./authored-live");

		const result = await syncAuthoredTweets({ limit: 5 });

		expect(result).toMatchObject({
			ok: true,
			accountId: "acct_primary",
			userId: "25401953",
		});
		expect(
			getNativeDb()
				.prepare("select external_user_id from accounts where id = ?")
				.get("acct_primary"),
		).toEqual({ external_user_id: "25401953" });
		expect(mocks.listUserTweets).toHaveBeenCalledWith(
			"25401953",
			expect.any(Object),
		);
	});

	it("refuses a missing account external id when xurl whoami mismatches without moving the cursor", async () => {
		makeTempHome();
		getNativeDb()
			.prepare(
				"insert into sync_cache (cache_key, value_json, updated_at) values (?, ?, ?)",
			)
			.run(
				"authored:xurl:acct_studio:cursor",
				JSON.stringify({
					sinceId: "600",
					paginationToken: null,
					pendingNewestId: null,
				}),
				"2026-05-12T12:00:00.000Z",
			);
		mocks.lookupAuthenticatedUser.mockResolvedValueOnce({
			id: "25401953",
			username: "steipete",
			name: "Peter Steinberger",
		});
		const { syncAuthoredTweets } = await import("./authored-live");

		await expect(
			syncAuthoredTweets({ account: "acct_studio", limit: 5 }),
		).rejects.toMatchObject({
			name: "AuthoredSyncError",
			exitCode: 4,
			message: expect.stringContaining(
				"selected account acct_studio is @birdclaw_lab",
			),
		});
		expect(mocks.listUserTweets).not.toHaveBeenCalled();
		expect(authoredCursor("acct_studio")).toEqual({
			sinceId: "600",
			paginationToken: null,
			pendingNewestId: null,
		});
		expect(
			getNativeDb()
				.prepare("select external_user_id from accounts where id = ?")
				.get("acct_studio"),
		).toEqual({ external_user_id: null });
	});

	it("seeds a first authored sync from local archive rows unless since_id is explicit", async () => {
		makeTempHome();
		insertLocalAuthoredHomeTweet({ id: "1000" });
		mocks.listUserTweets
			.mockResolvedValueOnce({
				items: [],
				nextToken: null,
			})
			.mockResolvedValueOnce({
				items: [],
				nextToken: null,
			});
		const { syncAuthoredTweets } = await import("./authored-live");

		await syncAuthoredTweets({ limit: 5 });
		await syncAuthoredTweets({ limit: 5, sinceId: "0" });

		expect(mocks.listUserTweets).toHaveBeenNthCalledWith(
			1,
			"25401953",
			expect.objectContaining({ sinceId: "1000" }),
		);
		expect(mocks.listUserTweets).toHaveBeenNthCalledWith(
			2,
			"25401953",
			expect.objectContaining({ sinceId: "0" }),
		);
	});

	it("does not seed a first authored sync from live timeline home rows", async () => {
		makeTempHome();
		insertLocalAuthoredHomeTweet({ id: "1001", source: "bird" });
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.listUserTweets.mockResolvedValueOnce({
			items: [],
			nextToken: null,
		});
		const { syncAuthoredTweets } = await import("./authored-live");

		try {
			await syncAuthoredTweets({ limit: 5 });
			const requestOptions = mocks.listUserTweets.mock.calls[0]?.[1] as
				| Record<string, unknown>
				| undefined;
			expect(requestOptions?.sinceId).toBeUndefined();
			expect(stderr).toHaveBeenCalledWith(
				"birdclaw sync authored: no archive baseline found; starting a full backwards scan",
			);
		} finally {
			stderr.mockRestore();
		}
	});

	it("seeds from selected account archive authored edges on a shared canonical tweet", async () => {
		makeTempHome();
		insertLocalAuthoredHomeTweet({
			id: "1100",
			source: "bird",
			edgeAccountId: "acct_studio",
		});
		insertAuthoredEdge("1100", "acct_primary", "archive");
		mocks.listUserTweets.mockResolvedValueOnce({
			items: [],
			nextToken: null,
		});
		const { syncAuthoredTweets } = await import("./authored-live");

		await syncAuthoredTweets({ limit: 5 });

		expect(mocks.listUserTweets).toHaveBeenCalledWith(
			"25401953",
			expect.objectContaining({ sinceId: "1100" }),
		);
	});

	it("seeds from archive authored edges instead of newer live authored edges", async () => {
		makeTempHome();
		insertLocalAuthoredHomeTweet({ id: "1000", source: "bird" });
		insertAuthoredEdge("1000", "acct_primary", "archive");
		insertLocalAuthoredHomeTweet({ id: "2000", source: "bird" });
		insertAuthoredEdge("2000", "acct_primary", "xurl");
		mocks.listUserTweets.mockResolvedValueOnce({
			items: [],
			nextToken: null,
		});
		const { syncAuthoredTweets } = await import("./authored-live");

		await syncAuthoredTweets({ limit: 5 });

		expect(mocks.listUserTweets).toHaveBeenCalledWith(
			"25401953",
			expect.objectContaining({ sinceId: "1000" }),
		);
	});

	it("skips nonnumeric archive ids when seeding first authored sync", async () => {
		makeTempHome();
		insertLocalAuthoredHomeTweet({
			id: "550e8400-e29b-41d4-a716-446655440000",
			source: "bird",
		});
		insertAuthoredEdge(
			"550e8400-e29b-41d4-a716-446655440000",
			"acct_primary",
			"archive",
		);
		insertLocalAuthoredHomeTweet({ id: "1000", source: "bird" });
		insertAuthoredEdge("1000", "acct_primary", "archive");
		mocks.listUserTweets.mockResolvedValueOnce({
			items: [],
			nextToken: null,
		});
		const { syncAuthoredTweets } = await import("./authored-live");

		await syncAuthoredTweets({ limit: 5 });

		expect(mocks.listUserTweets).toHaveBeenCalledWith(
			"25401953",
			expect.objectContaining({ sinceId: "1000" }),
		);
	});

	it("warns and omits since_id when first authored sync has no archive baseline", async () => {
		makeTempHome();
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.listUserTweets.mockResolvedValueOnce({
			items: [],
			nextToken: null,
		});
		const { syncAuthoredTweets } = await import("./authored-live");

		try {
			await syncAuthoredTweets({ limit: 5 });
			const requestOptions = mocks.listUserTweets.mock.calls[0]?.[1] as
				| Record<string, unknown>
				| undefined;
			expect(requestOptions?.sinceId).toBeUndefined();
			expect(stderr).toHaveBeenCalledWith(
				"birdclaw sync authored: no archive baseline found; starting a full backwards scan",
			);
		} finally {
			stderr.mockRestore();
		}
	});

	it("commits archive baseline after clearImportedData invalidates authored cursor", async () => {
		makeTempHome();
		getNativeDb()
			.prepare(
				"insert into sync_cache (cache_key, value_json, updated_at) values (?, ?, ?)",
			)
			.run(
				"authored:xurl:acct_primary:cursor",
				JSON.stringify({
					state: "pending-forward",
					sinceId: "900",
					token: "stale-forward",
					pendingNewestId: "950",
				}),
				"2026-05-12T12:00:00.000Z",
			);
		const { importArchive } = await import("./archive-import");
		await importArchive(makeArchiveWithTweet("1000"));
		mocks.listUserTweets.mockResolvedValueOnce({
			items: [],
			nextToken: null,
		});
		const { syncAuthoredTweets } = await import("./authored-live");

		await syncAuthoredTweets({ limit: 5 });

		expect(mocks.listUserTweets).toHaveBeenCalledWith(
			"25401953",
			expect.objectContaining({ sinceId: "1000" }),
		);
		expect(authoredCursor()).toEqual({
			state: "committed",
			sinceId: "1000",
		});
	});

	it("commits archive baseline after selected tweet import invalidates authored cursor", async () => {
		makeTempHome();
		const { importArchive } = await import("./archive-import");
		await importArchive(makeArchiveWithTweet("800"));
		getNativeDb()
			.prepare(
				"insert into sync_cache (cache_key, value_json, updated_at) values (?, ?, ?)",
			)
			.run(
				"authored:xurl:acct_primary:cursor",
				JSON.stringify({ state: "committed", sinceId: "900" }),
				"2026-05-12T12:00:00.000Z",
			);
		getNativeDb()
			.prepare(
				"insert into sync_cache (cache_key, value_json, updated_at) values (?, ?, ?)",
			)
			.run(
				"authored:xurl:acct_studio:cursor",
				JSON.stringify({ state: "committed", sinceId: "1200" }),
				"2026-05-12T12:00:00.000Z",
			);
		await importArchive(makeArchiveWithTweet("1000"), { select: ["tweets"] });
		mocks.listUserTweets.mockResolvedValueOnce({
			items: [],
			nextToken: null,
		});
		const { syncAuthoredTweets } = await import("./authored-live");

		await syncAuthoredTweets({ limit: 5 });

		expect(mocks.listUserTweets).toHaveBeenCalledWith(
			"25401953",
			expect.objectContaining({ sinceId: "1000" }),
		);
		expect(authoredCursor()).toEqual({
			state: "committed",
			sinceId: "1000",
		});
		expect(authoredCursor("acct_studio")).toEqual({
			state: "committed",
			sinceId: "1200",
		});
	});

	it("stores and resumes matching until_id tokens without moving since_id", async () => {
		makeTempHome();
		getNativeDb()
			.prepare(
				"insert into sync_cache (cache_key, value_json, updated_at) values (?, ?, ?)",
			)
			.run(
				"authored:xurl:acct_primary:cursor",
				JSON.stringify({ state: "committed", sinceId: "600" }),
				"2026-05-12T12:00:00.000Z",
			);
		mocks.listUserTweets
			.mockResolvedValueOnce(authoredPage("250", "older-page"))
			.mockResolvedValueOnce({
				items: [],
				nextToken: null,
			});
		const { syncAuthoredTweets } = await import("./authored-live");

		const partial = await syncAuthoredTweets({
			limit: 5,
			untilId: "250",
			maxPages: 1,
		});
		expect(partial).toMatchObject({
			partial: true,
			nextSinceId: "600",
			nextToken: "older-page",
		});
		expect(authoredCursor()).toEqual({
			state: "pending-until",
			sinceId: "600",
			token: "older-page",
			untilId: "250",
			requestedSinceId: null,
		});

		const resumed = await syncAuthoredTweets({ limit: 5, untilId: "250" });

		expect(resumed).toMatchObject({
			ok: true,
			nextSinceId: "600",
		});
		expect(mocks.listUserTweets).toHaveBeenNthCalledWith(
			2,
			"25401953",
			expect.objectContaining({
				paginationToken: "older-page",
				untilId: "250",
			}),
		);
		expect(authoredCursor()).toEqual({
			state: "committed",
			sinceId: "600",
		});
	});

	it("preserves explicit since_id across pending until_id resumes", async () => {
		makeTempHome();
		getNativeDb()
			.prepare(
				"insert into sync_cache (cache_key, value_json, updated_at) values (?, ?, ?)",
			)
			.run(
				"authored:xurl:acct_primary:cursor",
				JSON.stringify({ state: "committed", sinceId: "600" }),
				"2026-05-12T12:00:00.000Z",
			);
		mocks.listUserTweets
			.mockResolvedValueOnce(authoredPage("250", "older-page"))
			.mockResolvedValueOnce({
				items: [],
				nextToken: null,
			});
		const { syncAuthoredTweets } = await import("./authored-live");

		await syncAuthoredTweets({
			limit: 5,
			sinceId: "100",
			untilId: "500",
			maxPages: 1,
		});
		expect(authoredCursor()).toEqual({
			state: "pending-until",
			sinceId: "600",
			token: "older-page",
			untilId: "500",
			requestedSinceId: "100",
		});

		await syncAuthoredTweets({ limit: 5, untilId: "500" });

		expect(mocks.listUserTweets).toHaveBeenNthCalledWith(
			2,
			"25401953",
			expect.objectContaining({
				paginationToken: "older-page",
				sinceId: "100",
				untilId: "500",
			}),
		);
		expect(authoredCursor()).toEqual({
			state: "committed",
			sinceId: "600",
		});
	});

	it("reports committed since_id when an until_id backfill fails after saved pages", async () => {
		makeTempHome();
		getNativeDb()
			.prepare(
				"insert into sync_cache (cache_key, value_json, updated_at) values (?, ?, ?)",
			)
			.run(
				"authored:xurl:acct_primary:cursor",
				JSON.stringify({ state: "committed", sinceId: "600" }),
				"2026-05-12T12:00:00.000Z",
			);
		mocks.listUserTweets
			.mockResolvedValueOnce(authoredPage("250", "older-page"))
			.mockRejectedValueOnce(new Error("rate limited"));
		const { syncAuthoredTweets } = await import("./authored-live");

		const result = await syncAuthoredTweets({ limit: 5, untilId: "250" });

		expect(result).toMatchObject({
			ok: false,
			partial: true,
			error: "rate limited",
			nextSinceId: "600",
			cursor: { sinceId: "600", paginationToken: "older-page" },
		});
	});

	it("ignores pending until_id tokens during default authored sync", async () => {
		makeTempHome();
		getNativeDb()
			.prepare(
				"insert into sync_cache (cache_key, value_json, updated_at) values (?, ?, ?)",
			)
			.run(
				"authored:xurl:acct_primary:cursor",
				JSON.stringify({
					state: "pending-until",
					sinceId: "600",
					token: "older-page",
					untilId: "250",
				}),
				"2026-05-12T12:00:00.000Z",
			);
		mocks.listUserTweets.mockResolvedValueOnce({
			items: [],
			nextToken: null,
		});
		const { syncAuthoredTweets } = await import("./authored-live");

		await syncAuthoredTweets({ limit: 5 });

		const requestOptions = mocks.listUserTweets.mock.calls[0]?.[1] as
			| Record<string, unknown>
			| undefined;
		expect(requestOptions).toEqual(expect.objectContaining({ sinceId: "600" }));
		expect(requestOptions?.paginationToken).toBeUndefined();
		expect(requestOptions?.untilId).toBeUndefined();
		expect(authoredCursor()).toEqual({
			state: "committed",
			sinceId: "600",
		});
	});

	it("migrates legacy paginationToken cursors to pending-forward on read", async () => {
		makeTempHome();
		getNativeDb()
			.prepare(
				"insert into sync_cache (cache_key, value_json, updated_at) values (?, ?, ?)",
			)
			.run(
				"authored:xurl:acct_primary:cursor",
				JSON.stringify({ sinceId: "600", paginationToken: "legacy-page" }),
				"2026-05-12T12:00:00.000Z",
			);
		mocks.listUserTweets.mockResolvedValueOnce({
			items: [],
			nextToken: null,
		});
		const { syncAuthoredTweets } = await import("./authored-live");

		await syncAuthoredTweets({ limit: 5 });

		const requestOptions = mocks.listUserTweets.mock.calls[0]?.[1] as
			| Record<string, unknown>
			| undefined;
		expect(requestOptions).toEqual(
			expect.objectContaining({
				sinceId: "600",
				paginationToken: "legacy-page",
			}),
		);
	});

	it("passes until_id without preserving a stale pending pagination token", async () => {
		makeTempHome();
		mocks.listUserTweets
			.mockResolvedValueOnce(authoredPage("275", "stale-page"))
			.mockResolvedValueOnce({
				items: [],
				nextToken: null,
			})
			.mockResolvedValueOnce({
				items: [],
				nextToken: null,
			});
		const { syncAuthoredTweets } = await import("./authored-live");

		await syncAuthoredTweets({ limit: 5, maxPages: 1 });
		const until = await syncAuthoredTweets({ limit: 5, untilId: "250" });
		await syncAuthoredTweets({ limit: 5 });

		expect(until).toMatchObject({
			ok: true,
			nextSinceId: null,
		});
		expect(mocks.listUserTweets).toHaveBeenNthCalledWith(
			2,
			"25401953",
			expect.objectContaining({ untilId: "250" }),
		);
		const nextDefaultOptions = mocks.listUserTweets.mock.calls[2]?.[1] as
			| Record<string, unknown>
			| undefined;
		expect(nextDefaultOptions?.paginationToken).toBeUndefined();
	});

	it("ignores the stored since_id when until_id backfills older tweets", async () => {
		makeTempHome();
		getNativeDb()
			.prepare(
				"insert into sync_cache (cache_key, value_json, updated_at) values (?, ?, ?)",
			)
			.run(
				"authored:xurl:acct_primary:cursor",
				JSON.stringify({
					sinceId: "600",
					paginationToken: null,
					pendingNewestId: null,
				}),
				"2026-05-12T12:00:00.000Z",
			);
		mocks.listUserTweets.mockResolvedValueOnce({
			items: [],
			nextToken: null,
		});
		const { syncAuthoredTweets } = await import("./authored-live");

		const result = await syncAuthoredTweets({ limit: 5, untilId: "250" });

		expect(result).toMatchObject({
			ok: true,
			sinceId: null,
			nextSinceId: "600",
		});
		const requestOptions = mocks.listUserTweets.mock.calls[0]?.[1] as
			| Record<string, unknown>
			| undefined;
		expect(requestOptions).toEqual(expect.objectContaining({ untilId: "250" }));
		expect(requestOptions?.sinceId).toBeUndefined();
		expect(authoredCursor()).toEqual({
			state: "committed",
			sinceId: "600",
		});
	});

	it("preserves explicit since_id after an empty completed sync", async () => {
		makeTempHome();
		getNativeDb()
			.prepare(
				"insert into sync_cache (cache_key, value_json, updated_at) values (?, ?, ?)",
			)
			.run(
				"authored:xurl:acct_primary:cursor",
				JSON.stringify({
					sinceId: "500",
					paginationToken: null,
					pendingNewestId: null,
				}),
				"2026-05-12T12:00:00.000Z",
			);
		mocks.listUserTweets.mockResolvedValueOnce({
			items: [],
			nextToken: null,
		});
		const { syncAuthoredTweets } = await import("./authored-live");

		const result = await syncAuthoredTweets({ limit: 5, sinceId: "1000" });

		expect(result).toMatchObject({
			ok: true,
			sinceId: "1000",
			nextSinceId: "1000",
		});
		expect(mocks.listUserTweets).toHaveBeenCalledWith(
			"25401953",
			expect.objectContaining({ sinceId: "1000" }),
		);
		expect(authoredCursor()).toEqual({
			state: "committed",
			sinceId: "1000",
		});
	});

	it("does not duplicate rows when the same page is synced twice", async () => {
		makeTempHome();
		const page = {
			items: [
				{
					id: "300",
					author_id: "25401953",
					text: "idempotent authored row",
					created_at: "2026-05-11T12:00:00.000Z",
				},
			],
			nextToken: null,
		};
		mocks.listUserTweets.mockResolvedValue(page);
		const { syncAuthoredTweets } = await import("./authored-live");

		await syncAuthoredTweets({ limit: 5, sinceId: "0" });
		await syncAuthoredTweets({ limit: 5, sinceId: "0" });

		const db = getNativeDb();
		expect(
			db
				.prepare("select count(*) as count from tweets where id = ?")
				.get("300"),
		).toEqual({ count: 1 });
		expect(
			db
				.prepare(
					"select count(*) as count from tweet_account_edges where tweet_id = ? and kind = ?",
				)
				.get("300", "authored"),
		).toEqual({ count: 1 });
		expect(
			db
				.prepare("select count(*) as count from tweets_fts where tweet_id = ?")
				.get("300"),
		).toEqual({ count: 1 });
	});

	it("keeps retweets in authored sync and preserves their referenced_tweets marker", async () => {
		makeTempHome();
		mocks.listUserTweets.mockResolvedValueOnce({
			items: [
				{
					id: "400",
					author_id: "25401953",
					text: "RT @sam: original",
					created_at: "2026-05-11T12:00:00.000Z",
					referenced_tweets: [{ type: "retweeted", id: "399" }],
				},
			],
			nextToken: null,
		});
		const { syncAuthoredTweets } = await import("./authored-live");

		const result = await syncAuthoredTweets({ limit: 5 });
		const edge = getNativeDb()
			.prepare("select raw_json from tweet_account_edges where tweet_id = ?")
			.get("400") as { raw_json: string };

		expect(result.payload.data[0]?.referenced_tweets).toEqual([
			{ type: "retweeted", id: "399" },
		]);
		expect(mocks.listUserTweets).toHaveBeenCalledWith(
			"25401953",
			expect.objectContaining({ excludeRetweets: false }),
		);
		expect(JSON.parse(edge.raw_json).referenced_tweets).toEqual([
			{ type: "retweeted", id: "399" },
		]);
	});

	it("uses the stored since_id on rerun and advances only from new tweets", async () => {
		makeTempHome();
		mocks.listUserTweets
			.mockResolvedValueOnce({
				items: [
					{
						id: "500",
						author_id: "25401953",
						text: "first sync",
						created_at: "2026-05-11T12:00:00.000Z",
					},
				],
				nextToken: null,
			})
			.mockResolvedValueOnce({
				items: [],
				nextToken: null,
			});
		const { syncAuthoredTweets } = await import("./authored-live");

		const first = await syncAuthoredTweets({ limit: 5 });
		const second = await syncAuthoredTweets({ limit: 5 });

		expect(first).toMatchObject({ nextSinceId: "500" });
		expect(second).toMatchObject({
			count: 0,
			sinceId: "500",
			nextSinceId: "500",
		});
		expect(mocks.listUserTweets).toHaveBeenNthCalledWith(
			2,
			"25401953",
			expect.objectContaining({ sinceId: "500" }),
		);
		expect(
			getNativeDb()
				.prepare(
					"select count(*) as count from tweet_account_edges where kind = ?",
				)
				.get("authored"),
		).toEqual({ count: 1 });
	});
});
