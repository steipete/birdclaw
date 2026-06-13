import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SmartTimestamp } from "./SmartTimestamp";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("SmartTimestamp", () => {
	it("renders semantic exact metadata and updates relative time", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 5, 13, 16, 0, 0));
		const value = new Date(2026, 5, 13, 15, 59, 40).toISOString();

		render(<SmartTimestamp value={value} />);

		const timestamp = screen.getByText("just now");
		expect(timestamp.tagName).toBe("TIME");
		expect(timestamp).toHaveAttribute("datetime", value);
		expect(timestamp).toHaveAttribute(
			"title",
			expect.stringContaining("June 13, 2026"),
		);

		act(() => vi.advanceTimersByTime(60_000));
		expect(screen.getByText("1 min ago")).toBeInTheDocument();
	});
});
