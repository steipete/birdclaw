import { flushSync } from "react-dom";
import type { ThemeValue } from "./theme";

export interface ThemeTransitionContext {
	element?: HTMLElement | null;
	pointerClientX?: number;
	pointerClientY?: number;
}

const clamp01 = (value: number) => {
	if (Number.isNaN(value)) return 0.5;
	if (value <= 0) return 0;
	if (value >= 1) return 1;
	return value;
};

const hasReducedMotionPreference = () => {
	if (
		typeof window === "undefined" ||
		typeof window.matchMedia !== "function"
	) {
		return false;
	}

	return window.matchMedia("(prefers-reduced-motion: reduce)").matches ?? false;
};

const cleanupThemeTransition = (root: HTMLElement) => {
	root.classList.remove("theme-transition");
	root.style.removeProperty("--theme-switch-x");
	root.style.removeProperty("--theme-switch-y");
	root
		.querySelectorAll("[data-theme-transition-target]")
		.forEach((element) =>
			element.removeAttribute("data-theme-transition-target"),
		);
};

export function startThemeTransition({
	nextTheme,
	currentTheme,
	setTheme,
	context,
}: {
	nextTheme: ThemeValue;
	currentTheme: ThemeValue | null;
	setTheme: (theme: ThemeValue) => void;
	context?: ThemeTransitionContext;
}) {
	if (currentTheme === nextTheme) {
		return;
	}

	if (typeof document === "undefined") {
		setTheme(nextTheme);
		return;
	}

	const root = document.documentElement;
	const startViewTransition =
		typeof document.startViewTransition === "function"
			? document.startViewTransition.bind(document)
			: undefined;
	const canUseViewTransition =
		Boolean(startViewTransition) && !hasReducedMotionPreference();

	const applyTheme = () => {
		flushSync(() => {
			setTheme(nextTheme);
		});
	};

	if (!canUseViewTransition) {
		applyTheme();
		cleanupThemeTransition(root);
		return;
	}

	let xPercent = 0.5;
	let yPercent = 0.5;

	if (
		context?.pointerClientX !== undefined &&
		context.pointerClientY !== undefined &&
		typeof window !== "undefined"
	) {
		xPercent = clamp01(context.pointerClientX / window.innerWidth);
		yPercent = clamp01(context.pointerClientY / window.innerHeight);
	} else if (context?.element && typeof window !== "undefined") {
		const rect = context.element.getBoundingClientRect();
		if (rect.width > 0 && rect.height > 0) {
			xPercent = clamp01((rect.left + rect.width / 2) / window.innerWidth);
			yPercent = clamp01((rect.top + rect.height / 2) / window.innerHeight);
		}
	}

	root.style.setProperty("--theme-switch-x", `${xPercent * 100}%`);
	root.style.setProperty("--theme-switch-y", `${yPercent * 100}%`);
	root.classList.add("theme-transition");
	context?.element?.setAttribute("data-theme-transition-target", "");

	try {
		const transition = startViewTransition?.(() => {
			applyTheme();
		});

		if (!transition?.finished) {
			cleanupThemeTransition(root);
			return;
		}

		void transition.finished
			.catch(() => undefined)
			.finally(() => cleanupThemeTransition(root));
	} catch {
		cleanupThemeTransition(root);
		applyTheme();
	}
}
