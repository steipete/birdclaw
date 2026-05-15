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
		vi.useRealTimers();
	});

	it("posts the sync kind and reports success", async () => {
		const onSynced = vi.fn();
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						id: "sync_timeline_1",
						kind: "timeline",
						status: "succeeded",
						startedAt: "2026-05-15T12:00:00.000Z",
						summary: "Synced 12 items",
						inProgress: false,
						result: {
							ok: true,
							kind: "timeline",
							summary: "Synced 12 items",
							steps: [],
						},
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

	it("polls running sync jobs until completion", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/sync")) {
				return new Response(
					JSON.stringify({
						id: "sync_timeline_poll",
						kind: "timeline",
						status: "running",
						startedAt: "2026-05-15T12:00:00.000Z",
						summary: "Syncing Home timeline",
						inProgress: true,
					}),
					{ status: 202 },
				);
			}
			if (url.includes("/api/sync?id=sync_timeline_poll")) {
				return new Response(
					JSON.stringify({
						id: "sync_timeline_poll",
						kind: "timeline",
						status: "succeeded",
						startedAt: "2026-05-15T12:00:00.000Z",
						finishedAt: "2026-05-15T12:00:03.000Z",
						summary: "Synced 4 items",
						inProgress: false,
						result: {
							ok: true,
							kind: "timeline",
							summary: "Synced 4 items",
							steps: [],
						},
					}),
				);
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SyncNowButton
				kind="timeline"
				label="Sync timeline"
				onSynced={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Sync timeline" }));

		expect(await screen.findByText("Synced 4 items")).toBeInTheDocument();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("surfaces in-progress sync summaries", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							id: "sync_timeline_1",
							kind: "timeline",
							status: "failed",
							startedAt: "2026-05-15T12:00:00.000Z",
							summary: "Sync already running",
							inProgress: false,
							result: {
								ok: false,
								kind: "timeline",
								summary: "Sync already running",
								steps: [],
								inProgress: true,
							},
						}),
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
