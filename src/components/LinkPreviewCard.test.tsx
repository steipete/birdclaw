import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createTestQueryClient,
	renderWithQueryClient as render,
} from "#/test/render";
import { LinkPreviewCard } from "./LinkPreviewCard";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("LinkPreviewCard", () => {
	it("can rerender from a safe URL to an unsafe URL without changing hooks", () => {
		const { container, rerender } = render(
			<LinkPreviewCard
				entry={{
					url: "https://example.com",
					expandedUrl: "https://example.com",
					displayUrl: "example.com",
					start: 0,
					end: 19,
				}}
				index={0}
			/>,
		);

		expect(container.querySelector("a")).toBeInTheDocument();

		expect(() =>
			rerender(
				<LinkPreviewCard
					entry={{
						url: "javascript:alert(1)",
						expandedUrl: "javascript:alert(1)",
						displayUrl: "bad",
						start: 0,
						end: 19,
					}}
					index={0}
				/>,
			),
		).not.toThrow();
		expect(container.querySelector("a")).toBeNull();
	});

	it("renders direct Twitter media inline and falls back after image errors", () => {
		render(
			<LinkPreviewCard
				entry={{
					url: "https://pbs.twimg.com/media/photo.jpg",
					expandedUrl: "https://pbs.twimg.com/media/photo.jpg",
					displayUrl: "pbs.twimg.com/media/photo.jpg",
					start: 0,
					end: 35,
				}}
				index={0}
			/>,
		);

		const image = screen.getByRole("img", { name: "pbs.twimg.com" });
		expect(image).toHaveAttribute(
			"src",
			"https://pbs.twimg.com/media/photo.jpg",
		);

		fireEvent.error(image);

		expect(screen.queryByRole("img")).toBeNull();
		expect(document.querySelector("svg")).toBeInTheDocument();
	});

	it("proxies external preview images through the local cache", () => {
		render(
			<LinkPreviewCard
				entry={{
					url: "https://example.com/post",
					expandedUrl: "https://example.com/post",
					displayUrl: "example.com/post",
					title: "Example",
					description: "External image",
					imageUrl: "https://example.com/preview.png",
					siteName: "Example Site",
					start: 0,
					end: 24,
				}}
				index={0}
			/>,
		);

		expect(screen.getByRole("img")).toHaveAttribute(
			"src",
			"/api/link-preview?imageUrl=https%3A%2F%2Fexample.com%2Fpreview.png",
		);
	});

	it("hydrates missing metadata when the card becomes eligible", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					ok: true,
					preview: {
						url: "https://example.com/final",
						title: "Hydrated title",
						description: "Hydrated description",
						imageUrl: "https://pbs.twimg.com/media/hydrated.jpg",
						siteName: "Hydrated Site",
					},
				}),
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<LinkPreviewCard
				entry={{
					url: "https://t.co/hydrate-card",
					expandedUrl: "https://example.com/hydrate-card",
					displayUrl: "example.com/hydrate-card",
					start: 0,
					end: 25,
				}}
				index={0}
			/>,
		);

		expect(await screen.findByText("Hydrated title")).toBeInTheDocument();
		expect(screen.getByText("Hydrated description")).toBeInTheDocument();
		expect(screen.getByRole("img", { name: "Hydrated title" })).toHaveAttribute(
			"src",
			"https://pbs.twimg.com/media/hydrated.jpg",
		);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/link-preview?url=https%3A%2F%2Fexample.com%2Fhydrate-card",
		);
	});

	it("keeps fallback metadata when hydration fails", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: false,
			json: () => Promise.resolve({ ok: false }),
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<LinkPreviewCard
				entry={{
					url: "https://t.co/fail-card",
					expandedUrl: "https://example.com/fail-card",
					displayUrl: "example.com/fail-card",
					start: 0,
					end: 22,
				}}
				index={0}
			/>,
		);

		await waitFor(() => expect(fetchMock).toHaveBeenCalled());

		expect(screen.getAllByText("example.com/fail-card").length).toBeGreaterThan(
			0,
		);
	});

	it("retries a failed preview when the card mounts again", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: false,
				json: () => Promise.resolve({ ok: false }),
			})
			.mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						ok: true,
						preview: {
							url: "https://example.com/retry",
							title: "Retry succeeded",
							description: null,
							imageUrl: null,
							siteName: "Example",
						},
					}),
			});
		vi.stubGlobal("fetch", fetchMock);
		const queryClient = createTestQueryClient();
		const card = (
			<LinkPreviewCard
				entry={{
					url: "https://t.co/retry-card",
					expandedUrl: "https://example.com/retry-card",
					displayUrl: "example.com/retry-card",
					start: 0,
					end: 23,
				}}
				index={0}
			/>
		);

		const first = render(card, { queryClient });
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		first.unmount();
		render(card, { queryClient });

		expect(await screen.findByText("Retry succeeded")).toBeInTheDocument();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("waits for intersection before hydrating previews", async () => {
		const observerCallbacks: Array<
			(entries: Array<{ isIntersecting: boolean }>) => void
		> = [];
		const disconnectSpy = vi.fn();
		class MockIntersectionObserver {
			constructor(
				callback: (entries: Array<{ isIntersecting: boolean }>) => void,
			) {
				observerCallbacks.push(callback);
			}
			observe = vi.fn();
			disconnect = disconnectSpy;
		}
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					ok: true,
					preview: {
						url: "https://example.com/intersection-final",
						title: "Intersection title",
						description: null,
						imageUrl: null,
						siteName: "Intersection Site",
					},
				}),
		});
		vi.stubGlobal("fetch", fetchMock);
		vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);

		render(
			<LinkPreviewCard
				entry={{
					url: "https://t.co/intersection-card",
					expandedUrl: "https://example.com/intersection-card",
					displayUrl: "example.com/intersection-card",
					start: 0,
					end: 29,
				}}
				index={0}
			/>,
		);

		await new Promise((resolve) => window.setTimeout(resolve, 120));
		expect(fetchMock).not.toHaveBeenCalled();

		observerCallbacks[0]?.([{ isIntersecting: false }]);
		await new Promise((resolve) => window.setTimeout(resolve, 120));
		expect(fetchMock).not.toHaveBeenCalled();

		observerCallbacks[0]?.([{ isIntersecting: true }]);

		expect(await screen.findByText("Intersection title")).toBeInTheDocument();
		expect(disconnectSpy).toHaveBeenCalled();
	});
});
