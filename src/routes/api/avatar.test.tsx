// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "#/lib/config";
import { getNativeDb, resetDatabaseForTests } from "#/lib/db";
import { getRouteHandler } from "#/test/route-handlers";
import { Route } from "./avatar";

const tempDirs: string[] = [];
const GET = getRouteHandler(Route, "GET");

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	delete process.env.BIRDCLAW_WEB_PROFILE;

	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("avatar api route", () => {
	const onePixelPng =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

	it("returns 400 when profileId is missing", async () => {
		const response = await GET({
			request: new Request("http://birdclaw.test/api/avatar"),
		});

		expect(response.status).toBe(400);
	});

	it("returns cached avatar bytes for a profile", async () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-avatar-api-"));
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;

		const db = getNativeDb();
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, avatar_url, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			"profile_demo",
			"demo",
			"Demo",
			"",
			0,
			18,
			`data:image/png;base64,${onePixelPng}`,
			"2026-03-08T12:00:00.000Z",
		);

		const response = await GET({
			request: new Request(
				"http://birdclaw.test/api/avatar?profileId=profile_demo",
			),
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(Buffer.from(await response.arrayBuffer())).toEqual(
			Buffer.from(onePixelPng, "base64"),
		);
	});

	it("does not populate avatar cache in public read-only mode", async () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-avatar-api-"));
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;

		const db = getNativeDb();
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, avatar_url, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			"profile_public",
			"public",
			"Public",
			"",
			0,
			18,
			`data:image/png;base64,${onePixelPng}`,
			"2026-03-08T12:00:00.000Z",
		);
		db.prepare(
			`
      insert into tweets (
        id, account_id, author_profile_id, kind, text, created_at,
        is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
        entities_json, media_json, quoted_tweet_id
      ) values (
        'tweet_public', 'acct_primary', 'profile_public', 'home', 'hello', ?,
        0, null, 0, 0, 0, 0, '{}', '[]', null
      )
      `,
		).run("2026-03-08T12:00:00.000Z");
		process.env.BIRDCLAW_WEB_PROFILE = "public-readonly";

		const response = await GET({
			request: new Request(
				"http://birdclaw.test/api/avatar?profileId=profile_public",
			),
		});

		expect(response.status).toBe(404);
		expect(existsSync(path.join(tempDir, "media", "thumbs", "avatars"))).toBe(
			false,
		);
	});

	it("returns 404 when a profile has no avatar", async () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-avatar-api-"));
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;

		getNativeDb()
			.prepare(
				"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, created_at) values (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				"profile_demo",
				"demo",
				"Demo",
				"",
				0,
				18,
				"2026-03-08T12:00:00.000Z",
			);

		const response = await GET({
			request: new Request(
				"http://birdclaw.test/api/avatar?profileId=profile_demo",
			),
		});

		expect(response.status).toBe(404);
	});

	it("returns 404 instead of serving unsupported avatar data", async () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-avatar-api-"));
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;

		getNativeDb()
			.prepare(
				"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, avatar_url, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				"profile_demo",
				"demo",
				"Demo",
				"",
				0,
				18,
				"data:image/svg+xml;utf8," +
					encodeURIComponent(
						'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#111"/></svg>',
					),
				"2026-03-08T12:00:00.000Z",
			);

		const response = await GET({
			request: new Request(
				"http://birdclaw.test/api/avatar?profileId=profile_demo",
			),
		});

		expect(response.status).toBe(404);
	});
});
