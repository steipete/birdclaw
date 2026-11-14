// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerModerationCommands } from "../cli-moderation";
import {
	addBlock,
	getBlocksResponse,
	listBlocks,
	recordBlock,
	removeBlock,
	syncBlocks,
} from "../lib/blocks";
import { importBlocklist } from "../lib/blocklist";
import { resetBirdclawPathsForTests, writeBirdclawConfig } from "../lib/config";
import { getNativeDb, resetDatabaseForTests } from "../lib/db";
import { listInboxItems } from "../lib/inbox";
import { addMute, listMutes, recordMute, removeMute } from "../lib/mutes";
import {
	createDmReply,
	createPost,
	createTweetReply,
} from "../lib/query-actions";
import type { InboxResponse } from "../lib/api-contracts";
import {
	configureOperationAccountSelection,
	createCommandContext,
	resetOperationAccountSelection,
} from "./command-context";
import { CliInputError, configureNumericOptions } from "./numeric-options";
import { registerComposeCommands } from "./register-compose";
import { registerInboxCommand } from "./register-inbox";

const mocks = vi.hoisted(() => ({
	moderate: vi.fn(),
	birdMe: vi.fn(),
	me: vi.fn(),
	blocked: vi.fn(),
	post: vi.fn(),
	reply: vi.fn(),
	dm: vi.fn(),
	score: vi.fn(),
}));
vi.mock("../lib/bird", async () => {
	const { effectFromMock } = await import("../test/effect-mocks");
	return {
		getAuthenticatedBirdAccountEffect: effectFromMock(mocks.birdMe),
	};
});
vi.mock("../lib/bird-actions", async () => {
	const { effectFromMock } = await import("../test/effect-mocks");
	return {
		blockUserViaBirdEffect: effectFromMock(mocks.moderate),
		unblockUserViaBirdEffect: effectFromMock(mocks.moderate),
		muteUserViaBirdEffect: effectFromMock(mocks.moderate),
		unmuteUserViaBirdEffect: effectFromMock(mocks.moderate),
		lookupProfileViaBirdEffect: effectFromMock(() => Promise.resolve(null)),
	};
});
vi.mock("../lib/xurl", async () => {
	const { effectFromMock } = await import("../test/effect-mocks");
	return {
		lookupAuthenticatedUserFreshEffect: effectFromMock(mocks.me),
		lookupAuthenticatedUserEffect: effectFromMock(mocks.me),
		listBlockedUsersEffect: effectFromMock(mocks.blocked),
		blockUserViaXurlEffect: effectFromMock(mocks.moderate),
		unblockUserViaXurlEffect: effectFromMock(mocks.moderate),
		muteUserViaXurlEffect: effectFromMock(mocks.moderate),
		unmuteUserViaXurlEffect: effectFromMock(mocks.moderate),
		postViaXurlEffect: effectFromMock(mocks.post),
		replyViaXurlEffect: effectFromMock(mocks.reply),
		dmViaXurlEffect: effectFromMock(mocks.dm),
	};
});
vi.mock("../lib/openai", async () => {
	const { effectFromMock } = await import("../test/effect-mocks");
	return { scoreInboxItemWithOpenAIEffect: effectFromMock(mocks.score) };
});

const selectors = [
	"acct_primary",
	"steipete",
	"@steipete",
	"  @STEIPETE  ",
	" acct_primary ",
];
const commands = [
	["blocks", "add", "@amelia"],
	["blocks", "remove", "@amelia"],
	["blocks", "sync"],
	["blocks", "import", "BLOCKLIST"],
	["blocks", "record", "@amelia"],
	["mutes", "add", "@amelia"],
	["mutes", "remove", "@amelia"],
	["mutes", "record", "@amelia"],
	["ban", "@amelia"],
	["unban", "@amelia"],
	["mute", "@amelia"],
	["unmute", "@amelia"],
	["compose", "post", "scope post"],
	["compose", "reply", "tweet_004", "scope reply"],
];

