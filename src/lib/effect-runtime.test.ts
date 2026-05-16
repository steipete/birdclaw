import { describe, expect, it } from "vitest";
import { runEffectPromise, tryPromise } from "./effect-runtime";

describe("effect runtime boundary", () => {
	it("throws original promise errors instead of UnknownException wrappers", async () => {
		const original = Object.assign(new Error("socket reset"), {
			code: "ECONNRESET",
		});

		let rejected: unknown;
		try {
			await runEffectPromise(tryPromise(() => Promise.reject(original)));
		} catch (error) {
			rejected = error;
		}

		expect(rejected).toBe(original);
		expect(String(rejected)).not.toContain("UnknownException");
	});
});
