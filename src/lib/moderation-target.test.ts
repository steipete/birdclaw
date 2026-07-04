// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";

const mocks = vi.hoisted(() => ({
	lookupProfileViaBird: vi.fn(),
	lookupAuthenticatedUser: vi.fn(),
	lookupUsersByHandles: vi.fn(),
	lookupUsersByIds: vi.fn(),
}));

vi.mock("./bird-actions", () => {
	const fromMock =
		(mock: (...args: unknown[]) => PromiseLike<unknown>) =>
		(...args: unknown[]) =>
			Effect.tryPromise({
				try: () => mock(...args),
				catch: (error) => error,
			});
	return {
		lookupProfileViaBirdEffect: fromMock(mocks.lookupProfileViaBird),
	};
});

vi.mock("./xurl", () => {
	const fromMock =
		(mock: (...args: unknown[]) => PromiseLike<unknown>) =>
		(...args: unknown[]) =>
			Effect.tryPromise({
				try: () => mock(...args),
				catch: (error) => error,
			});
	return {
		lookupAuthenticatedUserEffect: fromMock(mocks.lookupAuthenticatedUser),
		lookupUsersByHandlesEffect: fromMock(mocks.lookupUsersByHandles),
		lookupUsersByIdsEffect: fromMock(mocks.lookupUsersByIds),
	};
});

const tempDirs: string[] = [];

