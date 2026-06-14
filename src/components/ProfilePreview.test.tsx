import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfilePreview } from "./ProfilePreview";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("ProfilePreview", () => {
	it("stays open after pointer leave while its trigger retains focus", () => {
		vi.useFakeTimers();
		render(
			<ProfilePreview
				profile={{
					id: "profile_amelia",
					handle: "amelia",
					displayName: "Amelia",
					bio: "Design systems",
					followersCount: 4200,
					avatarHue: 320,
					createdAt: "2026-03-08T12:00:00.000Z",
				}}
			>
				@amelia
			</ProfilePreview>,
		);

		const link = screen.getByRole("link", { name: "@amelia" });
		const wrapper = link.parentElement as HTMLElement;
		act(() => link.focus());
		expect(screen.getByRole("group")).toHaveTextContent("Design systems");

		fireEvent.pointerEnter(wrapper);
		fireEvent.pointerLeave(wrapper);
		act(() => vi.advanceTimersByTime(150));
		expect(screen.getByRole("group")).toBeInTheDocument();

		act(() => link.blur());
		act(() => vi.advanceTimersByTime(150));
		expect(screen.queryByRole("group")).toBeNull();
	});

	it("tracks layout-only movement while open", () => {
		let referenceTop = 100;
		const frames: FrameRequestCallback[] = [];
		const originalClientRects = HTMLElement.prototype.getClientRects;
		vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
			function (this: HTMLElement) {
				if (!this.classList.contains("relative")) {
					return originalClientRects.call(this);
				}
				return [
					{
						top: referenceTop,
						right: 180,
						bottom: referenceTop + 20,
						left: 100,
						width: 80,
						height: 20,
					} as DOMRect,
				] as unknown as DOMRectList;
			},
		);
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
			frames.push(callback);
			return frames.length;
		});
		vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

		render(
			<ProfilePreview
				profile={{
					id: "profile_amelia",
					handle: "amelia",
					displayName: "Amelia",
					bio: "",
					followersCount: 4200,
					avatarHue: 320,
					createdAt: "2026-03-08T12:00:00.000Z",
				}}
			>
				@amelia
			</ProfilePreview>,
		);

		act(() => screen.getByRole("link", { name: "@amelia" }).focus());
		const preview = screen.getByRole("group");
		expect(preview).toHaveStyle({ top: "130px" });

		referenceTop = 240;
		act(() => frames.shift()?.(16));
		expect(preview).toHaveStyle({ top: "270px" });
	});
});
