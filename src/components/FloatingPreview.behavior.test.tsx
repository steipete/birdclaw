import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useFloatingPreview } from "./FloatingPreview";

function Harness() {
	const preview = useFloatingPreview();
	return (
		<>
			<span
				data-reference
				ref={preview.referenceRef}
				{...preview.referenceProps}
			>
				<button type="button">Preview</button>
			</span>
			{preview.open ? (
				<span
					role="group"
					data-floating
					ref={preview.floatingRef}
					style={{ ...preview.floatingStyle, border: 0, padding: 0 }}
					{...preview.floatingProps}
				>
					<span data-floating-preview-content>Content</span>
				</span>
			) : null}
		</>
	);
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("does no idle frame work and follows layout shifts, content growth, and scrolling", () => {
	let referenceTop = 100,
		contentHeight = 60;
	const frames = new Map<number, FrameRequestCallback>();
	let nextFrame = 0;
	vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
		const id = ++nextFrame;
		frames.set(id, callback);
		return id;
	});
	vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
		frames.delete(id);
	});
	const flush = () =>
		act(() => {
			const pending = [...frames.values()];
			frames.clear();
			for (const frame of pending) frame(16);
		});
	const rect = (top: number, width: number, height: number) => ({
		x: 100,
		y: top,
		left: 100,
		right: 100 + width,
		top,
		bottom: top + height,
		width,
		height,
		toJSON: () => ({}),
	});
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
		function (this: HTMLElement) {
			return this.hasAttribute("data-reference")
				? rect(referenceTop, 80, 20)
				: rect(
						0,
						200,
						this.hasAttribute("data-floating-preview-content")
							? contentHeight
							: 80,
					);
		},
	);
	const clientRects = vi
		.spyOn(HTMLElement.prototype, "getClientRects")
		.mockImplementation(function (this: HTMLElement) {
			return [this.getBoundingClientRect()] as unknown as DOMRectList;
		});
	const moves: Array<{
		callback: IntersectionObserverCallback;
		targets: Element[];
	}> = [];
	class MoveObserver {
		targets: Element[] = [];
		callback: IntersectionObserverCallback;
		constructor(callback: IntersectionObserverCallback) {
			this.callback = callback;
			moves.push(this);
		}
		observe = (target: Element) => {
			this.targets.push(target);
		};
		disconnect = vi.fn();
		unobserve = vi.fn();
	}
	const resizes: Array<{
		callback: ResizeObserverCallback;
		targets: Element[];
	}> = [];
	class SizeObserver {
		targets: Element[] = [];
		callback: ResizeObserverCallback;
		constructor(callback: ResizeObserverCallback) {
			this.callback = callback;
			resizes.push(this);
		}
		observe = (target: Element) => {
			this.targets.push(target);
		};
		disconnect = vi.fn();
		unobserve = vi.fn();
	}
	vi.stubGlobal("IntersectionObserver", MoveObserver);
	vi.stubGlobal("ResizeObserver", SizeObserver);
	const height = Object.getOwnPropertyDescriptor(window, "innerHeight");
	Object.defineProperty(window, "innerHeight", {
		configurable: true,
		value: 400,
	});
	try {
		const { unmount } = render(<Harness />);
		act(() => screen.getByRole("button", { name: "Preview" }).focus());
		const popup = screen.getByRole("group");
		expect(popup).toHaveStyle({ top: "130px" });
		flush();
		clientRects.mockClear();
		for (let i = 0; i < 120; i++) flush();
		expect(clientRects).not.toHaveBeenCalled();
		referenceTop = 240;
		act(() =>
			moves
				.at(-1)
				?.callback(
					[{ intersectionRatio: 1 } as IntersectionObserverEntry],
					{} as IntersectionObserver,
				),
		);
		flush();
		expect(popup).toHaveStyle({ top: "270px" });
		contentHeight = 200;
		const contentObserver = resizes.find((x) =>
			x.targets.some((t) => t.hasAttribute("data-floating-preview-content")),
		);
		expect(contentObserver).toBeDefined();
		act(() => contentObserver?.callback([], {} as ResizeObserver));
		flush();
		expect(popup).toHaveStyle({ top: "30px" });
		referenceTop = 170;
		clientRects.mockClear();
		for (let i = 0; i < 20; i++) fireEvent.scroll(window);
		expect(frames.size).toBe(1);
		expect(clientRects).not.toHaveBeenCalled();
		flush();
		expect(popup).toHaveStyle({ top: "200px" });
		fireEvent.scroll(window);
		unmount();
		expect(frames.size).toBe(0);
	} finally {
		if (height) Object.defineProperty(window, "innerHeight", height);
	}
});
