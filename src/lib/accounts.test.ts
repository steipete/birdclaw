// @vitest-environment node
import { describe, expect, it } from "vitest";
import { insertTestAccount, useTestHome } from "../test/test-home";
import { clearAccountBirdProfile, setAccountBirdProfile } from "./accounts";

const testHome = useTestHome({ prefix: "birdclaw-accounts-" });

describe("account settings", () => {
	it("sets and clears the bird relay profile name for an account", async () => {
		const { db } = testHome();
		insertTestAccount(db, { id: "acct_primary" });

		await expect(
			setAccountBirdProfile("acct_primary", "  work  "),
		).resolves.toEqual({
			ok: true,
			accountId: "acct_primary",
			birdProfileName: "work",
		});
		expect(
			db
				.prepare("select bird_profile_name from accounts where id = ?")
				.get("acct_primary"),
		).toEqual({ bird_profile_name: "work" });

		await expect(clearAccountBirdProfile("acct_primary")).resolves.toEqual({
			ok: true,
			accountId: "acct_primary",
			birdProfileName: null,
		});
		expect(
			db
				.prepare("select bird_profile_name from accounts where id = ?")
				.get("acct_primary"),
		).toEqual({ bird_profile_name: null });
	});

	it("rejects empty profile names and unknown accounts", async () => {
		const { db } = testHome();
		insertTestAccount(db, { id: "acct_primary" });

		await expect(setAccountBirdProfile("acct_primary", " ")).rejects.toThrow(
			"bird profile name must not be empty",
		);
		await expect(setAccountBirdProfile("missing", "work")).rejects.toThrow(
			"Unknown account: missing",
		);
		await expect(clearAccountBirdProfile("missing")).rejects.toThrow(
			"Unknown account: missing",
		);
	});
});
