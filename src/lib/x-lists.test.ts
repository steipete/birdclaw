// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportBackup, importBackup } from "./backup";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { listTimelineItems } from "./queries";
import { ingestTweetPayload } from "./tweet-repository";
import type { XurlMentionUser } from "./types";

const mocks = vi.hoisted(() => ({
	getAuthenticatedBirdAccount: vi.fn(),
	listOwnedXListsViaBird: vi.fn(),
	listXListMembersViaBird: vi.fn(),
	lookupAuthenticatedOAuth2User: vi.fn(),
	listOwnedXListsViaXurl: vi.fn(),
	listXListMembersViaXurl: vi.fn(),
}));

vi.mock("./bird", () => ({
	getAuthenticatedBirdAccountEffect: () =>
		Effect.tryPromise({
			try: () => mocks.getAuthenticatedBirdAccount(),
			catch: (error) => error,
		}),
	listOwnedXListsViaBirdEffect: (options: unknown) =>
		Effect.tryPromise({
			try: () => mocks.listOwnedXListsViaBird(options),
			catch: (error) => error,
		}),
	listXListMembersViaBirdEffect: (options: unknown) =>
		Effect.tryPromise({
			try: () => mocks.listXListMembersViaBird(options),
			catch: (error) => error,
		}),
}));

vi.mock("./xurl", () => ({
	lookupAuthenticatedOAuth2UserEffect: (username: string) =>
		Effect.tryPromise({
			try: () => mocks.lookupAuthenticatedOAuth2User(username),
			catch: (error) => error,
		}),
	listOwnedXListsViaXurlEffect: (options: unknown) =>
		Effect.tryPromise({
			try: () => mocks.listOwnedXListsViaXurl(options),
			catch: (error) => error,
		}),
	listXListMembersViaXurlEffect: (options: unknown) =>
		Effect.tryPromise({
			try: () => mocks.listXListMembersViaXurl(options),
			catch: (error) => error,
		}),
}));

const tempRoots: string[] = [];

function member(id: string, username: string): XurlMentionUser {
	return {
		id,
		username,
		name: username.toUpperCase(),
		description: `${username} bio`,
		public_metrics: { followers_count: Number(id) * 10 },
	};
}

function switchHome(prefix = "birdclaw-lists-") {
	const root = mkdtempSync(path.join(os.tmpdir(), prefix));
	tempRoots.push(root);
	resetDatabaseForTests();
	process.env.BIRDCLAW_HOME = root;
	resetBirdclawPathsForTests();
	return root;
}

function setupAccount() {
	switchHome();
	const db = getNativeDb();
	const account = db
		.prepare(
			"select id, handle, external_user_id from accounts order by is_default desc limit 1",
		)
		.get() as {
		id: string;
		handle: string;
		external_user_id: string | null;
	};
	mocks.getAuthenticatedBirdAccount.mockResolvedValue({
		username: account.handle,
		...(account.external_user_id ? { id: account.external_user_id } : {}),
	});
	return { db, account };
}

