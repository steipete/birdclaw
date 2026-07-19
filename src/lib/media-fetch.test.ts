// @vitest-environment node
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { fetchTweetMedia } from "./media-fetch";

const tempDirs: string[] = [];

function home() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-media-fetch-"));
	tempDirs.push(dir);
	process.env.BIRDCLAW_HOME = dir;
	return dir;
}

function insertTweet(
	id: string,
	media: unknown[],
	createdAt = "2026-05-01T12:00:00.000Z",
	mediaCount = media.length,
) {
	const db = getNativeDb({ seedDemoData: false });
	db.prepare(
		`
      insert into tweets (
		id, author_profile_id, text, created_at,
		is_replied, reply_to_id, like_count, media_count,
		entities_json, media_json, quoted_tweet_id
	  ) values (?, 'profile_me', ?, ?, 0, null, 0, ?, '{}', ?, null)
	`,
	).run(id, `tweet ${id}`, createdAt, mediaCount, JSON.stringify(media));
	db.prepare(
		`
		insert into tweet_account_edges (
		  account_id, tweet_id, kind, first_seen_at, last_seen_at,
		  seen_count, source, raw_json, updated_at
		) values ('acct_primary', ?, 'home', ?, ?, 1, 'test', '{}', ?)
		`,
	).run(id, createdAt, createdAt, createdAt);
}

function pbs(name: string) {
	return { url: `https://pbs.twimg.com/media/${name}.jpg`, type: "image" };
}

function archiveTweetFile(
	root: string,
	tweetId: string,
	basename: string,
	ext = ".jpg",
	kind = "tweets",
) {
	return path.join(
		root,
		"media",
		"originals",
		"archive",
		kind,
		tweetId,
		`${tweetId}-${basename}${ext}`,
	);
}

function mp4(name: string, bitrate = 832000) {
	return {
		url: `https://video.twimg.com/ext_tw_video/1/pu/vid/720x720/${name}.mp4`,
		content_type: "video/mp4",
		bitrate,
	};
}

