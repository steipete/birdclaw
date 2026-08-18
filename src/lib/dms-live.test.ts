// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getConversationThread, listDmConversations } from "./dm-read-model";
import { getNativeDb, resetDatabaseForTests } from "./db";

const listDirectMessagesViaBirdMock = vi.fn();
const getAuthenticatedBirdAccountMock = vi.fn();
const listDirectMessageEventsViaXurlMock = vi.fn();
const lookupAuthenticatedUserMock = vi.fn();

vi.mock("./bird", async () => {
	const { effectFromMock } = await import("../test/effect-mocks");
	return {
		getAuthenticatedBirdAccountEffect: effectFromMock(
			getAuthenticatedBirdAccountMock,
		),
		listDirectMessagesViaBirdEffect: effectFromMock(
			listDirectMessagesViaBirdMock,
		),
	};
});

vi.mock("./xurl", async () => {
	const { effectFromMock } = await import("../test/effect-mocks");
	return {
		lookupAuthenticatedOAuth2UserEffect: effectFromMock(
			lookupAuthenticatedUserMock,
		),
		listDirectMessageEventsViaXurlEffect: effectFromMock(
			listDirectMessageEventsViaXurlMock,
		),
	};
});

const tempDirs: string[] = [];

function makeTempHome() {
	const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-dms-live-"));
	tempDirs.push(tempDir);
	process.env.BIRDCLAW_HOME = tempDir;
	return tempDir;
}

