// @vitest-environment node
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { insertTestAccount, useTestHome } from "../test/test-home";
import { runEffectPromise } from "./effect-runtime";
import {
	assertLiveAccountMatches,
	createLiveTransportAdapter,
	fetchWithTransportFallbackEffect,
	resolveLiveSyncAccount,
	runCachedLiveSyncEffect,
} from "./live-sync-engine";
import { writeSyncCache } from "./sync-cache";

const testHome = useTestHome({ prefix: "birdclaw-sync-engine-" });

function setupDatabase() {
	const { db } = testHome();
	db.exec("create table sync_events (value text)");
	return db;
}

describe("live sync engine", () => {
	it("resolves default and selected accounts", () => {
		const db = setupDatabase();
		insertTestAccount(db, {
			id: "main",
			name: "Main",
			handle: "@main",
			externalUserId: null,
			transport: "bird",
			createdAt: "2024-01-01",
		});
		insertTestAccount(db, {
			id: "secondary",
			name: "Secondary",
			handle: "@secondary",
			externalUserId: "222",
			transport: "bird",
			isDefault: 0,
			createdAt: "2024-01-02",
		});

		expect(resolveLiveSyncAccount(db)).toEqual({
			accountId: "main",
			username: "main",
			isDefault: true,
		});
		expect(resolveLiveSyncAccount(db, "secondary")).toEqual({
			accountId: "secondary",
			username: "secondary",
			externalUserId: "222",
			isDefault: false,
		});
		expect(resolveLiveSyncAccount(db, "@SECONDARY")).toEqual({
			accountId: "secondary",
			username: "secondary",
			externalUserId: "222",
			isDefault: false,
		});
	});

	it("normalizes adapter errors and rejects account mismatches", async () => {
		const adapter = createLiveTransportAdapter(
			"bird",
			Effect.fail("transport failed"),
		);
		await expect(runEffectPromise(adapter.fetch)).rejects.toThrow(
			"transport failed",
		);
		expect(() =>
			assertLiveAccountMatches({
				source: "bird",
				account: {
					accountId: "main",
					username: "main",
					externalUserId: "111",
					isDefault: true,
				},
				liveUsername: "other",
				liveExternalUserId: "222",
			}),
		).toThrow("refusing to sync");
	});

	it("falls through transport adapters in order", async () => {
		const result = await runEffectPromise(
			fetchWithTransportFallbackEffect([
				{
					source: "xurl",
					fetch: Effect.fail(new Error("unavailable")),
				},
				{
					source: "bird",
					fetch: Effect.succeed({ value: 2 }),
				},
			]),
		);

		expect(result).toEqual({ source: "bird", payload: { value: 2 } });
	});

	it("returns a fresh cache without fetching", async () => {
		const db = setupDatabase();
		writeSyncCache("timeline:test", { value: 1 }, db);
		const fetch = vi.fn(() => ({ value: 2 }));

		const result = await runEffectPromise(
			runCachedLiveSyncEffect({
				db,
				cacheKey: "timeline:test",
				refresh: false,
				cacheTtlMs: 60_000,
				transports: [{ source: "bird", fetch: Effect.sync(fetch) }],
				persistLive: () => undefined,
			}),
		);

		expect(result).toMatchObject({
			source: "cache",
			payload: { value: 1 },
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it("commits canonical writes and cache updates together", async () => {
		const db = setupDatabase();

		await expect(
			runEffectPromise(
				runCachedLiveSyncEffect({
					db,
					cacheKey: "timeline:test",
					refresh: true,
					cacheTtlMs: 0,
					transports: [
						{ source: "bird", fetch: Effect.succeed({ value: "live" }) },
					],
					persistLive: (writeDb, payload) => {
						writeDb
							.prepare("insert into sync_events (value) values (?)")
							.run(payload.value);
						throw new Error("rollback");
					},
				}),
			),
		).rejects.toThrow("rollback");
		expect(db.prepare("select value from sync_events").all()).toEqual([]);
		expect(
			db
				.prepare(
					"select cache_key from sync_cache where cache_key = 'timeline:test'",
				)
				.get(),
		).toBeUndefined();
	});
});
