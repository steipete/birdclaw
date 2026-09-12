import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SmartTimestamp } from "./SmartTimestamp";
import * as present from "#/lib/present";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("SmartTimestamp", () => {
	it("pauses all clock work while hidden and catches up immediately on return", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 5, 13, 16, 0, 0));
		const visibility = vi
			.spyOn(document, "visibilityState", "get")
			.mockReturnValue("visible");
		const format = vi.spyOn(present, "formatSmartTimestamp");
		const value = new Date(2026, 5, 13, 15, 59, 40).toISOString();
		const { unmount } = render(
			<>
				{Array.from({ length: 500 }, (_, index) => (
					<SmartTimestamp key={index} value={value} />
				))}
			</>,
		);
		expect(vi.getTimerCount()).toBe(1);
		visibility.mockReturnValue("hidden");
		fireEvent(document, new Event("visibilitychange"));
		const timersWhileHidden = vi.getTimerCount();
		format.mockClear();
		for (let i = 0; i < 20; i++) act(() => vi.advanceTimersByTime(30_000));
		expect({
			timers: timersWhileHidden,
			formatted: format.mock.calls.length,
		}).toEqual({ timers: 0, formatted: 0 });
		visibility.mockReturnValue("visible");
		fireEvent(document, new Event("visibilitychange"));
		expect(screen.getAllByText("10 min ago")).toHaveLength(500);
		expect(vi.getTimerCount()).toBe(1);
		unmount();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("formats exact metadata only when the timestamp value changes", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 5, 13, 16, 0, 0));
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		const exact = vi.spyOn(present, "formatExactTimestamp");
		const { rerender } = render(
			<SmartTimestamp value="2026-06-13T15:00:00Z" />,
		);
		act(() => vi.advanceTimersByTime(60_000));
		expect(exact).toHaveBeenCalledTimes(1);
		rerender(<SmartTimestamp value="2026-06-13T14:00:00Z" />);
		expect(exact).toHaveBeenCalledTimes(2);
	});

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
