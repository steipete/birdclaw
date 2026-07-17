// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import {
	findOperationAccount,
	resolveOperationAccount,
} from "./account-selection";

describe("operation account selection", () => {
	let homeDir = "";

	beforeEach(() => {
		homeDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-account-"));
		process.env.BIRDCLAW_HOME = homeDir;
		resetBirdclawPathsForTests();
		resetDatabaseForTests();
		const db = getNativeDb({ seedDemoData: false });
		db.prepare(
			`insert into accounts
			 (id, name, handle, external_user_id, transport, is_default, created_at)
			 values (?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"acct_first",
			"First",
			"@first_user",
			"100",
			"archive",
			0,
			"2026-01-01T00:00:00.000Z",
		);
		db.prepare(
			`insert into accounts
			 (id, name, handle, external_user_id, transport, is_default, created_at)
			 values (?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"acct_default",
			"Default",
			"@Default_User",
			"200",
			"xurl",
			1,
			"2026-01-02T00:00:00.000Z",
		);
	});

	afterEach(() => {
		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		delete process.env.BIRDCLAW_HOME;
		rmSync(homeDir, { recursive: true, force: true });
	});

	it("accepts ids, usernames, and @usernames without changing storage", () => {
		const db = getNativeDb({ seedDemoData: false });
		expect(findOperationAccount(db, "acct_first")).toEqual({
			id: "acct_first",
			username: "first_user",
			externalUserId: "100",
		});
		expect(findOperationAccount(db, "default_user")).toEqual({
			id: "acct_default",
			username: "Default_User",
			externalUserId: "200",
		});
		expect(findOperationAccount(db, "@DEFAULT_USER")).toEqual({
			id: "acct_default",
			username: "Default_User",
			externalUserId: "200",
		});
		expect(
			db.prepare("select id, is_default from accounts order by id asc").all(),
		).toEqual([
			{ id: "acct_default", is_default: 1 },
			{ id: "acct_first", is_default: 0 },
		]);
	});

	it("uses the database default only when no selector is supplied", () => {
		const db = getNativeDb({ seedDemoData: false });
		expect(findOperationAccount(db)).toMatchObject({ id: "acct_default" });
		expect(findOperationAccount(db, "@")).toBeUndefined();
		expect(findOperationAccount(db, "   ")).toBeUndefined();
		expect(() => resolveOperationAccount("@")).toThrow("Unknown account: @");
		expect(() => resolveOperationAccount("missing")).toThrow(
			"Unknown account: missing",
		);
	});
});