describe("account selection at CLI and local action boundaries", () => {
	let home: string;
	beforeEach(() => {
		home = mkdtempSync(path.join(os.tmpdir(), "birdclaw-account-scope-"));
		vi.stubEnv("BIRDCLAW_HOME", home);
		vi.stubEnv("BIRDCLAW_CONFIG", path.join(home, "config.json"));
		vi.stubEnv("BIRDCLAW_TEST_SEED_DEMO_DATA", "1");
		vi.stubEnv("BIRDCLAW_DISABLE_LIVE_WRITES", "0");
		vi.stubEnv("BIRDCLAW_DISABLE_LIVE_PROFILE_LOOKUP", "1");
		vi.stubEnv("BIRDCLAW_E2E_FAKE_LIVE_WRITES", "0");
		resetBirdclawPathsForTests();
		resetDatabaseForTests();
		const db = getNativeDb();
		db.exec(
			"update accounts set is_default = (id = 'acct_studio'); delete from blocks; delete from mutes; delete from ai_scores; update dm_conversations set needs_reply = 1",
		);
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, following_count, avatar_hue, created_at) values (?, ?, ?, '', 0, 0, 0, ?)",
		).run("profile_studio", "birdclaw_lab", "Studio", "2026-01-01");
		db.exec(
			"pragma foreign_keys = off; update profiles set id = 'profile_user_7' where id = 'profile_amelia'; update tweets set author_profile_id = 'profile_user_7' where author_profile_id = 'profile_amelia'; update dm_conversations set participant_profile_id = 'profile_user_7' where participant_profile_id = 'profile_amelia'; update dm_messages set sender_profile_id = 'profile_user_7' where sender_profile_id = 'profile_amelia'; pragma foreign_keys = on;",
		);
		db.prepare(
			"insert into tweet_account_edges (account_id, tweet_id, kind, first_seen_at, last_seen_at, seen_count, source, raw_json, updated_at) values (?, ?, 'mention', ?, ?, 1, 'test', '{}', ?)",
		).run("acct_studio", "tweet_006", "2026-01-01", "2026-01-01", "2026-01-01");
		for (const mock of Object.values(mocks)) mock.mockReset();
		mocks.moderate.mockResolvedValue({ ok: true, output: "mocked moderation" });
		mocks.birdMe.mockResolvedValue({ id: "25401953", username: "steipete" });
		mocks.me.mockResolvedValue({ id: "25401953", username: "steipete" });
		mocks.blocked.mockResolvedValue({
			items: [{ id: "7", username: "amelia", name: "Amelia" }],
			nextToken: null,
		});
		mocks.post.mockResolvedValue({ ok: true, output: "mocked post" });
		mocks.reply.mockResolvedValue({ ok: true, output: "mocked reply" });
		mocks.dm.mockResolvedValue({ ok: true, output: "mocked dm" });
		mocks.score.mockResolvedValue({
			model: "test",
			score: 75,
			summary: "test",
			reasoning: "test",
		});
	});
	afterEach(() => {
		resetOperationAccountSelection();
		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});
	function cli() {
		const program = new Command()
			.exitOverride()
			.configureOutput({ writeErr: () => {} });
		configureNumericOptions(program);
		configureOperationAccountSelection(program);
		const print = vi.fn();
		const update = vi.fn();
		const backup = vi.fn();
		const context = {
			...createCommandContext(program),
			print,
			autoUpdateBeforeRead: update,
			autoSyncAfterWrite: backup,
		};
		registerInboxCommand(context);
		registerComposeCommands(context);
		registerModerationCommands({
			...context,
			importBlocklist,
			resolveActionOptions: () => ({ transport: "xurl" }),
		});
		return { program, print, update, backup };
	}
	function seedModeration() {
		const db = getNativeDb();
		for (const table of ["blocks", "mutes"]) {
			db.prepare(
				"insert into " +
					table +
					" (account_id, profile_id, source, created_at) values (?, ?, 'manual', ?)",
			).run("acct_primary", "profile_user_7", "2026-01-01");
			db.prepare(
				"insert into " +
					table +
					" (account_id, profile_id, source, created_at) values (?, ?, 'manual', ?)",
			).run("acct_studio", "profile_ava", "2026-01-01");
		}
	}

	it.each(["mixed", "mentions", "dms"] as const)(
		"scopes both inbox scoring and listing for %s",
		async (kind) => {
			writeBirdclawConfig({ accounts: { default: "@steipete" } });
			const expected = listInboxItems({ kind, account: "acct_primary" }).items;
			expect(expected.length).toBeGreaterThan(0);
			const { program, print } = cli();
			await program.parseAsync(["inbox", "--kind", kind, "--score"], {
				from: "user",
			});
			const result = print.mock.calls[0][0] as InboxResponse;
			expect(result.items.map((item) => item.entityId).sort()).toEqual(
				expected.map((item) => item.entityId).sort(),
			);
			expect(
				result.items.every((item) => item.accountId === "acct_primary"),
			).toBe(true);
			expect(mocks.score.mock.calls.map((call) => call[0].text).sort()).toEqual(
				expected.map((item) => item.text).sort(),
			);
		},
	);
	it.each(["mixed", "mentions", "dms"] as const)(
		"honors explicit inbox account over config for %s",
		async (kind) => {
			writeBirdclawConfig({ accounts: { default: "acct_primary" } });
			const { program, print } = cli();
			await program.parseAsync(
				["inbox", "--kind", kind, "--score", "--account", " @BIRDCLAW_LAB "],
				{ from: "user" },
			);
			const result = print.mock.calls[0][0] as InboxResponse;
			expect(result.items.length).toBeGreaterThan(0);
			expect(
				result.items.every((item) => item.accountId === "acct_studio"),
			).toBe(true);
			expect(mocks.score).toHaveBeenCalledTimes(result.items.length);
			expect(mocks.score.mock.calls.map((call) => call[0].text).sort()).toEqual(
				result.items.map((item) => item.text).sort(),
			);
		},
	);
	it("preserves an unscoped inbox when no selector is configured", async () => {
		const { program, print } = cli();
		await program.parseAsync(["inbox"], { from: "user" });
		const result = print.mock.calls[0][0] as InboxResponse;
		expect(
			[...new Set(result.items.map((item) => item.accountId))].sort(),
		).toEqual(["acct_primary", "acct_studio"]);
	});
	it.each(["bogus", "", "MIXED"])(
		"rejects invalid inbox kind %j before reads or scoring",
		async (kind) => {
			const { program, print, update, backup } = cli();
			await expect(
				program.parseAsync(["inbox", "--kind", kind, "--score"], {
					from: "user",
				}),
			).rejects.toBeInstanceOf(CliInputError);
			expect(update).not.toHaveBeenCalled();
			expect(backup).not.toHaveBeenCalled();
			expect(mocks.score).not.toHaveBeenCalled();
			expect(print).not.toHaveBeenCalled();
		},
	);

	it.each(
		commands.flatMap((args) => [
			{
				args,
				configured: undefined,
				explicit: undefined,
				expected: args[1] === "sync" ? "acct_primary" : "acct_primary",
			},
			{
				args,
				configured: "@birdclaw_lab",
				explicit: undefined,
				expected: "acct_studio",
			},
			{
				args,
				configured: "@steipete",
				explicit: " @BIRDCLAW_LAB ",
				expected: "acct_studio",
			},
		]),
	)(
		"targets $expected for $args (config=$configured explicit=$explicit)",
		async ({ args, configured, explicit, expected }) => {
			writeBirdclawConfig({ accounts: { default: configured } });
			seedModeration();
			const principal =
				expected === "acct_primary"
					? { id: "25401953", username: "steipete" }
					: { id: "studio-id", username: "birdclaw_lab" };
			mocks.me.mockResolvedValue(principal);
			mocks.birdMe.mockResolvedValue(principal);
			const file = path.join(home, "blocks.txt");
			writeFileSync(file, "@amelia");
			const { program, print } = cli();
			await program.parseAsync(
				[
					...args.map((arg) => (arg === "BLOCKLIST" ? file : arg)),
					...(explicit ? ["--account", explicit] : []),
				],
				{ from: "user" },
			);
			const result = print.mock.calls[0][0];
			expect(result.ok).toBe(true);
			const accountId =
				args[0] === "compose"
					? (
							getNativeDb()
								.prepare(
									"select account_id from tweet_account_edges where tweet_id = ?",
								)
								.get(result.tweetId ?? result.replyId) as { account_id: string }
						).account_id
					: result.accountId;
			expect(accountId).toBe(expected);
			for (const call of mocks.moderate.mock.calls) {
				expect([principal.id, "7"]).toContain(call[0]);
				expect([principal.id, "7", undefined]).toContain(call[1]);
			}
		},
	);

	it.each(selectors)(
		"normalizes programmatic moderation writes for %j",
		async (account) => {
			for (const [add, record, remove] of [
				[addBlock, recordBlock, removeBlock],
				[addMute, recordMute, removeMute],
			] as const) {
				expect(
					await add(account, "@amelia", { transport: "xurl" }),
				).toMatchObject({
					ok: true,
					accountId: "acct_primary",
				});
				expect(await record(account, "@amelia")).toMatchObject({
					ok: true,
					accountId: "acct_primary",
				});
				expect(
					await remove(account, "@amelia", { transport: "xurl" }),
				).toMatchObject({
					ok: true,
					accountId: "acct_primary",
				});
			}
			expect(mocks.moderate).toHaveBeenCalledTimes(4);
			expect(
				mocks.moderate.mock.calls.every(
					(call) => call[0] === "25401953" && call[1] === "7",
				),
			).toBe(true);
		},
	);
	it.each(selectors)(
		"normalizes moderation listings and candidate flags for %j",
		(account) => {
			seedModeration();
			expect(listBlocks({ account }).map((item) => item.accountId)).toEqual([
				"acct_primary",
			]);
			expect(listMutes({ account }).map((item) => item.accountId)).toEqual([
				"acct_primary",
			]);
			const result = getBlocksResponse({
				accountId: account,
				search: "amelia",
			});
			expect(result.items).toHaveLength(1);
			expect(result.matches).toEqual([
				expect.objectContaining({ isBlocked: true }),
			]);
		},
	);
	it.each(selectors)(
		"normalizes block synchronization for %j",
		async (account) => {
			expect(await syncBlocks(account)).toMatchObject({
				ok: true,
				accountId: "acct_primary",
				synced: true,
				syncedCount: 1,
			});
			expect(listBlocks({ account: "acct_primary" })).toHaveLength(1);
			expect(listBlocks({ account: "acct_studio" })).toHaveLength(0);
		},
	);
	it.each(
		selectors.flatMap((account) =>
			["post", "reply", "dm"].map((kind) => ({ account, kind })),
		),
	)(
		"normalizes $kind account $account before remote and local writes",
		async ({ account, kind }) => {
			const db = getNativeDb();
			let author: unknown;
			let accounts: unknown;
			if (kind === "dm") {
				const result = await createDmReply("dm_003", "selected dm", account);
				author = db
					.prepare(
						"select sender_profile_id as id from dm_messages where id = ?",
					)
					.get(result.messageId);
				accounts = db
					.prepare(
						"select account_id from dm_conversations where id = 'dm_003'",
					)
					.all();
			} else {
				const result =
					kind === "post"
						? await createPost(account, "selected post")
						: await createTweetReply(account, "tweet_004", "selected reply");
				const id = "tweetId" in result ? result.tweetId : result.replyId;
				author = db
					.prepare("select author_profile_id as id from tweets where id = ?")
					.get(id);
				accounts = db
					.prepare(
						"select account_id from tweet_account_edges where tweet_id = ? union all select account_id from tweet_actions where body like 'selected %'",
					)
					.all(id);
			}
			expect(author).toEqual({ id: "profile_me" });
			expect(accounts).toEqual(
				Array.from({ length: kind === "dm" ? 1 : 2 }, () => ({
					account_id: "acct_primary",
				})),
			);
			expect(mocks.me).toHaveBeenCalledOnce();
		},
	);
	it("keeps an unselected DM reply on its conversation account", async () => {
		const { program, print } = cli();
		await program.parseAsync(["compose", "dm", "dm_003", "owner reply"], {
			from: "user",
		});
		expect(print.mock.calls[0][0].ok).toBe(true);
		expect(mocks.dm).toHaveBeenCalledOnce();
		expect(
			getNativeDb()
				.prepare("select sender_profile_id from dm_messages where text = ?")
				.get("owner reply"),
		).toEqual({ sender_profile_id: "profile_me" });
	});
	it("rejects unknown write selectors before any transport", async () => {
		await expect(addBlock("@missing", "@amelia")).rejects.toThrow(
			"Unknown account",
		);
		await expect(addMute("@missing", "@amelia")).rejects.toThrow(
			"Unknown account",
		);
		await expect(syncBlocks("@missing")).rejects.toThrow("Unknown account");
		await expect(createPost("@missing", "not sent")).rejects.toThrow(
			/Unknown account|No local author profile/,
		);
		await expect(
			createTweetReply("@missing", "tweet_004", "not sent"),
		).rejects.toThrow(/Unknown account|No local author profile/);
		await expect(
			createDmReply("dm_003", "not sent", "@missing"),
		).rejects.toThrow("Conversation belongs to acct_primary");
		for (const mock of [
			mocks.moderate,
			mocks.me,
			mocks.blocked,
			mocks.post,
			mocks.reply,
			mocks.dm,
		])
			expect(mock).not.toHaveBeenCalled();
	});
	it("keeps all-account listings and unknown filters from broadening", () => {
		seedModeration();
		expect(listBlocks()).toHaveLength(2);
		expect(listMutes({ account: "all" })).toHaveLength(2);
		expect(listBlocks({ account: "unknown" })).toEqual([]);
		expect(listMutes({ account: "unknown" })).toEqual([]);
	});
	it("preserves self-moderation and different-account DM guards with selectors", async () => {
		await expect(addBlock("@steipete", "@steipete")).rejects.toThrow(
			"Cannot block the current account",
		);
		await expect(addMute("@steipete", "@steipete")).rejects.toThrow(
			"Cannot mute the current account",
		);
		await expect(
			createDmReply("dm_003", "wrong account", "@birdclaw_lab"),
		).rejects.toThrow("Conversation belongs to acct_primary");
		expect(mocks.moderate).not.toHaveBeenCalled();
		expect(mocks.dm).not.toHaveBeenCalled();
	});
	it("does not weaken remote identity checks for normalized selectors", async () => {
		mocks.me.mockResolvedValue({ id: "wrong", username: "other" });
		mocks.birdMe.mockResolvedValue({ id: "wrong", username: "other" });
		await expect(createPost("@steipete", "not sent")).rejects.toThrow(
			"not @steipete",
		);
		await expect(
			createTweetReply("@steipete", "tweet_004", "not sent"),
		).rejects.toThrow("not @steipete");
		await expect(
			createDmReply("dm_003", "not sent", "@steipete"),
		).rejects.toThrow("not @steipete");
		expect(
			await addBlock("@birdclaw_lab", "@amelia", { transport: "xurl" }),
		).toMatchObject({
			ok: false,
			accountId: "acct_studio",
			transport: {
				ok: false,
				transport: "xurl",
				output: expect.stringContaining("not @birdclaw_lab"),
			},
		});
		await expect(
			addMute("@birdclaw_lab", "@amelia", { transport: "bird" }),
		).rejects.toThrow("refusing to sync into acct_studio (@birdclaw_lab)");
		expect(await syncBlocks("@steipete")).toMatchObject({
			ok: false,
			synced: false,
		});
		expect(mocks.moderate).not.toHaveBeenCalled();
		expect(mocks.post).not.toHaveBeenCalled();
		expect(mocks.reply).not.toHaveBeenCalled();
		expect(mocks.dm).not.toHaveBeenCalled();
		expect(mocks.blocked).not.toHaveBeenCalled();
		expect(
			getNativeDb()
				.prepare("select id from tweets where text = 'not sent'")
				.all(),
		).toEqual([]);
		expect(
			getNativeDb()
				.prepare("select * from blocks where account_id = 'acct_studio'")
				.all(),
		).toEqual([]);
		expect(
			getNativeDb()
				.prepare("select * from mutes where account_id = 'acct_studio'")
				.all(),
		).toEqual([]);
	});
});