function ownedList(memberCount = 2) {
	return {
		data: [
			{
				id: "list_builders",
				name: "Builders",
				description: "People who build",
				memberCount,
				isPrivate: false,
			},
		],
		meta: { result_count: 1, next_token: null },
	};
}

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	for (const mock of Object.values(mocks)) mock.mockReset();
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("X List sync and local filtering", () => {
	it("syncs complete Bird membership and filters lexical search locally", async () => {
		const { db, account } = setupAccount();
		mocks.listOwnedXListsViaBird.mockResolvedValue(ownedList());
		mocks.listXListMembersViaBird.mockResolvedValue({
			data: [member("1", "alice"), member("2", "bob")],
			meta: {
				result_count: 2,
				page_count: 1,
				next_token: null,
				pagination_known_complete: true,
			},
		});
		const {
			listStoredXListMembers,
			listStoredXLists,
			resolveStoredXListSelector,
			syncXLists,
		} = await import("./x-lists");

		await expect(
			syncXLists({
				mode: "bird",
				maxLists: 1,
				memberLimit: 20,
				maxMemberPages: 1,
				delayMs: 0,
			}),
		).resolves.toMatchObject({
			ok: true,
			source: "bird",
			listCount: 1,
			membershipCompleteCount: 1,
		});
		expect(listStoredXLists()).toMatchObject([
			{
				listId: "list_builders",
				name: "Builders",
				membershipStatus: "complete",
				memberResultCount: 2,
				rateLimit: { memberLimit: 20, maxMemberPages: 1, delayMs: 0 },
			},
		]);
		expect(
			listStoredXListMembers({ name: "builders" }).items.map(
				(item) => item.profile.handle,
			),
		).toEqual(["bob", "alice"]);

		ingestTweetPayload(db, {
			accountId: account.id,
			source: "test",
			edgeKind: "home",
			payload: {
				data: [
					{
						id: "tweet_alice",
						author_id: "1",
						text: "sqlite from alice",
						created_at: "2026-07-01T03:00:00.000Z",
					},
					{
						id: "tweet_outsider",
						author_id: "3",
						text: "sqlite from outsider",
						created_at: "2026-07-01T02:00:00.000Z",
					},
				],
				includes: {
					users: [member("1", "alice"), member("3", "outsider")],
				},
			},
		});
		const selected = resolveStoredXListSelector({ name: "Builders" });
		expect(
			listTimelineItems({
				resource: "home",
				search: "sqlite",
				listAccountId: selected.accountId,
				listId: selected.listId,
				limit: 20,
			}).map((item) => item.id),
		).toEqual(["tweet_alice"]);
		expect(mocks.listOwnedXListsViaXurl).not.toHaveBeenCalled();
	});

	it("preserves unseen members on partial sync and ends them on complete sync", async () => {
		setupAccount();
		mocks.listOwnedXListsViaBird.mockResolvedValue(ownedList());
		mocks.listXListMembersViaBird
			.mockResolvedValueOnce({
				data: [member("1", "alice"), member("2", "bob")],
				meta: { page_count: 1, pagination_known_complete: true },
			})
			.mockResolvedValueOnce({
				data: [member("1", "alice")],
				meta: {
					page_count: 1,
					next_token: "cursor-next",
					pagination_known_complete: false,
				},
			})
			.mockResolvedValueOnce({
				data: [member("1", "alice")],
				meta: { page_count: 1, pagination_known_complete: true },
			});
		const { listStoredXListMembers, syncXLists } = await import("./x-lists");
		const options = {
			mode: "bird" as const,
			maxLists: 1,
			memberLimit: 20,
			maxMemberPages: 1,
			delayMs: 0,
		};

		await syncXLists(options);
		await syncXLists(options);
		expect(
			listStoredXListMembers({ name: "Builders" }).items.map(
				(item) => item.profile.handle,
			),
		).toEqual(["bob", "alice"]);
		mocks.listOwnedXListsViaBird.mockResolvedValue(ownedList(1));
		await syncXLists(options);
		const allMembers = listStoredXListMembers({
			name: "Builders",
			includeEnded: true,
		}).items;
		expect(
			allMembers.map((item) => [item.profile.handle, item.current]),
		).toEqual([
			["bob", false],
			["alice", true],
		]);
	});

	it("round-trips List metadata and membership through current-schema backup", async () => {
		setupAccount();
		mocks.listOwnedXListsViaBird.mockResolvedValue(ownedList(1));
		mocks.listXListMembersViaBird.mockResolvedValue({
			data: [member("1", "alice")],
			meta: { page_count: 1, pagination_known_complete: true },
		});
		const { listStoredXListMembers, listStoredXLists, syncXLists } =
			await import("./x-lists");
		await syncXLists({ mode: "bird", maxLists: 1, delayMs: 0 });
		const backupRoot = mkdtempSync(
			path.join(os.tmpdir(), "birdclaw-lists-backup-"),
		);
		tempRoots.push(backupRoot);
		const exported = await exportBackup({ repoPath: backupRoot });
		expect(exported.manifest).toMatchObject({
			schemaVersion: 5,
			counts: { x_lists: 1, x_list_members: 1 },
		});

		switchHome("birdclaw-lists-restored-");
		await importBackup({ repoPath: backupRoot });
		expect(listStoredXLists()).toMatchObject([
			{ listId: "list_builders", membershipStatus: "complete" },
		]);
		expect(
			listStoredXListMembers({ listId: "list_builders" }).items.map(
				(item) => item.profile.handle,
			),
		).toEqual(["alice"]);
	});
});
