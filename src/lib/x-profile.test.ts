// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import {
	buildExternalProfileId,
	ensureStubProfileForXUser,
	getExternalUserId,
	upsertProfileFromXUser,
} from "./x-profile";

const tempDirs: string[] = [];

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;

	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempHome() {
	const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-x-profile-"));
	tempDirs.push(tempDir);
	process.env.BIRDCLAW_HOME = tempDir;
	return getNativeDb();
}

describe("x profile sync helpers", () => {
	it("creates external profile ids and resolves them back", () => {
		expect(buildExternalProfileId("42")).toBe("profile_user_42");
		expect(getExternalUserId("profile_user_42")).toBe("42");
		expect(getExternalUserId("profile_me")).toBeNull();
	});

	it("upserts new x users and updates existing local handles in place", () => {
		const db = makeTempHome();

		const inserted = upsertProfileFromXUser(db, {
			id: "42",
			username: "sam",
			name: "Sam Altman",
			description: "builder",
			profile_image_url:
				"https://pbs.twimg.com/profile_images/42/demo_normal.jpg",
			public_metrics: {
				followers_count: 321,
			},
		});
		expect(inserted.profile).toEqual(
			expect.objectContaining({
				id: "profile_sam",
				handle: "sam",
				displayName: "Sam Altman",
				followersCount: 321,
			}),
		);
		expect(inserted.profile.avatarUrl).toContain("demo.jpg");

		const updated = upsertProfileFromXUser(db, {
			id: "7",
			username: "amelia",
			name: "Amelia New",
			description: "new bio",
			public_metrics: {
				followers_count: 88,
			},
		});
		expect(updated.profile).toEqual(
			expect.objectContaining({
				id: "profile_amelia",
				handle: "amelia",
				displayName: "Amelia New",
				bio: "new bio",
				followersCount: 88,
			}),
		);
	});

	it("creates stub profiles once and reuses them", () => {
		const db = makeTempHome();

		const first = ensureStubProfileForXUser(db, "999");
		const second = ensureStubProfileForXUser(db, "999");

		expect(first.profile).toEqual(
			expect.objectContaining({
				id: "profile_user_999",
				handle: "user_999",
			}),
		);
		expect(second.profile.id).toBe("profile_user_999");
		expect(
			db
				.prepare("select count(*) as count from profiles where id = ?")
				.get("profile_user_999"),
		).toEqual({ count: 1 });
	});

	it("rejects malformed x user payloads", () => {
		const db = makeTempHome();

		expect(() =>
			upsertProfileFromXUser(db, {
				id: "",
				username: "sam",
				name: "Sam",
			}),
		).toThrow("Resolved user is missing an id");
		expect(() =>
			upsertProfileFromXUser(db, {
				id: "42",
				username: "",
				name: "Sam",
			}),
		).toThrow("Resolved user is missing a username");
	});
});