function makeTempHome() {
	const tempRoot = mkdtempSync(
		path.join(os.tmpdir(), "birdclaw-moderation-target-"),
	);
	tempDirs.push(tempRoot);
	process.env.BIRDCLAW_HOME = tempRoot;
	return getNativeDb();
}

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	delete process.env.BIRDCLAW_DISABLE_LIVE_PROFILE_LOOKUP;

	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("moderation target helpers", () => {
	beforeEach(() => {
		mocks.lookupProfileViaBird.mockReset();
		mocks.lookupAuthenticatedUser.mockReset();
		mocks.lookupUsersByHandles.mockReset();
		mocks.lookupUsersByIds.mockReset();
	});

	it("normalizes handles and x urls", async () => {
		const { normalizeProfileQuery } = await import("./moderation-target");

		expect(normalizeProfileQuery(" @steipete ")).toBe("steipete");
		expect(normalizeProfileQuery("https://x.com/steipete")).toBe("steipete");
		expect(normalizeProfileQuery("")).toBe("");
	});

	it("resolves default accounts and local profiles", async () => {
		const db = makeTempHome();
		db.prepare(
			`
      insert into profiles (
        id, handle, display_name, bio, followers_count, avatar_hue, avatar_url, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
		).run(
			"profile_user_77",
			"external77",
			"External 77",
			"",
			0,
			11,
			null,
			"2026-03-09T00:00:00.000Z",
		);
		const { getAccountHandle, getDefaultAccountId, resolveLocalProfile } =
			await import("./moderation-target");

		expect(getDefaultAccountId(db)).toBe("acct_primary");
		expect(getAccountHandle(db, "acct_primary")).toBe("steipete");
		expect(resolveLocalProfile(db, "external77")).toEqual({
			profile: expect.objectContaining({
				id: "profile_user_77",
				handle: "external77",
			}),
			externalUserId: "77",
		});
		expect(resolveLocalProfile(db, "missing")).toBeNull();
	});

	it("resolves remote profiles and falls back to local matches on lookup failure", async () => {
		const db = makeTempHome();
		db.prepare(
			`
      insert into profiles (
        id, handle, display_name, bio, followers_count, avatar_hue, avatar_url, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
		).run(
			"profile_group_1",
			"groupdm",
			"Group DM",
			"",
			0,
			1,
			null,
			"2026-03-09T00:00:00.000Z",
		);
		mocks.lookupProfileViaBird
			.mockResolvedValueOnce({
				id: "88",
				username: "amelia",
				name: "Amelia",
			})
			.mockRejectedValueOnce(new Error("bird down"));
		mocks.lookupUsersByHandles.mockRejectedValueOnce(new Error("network down"));
		const { resolveProfile } = await import("./moderation-target");

		await expect(resolveProfile("@amelia")).resolves.toMatchObject({
			profile: expect.objectContaining({
				handle: "amelia",
				displayName: "Amelia",
			}),
			externalUserId: "88",
		});
		await expect(resolveProfile("groupdm")).resolves.toMatchObject({
			profile: expect.objectContaining({
				id: "profile_group_1",
				handle: "groupdm",
			}),
			externalUserId: null,
		});
	});

	it("keeps local profile matches local when live profile lookup is disabled", async () => {
		makeTempHome();
		process.env.BIRDCLAW_DISABLE_LIVE_PROFILE_LOOKUP = "1";
		const { resolveProfile } = await import("./moderation-target");

		await expect(resolveProfile("profile_amelia")).resolves.toMatchObject({
			profile: expect.objectContaining({
				id: "profile_amelia",
				handle: "amelia",
			}),
			externalUserId: null,
		});
		expect(mocks.lookupProfileViaBird).not.toHaveBeenCalled();
		expect(mocks.lookupUsersByHandles).not.toHaveBeenCalled();
	});

	it("does not live lookup missing profiles when live profile lookup is disabled", async () => {
		makeTempHome();
		process.env.BIRDCLAW_DISABLE_LIVE_PROFILE_LOOKUP = "1";
		const { resolveProfile } = await import("./moderation-target");

		await expect(resolveProfile("missing")).rejects.toThrow(
			"Profile not found locally: missing",
		);
		expect(mocks.lookupProfileViaBird).not.toHaveBeenCalled();
		expect(mocks.lookupUsersByHandles).not.toHaveBeenCalled();
		expect(mocks.lookupUsersByIds).not.toHaveBeenCalled();
	});

	it("falls back to xurl lookups when bird profile lookup misses", async () => {
		makeTempHome();
		mocks.lookupProfileViaBird.mockResolvedValueOnce(null);
		mocks.lookupUsersByIds.mockResolvedValueOnce([
			{
				id: "88",
				username: "amelia",
				name: "Amelia",
			},
		]);
		const { resolveProfile } = await import("./moderation-target");

		await expect(resolveProfile("88")).resolves.toMatchObject({
			profile: expect.objectContaining({
				handle: "amelia",
				displayName: "Amelia",
			}),
			externalUserId: "88",
		});
		expect(mocks.lookupUsersByIds).toHaveBeenCalledWith(["88"]);
	});

	it("exposes moderation target resolution as lazy Effect programs", async () => {
		makeTempHome();
		mocks.lookupProfileViaBird.mockResolvedValueOnce(null);
		mocks.lookupUsersByHandles.mockResolvedValueOnce([
			{
				id: "88",
				username: "amelia",
				name: "Amelia",
			},
		]);
		const { resolveProfileEffect } = await import("./moderation-target");
		const { resolveModerationTargetEffect } =
			await import("./moderation-state");

		const profileEffect = resolveProfileEffect("@amelia");
		expect(mocks.lookupUsersByHandles).not.toHaveBeenCalled();
		await expect(Effect.runPromise(profileEffect)).resolves.toMatchObject({
			profile: expect.objectContaining({ handle: "amelia" }),
			externalUserId: "88",
		});

		const targetEffect = resolveModerationTargetEffect({
			accountId: "acct_primary",
			query: "@amelia",
			selfActionError: "Cannot block the current account",
		});
		await expect(Effect.runPromise(targetEffect)).resolves.toMatchObject({
			resolvedAccountId: "acct_primary",
			actionQuery: "amelia",
		});
	});

	it("returns authenticated ids safely", async () => {
		makeTempHome();
		mocks.lookupAuthenticatedUser
			.mockResolvedValueOnce({ id: "1" })
			.mockResolvedValueOnce({ id: "" })
			.mockRejectedValueOnce(new Error("auth down"));
		const { getAuthenticatedUserId } = await import("./moderation-target");

		await expect(getAuthenticatedUserId()).resolves.toBe("1");
		await expect(getAuthenticatedUserId()).resolves.toBeNull();
		await expect(getAuthenticatedUserId()).resolves.toBeNull();
	});

	it("exposes authenticated user id lookup as a safe Effect program", async () => {
		makeTempHome();
		mocks.lookupAuthenticatedUser.mockResolvedValueOnce({ id: "1" });
		const { getAuthenticatedUserIdEffect } =
			await import("./moderation-target");

		const effect = getAuthenticatedUserIdEffect();
		expect(mocks.lookupAuthenticatedUser).not.toHaveBeenCalled();
		await expect(Effect.runPromise(effect)).resolves.toBe("1");
	});
});
