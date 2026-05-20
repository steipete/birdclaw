// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getConversationThread, listDmConversations } from "./queries";
import { resetDatabaseForTests } from "./db";

const listDirectMessagesViaBirdMock = vi.fn();

vi.mock("./bird", async () => {
	const { Effect } = await import("effect");
	return {
		listDirectMessagesViaBird: (...args: unknown[]) =>
			listDirectMessagesViaBirdMock(...args),
		listDirectMessagesViaBirdEffect: (...args: unknown[]) =>
			Effect.tryPromise({
				try: () => listDirectMessagesViaBirdMock(...args),
				catch: (error) => error,
			}),
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
					handle: "user_99",
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
