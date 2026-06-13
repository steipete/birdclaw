import { describe, expect, it } from "vitest";
import {
	formatCompactNumber,
	formatExactTimestamp,
	formatShortTimestamp,
	formatSmartTimestamp,
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

	it("uses relative labels for recent timestamps", () => {
		const now = new Date(2026, 5, 13, 16, 0, 0).getTime();

		expect(
			formatSmartTimestamp(new Date(now - 20_000).toISOString(), now),
		).toBe("just now");
		expect(
			formatSmartTimestamp(new Date(now - 70_000).toISOString(), now),
		).toBe("1 min ago");
		expect(
			formatSmartTimestamp(new Date(now - 42 * 60_000).toISOString(), now),
		).toBe("42 min ago");
		expect(
			formatSmartTimestamp(new Date(now - 60 * 60_000).toISOString(), now),
		).toBe("1 hour ago");
		expect(
			formatSmartTimestamp(new Date(now - 3 * 60 * 60_000).toISOString(), now),
		).toBe("3 hours ago");
	});

	it("switches recent history to calendar labels", () => {
		const now = new Date(2026, 5, 13, 16, 0, 0);

		expect(
			formatSmartTimestamp(
				new Date(2026, 5, 12, 15, 0, 0).toISOString(),
				now.getTime(),
			),
		).toBe("Yesterday at 3:00 PM");
		expect(
			formatSmartTimestamp(
				new Date(2026, 5, 10, 15, 0, 0).toISOString(),
				now.getTime(),
			),
		).toBe("Wednesday at 3:00 PM");
		expect(
			formatSmartTimestamp(
				new Date(2026, 4, 10, 15, 0, 0).toISOString(),
				now.getTime(),
			),
		).toBe("May 10 at 3:00 PM");
		expect(
			formatSmartTimestamp(
				new Date(2025, 4, 10, 15, 0, 0).toISOString(),
				now.getTime(),
			),
		).toBe("May 10, 2025 at 3:00 PM");
	});

	it("provides exact timestamps and preserves invalid values", () => {
		const value = new Date(2026, 5, 13, 16, 3, 12).toISOString();

		expect(formatExactTimestamp(value)).toContain("June 13, 2026");
		expect(formatExactTimestamp(value)).toContain("4:03:12 PM");
		expect(formatSmartTimestamp("not-a-date")).toBe("not-a-date");
		expect(formatExactTimestamp("not-a-date")).toBe("not-a-date");
	});
});
