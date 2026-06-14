import {
	type CSSProperties,
	type FocusEvent,
	type KeyboardEvent,
	type PointerEvent,
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

type PreviewSide = "top" | "bottom";

type Rect = {
	top: number;
	right: number;
	bottom: number;
	left: number;
	width: number;
	height: number;
};

type PreviewPosition = {
	top: number;
	left: number;
	maxWidth: number;
	maxHeight: number;
	side: PreviewSide;
	measured: boolean;
	ready: boolean;
};

type PlacementInput = {
	referenceRects: Rect[];
	floatingWidth: number;
	floatingHeight: number;
	viewport: Rect;
	gap?: number;
	gutter?: number;
};

const DEFAULT_GAP = 10;
const DEFAULT_GUTTER = 12;
const DEFAULT_CLOSE_DELAY_MS = 120;

const initialPosition: PreviewPosition = {
	top: 0,
	left: 0,
	maxWidth: 0,
	maxHeight: 0,
	side: "bottom",
	measured: false,
	ready: false,
};

function edgeRect(rects: Rect[], side: PreviewSide) {
	return rects.reduce((best, rect) => {
		if (side === "bottom") {
			if (rect.bottom > best.bottom) return rect;
			if (rect.bottom === best.bottom && rect.width > best.width) return rect;
			return best;
		}
		if (rect.top < best.top) return rect;
		if (rect.top === best.top && rect.width > best.width) return rect;
		return best;
	});
}

function clamp(value: number, minimum: number, maximum: number) {
	if (maximum < minimum) return minimum;
	return Math.min(Math.max(value, minimum), maximum);
}

function calculatePreviewPosition({
	referenceRects,
	floatingWidth,
	floatingHeight,
	viewport,
	gap = DEFAULT_GAP,
	gutter = DEFAULT_GUTTER,
}: PlacementInput): PreviewPosition {
	const referenceTop = Math.min(...referenceRects.map((rect) => rect.top));
	const referenceBottom = Math.max(
		...referenceRects.map((rect) => rect.bottom),
	);
	const availableBelow = Math.max(
		0,
		viewport.bottom - gutter - referenceBottom - gap,
	);
	const availableAbove = Math.max(
		0,
		referenceTop - viewport.top - gutter - gap,
	);
	const side: PreviewSide =
		availableBelow >= floatingHeight || availableBelow >= availableAbove
			? "bottom"
			: "top";
	const availableHeight = side === "bottom" ? availableBelow : availableAbove;
	const renderedHeight = Math.min(floatingHeight, availableHeight);
	const anchor = edgeRect(referenceRects, side);
	const maxWidth = Math.max(0, viewport.width - gutter * 2);
	const renderedWidth = Math.min(floatingWidth, maxWidth);
	const minimumLeft = viewport.left + gutter;
	const maximumLeft = viewport.right - gutter - renderedWidth;
	const left = clamp(
		anchor.left + anchor.width / 2 - renderedWidth / 2,
		minimumLeft,
		maximumLeft,
	);
	const top =
		side === "bottom"
			? referenceBottom + gap
			: referenceTop - gap - renderedHeight;

	return {
		top,
		left,
		maxWidth,
		maxHeight: availableHeight,
		side,
		measured: true,
		ready: true,
	};
}

function viewportRect(): Rect {
	const viewport = window.visualViewport;
	const left = viewport?.offsetLeft ?? 0;
	const top = viewport?.offsetTop ?? 0;
	const width = viewport?.width ?? window.innerWidth;
	const height = viewport?.height ?? window.innerHeight;
	return {
		top,
		right: left + width,
		bottom: top + height,
		left,
		width,
		height,
	};
}

function elementRects(element: HTMLElement): Rect[] {
	const fragments = Array.from(element.getClientRects()).filter(
		(rect) => rect.width > 0 || rect.height > 0,
	);
	return fragments.length > 0 ? fragments : [element.getBoundingClientRect()];
}

function referenceIntersectsViewport(rects: Rect[], viewport: Rect) {
	return rects.some(
		(rect) =>
			rect.right >= viewport.left &&
			rect.left <= viewport.right &&
			rect.bottom >= viewport.top &&
			rect.top <= viewport.bottom,
	);
}

function samePosition(left: PreviewPosition, right: PreviewPosition) {
	return (
		left.top === right.top &&
		left.left === right.left &&
		left.maxWidth === right.maxWidth &&
		left.maxHeight === right.maxHeight &&
		left.side === right.side &&
		left.measured === right.measured &&
		left.ready === right.ready
	);
}

function floatingStyle(position: PreviewPosition): CSSProperties {
	return {
		position: "fixed",
		top: position.top,
		left: position.left,
		// Apply constraints during the hidden first pass so remeasurement can settle.
		maxWidth: position.measured ? position.maxWidth : undefined,
		maxHeight: position.measured ? position.maxHeight : undefined,
		visibility: position.ready ? "visible" : "hidden",
	};
}

function containsTarget(
	target: EventTarget | null,
	...elements: Array<HTMLElement | null>
) {
	return (
		target instanceof Node &&
		elements.some((element) => element?.contains(target))
	);
}

export function useFloatingPreview(options: { closeDelayMs?: number } = {}): {
	open: boolean;
	referenceRef: RefObject<HTMLSpanElement | null>;
	floatingRef: RefObject<HTMLSpanElement | null>;
	floatingStyle: CSSProperties;
	referenceProps: {
		onPointerEnter: (event: PointerEvent<HTMLElement>) => void;
		onPointerLeave: (event: PointerEvent<HTMLElement>) => void;
		onFocus: (event: FocusEvent<HTMLElement>) => void;
		onBlur: (event: FocusEvent<HTMLElement>) => void;
		onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
	};
	floatingProps: {
		onPointerEnter: (event: PointerEvent<HTMLElement>) => void;
		onPointerLeave: (event: PointerEvent<HTMLElement>) => void;
		onFocus: (event: FocusEvent<HTMLElement>) => void;
		onBlur: (event: FocusEvent<HTMLElement>) => void;
		onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
	};
	floatingId: string;
	closePreview: () => void;
} {
	const closeDelayMs = options.closeDelayMs ?? DEFAULT_CLOSE_DELAY_MS;
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState(initialPosition);
	const floatingId = useId();
	const referenceRef = useRef<HTMLSpanElement | null>(null);
	const floatingRef = useRef<HTMLSpanElement | null>(null);
	const closeTimerRef = useRef<number | null>(null);

	const clearCloseTimer = useCallback(() => {
		if (closeTimerRef.current === null) return;
		window.clearTimeout(closeTimerRef.current);
		closeTimerRef.current = null;
	}, []);

	const openPreview = useCallback(() => {
		clearCloseTimer();
		if (!open) setPosition(initialPosition);
		setOpen(true);
	}, [clearCloseTimer, open]);

	const closePreview = useCallback(() => {
		clearCloseTimer();
		setOpen(false);
	}, [clearCloseTimer]);

	const scheduleClose = useCallback(() => {
		clearCloseTimer();
		closeTimerRef.current = window.setTimeout(() => {
			closeTimerRef.current = null;
			const reference = referenceRef.current;
			const floating = floatingRef.current;
			const focusInside = containsTarget(
				document.activeElement,
				reference,
				floating,
			);
			const pointerInside =
				Boolean(reference?.matches(":hover")) ||
				Boolean(floating?.matches(":hover"));
			if (!focusInside && !pointerInside) setOpen(false);
		}, closeDelayMs);
	}, [clearCloseTimer, closeDelayMs]);

	const handleBlur = useCallback(
		(event: FocusEvent<HTMLElement>) => {
			if (
				containsTarget(
					event.relatedTarget,
					referenceRef.current,
					floatingRef.current,
				)
			) {
				return;
			}
			scheduleClose();
		},
		[scheduleClose],
	);

	const handleKeyDown = useCallback(
		(event: KeyboardEvent<HTMLElement>) => {
			if (event.key !== "Escape") return;
			closePreview();
			referenceRef.current?.querySelector<HTMLElement>("a,button")?.focus();
		},
		[closePreview],
	);

	const updatePlacement = useCallback(() => {
		const reference = referenceRef.current;
		const floating = floatingRef.current;
		if (!reference || !floating) return;
		const viewport = viewportRect();
		const referenceRects = elementRects(reference);
		if (!referenceIntersectsViewport(referenceRects, viewport)) {
			setPosition((current) =>
				current.ready ? { ...current, ready: false } : current,
			);
			return;
		}
		const floatingRect = floating.getBoundingClientRect();
		const content = floating.querySelector<HTMLElement>(
			"[data-floating-preview-content]",
		);
		const style = window.getComputedStyle(floating);
		const verticalChrome = [
			style.paddingTop,
			style.paddingBottom,
			style.borderTopWidth,
			style.borderBottomWidth,
		].reduce((total, value) => total + (Number.parseFloat(value) || 0), 0);
		// Measure the unclipped child so a previously constrained card can grow again.
		const naturalHeight = Math.max(
			floatingRect.height,
			(content?.getBoundingClientRect().height ?? 0) + verticalChrome,
		);
		const next = calculatePreviewPosition({
			referenceRects,
			floatingWidth: floatingRect.width,
			floatingHeight: naturalHeight,
			viewport,
		});
		if (floatingRect.width > next.maxWidth + 0.5) next.ready = false;
		setPosition((current) => (samePosition(current, next) ? current : next));
	}, []);

	useLayoutEffect(() => {
		if (!open) return;
		updatePlacement();
		let frame = 0;
		const trackLayout = () => {
			updatePlacement();
			frame = window.requestAnimationFrame(trackLayout);
		};
		// Fixed positioning needs explicit tracking when surrounding content shifts.
		frame = window.requestAnimationFrame(trackLayout);
		const viewport = window.visualViewport;
		window.addEventListener("resize", updatePlacement);
		window.addEventListener("scroll", updatePlacement, true);
		viewport?.addEventListener("resize", updatePlacement);
		viewport?.addEventListener("scroll", updatePlacement);
		const observer =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(updatePlacement);
		if (referenceRef.current) observer?.observe(referenceRef.current);
		if (floatingRef.current) observer?.observe(floatingRef.current);

		return () => {
			window.cancelAnimationFrame(frame);
			window.removeEventListener("resize", updatePlacement);
			window.removeEventListener("scroll", updatePlacement, true);
			viewport?.removeEventListener("resize", updatePlacement);
			viewport?.removeEventListener("scroll", updatePlacement);
			observer?.disconnect();
		};
	}, [open, updatePlacement]);

	useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

	const interactionProps = {
		onPointerEnter: (_event: PointerEvent<HTMLElement>) => openPreview(),
		onPointerLeave: (_event: PointerEvent<HTMLElement>) => scheduleClose(),
		onFocus: (_event: FocusEvent<HTMLElement>) => openPreview(),
		onBlur: handleBlur,
		onKeyDown: handleKeyDown,
	};

	return {
		open,
		referenceRef,
		floatingRef,
		floatingStyle: floatingStyle(position),
		referenceProps: interactionProps,
		floatingProps: interactionProps,
		floatingId,
		closePreview,
	};
}

export const __test__ = {
	calculatePreviewPosition,
	floatingStyle,
	referenceIntersectsViewport,
};
