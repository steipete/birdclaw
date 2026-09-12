// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCliMain } from "../cli";
import { resetBirdclawPathsForTests } from "../lib/config";
import { getNativeDb, resetDatabaseForTests } from "../lib/db";
import { seedDemoData } from "../lib/seed";

let home: string;
const log = vi.spyOn(console, "log").mockImplementation(() => {});
const error = vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
	process.exitCode = 0;
	home = mkdtempSync(path.join(os.tmpdir(), "birdclaw-local-cli-"));
	vi.stubEnv("BIRDCLAW_HOME", home);
	vi.stubEnv("BIRDCLAW_CONFIG", path.join(home, "config.json"));
	vi.stubEnv("BIRDCLAW_BACKUP_AUTO_SYNC", "0");
	vi.stubEnv("BIRDCLAW_DISABLE_LIVE_WRITES", "1");
	vi.stubEnv("BIRDCLAW_DISABLE_LIVE_PROFILE_LOOKUP", "1");
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	seedDemoData(getNativeDb({ seedDemoData: false }));
	log.mockClear();
	error.mockClear();
});

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	vi.unstubAllEnvs();
	process.exitCode = 0;
	rmSync(home, { recursive: true, force: true });
});

async function run(...args: string[]) {
	await runCliMain(["node", "birdclaw", ...args, "--json"]);
	return log.mock.calls.length
		? JSON.parse(String(log.mock.lastCall?.[0]))
		: undefined;
}

describe("local CLI commands", () => {
	it("reads a tweet and a bounded thread from the archive", async () => {
		const tweet = await run("show", "tweet", "tweet_001");
		expect(tweet).toMatchObject({
			id: "tweet_001",
			text: expect.stringContaining("local-first"),
		});
		const thread = await run("show", "thread", "tweet_001", "--limit", "1");
		expect(thread).toMatchObject({ anchorId: "tweet_001", truncated: true });
		expect(thread.items).toHaveLength(1);
		expect(error).not.toHaveBeenCalled();
	});

	it("returns the complete cached DM history in order", async () => {
		const result = await run("show", "dm", "dm_001");
		expect(result.conversation.id).toBe("dm_001");
		expect(result.messages.map((item: { id: string }) => item.id)).toEqual([
			"msg_002",
			"msg_001",
		]);
		expect(error).not.toHaveBeenCalled();
	});

	it.each([
		["tweet", "tweet_001"],
		["thread", "tweet_001"],
		["dm", "dm_001"],
	])("does not reveal another account's %s", async (kind, id) => {
		await run("show", kind, id, "--account", "@birdclaw_lab");
		expect(process.exitCode).toBe(1);
		expect(log).not.toHaveBeenCalled();
		expect(JSON.parse(String(error.mock.lastCall?.[0]))).toEqual({
			error: expect.stringContaining("not found in selected account"),
		});
	});

	it("honors the configured account default and an explicit override", async () => {
		writeFileSync(
			path.join(home, "config.json"),
			JSON.stringify({ accounts: { default: "@birdclaw_lab" } }),
		);
		await run("show", "tweet", "tweet_001");
		expect(process.exitCode).toBe(1);
		expect(log).not.toHaveBeenCalled();
		process.exitCode = 0;
		const tweet = await run(
			"show",
			"tweet",
			"tweet_001",
			"--account",
			"@steipete",
		);
		expect(tweet.id).toBe("tweet_001");
		expect(process.exitCode).toBe(0);
	});

	it("reports missing records as JSON failures", async () => {
		await run("show", "tweet", "missing");
		expect(process.exitCode).toBe(1);
		expect(log).not.toHaveBeenCalled();
		expect(JSON.parse(String(error.mock.lastCall?.[0]))).toEqual({
			error: "Tweet not found in selected account: missing",
		});
	});

	it("vacuums the store while preserving its contents", async () => {
		const result = await run("db", "vacuum");
		expect(result).toEqual({ ok: true, operation: "vacuum" });
		const db = getNativeDb({ seedDemoData: false });
		expect(db.prepare("select count(*) as count from tweets").get()).toEqual({
			count: 6,
		});
		expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
	});

	it("keeps read-only deployments readable and rejects vacuum", async () => {
		resetDatabaseForTests();
		vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "1");
		const tweet = await run("show", "tweet", "tweet_001");
		expect(tweet.id).toBe("tweet_001");
		expect(process.exitCode).toBe(0);
		log.mockClear();
		await run("db", "vacuum");
		expect(process.exitCode).toBe(1);
		expect(log).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledTimes(1);
	});
});
