import { describe, expect, it } from "vitest";
import { getRouter } from "./router";

describe("router", () => {
	it("builds the app router with scroll restoration", () => {
		const router = getRouter();

		expect(router.options.scrollRestoration).toBe(true);
		expect(router.options.defaultPreload).toBe("intent");
		expect(router.options.defaultPreloadStaleTime).toBe(60_000);
	});
});
