import { afterEach, describe, expect, it, vi } from "vitest";
import { startThemeTransition } from "./theme-transition";

describe("startThemeTransition", () => {
	const root = document.documentElement;
	const documentWithTransition = document as unknown as {
		startViewTransition?:
			| ((callback: () => void) => { finished?: Promise<void> })
			| undefined;
	};
	const originalMatchMedia = window.matchMedia;
	const originalStartViewTransition =
		documentWithTransition.startViewTransition;

	afterEach(() => {
		root.classList.remove("theme-transition");
		root.style.removeProperty("--theme-switch-x");
		root.style.removeProperty("--theme-switch-y");
		window.matchMedia = originalMatchMedia;
		documentWithTransition.startViewTransition = originalStartViewTransition;
		vi.restoreAllMocks();
	});

	it("returns early when the theme is already active", () => {
		const setTheme = vi.fn();

		startThemeTransition({
			nextTheme: "dark",
			currentTheme: "dark",
			setTheme,
		});

		expect(setTheme).not.toHaveBeenCalled();
	});

	it("falls back cleanly when view transitions are unavailable", () => {
		const setTheme = vi.fn();
		root.classList.add("theme-transition");
		root.style.setProperty("--theme-switch-x", "25%");
		root.style.setProperty("--theme-switch-y", "75%");
		documentWithTransition.startViewTransition = undefined;

		startThemeTransition({
			nextTheme: "dark",
			currentTheme: "light",
			setTheme,
		});

		expect(setTheme).toHaveBeenCalledWith("dark");
		expect(root.classList.contains("theme-transition")).toBe(false);
		expect(root.style.getPropertyValue("--theme-switch-x")).toBe("");
		expect(root.style.getPropertyValue("--theme-switch-y")).toBe("");
	});

	it("uses clamped pointer coordinates for animated transitions", async () => {
		const setTheme = vi.fn();
		window.matchMedia = vi.fn().mockReturnValue({ matches: false });
		documentWithTransition.startViewTransition = vi.fn(
			(callback: () => void) => {
				callback();
				return {
					finished: Promise.resolve(),
				};
			},
		);
		Object.defineProperty(window, "innerWidth", {
			configurable: true,
			value: 1000,
		});
		Object.defineProperty(window, "innerHeight", {
			configurable: true,
			value: 800,
		});

		startThemeTransition({
			nextTheme: "dark",
			currentTheme: "light",
			setTheme,
			context: {
				pointerClientX: -20,
				pointerClientY: 9999,
			},
		});

		expect(setTheme).toHaveBeenCalledWith("dark");
		expect(root.style.getPropertyValue("--theme-switch-x")).toBe("0%");
		expect(root.style.getPropertyValue("--theme-switch-y")).toBe("100%");
		await Promise.resolve();
		await Promise.resolve();
		expect(root.classList.contains("theme-transition")).toBe(false);
	});

	it("uses the trigger element center when pointer coordinates are missing", async () => {
		const setTheme = vi.fn();
		window.matchMedia = vi.fn().mockReturnValue({ matches: false });
		documentWithTransition.startViewTransition = vi.fn(
			(callback: () => void) => {
				callback();
				return {
					finished: Promise.resolve(),
				};
			},
		);
		Object.defineProperty(window, "innerWidth", {
			configurable: true,
			value: 1000,
		});
		Object.defineProperty(window, "innerHeight", {
			configurable: true,
			value: 800,
		});

		const element = document.createElement("button");
		vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
			x: 0,
			y: 0,
			left: 100,
			top: 200,
			right: 300,
			bottom: 260,
			width: 200,
			height: 60,
			toJSON: () => ({}),
		});

		startThemeTransition({
			nextTheme: "dark",
			currentTheme: "light",
			setTheme,
			context: { element },
		});

		expect(root.style.getPropertyValue("--theme-switch-x")).toBe("20%");
		expect(root.style.getPropertyValue("--theme-switch-y")).toBe(
			"28.749999999999996%",
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(root.style.getPropertyValue("--theme-switch-x")).toBe("");
		expect(root.style.getPropertyValue("--theme-switch-y")).toBe("");
	});

	it("marks the trigger while an animated transition is active", async () => {
		const setTheme = vi.fn();
		let finishTransition!: () => void;
		window.matchMedia = vi.fn().mockReturnValue({ matches: false });
		documentWithTransition.startViewTransition = vi.fn(
			(callback: () => void) => {
				callback();
				return {
					finished: new Promise<void>((resolve) => {
						finishTransition = resolve;
					}),
				};
			},
		);

		const element = document.createElement("button");
		document.body.append(element);

		startThemeTransition({
			nextTheme: "dark",
			currentTheme: "light",
			setTheme,
			context: { element },
		});

		expect(setTheme).toHaveBeenCalledWith("dark");
		expect(root.classList.contains("theme-transition")).toBe(true);
		expect(element).toHaveAttribute("data-theme-transition-target");

		finishTransition();
		await Promise.resolve();
		await Promise.resolve();

		expect(root.classList.contains("theme-transition")).toBe(false);
		expect(element).not.toHaveAttribute("data-theme-transition-target");
		element.remove();
	});

	it("falls back when the transition handle is incomplete or throws", () => {
		const setTheme = vi.fn();
		window.matchMedia = vi.fn().mockReturnValue({ matches: false });
		documentWithTransition.startViewTransition = vi
			.fn()
			.mockReturnValueOnce({})
			.mockImplementationOnce(() => {
				throw new Error("boom");
			});

		startThemeTransition({
			nextTheme: "dark",
			currentTheme: "light",
			setTheme,
		});
		expect(setTheme).not.toHaveBeenCalled();

		startThemeTransition({
			nextTheme: "light",
			currentTheme: "dark",
			setTheme,
		});

		expect(setTheme).toHaveBeenCalledTimes(1);
		expect(setTheme).toHaveBeenNthCalledWith(1, "light");
		expect(root.classList.contains("theme-transition")).toBe(false);
	});

	it("skips animated transitions when reduced motion is enabled", () => {
		const setTheme = vi.fn();
		window.matchMedia = vi.fn().mockReturnValue({ matches: true });
		documentWithTransition.startViewTransition = vi.fn();

		startThemeTransition({
			nextTheme: "dark",
			currentTheme: "light",
			setTheme,
		});

		expect(setTheme).toHaveBeenCalledWith("dark");
		expect(documentWithTransition.startViewTransition).not.toHaveBeenCalled();
	});
});
