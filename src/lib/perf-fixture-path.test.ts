import { describe, expect, it } from "vitest";
import { parsePerfFixturePath } from "../../scripts/perf-fixture-path";

describe("performance fixture paths", () => {
	it.each(["", " \t\n"])(
		"rejects an empty override %j before it can select the default archive",
		(argument) => {
			expect(() => parsePerfFixturePath(argument)).toThrow(
				"non-empty fixture path",
			);
		},
	);

	it("generates fixtures only for an omitted path or the explicit dash marker", () => {
		expect(parsePerfFixturePath(undefined)).toBeUndefined();
		expect(parsePerfFixturePath("-")).toBeUndefined();
		for (const value of ["/tmp/synthetic archive", "./fixture"])
			expect(parsePerfFixturePath(value)).toBe(value);
	});
});
