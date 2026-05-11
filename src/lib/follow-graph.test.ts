// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import type { XurlMentionUser } from "./types";

const mocks = vi.hoisted(() => ({
	listFollowUsersViaXurl: vi.fn(),
}));

vi.mock("./xurl", () => ({
	listFollowUsersViaXurl: mocks.listFollowUsersViaXurl,
}));

const tempRoots: string[] = [];

function setupTempHome() {
	const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-graph-"));
	tempRoots.push(tempRoot);
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
}

function user(
	id: string,
	username: string,
	followersCount: number,
): XurlMentionUser {
	return {
		id,
		username,
		name: username.toUpperCase(),
		description: `${username} bio`,
		public_metrics: {
			followers_count: followersCount,
			following_count: 10,
			tweet_count: 100,
			listed_count: 1,
		},
	};
}

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	mocks.listFollowUsersViaXurl.mockReset();
	for (const tempRoot of tempRoots.splice(0)) {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

describe("follow graph sync and cache-only queries", () => {
	it("defaults to dry-run and does not call xurl", async () => {
		setupTempHome();
		const { syncFollowGraph } = await import("./follow-graph");

		const result = await syncFollowGraph({ direction: "followers" });
		const customTtl = await syncFollowGraph({
			direction: "followers",
			cacheTtlMs: 1000,
		});

		expect(result).toMatchObject({
			ok: true,
			dryRun: true,
			wouldCallX: true,
			requiredFlag: "--yes",
		});
		expect(customTtl).toMatchObject({
			estimate: {
				cacheTtlSeconds: 1,
			},
		});
		expect(mocks.listFollowUsersViaXurl).not.toHaveBeenCalled();
	});

	it("syncs complete follower/following snapshots and answers graph queries locally", async () => {
		setupTempHome();
		mocks.listFollowUsersViaXurl
			.mockResolvedValueOnce({
				data: [user("1", "alice", 100), user("2", "bob", 500)],
				meta: { result_count: 2 },
			})
			.mockResolvedValueOnce({
				data: [user("2", "bob", 500), user("3", "charlie", 300)],
				meta: { result_count: 2 },
			});
		const {
			getFollowGraphSummary,
			listMutuals,
			listNonMutualFollowing,
			listTopFollowers,
			syncFollowGraph,
		} = await import("./follow-graph");

		const followersResult = await syncFollowGraph({
			direction: "followers",
			yes: true,
			refresh: true,
		});
		const followingResult = await syncFollowGraph({
			direction: "following",
			yes: true,
			refresh: true,
		});

		expect(followersResult).toMatchObject({
			ok: true,
			source: "xurl",
			status: "complete",
			count: 2,
		});
		expect(followingResult).toMatchObject({
			ok: true,
			source: "xurl",
			status: "complete",
			count: 2,
		});
		getNativeDb()
			.prepare("update profiles set public_metrics_json = ? where handle = ?")
			.run("{bad", "bob");
		getNativeDb()
			.prepare("update profiles set public_metrics_json = ? where handle = ?")
			.run("", "alice");
		expect(listTopFollowers().items.map((item) => item.handle)).toEqual([
			"bob",
			"alice",
		]);
		expect(listTopFollowers().items.map((item) => item.publicMetrics)).toEqual([
			{},
			{},
		]);
		expect(listMutuals().items.map((item) => item.handle)).toEqual(["bob"]);
		expect(listNonMutualFollowing().items.map((item) => item.handle)).toEqual([
			"charlie",
		]);
		expect(getFollowGraphSummary()).toMatchObject({
			followers: 2,
			following: 2,
			mutuals: 1,
			nonMutualFollowing: 1,
		});
	});

	it("reuses fresh cache for duplicate sync requests instead of calling xurl again", async () => {
		setupTempHome();
		mocks.listFollowUsersViaXurl.mockResolvedValueOnce({
			data: [user("1", "alice", 100)],
			meta: { result_count: 1 },
		});
		const { syncFollowGraph } = await import("./follow-graph");

		await syncFollowGraph({ direction: "followers", yes: true, refresh: true });
		const cachedResult = await syncFollowGraph({
			direction: "followers",
			yes: true,
		});

		expect(cachedResult).toMatchObject({
			ok: true,
			source: "cache",
			status: "complete",
			count: 1,
		});
		expect(mocks.listFollowUsersViaXurl).toHaveBeenCalledTimes(1);
	});

	it("reports fresh cache hits during dry-run without calling xurl", async () => {
		setupTempHome();
		mocks.listFollowUsersViaXurl.mockResolvedValueOnce({
			data: [user("1", "alice", 100)],
			meta: { result_count: 1 },
		});
		const { syncFollowGraph } = await import("./follow-graph");

		await syncFollowGraph({ direction: "followers", yes: true, refresh: true });
		const dryRun = await syncFollowGraph({ direction: "followers" });

		expect(dryRun).toMatchObject({
			ok: true,
			dryRun: true,
			wouldCallX: false,
			cache: {
				hit: true,
				fresh: true,
				count: 1,
			},
			currentCount: 1,
		});
		expect(mocks.listFollowUsersViaXurl).toHaveBeenCalledTimes(1);
	});

	it("validates follow sync limits before using xurl", async () => {
		setupTempHome();
		const { syncFollowGraph } = await import("./follow-graph");

		await expect(
			syncFollowGraph({ direction: "followers", limit: 0, yes: true }),
		).rejects.toThrow("--limit must be between 1 and 1000 for follow sync");
		await expect(
			syncFollowGraph({ direction: "followers", maxPages: 0, yes: true }),
		).rejects.toThrow("--max-pages must be at least 1");
		await expect(
			syncFollowGraph({ direction: "followers", account: "missing" }),
		).rejects.toThrow("Unknown account: missing");
		expect(mocks.listFollowUsersViaXurl).not.toHaveBeenCalled();
	});

	it("diffs complete snapshots into ended follow events", async () => {
		setupTempHome();
		mocks.listFollowUsersViaXurl
			.mockResolvedValueOnce({
				data: [user("1", "alice", 100), user("2", "bob", 500)],
				meta: { result_count: 2 },
			})
			.mockResolvedValueOnce({
				data: [user("1", "alice", 100)],
				meta: { result_count: 1 },
			});
		const { listFollowEvents, listUnfollowedSince, syncFollowGraph } =
			await import("./follow-graph");

		await syncFollowGraph({ direction: "followers", yes: true, refresh: true });
		await syncFollowGraph({ direction: "followers", yes: true, refresh: true });

		expect(
			listUnfollowedSince({
				date: "2026-01-01",
			}).items.map((item) => item.profile.handle),
		).toEqual(["bob"]);
		expect(
			listFollowEvents({
				direction: "followers",
				kind: "ended",
				since: "2026-01-01",
			}).items.map((item) => ({
				kind: item.kind,
				direction: item.direction,
				handle: item.profile.handle,
			})),
		).toEqual([
			{
				kind: "ended",
				direction: "followers",
				handle: "bob",
			},
		]);
		expect(
			listFollowEvents({
				direction: "followers",
				kind: "started",
				until: "2999-01-01",
			}).items.map((item) => item.profile.handle),
		).toEqual(["bob", "alice"]);
	});

	it("records incomplete capped snapshots without ending existing edges", async () => {
		setupTempHome();
		mocks.listFollowUsersViaXurl
			.mockResolvedValueOnce({
				data: [user("1", "alice", 100), user("2", "bob", 500)],
				meta: { result_count: 2 },
			})
			.mockResolvedValueOnce({
				data: [user("1", "alice", 100)],
				meta: { next_token: "page-two", result_count: 1 },
			});
		const {
			getFollowGraphSummary,
			listTopFollowers,
			listUnfollowedSince,
			syncFollowGraph,
		} = await import("./follow-graph");

		await syncFollowGraph({ direction: "followers", yes: true, refresh: true });
		const capped = await syncFollowGraph({
			direction: "followers",
			yes: true,
			refresh: true,
			maxPages: 1,
		});

		expect(capped).toMatchObject({
			ok: true,
			status: "incomplete",
			partial: true,
			warning:
				"Snapshot is incomplete because a page/resource cap stopped pagination. It was recorded but not used for churn events.",
		});
		expect(listTopFollowers().items.map((item) => item.handle)).toEqual([
			"bob",
			"alice",
		]);
		expect(listUnfollowedSince({ date: "2026-01-01" }).items).toEqual([]);
		expect(getFollowGraphSummary().lastIncompleteSnapshots.followers).toEqual(
			expect.any(String),
		);
	});

	it("marks max-resource truncated snapshots incomplete and preserves payload members", async () => {
		setupTempHome();
		mocks.listFollowUsersViaXurl.mockResolvedValueOnce({
			data: [
				user("1", "alice", 100),
				user("1", "alice", 100),
				user("2", "bob", 500),
			],
			meta: { result_count: 3 },
		});
		const { syncFollowGraph } = await import("./follow-graph");

		const result = await syncFollowGraph({
			direction: "followers",
			yes: true,
			refresh: true,
			maxResources: 1,
			allowPartial: true,
		});
		const memberCount = getNativeDb()
			.prepare("select count(*) as count from follow_snapshot_members")
			.get() as { count: number };
		const snapshotMeta = getNativeDb()
			.prepare("select raw_meta_json from follow_snapshots")
			.get() as { raw_meta_json: string };

		expect(result).toMatchObject({
			status: "incomplete",
			partial: true,
			count: 1,
			warning: undefined,
		});
		expect(memberCount.count).toBe(1);
		expect(JSON.parse(snapshotMeta.raw_meta_json)).toMatchObject({
			result_count: 1,
			page_count: 1,
			truncated_by_max_resources: true,
		});
	});

	it("supports handle sorting and ISO timestamp filters for cache-only queries", async () => {
		setupTempHome();
		mocks.listFollowUsersViaXurl
			.mockResolvedValueOnce({
				data: [user("1", "zara", 100), user("2", "alice", 500)],
				meta: { result_count: 2 },
			})
			.mockResolvedValueOnce({
				data: [user("2", "alice", 500)],
				meta: { result_count: 1 },
			});
		const { listNonMutualFollowing, listUnfollowedSince, syncFollowGraph } =
			await import("./follow-graph");

		await syncFollowGraph({ direction: "following", yes: true, refresh: true });
		await syncFollowGraph({ direction: "following", yes: true, refresh: true });

		expect(
			listNonMutualFollowing({ sort: "handle" }).items.map(
				(item) => item.handle,
			),
		).toEqual(["alice"]);
		expect(
			listUnfollowedSince({
				direction: "following",
				date: "2026-01-01T00:00:00.000Z",
			}).items.map((item) => item.profile.handle),
		).toEqual(["zara"]);
	});
});
