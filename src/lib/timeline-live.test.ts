// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { listTimelineItems } from "./queries";

const listHomeTimelineViaBirdMock = vi.fn();

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
	};
});

const tempDirs: string[] = [];

function makeTempHome() {
	const tempDir = mkdtempSync(
		path.join(os.tmpdir(), "birdclaw-timeline-live-"),
	);
	tempDirs.push(tempDir);
	process.env.BIRDCLAW_HOME = tempDir;
	return tempDir;
}

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	listHomeTimelineViaBirdMock.mockReset();

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

		const effect = syncHomeTimelineEffect({
			account: "acct_primary",
			limit: 5,
			refresh: true,
		});

		expect(listHomeTimelineViaBirdMock).not.toHaveBeenCalled();
		await expect(Effect.runPromise(effect)).resolves.toMatchObject({
			source: "bird",
			count: 0,
		});
		expect(listHomeTimelineViaBirdMock).toHaveBeenCalledTimes(1);
	});

	it("stores account-scoped home timeline edges without moving canonical tweets", async () => {
		makeTempHome();
		const db = getNativeDb();
		db.prepare("update tweets set account_id = ? where id = ?").run(
			"acct_primary",
			"tweet_001",
		);
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
				users: [{ id: "42", username: "sam", name: "Sam" }],
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
			db.prepare("select account_id from tweets where id = ?").get("tweet_001"),
		).toEqual({ account_id: "acct_primary" });
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
        id, account_id, author_profile_id, kind, text, created_at,
        is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
        entities_json, media_json, quoted_tweet_id
      ) values (?, 'acct_primary', 'profile_user_42', 'home', ?, ?, 0, null, 0, 1, 0, 0, '{}', ?, null)
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
});
