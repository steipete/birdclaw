// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import {
	getBirdclawPaths,
	resetBirdclawPathsForTests,
	writeBirdclawConfig,
} from "./config";
import { closeDatabase, getNativeDb, getReadDb } from "./db";
import { enqueueDatabaseWrite } from "./database-writer";
import { getQueryEnvelope } from "./query-status";
import {
	maybeAutoSyncBackup,
	maybeAutoUpdateBackup,
	requestBackupAutoUpdate,
} from "./backup";
import { readCachedAvatar } from "./avatar-cache";
import NativeSqliteDatabase from "./sqlite";
import { getOrFetchLinkPreview } from "./link-preview-metadata";
import { getNetworkMap } from "./network-map";
import { runSubprocessEffect } from "./subprocess";
import { sensitiveRequestErrorResponse } from "./http-effect";

const homes: string[] = [];
afterEach(() => {
	closeDatabase();
	resetBirdclawPathsForTests();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
});

function freshHome() {
	const home = mkdtempSync(path.join(os.tmpdir(), "birdclaw-read-only-"));
	homes.push(home);
	vi.stubEnv("BIRDCLAW_HOME", home);
	resetBirdclawPathsForTests();
	return home;
}

it("reads an initialized archive without migrations, backup jobs, subprocesses, or cache writes", async () => {
	const home = freshHome();
	const db = getNativeDb({ seedDemoData: true });
	db.prepare("update profiles set avatar_url = ? where id = ?").run(
		"https://pbs.twimg.com/profile_images/123/test.jpg",
		"profile_sam",
	);
	writeBirdclawConfig({
		backup: { repoPath: path.join(home, "backup"), autoSync: true },
	});
	closeDatabase();
	const before = readFileSync(getBirdclawPaths().dbPath);
	const deferredProcess = runSubprocessEffect({
		command: process.execPath,
		args: ["-e", "process.stdout.write('unexpected')"],
	});
	vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "1");
	const fetch = vi.fn(() =>
		Promise.reject(new Error("unexpected network request")),
	);
	vi.stubGlobal("fetch", fetch);
	const status = await getQueryEnvelope();
	expect(status.readOnly).toBe(true);
	expect(status.transport).toEqual({
		installed: false,
		availableTransport: "local",
		statusText: "Read-only cached archive",
	});
	expect(status.archives).toEqual([]);
	expect(status.stats.home).toBeGreaterThan(0);
	expect(() => getNativeDb().exec("delete from tweets")).toThrow(
		/readonly|read-only/i,
	);
	await expect(enqueueDatabaseWrite(() => "unexpected", db)).rejects.toThrow(
		/read-only/,
	);
	expect(() => writeBirdclawConfig({})).toThrow(/read-only/);
	await expect(Effect.runPromise(deferredProcess)).rejects.toThrow(
		/Subprocesses are disabled/,
	);
	expect(await maybeAutoUpdateBackup()).toMatchObject({
		enabled: false,
		skipped: true,
	});
	expect(await maybeAutoSyncBackup()).toMatchObject({
		enabled: false,
		skipped: true,
	});
	const timer = vi.spyOn(globalThis, "setTimeout");
	requestBackupAutoUpdate();
	expect(timer).not.toHaveBeenCalled();
	timer.mockRestore();
	expect(await readCachedAvatar("profile_sam")).toBeNull();
	expect(
		await getOrFetchLinkPreview("https://example.com/unseen", {
			refresh: true,
		}),
	).toMatchObject({ title: null, imageUrl: null });
	expect((await getNetworkMap({ refresh: true })).meta.geocodedThisRun).toBe(0);
	expect(fetch).not.toHaveBeenCalled();
	closeDatabase();
	expect(readFileSync(getBirdclawPaths().dbPath)).toEqual(before);
	expect(existsSync(path.join(home, "backup"))).toBe(false);
});

it("does not initialize or seed a missing read-only database", () => {
	const home = freshHome();
	vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "1");
	expect(() => getReadDb({ seedDemoData: true })).toThrow(/not initialized/);
	expect(existsSync(path.join(home, "birdclaw.sqlite"))).toBe(false);
	expect(existsSync(path.join(home, "media"))).toBe(false);
});

it("requires a cached API path at handler admission even for a rewritten URL", () => {
	vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "1");
	expect(
		sensitiveRequestErrorResponse(new Request("http://localhost/api/query")),
	).toBeNull();
	expect(
		sensitiveRequestErrorResponse(new Request("http://localhost/rewritten"))
			?.status,
	).toBe(403);
	vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "0");
	expect(
		sensitiveRequestErrorResponse(new Request("http://localhost/rewritten")),
	).toBeNull();
});

it("reuses read-only status counts and invalidates after an external commit", async () => {
	freshHome();
	getNativeDb({ seedDemoData: true });
	closeDatabase();
	vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "1");
	const first = await getQueryEnvelope({ includeArchives: false });
	const expected = structuredClone(first);
	await getQueryEnvelope({ includeArchives: false });
	const prepare = vi.spyOn(NativeSqliteDatabase.prototype, "prepare");
	first.stats.home = -1;
	first.accounts[0].name = "mutated caller copy";
	expect(await getQueryEnvelope({ includeArchives: false })).toEqual(expected);
	expect(await getQueryEnvelope({ includeArchives: false })).toEqual(expected);
	expect(prepare.mock.calls.some(([sql]) => sql.includes("count("))).toBe(
		false,
	);
	prepare.mockRestore();
	const writer = new NativeSqliteDatabase(getBirdclawPaths().dbPath);
	try {
		writer.exec("update dm_conversations set needs_reply=0");
	} finally {
		writer.close();
	}
	expect(expected.stats.needsReply).toBeGreaterThan(0);
	expect(
		(await getQueryEnvelope({ includeArchives: false })).stats.needsReply,
	).toBe(0);
	expect(
		(await getQueryEnvelope({ includeArchives: false })).stats.needsReply,
	).toBe(0);
});
