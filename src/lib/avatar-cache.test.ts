// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	__test__,
	getAvatarCachePath,
	normalizeAvatarUrl,
	readCachedAvatar,
	readCachedAvatarEffect,
} from "./avatar-cache";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";

const tempDirs: string[] = [];

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	vi.unstubAllGlobals();

	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("avatar cache", () => {
	it("normalizes twitter avatar sizes", () => {
		expect(
			normalizeAvatarUrl(
				"https://pbs.twimg.com/profile_images/12345/avatar_normal.jpg",
			),
		).toBe("https://pbs.twimg.com/profile_images/12345/avatar.jpg");
		expect(normalizeAvatarUrl("   ")).toBeNull();
		expect(normalizeAvatarUrl("not-a-url")).toBe("not-a-url");
	});

	it("caches data-url avatars locally", async () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-avatar-"));
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;

		const db = getNativeDb();
		const avatarUrl =
			"data:image/svg+xml;utf8," +
			encodeURIComponent(
				'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#111"/><text x="8" y="11" fill="white" text-anchor="middle">PS</text></svg>',
			);

		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, avatar_url, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			"profile_demo",
			"demo",
			"Demo",
			"",
			0,
			18,
			avatarUrl,
			"2026-03-08T12:00:00.000Z",
		);

		const avatar = await readCachedAvatar("profile_demo");
		expect(avatar?.contentType).toBe("image/svg+xml");
		expect(avatar?.cachePath).toBe(
			getAvatarCachePath("profile_demo", avatarUrl),
		);
		expect(readFileSync(avatar?.cachePath ?? "", "utf8")).toContain("<svg");
	});

	it("maps cached extension types", () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-avatar-"));
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;

		expect(__test__.getContentTypeFromExtension(".png")).toBe("image/png");
		expect(__test__.getContentTypeFromExtension(".webp")).toBe("image/webp");
		expect(__test__.getContentTypeFromExtension(".gif")).toBe("image/gif");
		expect(__test__.getContentTypeFromExtension(".svg")).toBe("image/svg+xml");
		expect(__test__.getContentTypeFromExtension(".jpg")).toBe("image/jpeg");
		expect(
			__test__.getExtensionFromAvatarUrl("https://pbs.twimg.com/a.gif"),
		).toBe(".gif");
		expect(
			__test__.getExtensionFromAvatarUrl("https://pbs.twimg.com/a.webp"),
		).toBe(".webp");
		expect(
			__test__.getExtensionFromAvatarUrl("https://pbs.twimg.com/a.svg"),
		).toBe(".svg");
		expect(
			__test__.getExtensionFromAvatarUrl("https://pbs.twimg.com/a.jpeg"),
		).toBe(".jpg");
		expect(__test__.getExtensionFromAvatarUrl("broken")).toBe(".jpg");
		expect(__test__.sanitizeFileToken("profile:user/1")).toBe("profile_user_1");
		expect(
			getAvatarCachePath("profile_png", "data:image/png;base64,aGk="),
		).toMatch(/\.png$/);
		expect(
			getAvatarCachePath("profile_webp", "data:image/webp;base64,aGk="),
		).toMatch(/\.webp$/);
		expect(
			getAvatarCachePath("profile_gif", "data:image/gif;base64,aGk="),
		).toMatch(/\.gif$/);
		expect(
			getAvatarCachePath("profile_unknown", "data:image/bmp;base64,aGk="),
		).toMatch(/\.jpg$/);
		expect(__test__.decodeDataUrl("data:;base64,aGk=")).toMatchObject({
			contentType: "application/octet-stream",
			buffer: Buffer.from("hi"),
		});
		expect(__test__.decodeDataUrl("data:text/plain,hello")).toMatchObject({
			contentType: "text/plain",
			buffer: Buffer.from("hello"),
		});
	});

	it("fetches remote avatars once and then serves the cached file", async () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-avatar-"));
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;

		const db = getNativeDb();
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, avatar_url, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			"profile_remote",
			"remote",
			"Remote",
			"",
			0,
			18,
			"https://pbs.twimg.com/profile_images/remote/avatar.png",
			"2026-03-08T12:00:00.000Z",
		);

		const fetchMock = vi.fn(async () => {
			const bytes = new Uint8Array([137, 80, 78, 71]);
			return new Response(bytes, {
				status: 200,
				headers: { "content-type": "image/png" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const first = await readCachedAvatar("profile_remote");
		const second = await readCachedAvatar("profile_remote");

		expect(first?.contentType).toBe("image/png");
		expect(first?.cachePath && existsSync(first.cachePath)).toBe(true);
		expect(second?.contentType).toBe("image/png");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("covers null and invalid avatar paths", async () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-avatar-"));
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;

		const db = getNativeDb();
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, created_at) values (?, ?, ?, ?, ?, ?, ?)",
		).run(
			"profile_none",
			"none",
			"None",
			"",
			0,
			18,
			"2026-03-08T12:00:00.000Z",
		);
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, avatar_url, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			"profile_bad",
			"bad",
			"Bad",
			"",
			0,
			18,
			"data:image/png",
			"2026-03-08T12:00:00.000Z",
		);

		await expect(readCachedAvatar("missing")).resolves.toBeNull();
		await expect(readCachedAvatar("profile_none")).resolves.toBeNull();
		await expect(readCachedAvatar("profile_bad")).rejects.toThrow(
			"Invalid avatar data URL",
		);
		expect(() => getAvatarCachePath("profile_bad", "")).toThrow(
			"Missing avatar URL",
		);
	});

	it("returns null for blank stored avatar urls", async () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-avatar-"));
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;

		const db = getNativeDb();
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, avatar_url, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			"profile_blank",
			"blank",
			"Blank",
			"",
			0,
			18,
			"   ",
			"2026-03-08T12:00:00.000Z",
		);

		await expect(readCachedAvatar("profile_blank")).resolves.toBeNull();
	});

	it("exposes cached avatar reads as Effects", async () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-avatar-"));
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;

		const effect = readCachedAvatarEffect("missing");

		await expect(Effect.runPromise(effect)).resolves.toBeNull();
	});

	it("throws when remote avatar fetch fails", async () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-avatar-"));
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;

		const db = getNativeDb();
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, avatar_url, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			"profile_fail",
			"fail",
			"Fail",
			"",
			0,
			18,
			"https://pbs.twimg.com/profile_images/fail/avatar.png",
			"2026-03-08T12:00:00.000Z",
		);

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("nope", { status: 404 })),
		);

		await expect(readCachedAvatar("profile_fail")).rejects.toThrow(
			"Avatar fetch failed with 404",
		);
	});

	it("uses jpeg as the default remote avatar content type", async () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-avatar-"));
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;

		const db = getNativeDb();
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, avatar_url, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			"profile_jpeg",
			"jpeg",
			"Jpeg",
			"",
			0,
			18,
			"https://pbs.twimg.com/profile_images/jpeg/avatar",
			"2026-03-08T12:00:00.000Z",
		);

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
		);

		const avatar = await readCachedAvatar("profile_jpeg");

		expect(avatar?.contentType).toBe("image/jpeg");
		expect(avatar?.cachePath).toMatch(/\.jpg$/);
	});
});
