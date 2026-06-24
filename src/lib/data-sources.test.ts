// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";

const mocks = vi.hoisted(() => ({
	getAuthenticatedBirdAccount: vi.fn(),
	getTransportStatus: vi.fn(),
	lookupAuthenticatedOAuth2User: vi.fn(),
	readXurlOAuth2Accounts: vi.fn(),
}));

vi.mock("./bird", () => ({
	getAuthenticatedBirdAccountEffect: (profileName: string) =>
		Effect.tryPromise({
			try: () => mocks.getAuthenticatedBirdAccount(profileName),
			catch: (error) => error,
		}),
}));

vi.mock("./xurl", () => ({
	getTransportStatusEffect: () =>
		Effect.tryPromise({
			try: () => mocks.getTransportStatus(),
			catch: (error) => error,
		}),
	lookupAuthenticatedOAuth2UserEffect: () =>
		Effect.tryPromise({
			try: () => mocks.lookupAuthenticatedOAuth2User(),
			catch: (error) => error,
		}),
	readXurlOAuth2AccountsEffect: () =>
		Effect.tryPromise({
			try: () => mocks.readXurlOAuth2Accounts(),
			catch: (error) => error,
		}),
}));

const tempRoots: string[] = [];

function setupTempHome() {
	const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-data-src-"));
	tempRoots.push(tempRoot);
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
	mocks.getTransportStatus.mockResolvedValue({
		availableTransport: "none",
		installed: false,
		statusText: "xurl unavailable",
	});
	mocks.lookupAuthenticatedOAuth2User.mockResolvedValue(null);
	mocks.readXurlOAuth2Accounts.mockResolvedValue([]);
	return getNativeDb();
}

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	for (const mock of Object.values(mocks)) {
		mock.mockReset();
	}
	for (const tempRoot of tempRoots.splice(0)) {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

describe("live data sources", () => {
	it("checks bird with the selected account profile", async () => {
		const db = setupTempHome();
		db.prepare("update accounts set bird_profile_name = null where id = ?").run(
			"acct_primary",
		);
		db.prepare("update accounts set bird_profile_name = ? where id = ?").run(
			"profile-studio",
			"acct_studio",
		);
		mocks.getAuthenticatedBirdAccount.mockResolvedValue({
			username: "birdclaw_lab",
		});
		const { getLiveDataSourcesEffect } = await import("./data-sources");

		const result = await Effect.runPromise(
			getLiveDataSourcesEffect({ accountId: "acct_studio" }),
		);
		const bird = result.sources.find((source) => source.source === "bird");

		expect(mocks.getAuthenticatedBirdAccount).toHaveBeenCalledWith(
			"profile-studio",
		);
		expect(bird).toMatchObject({
			works: true,
			status: "ok",
			detail: "authenticated as @birdclaw_lab",
			accounts: [{ username: "birdclaw_lab", handle: "@birdclaw_lab" }],
		});
	});
});
