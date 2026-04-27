import { describe, expect, it } from "vitest";
import {
	formatCompactNumber,
	formatShortTimestamp,
	getInitials,
} from "./present";

describe("present helpers", () => {
	it("formats compact counts, short timestamps, and initials", () => {
		expect(formatCompactNumber(12_300)).toBe("12K");
		const localNoon = new Date(2026, 2, 8, 12, 0, 0).toISOString();
		expect(formatShortTimestamp(localNoon)).toBe("Mar 8, 12:00 PM");
		expect(getInitials("Sam Altman")).toBe("SA");
		expect(getInitials("A")).toBe("A");
		expect(getInitials(" Sam")).toBe("S");
	});
});