function failingStream(bytes: Uint8Array, error: Error) {
	let sent = false;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent) {
				controller.error(error);
				return;
			}
			sent = true;
			controller.enqueue(bytes);
		},
	});
}

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	vi.unstubAllGlobals();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("media fetch", () => {
	it("dry-runs missing pbs media without downloading", async () => {
		const root = home();
		insertTweet("tweet_1", [
			pbs("demo"),
			{ url: "https://video.twimg.com/ext_tw_video/1/pu/vid/x.mp4" },
		]);
		const fetchMock = vi.fn(async () => {
			throw new Error("must not fetch");
		});

		const result = await fetchTweetMedia({
			dryRun: true,
			fetchImpl: fetchMock,
		});

		expect(result).toMatchObject({
			fetched: 0,
			would_fetch: [
				{
					media_key: "demo",
					tweet_id: "tweet_1",
					url: "https://pbs.twimg.com/media/demo.jpg",
					path: path.join(root, "media", "originals", "demo.jpg"),
				},
			],
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(existsSync(path.join(root, "media", "originals", "demo.jpg"))).toBe(
			false,
		);
	});

	it("does not fetch media belonging to a tombstoned tweet", async () => {
		home();
		insertTweet("tweet_deleted", [pbs("deleted_media")]);
		getNativeDb()
			.prepare(
				"update tweets set deleted_at = ?, deletion_reason = ? where id = ?",
			)
			.run(
				"2026-07-18T12:00:00.000Z",
				"explicit_deleted_tweet_record",
				"tweet_deleted",
			);

		const result = await fetchTweetMedia({ dryRun: true });

		expect(result.would_fetch).toEqual([]);
	});

	it("scopes kind filters through tweet account edges", async () => {
		const root = home();
		insertTweet("tweet_1", [pbs("edge_media")]);
		getNativeDb()
			.prepare(
				`
        insert into tweet_account_edges (
          account_id, tweet_id, kind, first_seen_at, last_seen_at,
          seen_count, source, raw_json, updated_at
        ) values (?, ?, ?, ?, ?, 1, 'test', '{}', ?)
        `,
			)
			.run(
				"acct_studio",
				"tweet_1",
				"home",
				"2026-05-01T12:00:00.000Z",
				"2026-05-01T12:00:00.000Z",
				"2026-05-01T12:00:00.000Z",
			);

		const result = await fetchTweetMedia({
			account: "acct_studio",
			kind: "home",
			dryRun: true,
		});

		expect(result.would_fetch).toEqual([
			expect.objectContaining({
				media_key: "edge_media",
				tweet_id: "tweet_1",
				path: path.join(root, "media", "originals", "edge_media.jpg"),
			}),
		]);
	});

	it("skips existing files by media key", async () => {
		const root = home();
		const mediaDir = path.join(root, "media", "originals");
		mkdirSync(mediaDir, { recursive: true });
		writeFileSync(path.join(mediaDir, "demo.jpg"), "cached");
		insertTweet("tweet_1", [pbs("demo")]);
		const fetchMock = vi.fn();

		await expect(
			fetchTweetMedia({ fetchImpl: fetchMock }),
		).resolves.toMatchObject({
			fetched: 0,
			skipped_cached: 1,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("preserves filesystem errors while storing fetched media", async () => {
		const root = home();
		const mediaDir = path.join(root, "media", "originals");
		mkdirSync(mediaDir, { recursive: true });
		insertTweet("tweet_1", [pbs("demo")]);

		let thrown: unknown;
		try {
			await fetchTweetMedia({
				fetchImpl: async () => {
					mkdirSync(path.join(mediaDir, "demo.jpg"), { recursive: true });
					return new Response(new Uint8Array([1, 2, 3]));
				},
				pacingMs: 0,
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(Error);
		expect(String(thrown)).not.toMatch(/UnknownException|unknown error/i);
		expect((thrown as Error).message).toMatch(/EISDIR|directory|rename/i);
	});

	it("reuses archive bytes before fetching from the CDN", async () => {
		const root = home();
		const archiveFile = archiveTweetFile(root, "tweet_1", "demo");
		mkdirSync(path.dirname(archiveFile), { recursive: true });
		writeFileSync(archiveFile, Buffer.from([9, 8, 7]));
		insertTweet("tweet_1", [pbs("demo")]);
		const fetchMock = vi.fn(async () => {
			throw new Error("must not fetch");
		});

		const result = await fetchTweetMedia({ fetchImpl: fetchMock, pacingMs: 0 });

		expect(result).toMatchObject({
			fetched: 1,
			images_fetched: 1,
			reused_from_archive: 1,
			bytes: 3,
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(
			readFileSync(path.join(root, "media", "originals", "demo.jpg")),
		).toEqual(Buffer.from([9, 8, 7]));
	});

	it("reuses community archive bytes before fetching from the CDN", async () => {
		const root = home();
		const archiveFile = archiveTweetFile(
			root,
			"tweet_1",
			"demo",
			".jpg",
			"community",
		);
		mkdirSync(path.dirname(archiveFile), { recursive: true });
		writeFileSync(archiveFile, Buffer.from([6, 5, 4]));
		insertTweet("tweet_1", [pbs("demo")]);
		const fetchMock = vi.fn(async () => {
			throw new Error("must not fetch");
		});

		const result = await fetchTweetMedia({ fetchImpl: fetchMock, pacingMs: 0 });

		expect(result).toMatchObject({
			fetched: 1,
			images_fetched: 1,
			reused_from_archive: 1,
			bytes: 3,
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(
			readFileSync(path.join(root, "media", "originals", "demo.jpg")),
		).toEqual(Buffer.from([6, 5, 4]));
	});

	it("enforces max-bytes before archive reuse", async () => {
		const root = home();
		const archiveFile = archiveTweetFile(root, "tweet_1", "demo");
		mkdirSync(path.dirname(archiveFile), { recursive: true });
		writeFileSync(archiveFile, Buffer.from([9, 8, 7]));
		insertTweet("tweet_1", [pbs("demo")]);
		const fetchMock = vi.fn(async () => {
			throw new Error("must not fetch");
		});

		const result = await fetchTweetMedia({
			fetchImpl: fetchMock,
			maxBytes: 2,
			pacingMs: 0,
		});

		expect(result).toMatchObject({
			fetched: 0,
			failed: 1,
			reused_from_archive: 0,
			failures: [
				expect.objectContaining({
					media_key: "demo",
					reason: "max-bytes",
				}),
			],
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(existsSync(path.join(root, "media", "originals", "demo.jpg"))).toBe(
			false,
		);
	});

	it("falls through to HTTP when archive bytes are missing", async () => {
		const root = home();
		insertTweet("tweet_1", [pbs("demo")]);
		const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2])));

		const result = await fetchTweetMedia({ fetchImpl: fetchMock, pacingMs: 0 });

		expect(result).toMatchObject({
			fetched: 1,
			reused_from_archive: 0,
			bytes: 2,
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(
			readFileSync(path.join(root, "media", "originals", "demo.jpg")),
		).toEqual(Buffer.from([1, 2]));
	});

	it("fetches media_json candidates even when media_count is stale zero", async () => {
		const root = home();
		insertTweet("tweet_1", [pbs("preserved")], "2026-05-01T12:00:00.000Z", 0);
		const fetchMock = vi.fn(async () => new Response(new Uint8Array([5, 6])));

		const result = await fetchTweetMedia({ fetchImpl: fetchMock, pacingMs: 0 });

		expect(result).toMatchObject({
			fetched: 1,
			images_fetched: 1,
			bytes: 2,
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(
			readFileSync(path.join(root, "media", "originals", "preserved.jpg")),
		).toEqual(Buffer.from([5, 6]));
	});

	it("ignores stale archive bytes with a different basename", async () => {
		const root = home();
		const archiveFile = archiveTweetFile(root, "tweet_1", "other");
		mkdirSync(path.dirname(archiveFile), { recursive: true });
		writeFileSync(archiveFile, "stale");
		insertTweet("tweet_1", [pbs("demo")]);
		const fetchMock = vi.fn(async () => new Response(new Uint8Array([3])));

		const result = await fetchTweetMedia({ fetchImpl: fetchMock, pacingMs: 0 });

		expect(result.reused_from_archive).toBe(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(readFileSync(archiveFile, "utf8")).toBe("stale");
		expect(
			readFileSync(path.join(root, "media", "originals", "demo.jpg")),
		).toEqual(Buffer.from([3]));
	});

	it("keeps reruns idempotent after archive reuse", async () => {
		const root = home();
		const archiveFile = archiveTweetFile(root, "tweet_1", "demo");
		mkdirSync(path.dirname(archiveFile), { recursive: true });
		writeFileSync(archiveFile, Buffer.from([4, 5]));
		insertTweet("tweet_1", [pbs("demo")]);
		const fetchMock = vi.fn(async () => {
			throw new Error("must not fetch");
		});

		const first = await fetchTweetMedia({ fetchImpl: fetchMock, pacingMs: 0 });
		writeFileSync(archiveFile, Buffer.from([0]));
		const second = await fetchTweetMedia({ fetchImpl: fetchMock, pacingMs: 0 });

		expect(first).toMatchObject({ fetched: 1, reused_from_archive: 1 });
		expect(second).toMatchObject({
			fetched: 0,
			reused_from_archive: 0,
			skipped_cached: 1,
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(
			readFileSync(path.join(root, "media", "originals", "demo.jpg")),
		).toEqual(Buffer.from([4, 5]));
	});

	it("reuses archive mp4 bytes when media_json has no variants", async () => {
		const root = home();
		const mediaDir = path.join(root, "media", "originals");
		mkdirSync(mediaDir, { recursive: true });
		writeFileSync(path.join(mediaDir, "thumb.jpg"), "cached thumb");
		const archiveFile = archiveTweetFile(root, "tweet_1", "clip", ".mp4");
		mkdirSync(path.dirname(archiveFile), { recursive: true });
		writeFileSync(archiveFile, Buffer.from([6, 7, 8]));
		insertTweet("tweet_1", [
			{
				url: "https://pbs.twimg.com/ext_tw_video_thumb/thumb.jpg",
				type: "video",
			},
		]);
		const fetchMock = vi.fn(async () => {
			throw new Error("must not fetch");
		});

		const result = await fetchTweetMedia({ fetchImpl: fetchMock, pacingMs: 0 });

		expect(result).toMatchObject({
			videos_fetched: 1,
			reused_from_archive: 1,
			skipped_cached: 1,
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(readFileSync(path.join(mediaDir, "clip.mp4"))).toEqual(
			Buffer.from([6, 7, 8]),
		);
	});

	it("reuses archive mp4 bytes before CDN video variants", async () => {
		const root = home();
		const mediaDir = path.join(root, "media", "originals");
		mkdirSync(mediaDir, { recursive: true });
		writeFileSync(path.join(mediaDir, "thumb.jpg"), "cached thumb");
		const archiveFile = archiveTweetFile(
			root,
			"tweet_1",
			"archive-clip",
			".mp4",
		);
		mkdirSync(path.dirname(archiveFile), { recursive: true });
		writeFileSync(archiveFile, Buffer.from([8, 7, 6]));
		insertTweet("tweet_1", [
			{
				url: "https://pbs.twimg.com/ext_tw_video_thumb/thumb.jpg",
				type: "video",
				variants: [
					{
						url: "https://video.twimg.com/ext_tw_video/1/pu/vid/720x720/cdn-clip.mp4",
						contentType: "video/mp4",
						bitRate: 2176000,
					},
				],
			},
		]);
		const fetchMock = vi.fn(async () => {
			throw new Error("must not fetch video");
		});

		const result = await fetchTweetMedia({ fetchImpl: fetchMock, pacingMs: 0 });

		expect(result).toMatchObject({
			videos_fetched: 1,
			reused_from_archive: 1,
			skipped_cached: 1,
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(readFileSync(path.join(mediaDir, "archive-clip.mp4"))).toEqual(
			Buffer.from([8, 7, 6]),
		);
		expect(existsSync(path.join(mediaDir, "cdn-clip.mp4"))).toBe(false);
	});

	it("backs off and retries once after 429", async () => {
		const root = home();
		insertTweet("tweet_1", [pbs("demo")]);
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("slow", { status: 429 }))
			.mockResolvedValueOnce(
				new Response(new Uint8Array([1, 2, 3]), {
					status: 200,
					headers: { "content-type": "image/jpeg" },
				}),
			);
		const sleeps: number[] = [];

		const result = await fetchTweetMedia({
			fetchImpl: fetchMock,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			pacingMs: 0,
		});

		expect(result).toMatchObject({
			ok: true,
			fetched: 1,
			skipped_cached: 0,
			failed: 0,
			rate_limited: 1,
			bytes: 3,
			failures: [],
		});
		expect(sleeps).toEqual([1000]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(
			readFileSync(path.join(root, "media", "originals", "demo.jpg")),
		).toEqual(Buffer.from([1, 2, 3]));
	});

	it("records a failure when retry-max is exhausted", async () => {
		home();
		insertTweet("tweet_1", [pbs("demo")]);
		const fetchMock = vi.fn(async () => new Response("no", { status: 429 }));

		const result = await fetchTweetMedia({
			fetchImpl: fetchMock,
			sleep: async () => {},
			pacingMs: 0,
			retryMax: 1,
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result).toMatchObject({
			failed: 1,
			rate_limited: 1,
			failures: [
				{
					media_key: "demo",
					url: "https://pbs.twimg.com/media/demo.jpg",
					reason: "429",
				},
			],
		});
	});

	it("paces sequential requests between media downloads", async () => {
		home();
		insertTweet("tweet_1", [pbs("one")], "2026-05-02T12:00:00.000Z");
		insertTweet("tweet_2", [pbs("two")]);
		let clock = 0;
		const sleeps: number[] = [];
		const fetchMock = vi.fn(async () => new Response(new Uint8Array([1])));

		const result = await fetchTweetMedia({
			fetchImpl: fetchMock,
			now: () => clock,
			sleep: async (ms) => {
				sleeps.push(ms);
				clock += ms;
			},
			pacingMs: 25,
			parallel: 1,
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(sleeps).toEqual([25]);
		expect(result.duration_ms).toBeGreaterThanOrEqual(25);
	});

	it("paces image request starts globally across parallel workers", async () => {
		home();
		for (let index = 0; index < 6; index += 1) {
			insertTweet(
				`tweet_${index}`,
				[pbs(`parallel_${index}`)],
				`2026-05-02T12:00:0${index}.000Z`,
			);
		}
		let clock = 0;
		const starts: number[] = [];

		await fetchTweetMedia({
			fetchImpl: async () => {
				starts.push(clock);
				return new Response(new Uint8Array([1]));
			},
			now: () => clock,
			sleep: async (ms) => {
				clock += ms;
			},
			pacingMs: 100,
			parallel: 3,
		});

		expect(starts).toHaveLength(6);
		expect(
			starts.slice(1).every((start, index) => start - starts[index] >= 100),
		).toBe(true);
	});

	it("selects the highest-bitrate mp4 video variant", async () => {
		const root = home();
		insertTweet("tweet_1", [
			{
				type: "video",
				variants: [
					{
						url: "https://video.twimg.com/hls.m3u8",
						content_type: "application/x-mpegURL",
					},
					{
						url: "https://video.twimg.com/ext_tw_video/1/pu/vid/720x720/low.mp4",
						contentType: "video/mp4",
						bitRate: 256000,
					},
					{
						url: "https://video.twimg.com/ext_tw_video/1/pu/vid/720x720/high.mp4",
						contentType: "video/mp4",
						bitRate: 2176000,
					},
				],
			},
		]);

		const result = await fetchTweetMedia({ dryRun: true });

		expect(result.would_fetch).toEqual([
			{
				media_key: "high",
				tweet_id: "tweet_1",
				kind: "video",
				url: "https://video.twimg.com/ext_tw_video/1/pu/vid/720x720/high.mp4",
				path: path.join(root, "media", "originals", "high.mp4"),
			},
		]);
	});

	it("handles animated gifs as mp4 downloads", async () => {
		const root = home();
		insertTweet("tweet_1", [
			{ type: "animated_gif", variants: [mp4("gif", 0)] },
		]);

		const result = await fetchTweetMedia({
			fetchImpl: async () => new Response(new Uint8Array([7, 8])),
			pacingMs: 0,
		});

		expect(result).toMatchObject({ fetched: 1, gifs_fetched: 1, gif_bytes: 2 });
		expect(
			readFileSync(path.join(root, "media", "originals", "gif.mp4")),
		).toEqual(Buffer.from([7, 8]));
	});

	it("skips HLS-only media instead of attempting manifests", async () => {
		home();
		insertTweet("tweet_1", [
			{
				type: "video",
				variants: [
					{
						url: "https://video.twimg.com/hls.m3u8",
						content_type: "application/x-mpegURL",
					},
				],
			},
		]);
		const fetchMock = vi.fn();

		await expect(
			fetchTweetMedia({ fetchImpl: fetchMock }),
		).resolves.toMatchObject({
			fetched: 0,
			failed: 0,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("skips oversized media before streaming", async () => {
		home();
		insertTweet("tweet_1", [{ type: "video", variants: [mp4("huge")] }]);

		const result = await fetchTweetMedia({
			fetchImpl: async () =>
				new Response(new Uint8Array([1]), {
					headers: { "content-length": "5" },
				}),
			maxBytes: 4,
			pacingMs: 0,
		});

		expect(result).toMatchObject({
			failed: 1,
			failures: [
				{
					media_key: "huge",
					url: "https://video.twimg.com/ext_tw_video/1/pu/vid/720x720/huge.mp4",
					reason: "max-bytes",
				},
			],
		});
	});

	it("removes tmp files when streamed media exceeds max-bytes", async () => {
		const root = home();
		insertTweet("tweet_1", [{ type: "video", variants: [mp4("chunked")] }]);

		const result = await fetchTweetMedia({
			fetchImpl: async () =>
				new Response(new Uint8Array([1, 2, 3, 4, 5]), {
					headers: { "content-length": "2" },
				}),
			maxBytes: 4,
			pacingMs: 0,
		});

		const mediaDir = path.join(root, "media", "originals");
		expect(result).toMatchObject({
			fetched: 0,
			failed: 1,
			failures: [
				expect.objectContaining({
					media_key: "chunked",
					reason: "max-bytes",
				}),
			],
		});
		expect(existsSync(path.join(mediaDir, "chunked.mp4.tmp"))).toBe(false);
		expect(existsSync(path.join(mediaDir, "chunked.mp4"))).toBe(false);
	});

	it("preserves tmp files after transient stream errors for later range resume", async () => {
		const root = home();
		insertTweet("tweet_1", [{ type: "video", variants: [mp4("flaky")] }]);
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					failingStream(new Uint8Array([1, 2, 3]), new Error("socket reset")),
				),
			)
			.mockResolvedValueOnce(
				new Response(new Uint8Array([4, 5]), {
					status: 206,
					headers: { "content-range": "bytes 3-4/5" },
				}),
			);

		const first = await fetchTweetMedia({ fetchImpl: fetchMock, pacingMs: 0 });

		const mediaDir = path.join(root, "media", "originals");
		expect(first).toMatchObject({
			fetched: 0,
			failed: 1,
			failures: [
				expect.objectContaining({
					media_key: "flaky",
					reason: "socket reset",
				}),
			],
		});
		expect(readFileSync(path.join(mediaDir, "flaky.mp4.tmp"))).toEqual(
			Buffer.from([1, 2, 3]),
		);

		await fetchTweetMedia({ fetchImpl: fetchMock, pacingMs: 0 });

		const [, init] = fetchMock.mock.calls[1] as unknown as [
			string,
			RequestInit,
		];
		expect(init.headers).toMatchObject({ range: "bytes=3-" });
		expect(readFileSync(path.join(mediaDir, "flaky.mp4"))).toEqual(
			Buffer.from([1, 2, 3, 4, 5]),
		);
		expect(existsSync(path.join(mediaDir, "flaky.mp4.tmp"))).toBe(false);
	});

	it("isolates thumbnail and video tmp files when media keys match", async () => {
		const root = home();
		insertTweet("tweet_1", [
			{
				url: "https://pbs.twimg.com/ext_tw_video_thumb/foo.jpg",
				type: "video",
				variants: [mp4("foo")],
			},
		]);
		const fetchMock = vi.fn(async (url: string) =>
			url.includes("pbs.twimg.com")
				? new Response(
						failingStream(
							new Uint8Array([0xff, 0xd8]),
							new Error("thumbnail reset"),
						),
					)
				: new Response(
						failingStream(new Uint8Array([1, 2]), new Error("video reset")),
					),
		);

		await fetchTweetMedia({ fetchImpl: fetchMock, pacingMs: 0 });

		const mediaDir = path.join(root, "media", "originals");
		const [, videoInit] = fetchMock.mock.calls[1] as unknown as [
			string,
			RequestInit,
		];
		expect((videoInit.headers as Record<string, string>).range).toBeUndefined();
		expect(readFileSync(path.join(mediaDir, "foo.jpg.tmp"))).toEqual(
			Buffer.from([0xff, 0xd8]),
		);
		expect(readFileSync(path.join(mediaDir, "foo.mp4.tmp"))).toEqual(
			Buffer.from([1, 2]),
		);
		expect(existsSync(path.join(mediaDir, "foo.mp4"))).toBe(false);
	});

	it("resumes partial video tmp files with a range request", async () => {
		const root = home();
		const mediaDir = path.join(root, "media", "originals");
		mkdirSync(mediaDir, { recursive: true });
		writeFileSync(
			path.join(mediaDir, "resume.mp4.tmp"),
			Buffer.from([1, 2, 3]),
		);
		insertTweet("tweet_1", [{ type: "video", variants: [mp4("resume")] }]);
		const fetchMock = vi.fn(
			async () =>
				new Response(new Uint8Array([4, 5, 6]), {
					status: 206,
					headers: { "content-range": "bytes 3-5/6" },
				}),
		);

		await fetchTweetMedia({ fetchImpl: fetchMock, pacingMs: 0 });

		const [, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(init.headers).toMatchObject({ range: "bytes=3-" });
		expect(readFileSync(path.join(mediaDir, "resume.mp4"))).toEqual(
			Buffer.from([1, 2, 3, 4, 5, 6]),
		);
	});

	it("resets max-bytes accounting when a server ignores range resume", async () => {
		const root = home();
		const mediaDir = path.join(root, "media", "originals");
		mkdirSync(mediaDir, { recursive: true });
		writeFileSync(
			path.join(mediaDir, "ignored.mp4.tmp"),
			Buffer.from([1, 2, 3]),
		);
		insertTweet("tweet_1", [{ type: "video", variants: [mp4("ignored")] }]);
		const fetchMock = vi.fn(
			async () =>
				new Response(new Uint8Array([4, 5, 6, 7]), {
					headers: { "content-length": "4" },
				}),
		);

		const result = await fetchTweetMedia({
			fetchImpl: fetchMock,
			maxBytes: 5,
			pacingMs: 0,
		});

		const [, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(init.headers).toMatchObject({ range: "bytes=3-" });
		expect(result).toMatchObject({ fetched: 1, failed: 0 });
		expect(readFileSync(path.join(mediaDir, "ignored.mp4"))).toEqual(
			Buffer.from([4, 5, 6, 7]),
		);
		expect(existsSync(path.join(mediaDir, "ignored.mp4.tmp"))).toBe(false);
	});

	it("fetches video serially even when image parallelism is higher", async () => {
		home();
		insertTweet("tweet_1", [{ type: "video", variants: [mp4("one")] }]);
		insertTweet("tweet_2", [{ type: "video", variants: [mp4("two")] }]);
		let clock = 0;
		const sleeps: number[] = [];

		await fetchTweetMedia({
			fetchImpl: async () => new Response(new Uint8Array([1])),
			now: () => clock,
			sleep: async (ms) => {
				sleeps.push(ms);
				clock += ms;
			},
			parallel: 3,
			videoPacingMs: 40,
		});

		expect(sleeps).toEqual([40]);
	});
});
