import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncNowButton } from "./SyncNowButton";

describe("SyncNowButton", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("posts the sync kind and reports success", async () => {
		const onSynced = vi.fn();
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						ok: true,
						kind: "timeline",
						summary: "Synced 12 items",
						steps: [],
					}),
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SyncNowButton
				kind="timeline"
				label="Sync timeline"
				onSynced={onSynced}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Sync timeline" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/sync",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({ kind: "timeline" }),
				}),
			);
			expect(onSynced).toHaveBeenCalledWith(
				expect.objectContaining({ summary: "Synced 12 items" }),
			);
		});
		expect(screen.getByText("Synced 12 items")).toBeInTheDocument();
	});

	it("keeps an accessible label when the visible text is hidden", () => {
		render(
			<SyncNowButton
				kind="timeline"
				label="Sync timeline"
				onSynced={vi.fn()}
			/>,
		);

		expect(
			screen.getByRole("button", { name: "Sync timeline" }),
		).toHaveAttribute("aria-label", "Sync timeline");
	});

	it("surfaces sync failures", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ ok: false, message: "Rate limited" }), {
						status: 500,
					}),
			),
		);

		render(
			<SyncNowButton
				kind="mentions"
				label="Sync mentions"
				onSynced={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Sync mentions" }));

		expect(await screen.findByText("Rate limited")).toBeInTheDocument();
	});

	it("surfaces in-progress sync summaries", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							ok: false,
							kind: "timeline",
							summary: "Sync already running",
							steps: [],
							inProgress: true,
						}),
						{ status: 409 },
					),
			),
		);

		render(
			<SyncNowButton
				kind="timeline"
				label="Sync timeline"
				onSynced={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Sync timeline" }));

		expect(await screen.findByText("Sync already running")).toBeInTheDocument();
	});
});
