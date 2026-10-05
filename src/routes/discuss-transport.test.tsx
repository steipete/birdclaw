import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPreferredTransport } from "#/lib/config";
import { validateDiscussSearch } from "#/lib/route-search";
import { getRouteHandler } from "#/test/route-handlers";
import { useTestHome } from "#/test/test-home";

const streamSearchDiscussionMock = vi.fn();

vi.mock("#/lib/backup", () => ({
	requestBackupAutoUpdate: vi.fn(),
}));
vi.mock("#/lib/search-discussion", () => ({
	streamSearchDiscussionEffect: (...args: unknown[]) =>
		Effect.sync(() => streamSearchDiscussionMock(...args)),
}));

import { Route as ApiRoute } from "./api/search-discussion";
import { DiscussRouteView } from "./discuss";

const GET = getRouteHandler(ApiRoute, "GET");

describe("Discuss browser-to-API transport selection", () => {
	useTestHome();
	beforeEach(() => {
		delete process.env.BIRDCLAW_PREFERRED_TRANSPORT;
		streamSearchDiscussionMock.mockReset();
		streamSearchDiscussionMock.mockImplementation(
			(_options: unknown, handlers: { onEvent: (event: unknown) => void }) => {
				handlers.onEvent({ type: "error", error: "fixture complete" });
			},
		);
	});
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it.each([
		{ preferred: undefined, mode: undefined, expected: "xurl" },
		{ preferred: "bird", mode: undefined, expected: "auto" },
		{ preferred: "xurl", mode: undefined, expected: "auto" },
		{ preferred: undefined, mode: "auto", expected: "auto" },
		{ preferred: "xurl", mode: "bird", expected: "bird" },
		{ preferred: "bird", mode: "xurl", expected: "xurl" },
		{ preferred: "bird", mode: "local", expected: "local" },
	] as const)(
		"passes preferred=$preferred and mode=$mode through the browser as $expected",
		async ({ preferred, mode, expected }) => {
			if (preferred) setPreferredTransport(preferred);
			const urls: URL[] = [];
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: RequestInfo | URL) => {
					const url = new URL(String(input));
					urls.push(url);
					return GET({ request: new Request(url) });
				}),
			);
			render(
				<DiscussRouteView
					searchState={validateDiscussSearch({ q: "fixture", mode })}
				/>,
			);
			expect(screen.getByLabelText("Mode")).toHaveValue(mode ?? "");
			fireEvent.click(screen.getByRole("button", { name: "Discuss" }));
			await screen.findByText("fixture complete");
			expect(urls[0]?.searchParams.get("mode")).toBe(mode ?? null);
			expect(streamSearchDiscussionMock).toHaveBeenCalledWith(
				expect.objectContaining({ mode: expected }),
				expect.any(Object),
			);
		},
	);

	it("lets the user return from explicit Auto to the server default", async () => {
		const urls: URL[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				urls.push(url);
				return GET({ request: new Request(url) });
			}),
		);
		render(<DiscussRouteView />);
		fireEvent.change(screen.getByPlaceholderText("Keywords"), {
			target: { value: "fixture" },
		});
		fireEvent.change(screen.getByLabelText("Mode"), {
			target: { value: "auto" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Discuss" }));
		await screen.findByText("fixture complete");
		expect(urls[0]?.searchParams.get("mode")).toBe("auto");
		fireEvent.change(screen.getByLabelText("Mode"), {
			target: { value: "" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Discuss" }));
		await screen.findByText("fixture complete");
		expect(urls[1]?.searchParams.has("mode")).toBe(false);
		expect(streamSearchDiscussionMock).toHaveBeenLastCalledWith(
			expect.objectContaining({ mode: "xurl" }),
			expect.any(Object),
		);
	});
});
