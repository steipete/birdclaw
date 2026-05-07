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
				following_count: 123,
			},
		});
		expect(inserted.profile).toEqual(
			expect.objectContaining({
				id: "profile_sam",
				handle: "sam",
				displayName: "Sam Altman",
				followersCount: 321,
				followingCount: 123,
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
				following_count: 44,
			},
		});
		expect(updated.profile).toEqual(
			expect.objectContaining({
				id: "profile_amelia",
				handle: "amelia",
				displayName: "Amelia New",
				bio: "new bio",
				followersCount: 88,
				followingCount: 44,
			}),
		);
	});

	it("preserves an existing avatar when a later payload omits one", () => {
		const db = makeTempHome();

		const first = upsertProfileFromXUser(db, {
			id: "42",
			username: "sam",
			name: "Sam Altman",
			profile_image_url:
				"https://pbs.twimg.com/profile_images/42/demo_normal.jpg",
		});
		const second = upsertProfileFromXUser(db, {
			id: "42",
			username: "sam",
			name: "Sam Updated",
		});

		expect(first.profile.avatarUrl).toContain("demo.jpg");
		expect(second.profile).toEqual(
			expect.objectContaining({
				id: "profile_sam",
				displayName: "Sam Updated",
				avatarUrl: first.profile.avatarUrl,
			}),
		);
	});

	it("preserves existing following count when later x user payload omits metrics", () => {
		const db = makeTempHome();

		upsertProfileFromXUser(db, {
			id: "42",
			username: "sam",
			name: "Sam Altman",
			public_metrics: {
				followers_count: 321,
				following_count: 123,
			},
		});
		const updated = upsertProfileFromXUser(db, {
			id: "42",
			username: "sam",
			name: "Sam Updated",
			public_metrics: {
				followers_count: 999,
			},
		});

		expect(updated.profile).toEqual(
			expect.objectContaining({
				followersCount: 999,
				followingCount: 123,
			}),
		);
		expect(
			db
				.prepare(
					"select followers_count, following_count from profiles where id = ?",
				)
				.get("profile_sam"),
		).toEqual({ followers_count: 999, following_count: 123 });
	});

	it("records profile snapshots and bio entities during upserts", () => {
		const db = makeTempHome();

		upsertProfileFromXUser(db, {
			id: "4242",
			username: "blacksmith_guy",
			name: "Blacksmith Guy",
			description: "Co-founder at @useblacksmith",
			url: "https://blacksmith.sh",
			public_metrics: {
				followers_count: 10,
				following_count: 5,
			},
		});
		upsertProfileFromXUser(db, {
			id: "4242",
			username: "blacksmith_guy",
			name: "Blacksmith Guy",
			description: "Now at @newco",
			url: "https://newco.dev",
			public_metrics: {
				followers_count: 20,
				following_count: 5,
			},
		});

		expect(
			db
				.prepare(
					"select bio from profile_snapshots where profile_id = ? order by observed_at asc",
				)
				.all("profile_user_4242"),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ bio: "Co-founder at @useblacksmith" }),
				expect.objectContaining({ bio: "Now at @newco" }),
			]),
		);
		expect(
			db
				.prepare(
					"select kind, value, is_active from profile_bio_entities where profile_id = ? order by value",
				)
				.all("profile_user_4242"),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "handle",
					value: "@newco",
					is_active: 1,
				}),
				expect.objectContaining({
					kind: "handle",
					value: "@useblacksmith",
					is_active: 0,
				}),
			]),
		);
	});

	it("falls back to username when x user payload omits a display name", () => {
		const db = makeTempHome();

		const profile = upsertProfileFromXUser(db, {
			id: "1234",
			username: "nameless",
			name: "",
		});

		expect(profile.profile).toEqual(
			expect.objectContaining({
				id: "profile_user_1234",
				handle: "nameless",
				displayName: "nameless",
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
