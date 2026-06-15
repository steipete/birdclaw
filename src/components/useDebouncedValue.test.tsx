import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDebouncedValue } from "./useDebouncedValue";

describe("useDebouncedValue", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("retains the previous value until the delay passes", () => {
		vi.useFakeTimers();
		const { result, rerender } = renderHook(
			({ value }) => useDebouncedValue(value, 180),
			{ initialProps: { value: "" } },
		);

		rerender({ value: "bird" });
		expect(result.current).toBe("");

		act(() => vi.advanceTimersByTime(179));
		expect(result.current).toBe("");

		act(() => vi.advanceTimersByTime(1));
		expect(result.current).toBe("bird");
	});
});