describe("cached live DMs", () => {
	beforeEach(() => {
		listDirectMessagesViaBirdMock.mockReset();
		getAuthenticatedBirdAccountMock.mockReset();
		listDirectMessageEventsViaXurlMock.mockReset();
		lookupAuthenticatedUserMock.mockReset();
		getAuthenticatedBirdAccountMock.mockResolvedValue({
			id: "25401953",
			username: "steipete",
		});
		lookupAuthenticatedUserMock.mockResolvedValue({
			id: "25401953",
			username: "steipete",
		});
	});

	afterEach(() => {
		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		delete process.env.BIRDCLAW_HOME;

		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps cached DM sync effects lazy", async () => {
		makeTempHome();
		listDirectMessagesViaBirdMock.mockResolvedValueOnce({
			success: true,
			conversations: [],
			events: [],
		});
		const { syncDirectMessagesViaCachedBirdEffect } =
			await import("./dms-live");

		const effect = syncDirectMessagesViaCachedBirdEffect({
			account: "acct_primary",
			limit: 5,
			refresh: true,
		});

		expect(listDirectMessagesViaBirdMock).not.toHaveBeenCalled();
		await expect(Effect.runPromise(effect)).resolves.toMatchObject({
			source: "bird",
			conversations: 0,
			messages: 0,
		});
		expect(listDirectMessagesViaBirdMock).toHaveBeenCalledTimes(1);
	});

	it("fetches bird DMs, caches them, and syncs them into the local store", async () => {
		makeTempHome();
		listDirectMessagesViaBirdMock.mockResolvedValueOnce({
			success: true,
			conversations: [
				{
					id: "25401953-42",
					participants: [
						{ id: "25401953", username: "steipete", name: "Peter" },
						{ id: "42", username: "sam", name: "Sam Altman" },
					],
					messages: [
						{
							id: "dm_live_1",
							conversationId: "25401953-42",
							text: "Live DM hello",
							createdAt: "2026-04-25T20:00:00.000Z",
							senderId: "42",
							recipientId: "25401953",
							sender: { id: "42", username: "sam", name: "Sam Altman" },
							recipient: {
								id: "25401953",
								username: "steipete",
								name: "Peter",
							},
						},
					],
					lastMessageAt: "2026-04-25T20:00:00.000Z",
					inboxKind: "request",
					isMessageRequest: true,
				},
			],
			events: [
				{
					id: "dm_live_1",
					conversationId: "25401953-42",
					text: "Live DM hello",
					createdAt: "2026-04-25T20:00:00.000Z",
					senderId: "42",
					recipientId: "25401953",
					sender: { id: "42", username: "sam", name: "Sam Altman" },
					recipient: { id: "25401953", username: "steipete", name: "Peter" },
				},
			],
		});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		const summary = await syncDirectMessagesViaCachedBird({
			account: "acct_primary",
			limit: 5,
			refresh: true,
		});

		expect(summary).toEqual({
			ok: true,
			source: "bird",
			accountId: "acct_primary",
			conversations: 1,
			messages: 1,
		});
		expect(listDirectMessagesViaBirdMock).toHaveBeenCalledWith({
			maxResults: 5,
		});
		expect(listDmConversations({ search: "hello", limit: 10 })).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "25401953-42",
					accountId: "acct_primary",
					inboxKind: "request",
					isMessageRequest: true,
					needsReply: true,
					participant: expect.objectContaining({
						handle: "sam",
						displayName: "Sam Altman",
					}),
				}),
			]),
		);
		expect(listDmConversations({ inbox: "requests", limit: 10 })).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "25401953-42",
					inboxKind: "request",
					isMessageRequest: true,
				}),
			]),
		);
		expect(getConversationThread("25401953-42")?.messages).toEqual([
			expect.objectContaining({
				id: "dm_live_1",
				text: "Live DM hello",
				direction: "inbound",
				sender: expect.objectContaining({ handle: "sam" }),
			}),
		]);
	});

	it("fetches recent xurl DM events into the local store", async () => {
		makeTempHome();
		listDirectMessageEventsViaXurlMock.mockResolvedValueOnce({
			data: [
				{
					id: "dm_xurl_1",
					event_type: "MessageCreate",
					text: "Hello from xurl",
					created_at: "2026-05-20T12:00:00.000Z",
					dm_conversation_id: "25401953-42",
					sender_id: "42",
					participant_ids: ["25401953", "42"],
				},
			],
			includes: {
				users: [
					{ id: "25401953", username: "steipete", name: "Peter" },
					{ id: "42", username: "sam", name: "Sam Altman" },
				],
			},
			meta: { result_count: 1 },
		});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		const summary = await syncDirectMessagesViaCachedBird({
			account: "acct_primary",
			mode: "xurl",
			limit: 5,
			refresh: true,
		});

		expect(summary).toEqual({
			ok: true,
			source: "xurl",
			accountId: "acct_primary",
			conversations: 1,
			messages: 1,
		});
		expect(listDirectMessagesViaBirdMock).not.toHaveBeenCalled();
		expect(lookupAuthenticatedUserMock).toHaveBeenCalledWith("steipete");
		expect(listDirectMessageEventsViaXurlMock).toHaveBeenCalledWith({
			maxResults: 5,
			username: "steipete",
		});
		expect(listDmConversations({ search: "xurl", limit: 10 })).toEqual([
			expect.objectContaining({
				id: "25401953-42",
				accountId: "acct_primary",
				inboxKind: "accepted",
				isMessageRequest: false,
				participant: expect.objectContaining({
					handle: "sam",
					displayName: "Sam Altman",
				}),
			}),
		]);
		expect(getConversationThread("25401953-42")?.messages).toEqual([
			expect.objectContaining({
				id: "dm_xurl_1",
				text: "Hello from xurl",
				direction: "inbound",
				sender: expect.objectContaining({ handle: "sam" }),
			}),
		]);
	});

	it("paginates xurl DM events when requested", async () => {
		makeTempHome();
		listDirectMessageEventsViaXurlMock
			.mockResolvedValueOnce({
				data: [
					{
						id: "dm_xurl_page_1",
						event_type: "MessageCreate",
						text: "Page one",
						created_at: "2026-05-20T12:00:00.000Z",
						dm_conversation_id: "25401953-42",
						sender_id: "42",
						participant_ids: ["25401953", "42"],
					},
				],
				includes: {
					users: [
						{ id: "25401953", username: "steipete", name: "Peter" },
						{ id: "42", username: "sam", name: "Sam Altman" },
					],
				},
				meta: { next_token: "next-page" },
			})
			.mockResolvedValueOnce({
				data: [
					{
						id: "dm_xurl_page_2",
						event_type: "MessageCreate",
						text: "Page two",
						created_at: "2026-05-19T12:00:00.000Z",
						dm_conversation_id: "25401953-99",
						sender_id: "99",
						participant_ids: ["25401953", "99"],
					},
				],
				includes: {
					users: [{ id: "99", username: "pat", name: "Pat" }],
				},
				meta: {},
			});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		await expect(
			syncDirectMessagesViaCachedBird({
				mode: "xurl",
				limit: 5,
				maxPages: 1,
				refresh: true,
			}),
		).resolves.toEqual(
			expect.objectContaining({
				source: "xurl",
				conversations: 2,
				messages: 2,
			}),
		);
		expect(listDirectMessageEventsViaXurlMock).toHaveBeenNthCalledWith(2, {
			maxResults: 5,
			username: "steipete",
			paginationToken: "next-page",
		});
	});

	it("reuses fresh cache without spending another bird call", async () => {
		makeTempHome();
		listDirectMessagesViaBirdMock.mockResolvedValue({
			success: true,
			conversations: [],
			events: [],
		});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		await syncDirectMessagesViaCachedBird({
			account: "acct_primary",
			limit: 5,
		});
		const second = await syncDirectMessagesViaCachedBird({
			account: "acct_primary",
			limit: 5,
		});

		expect(second.source).toBe("cache");
		expect(listDirectMessagesViaBirdMock).toHaveBeenCalledTimes(1);
	});

	it("validates limits and account selection", async () => {
		makeTempHome();
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		await expect(syncDirectMessagesViaCachedBird({ limit: 0 })).rejects.toThrow(
			"bird DM mode requires --limit of at least 1",
		);
		await expect(
			syncDirectMessagesViaCachedBird({ account: "missing", limit: 1 }),
		).rejects.toThrow("Unknown account: missing");
		await expect(
			syncDirectMessagesViaCachedBird({ mode: "xurl", limit: 101 }),
		).rejects.toThrow("xurl DM mode requires --limit between 1 and 100");
		await expect(
			syncDirectMessagesViaCachedBird({
				mode: "xurl",
				inbox: "requests",
				limit: 5,
			}),
		).rejects.toThrow("xurl DM mode cannot read the message-request inbox");
	});

	it("falls back from xurl to bird in auto mode", async () => {
		makeTempHome();
		listDirectMessageEventsViaXurlMock.mockRejectedValueOnce(
			new Error("xurl denied"),
		);
		listDirectMessagesViaBirdMock.mockResolvedValueOnce({
			success: true,
			conversations: [],
			events: [],
		});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		await expect(
			syncDirectMessagesViaCachedBird({
				mode: "auto",
				limit: 5,
				refresh: true,
			}),
		).resolves.toEqual(
			expect.objectContaining({
				source: "bird",
			}),
		);
		expect(listDirectMessageEventsViaXurlMock).toHaveBeenCalledTimes(1);
		expect(listDirectMessagesViaBirdMock).toHaveBeenCalledTimes(1);
	});

	it("uses bird for request inbox syncs in auto mode", async () => {
		makeTempHome();
		listDirectMessagesViaBirdMock.mockResolvedValueOnce({
			success: true,
			conversations: [],
			events: [],
		});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		await expect(
			syncDirectMessagesViaCachedBird({
				mode: "auto",
				inbox: "requests",
				limit: 5,
				refresh: true,
			}),
		).resolves.toEqual(
			expect.objectContaining({
				source: "bird",
			}),
		);
		expect(lookupAuthenticatedUserMock).not.toHaveBeenCalled();
		expect(listDirectMessageEventsViaXurlMock).not.toHaveBeenCalled();
		expect(listDirectMessagesViaBirdMock).toHaveBeenCalledWith({
			maxResults: 5,
			inbox: "requests",
		});
	});

	it("refuses to fetch DMs when bird is authenticated as another account", async () => {
		makeTempHome();
		getAuthenticatedBirdAccountMock.mockResolvedValueOnce({
			id: "1995710751097659392",
			username: "openclaw",
		});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		await expect(
			syncDirectMessagesViaCachedBird({
				account: "acct_primary",
				limit: 5,
				refresh: true,
			}),
		).rejects.toThrow(
			"bird is authenticated as user 1995710751097659392; refusing to sync into acct_primary (25401953)",
		);
		expect(listDirectMessagesViaBirdMock).not.toHaveBeenCalled();
		expect(listDmConversations({ search: "Wrong account", limit: 10 })).toEqual(
			[],
		);
	});

	it("refuses xurl DMs when xurl is authenticated as another account", async () => {
		makeTempHome();
		lookupAuthenticatedUserMock.mockResolvedValueOnce({
			id: "1995710751097659392",
			username: "openclaw",
		});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		await expect(
			syncDirectMessagesViaCachedBird({
				account: "acct_primary",
				mode: "xurl",
				limit: 5,
				refresh: true,
			}),
		).rejects.toThrow(
			"xurl is authenticated as user 1995710751097659392; refusing to sync into acct_primary (25401953)",
		);
		expect(listDirectMessageEventsViaXurlMock).not.toHaveBeenCalled();
	});

	it("refuses payloads that do not include the configured account", async () => {
		makeTempHome();
		listDirectMessagesViaBirdMock.mockResolvedValueOnce({
			success: true,
			conversations: [
				{
					id: "999-42",
					participants: [{ id: "42", username: "sam", name: "Sam Altman" }],
					messages: [],
				},
			],
			events: [
				{
					id: "dm_live_1",
					conversationId: "999-42",
					text: "Wrong account",
					createdAt: "2026-04-25T20:00:00.000Z",
					senderId: "42",
					sender: { id: "42", username: "sam", name: "Sam Altman" },
				},
			],
		});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		await expect(
			syncDirectMessagesViaCachedBird({
				account: "acct_primary",
				limit: 5,
				refresh: true,
			}),
		).rejects.toThrow(
			"bird DM payload does not include @steipete; refusing to sync into acct_primary",
		);
	});

	it("uses the stable account id when handles or payload users are sparse", async () => {
		makeTempHome();
		getAuthenticatedBirdAccountMock.mockResolvedValueOnce({
			id: "25401953",
			username: "renamed",
		});
		listDirectMessagesViaBirdMock.mockResolvedValueOnce({
			success: true,
			conversations: [
				{
					id: "25401953-42",
					participants: [
						{ id: "25401953" },
						{ id: "42", username: "sam", name: "Sam Altman" },
					],
					messages: [],
					lastMessageAt: "2026-04-25T20:00:00.000Z",
				},
			],
			events: [
				{
					id: "dm_sparse_self",
					conversationId: "25401953-42",
					text: "Sparse self",
					createdAt: "2026-04-25T20:00:00.000Z",
					senderId: "42",
					recipientId: "25401953",
					sender: { id: "42", username: "sam", name: "Sam Altman" },
				},
			],
		});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		await expect(
			syncDirectMessagesViaCachedBird({
				account: "acct_primary",
				limit: 5,
				refresh: true,
			}),
		).resolves.toEqual(
			expect.objectContaining({
				source: "bird",
				conversations: 1,
				messages: 1,
			}),
		);
		expect(getConversationThread("25401953-42")?.messages).toEqual([
			expect.objectContaining({
				id: "dm_sparse_self",
				direction: "inbound",
			}),
		]);
	});

	it("updates sparse remote DM identity without downgrading rich profile fields", async () => {
		makeTempHome();
		const db = getNativeDb();
		db.prepare(
			`insert into profiles (
			 id, handle, display_name, bio, followers_count, following_count,
			 public_metrics_json, avatar_hue, avatar_url, entities_json, raw_json,
			 created_at
			) values (
			 'profile_user_4242', 'old4242', 'Old Name', 'rich remote bio', 4242, 242,
			 '{"followers_count":4242,"following_count":242}', 42,
			 'https://img.example/4242.jpg', '{"description":{"urls":[]}}',
			 '{"id":"4242","username":"old4242","rich":true}',
			 '2025-01-01T00:00:00.000Z'
			)`,
		).run();
		listDirectMessagesViaBirdMock.mockResolvedValueOnce({
			success: true,
			conversations: [
				{
					id: "25401953-4242",
					participants: [
						{ id: "25401953" },
						{
							id: "4242",
							username: "new4242",
							name: "New Name",
							profileImageUrl: "https://img.example/new4242.jpg",
						},
					],
					messages: [],
				},
			],
			events: [
				{
					id: "dm_sparse_remote",
					conversationId: "25401953-4242",
					text: "Sparse remote participant",
					createdAt: "2026-04-25T20:00:00.000Z",
					senderId: "4242",
					recipientId: "25401953",
					sender: {
						id: "4242",
						username: "new4242",
						name: "New Name",
						profileImageUrl: "https://img.example/new4242.jpg",
					},
				},
			],
		});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		await syncDirectMessagesViaCachedBird({ limit: 5, refresh: true });

		const row = db
			.prepare(
				`select handle, display_name, bio, followers_count, following_count,
				 public_metrics_json, avatar_url, entities_json, raw_json
				 from profiles where id = 'profile_user_4242'`,
			)
			.get() as Record<string, unknown>;
		expect(row).toMatchObject({
			handle: "new4242",
			display_name: "New Name",
			bio: "rich remote bio",
			followers_count: 4242,
			following_count: 242,
			public_metrics_json: '{"followers_count":4242,"following_count":242}',
			avatar_url: "https://img.example/new4242.jpg",
			entities_json: '{"description":{"urls":[]}}',
		});
		expect(JSON.parse(String(row.raw_json))).toMatchObject({
			id: "4242",
			username: "new4242",
			rich: true,
		});
	});

	it("preserves a rich display name for a username-only DM participant", async () => {
		makeTempHome();
		const db = getNativeDb();
		db.prepare(
			`insert into profiles (
			 id, handle, display_name, bio, followers_count, avatar_hue, raw_json, created_at
			) values (
			 'profile_user_4243', 'old4243', 'Rich Display Name', 'rich bio', 43, 43,
			 '{"id":"4243","username":"old4243"}', '2025-01-01T00:00:00.000Z'
			)`,
		).run();
		listDirectMessagesViaBirdMock.mockResolvedValueOnce({
			success: true,
			conversations: [
				{
					id: "25401953-4243",
					participants: [
						{ id: "25401953" },
						{ id: "4243", username: "new4243" },
					],
					messages: [],
				},
			],
			events: [],
		});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		await syncDirectMessagesViaCachedBird({ limit: 5, refresh: true });

		const row = db
			.prepare(
				"select handle, display_name, bio, raw_json from profiles where id = 'profile_user_4243'",
			)
			.get() as Record<string, unknown>;
		expect(row).toMatchObject({
			handle: "new4243",
			display_name: "Rich Display Name",
			bio: "rich bio",
		});
		expect(JSON.parse(String(row.raw_json))).toMatchObject({
			id: "4243",
			username: "new4243",
		});
	});

	it("indexes a learned name for a handle-less remote DM participant", async () => {
		makeTempHome();
		const db = getNativeDb();
		listDirectMessagesViaBirdMock.mockResolvedValueOnce({
			success: true,
			conversations: [
				{
					id: "25401953-4343",
					participants: [
						{ id: "25401953" },
						{
							id: "4343",
							name: "Name Only",
							profileImageUrl:
								"https://pbs.twimg.com/profile_images/4343/name_normal.jpg",
						},
					],
					messages: [],
				},
			],
			events: [
				{
					id: "dm_handleless_remote",
					conversationId: "25401953-4343",
					text: "Handle-less remote participant",
					createdAt: "2026-04-25T20:00:00.000Z",
					senderId: "4343",
					recipientId: "25401953",
					sender: {
						id: "4343",
						name: "Name Only",
					},
				},
			],
		});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		await syncDirectMessagesViaCachedBird({ limit: 5, refresh: true });

		const profile = db
			.prepare(
				`select handle, display_name, avatar_url, raw_json
				 from profiles where id = 'profile_user_4343'`,
			)
			.get() as Record<string, unknown>;
		expect(profile).toMatchObject({
			display_name: "Name Only",
			avatar_url: "https://pbs.twimg.com/profile_images/4343/name.jpg",
		});
		expect(String(profile.handle)).toMatch(/^birdclaw_stub_/);
		expect(JSON.parse(String(profile.raw_json))).toEqual({ id: "4343" });
		expect(
			db
				.prepare(
					`select value from identity_search_index
					 where profile_id = 'profile_user_4343' and kind = 'profile_name'`,
				)
				.get(),
		).toEqual({ value: "Name Only" });
		expect(
			db
				.prepare(
					"select count(*) as count from profile_snapshots where profile_id = 'profile_user_4343'",
				)
				.get(),
		).toEqual({ count: 2 });
	});

	it("coalesces handle-less DM avatars without downgrading a rich profile", async () => {
		makeTempHome();
		const db = getNativeDb();
		db.prepare(
			`insert into profiles (
			 id, handle, display_name, bio, followers_count, following_count,
			 public_metrics_json, avatar_hue, avatar_url, entities_json, raw_json,
			 created_at
			) values (
			 'profile_user_4444', 'birdclaw_stub_existing4444', 'Rich Person',
			 'rich handle-less bio', 444, 44,
			 '{"followers_count":444,"following_count":44}', 44,
			 'https://img.example/original4444.jpg', '{"description":{"urls":[]}}',
			 '{"id":"4444","rich":true}', '2025-01-01T00:00:00.000Z'
			)`,
		).run();
		const payload = (profileImageUrl?: string) => ({
			success: true as const,
			conversations: [
				{
					id: "25401953-4444",
					participants: [
						{ id: "25401953" },
						{
							id: "4444",
							name: "Incoming Sparse Name",
							...(profileImageUrl ? { profileImageUrl } : {}),
						},
					],
					messages: [],
				},
			],
			events: [
				{
					id: profileImageUrl
						? "dm_handleless_avatar_new"
						: "dm_handleless_no_avatar",
					conversationId: "25401953-4444",
					text: "Sparse handle-less participant",
					createdAt: "2026-04-25T20:00:00.000Z",
					senderId: "4444",
					recipientId: "25401953",
					sender: {
						id: "4444",
						name: "Incoming Sparse Name",
						...(profileImageUrl ? { profileImageUrl } : {}),
					},
				},
			],
		});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		listDirectMessagesViaBirdMock.mockResolvedValueOnce(payload());
		await syncDirectMessagesViaCachedBird({ limit: 5, refresh: true });
		const first = db
			.prepare(
				`select handle, display_name, bio, followers_count, following_count,
				 public_metrics_json, avatar_url, entities_json, raw_json
				 from profiles where id = 'profile_user_4444'`,
			)
			.get() as Record<string, unknown>;
		expect(first).toMatchObject({
			handle: "birdclaw_stub_existing4444",
			display_name: "Rich Person",
			bio: "rich handle-less bio",
			followers_count: 444,
			following_count: 44,
			public_metrics_json: '{"followers_count":444,"following_count":44}',
			avatar_url: "https://img.example/original4444.jpg",
			entities_json: '{"description":{"urls":[]}}',
		});

		listDirectMessagesViaBirdMock.mockResolvedValueOnce(
			payload(
				"https://pbs.twimg.com/profile_images/4444/replacement_normal.jpg",
			),
		);
		await syncDirectMessagesViaCachedBird({ limit: 5, refresh: true });
		const updated = db
			.prepare(
				`select handle, display_name, bio, followers_count, avatar_url, raw_json
				 from profiles where id = 'profile_user_4444'`,
			)
			.get() as Record<string, unknown>;
		expect(updated).toMatchObject({
			handle: "birdclaw_stub_existing4444",
			display_name: "Rich Person",
			bio: "rich handle-less bio",
			followers_count: 444,
			avatar_url: "https://pbs.twimg.com/profile_images/4444/replacement.jpg",
		});
		expect(JSON.parse(String(updated.raw_json))).toEqual({
			id: "4444",
			rich: true,
		});
		expect(
			db
				.prepare(
					`select value from identity_search_index
					 where profile_id = 'profile_user_4444' and kind = 'profile_name'`,
				)
				.get(),
		).toEqual({ value: "Rich Person" });
		expect(
			db
				.prepare(
					"select count(*) as count from profile_snapshots where profile_id = 'profile_user_4444'",
				)
				.get(),
		).toEqual({ count: 1 });
	});

	it("keeps request conversations that only have a last-message preview", async () => {
		makeTempHome();
		listDirectMessagesViaBirdMock.mockResolvedValueOnce({
			success: true,
			conversations: [
				{
					id: "25401953-55",
					participants: [
						{ id: "25401953" },
						{ id: "55", username: "previewonly", name: "Preview Only" },
					],
					messages: [],
					lastMessageAt: "2026-04-25T20:00:00.000Z",
					lastMessagePreview: "Preview text without an event body",
					inboxKind: "request",
					isMessageRequest: true,
				},
			],
			events: [],
		});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		await expect(
			syncDirectMessagesViaCachedBird({
				account: "acct_primary",
				limit: 5,
				refresh: true,
			}),
		).resolves.toEqual(
			expect.objectContaining({
				source: "bird",
				conversations: 1,
				messages: 0,
			}),
		);
		expect(listDmConversations({ inbox: "requests", limit: 10 })).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "25401953-55",
					inboxKind: "request",
					isMessageRequest: true,
					lastMessagePreview: "Preview text without an event body",
					needsReply: true,
					participant: expect.objectContaining({
						handle: "previewonly",
						displayName: "Preview Only",
					}),
				}),
			]),
		);
		expect(
			listDmConversations({
				search: "Preview text",
				inbox: "requests",
				limit: 10,
			}).map((item) => item.id),
		).toEqual(["25401953-55"]);
		expect(getConversationThread("25401953-55")?.messages).toEqual([
			expect.objectContaining({
				id: "preview:25401953-55",
				text: "Preview text without an event body",
				direction: "inbound",
			}),
		]);
	});

	it("imports sparse outbound messages from the stable account id", async () => {
		makeTempHome();
		const db = getNativeDb();
		db.prepare(
			`update profiles set bio = 'rich local account', followers_count = 999,
				 avatar_url = 'https://img.example/account.jpg',
				 entities_json = '{"description":{"urls":[]}}', raw_json = '{}'
				 where id = 'profile_me'`,
		).run();
		db.prepare(
			"insert into tweets (id, author_profile_id, text, created_at) values ('dm-local-proof-tweet', 'profile_me', 'local proof', '2026-01-01T00:00:00.000Z')",
		).run();
		db.prepare(
			"insert into profile_snapshots (profile_id, snapshot_hash, observed_at, last_seen_at, source, handle, display_name, bio, followers_count, following_count) values ('profile_me', 'dm-local-proof-snapshot', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'test', 'steipete', 'Peter Steinberger', 'rich local account', 999, 0)",
		).run();
		listDirectMessagesViaBirdMock.mockResolvedValueOnce({
			success: true,
			conversations: [
				{
					id: "25401953-66",
					participants: [
						{
							id: "25401953",
							username: "steipete",
							name: "Sparse Peter",
						},
						{ id: "66", username: "pat", name: "Pat" },
					],
					messages: [],
				},
			],
			events: [
				{
					id: "dm_sparse_outbound",
					conversationId: "25401953-66",
					text: "Sparse outbound",
					createdAt: "2026-04-25T20:00:00.000Z",
					senderId: "25401953",
					recipientId: "66",
					recipient: { id: "66", username: "pat", name: "Pat" },
				},
			],
		});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		await expect(
			syncDirectMessagesViaCachedBird({
				account: "acct_primary",
				limit: 5,
				refresh: true,
			}),
		).resolves.toEqual(
			expect.objectContaining({
				source: "bird",
				conversations: 1,
				messages: 1,
			}),
		);
		expect(getConversationThread("25401953-66")?.messages).toEqual([
			expect.objectContaining({
				id: "dm_sparse_outbound",
				direction: "outbound",
			}),
		]);
		expect(
			db
				.prepare(
					`select bio, followers_count, avatar_url, entities_json
					 from profiles where id = 'profile_user_25401953'`,
				)
				.get(),
		).toEqual({
			bio: "rich local account",
			followers_count: 999,
			avatar_url: "https://img.example/account.jpg",
			entities_json: '{"description":{"urls":[]}}',
		});
		expect(
			db.prepare("select 1 from profiles where id = 'profile_me'").get(),
		).toBeUndefined();
		expect(
			db
				.prepare(
					"select author_profile_id from tweets where id = 'dm-local-proof-tweet'",
				)
				.get(),
		).toEqual({ author_profile_id: "profile_user_25401953" });
		expect(
			db
				.prepare(
					"select sender_profile_id from dm_messages where id = 'dm_sparse_outbound'",
				)
				.get(),
		).toEqual({ sender_profile_id: "profile_user_25401953" });
		expect(
			db
				.prepare(
					"select profile_id from profile_snapshots where handle = 'steipete' and bio = 'rich local account' limit 1",
				)
				.get(),
		).toEqual({ profile_id: "profile_user_25401953" });
	});

	it("uses the live bird account id when the selected account has no stored external id", async () => {
		makeTempHome();
		getNativeDb()
			.prepare("update accounts set external_user_id = null where id = ?")
			.run("acct_primary");
		listDirectMessagesViaBirdMock.mockResolvedValueOnce({
			success: true,
			conversations: [
				{
					id: "25401953-77",
					participants: [{ id: "77", username: "casey", name: "Casey" }],
					messages: [],
					lastMessageAt: "2026-04-25T20:00:00.000Z",
				},
			],
			events: [
				{
					id: "dm_sparse_live_id",
					conversationId: "25401953-77",
					text: "Sparse self from live id",
					createdAt: "2026-04-25T20:00:00.000Z",
					senderId: "77",
					sender: { id: "77", username: "casey", name: "Casey" },
				},
			],
		});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		await expect(
			syncDirectMessagesViaCachedBird({
				account: "acct_primary",
				limit: 5,
				refresh: true,
			}),
		).resolves.toEqual(
			expect.objectContaining({
				source: "bird",
				conversations: 1,
				messages: 1,
			}),
		);
		expect(getConversationThread("25401953-77")?.messages).toEqual([
			expect.objectContaining({
				id: "dm_sparse_live_id",
				direction: "inbound",
			}),
		]);
		expect(
			getNativeDb()
				.prepare("select external_user_id from accounts where id = ?")
				.get("acct_primary"),
		).toEqual({ external_user_id: "25401953" });

		const cached = await syncDirectMessagesViaCachedBird({
			account: "acct_primary",
			limit: 5,
		});

		expect(cached).toEqual(
			expect.objectContaining({
				source: "cache",
				conversations: 1,
				messages: 1,
			}),
		);
		expect(listDirectMessagesViaBirdMock).toHaveBeenCalledTimes(1);
	});

	it("treats a blank stored external id as missing", async () => {
		makeTempHome();
		getNativeDb()
			.prepare("update accounts set external_user_id = '  ' where id = ?")
			.run("acct_primary");
		listDirectMessagesViaBirdMock.mockResolvedValueOnce({
			success: true,
			conversations: [
				{
					id: "25401953-88",
					participants: [{ id: "88", username: "blankcase", name: "Blank" }],
					messages: [],
				},
			],
			events: [
				{
					id: "dm_blank_external_id",
					conversationId: "25401953-88",
					text: "Blank external id repaired",
					createdAt: "2026-04-25T20:00:00.000Z",
					senderId: "88",
					sender: { id: "88", username: "blankcase", name: "Blank" },
				},
			],
		});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		await expect(
			syncDirectMessagesViaCachedBird({
				account: "acct_primary",
				limit: 5,
				refresh: true,
			}),
		).resolves.toEqual(
			expect.objectContaining({
				source: "bird",
				conversations: 1,
				messages: 1,
			}),
		);
		expect(
			getNativeDb()
				.prepare("select external_user_id from accounts where id = ?")
				.get("acct_primary"),
		).toEqual({ external_user_id: "25401953" });
	});

	it("handles outbound latest messages and skips incomplete bird events", async () => {
		makeTempHome();
		listDirectMessagesViaBirdMock.mockResolvedValueOnce({
			success: true,
			conversations: [
				{
					id: "25401953-99",
					participants: [
						{ id: "25401953", username: "steipete", name: "Peter" },
						{ id: "99", name: "No Handle" },
					],
					messages: [],
					lastMessageAt: "bad-date",
				},
				{
					id: "empty",
					participants: [{ id: "100", username: "empty" }],
					messages: [],
				},
			],
			events: [
				{
					id: "missing_conversation",
					text: "skip no conversation id",
					senderId: "99",
					sender: { id: "99", name: "No Handle" },
				},
				{
					id: "missing_sender",
					conversationId: "25401953-99",
					text: "skip no sender",
					createdAt: "2026-04-25T19:00:00.000Z",
				},
				{
					id: "dm_outbound",
					conversationId: "25401953-99",
					text: "Outbound reply",
					createdAt: "2026-04-25T21:00:00.000Z",
					senderId: "25401953",
					recipientId: "99",
					sender: { id: "25401953", username: "steipete", name: "Peter" },
					recipient: { id: "99", name: "No Handle" },
				},
			],
		});
		const { syncDirectMessagesViaCachedBird } = await import("./dms-live");

		await expect(
			syncDirectMessagesViaCachedBird({
				limit: 2,
				refresh: true,
				cacheTtlMs: -1,
			}),
		).resolves.toEqual(
			expect.objectContaining({
				source: "bird",
				conversations: 2,
				messages: 3,
			}),
		);
		expect(listDmConversations({ search: "Outbound", limit: 10 })).toEqual([
			expect.objectContaining({
				id: "25401953-99",
				needsReply: false,
				participant: expect.objectContaining({
					handle: expect.stringMatching(/^birdclaw_stub_/),
					displayName: "No Handle",
				}),
			}),
		]);
		expect(getConversationThread("25401953-99")?.messages).toEqual([
			expect.objectContaining({
				id: "dm_outbound",
				createdAt: "2026-04-25T21:00:00.000Z",
				direction: "outbound",
			}),
		]);
	});
});
