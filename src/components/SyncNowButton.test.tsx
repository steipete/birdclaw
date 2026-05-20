import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStoredAccountId } from "./account-selection";
import { SyncNowButton } from "./SyncNowButton";

describe("SyncNowButton", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		cleanup();
		window.localStorage.clear();
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

	it("includes dm sync options in the sync request", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						id: "sync_dms_1",
						kind: "dms",
						status: "succeeded",
						startedAt: "2026-05-15T12:00:00.000Z",
						summary: "Synced 9 items",
						inProgress: false,
						result: {
							ok: true,
							kind: "dms",
							summary: "Synced 9 items",
							steps: [],
						},
					}),
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SyncNowButton
				kind="dms"
				label="Sync DMs"
				onSynced={vi.fn()}
				syncOptions={{ inbox: "requests", limit: 200, maxPages: 3 }}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Sync DMs" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/sync",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({
						kind: "dms",
						inbox: "requests",
						limit: 200,
						maxPages: 3,
					}),
				}),
			);
		});
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

	it("waits for an account before account-scoped syncs", () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SyncNowButton
				kind="bookmarks"
				label="Sync bookmarks"
				onSynced={vi.fn()}
			/>,
		);

		const button = screen.getByRole("button", { name: "Sync bookmarks" });
		expect(button).toBeDisabled();
		fireEvent.click(button);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("allows account-scoped syncs after an empty account list loads", async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body)) as {
					kind: string;
					accountId?: string;
				};
				return new Response(
					JSON.stringify({
						id: "sync_bookmarks_1",
						kind: body.kind,
						accountId: body.accountId,
						status: "succeeded",
						startedAt: "2026-05-15T12:00:00.000Z",
						summary: "Synced 5 items",
						inProgress: false,
						result: {
							ok: true,
							kind: body.kind,
							accountId: body.accountId,
							summary: "Synced 5 items",
							steps: [],
						},
					}),
				);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SyncNowButton
				accounts={[]}
				kind="bookmarks"
				label="Sync bookmarks"
				onSynced={vi.fn()}
			/>,
		);

		const button = screen.getByRole("button", { name: "Sync bookmarks" });
		expect(button).toBeEnabled();
		fireEvent.click(button);

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/sync",
				expect.objectContaining({
					body: JSON.stringify({ kind: "bookmarks" }),
				}),
			);
		});
	});

	it("posts the selected account id when multiple accounts are available", async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body)) as {
					kind: string;
					accountId?: string;
				};
				return new Response(
					JSON.stringify({
						id: "sync_mentions_1",
						kind: body.kind,
						accountId: body.accountId,
						status: "succeeded",
						startedAt: "2026-05-15T12:00:00.000Z",
						summary: "Synced 5 items",
						inProgress: false,
						result: {
							ok: true,
							kind: body.kind,
							accountId: body.accountId,
							summary: "Synced 5 items",
							steps: [],
						},
					}),
				);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SyncNowButton
				accounts={[
					{
						id: "acct_primary",
						name: "Peter",
						handle: "@steipete",
						transport: "xurl",
						isDefault: 1,
						createdAt: "2026-05-15T12:00:00.000Z",
					},
					{
						id: "acct_studio",
						name: "Studio",
						handle: "@studio",
						transport: "xurl",
						isDefault: 0,
						createdAt: "2026-05-15T12:00:00.000Z",
					},
				]}
				kind="mentions"
				label="Sync mentions"
				onSynced={vi.fn()}
				showAccountPicker
			/>,
		);

		fireEvent.change(screen.getByLabelText("Sync account"), {
			target: { value: "acct_studio" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Sync mentions" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/sync",
				expect.objectContaining({
					body: JSON.stringify({
						kind: "mentions",
						accountId: "acct_studio",
					}),
				}),
			);
		});

		setStoredAccountId("acct_primary");
		await waitFor(() => {
			expect(screen.getByLabelText("Sync account")).toHaveValue("acct_primary");
		});
		fireEvent.click(screen.getByRole("button", { name: "Sync mentions" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenLastCalledWith(
				"/api/sync",
				expect.objectContaining({
					body: JSON.stringify({
						kind: "mentions",
						accountId: "acct_primary",
					}),
				}),
			);
		});
	});

	it("uses the global account without rendering an inline picker", async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body)) as {
					kind: string;
					accountId?: string;
				};
				return new Response(
					JSON.stringify({
						id: "sync_mentions_1",
						kind: body.kind,
						accountId: body.accountId,
						status: "succeeded",
						startedAt: "2026-05-15T12:00:00.000Z",
						summary: "Synced 5 items",
						inProgress: false,
						result: {
							ok: true,
							kind: body.kind,
							accountId: body.accountId,
							summary: "Synced 5 items",
							steps: [],
						},
					}),
				);
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		setStoredAccountId("acct_studio");

		render(
			<SyncNowButton
				accounts={[
					{
						id: "acct_primary",
						name: "Peter",
						handle: "@steipete",
						transport: "xurl",
						isDefault: 1,
						createdAt: "2026-05-15T12:00:00.000Z",
					},
					{
						id: "acct_studio",
						name: "Studio",
						handle: "@studio",
						transport: "xurl",
						isDefault: 0,
						createdAt: "2026-05-15T12:00:00.000Z",
					},
				]}
				kind="mentions"
				label="Sync mentions"
				onSynced={vi.fn()}
			/>,
		);

		expect(screen.queryByLabelText("Sync account")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Sync mentions" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/sync",
				expect.objectContaining({
					body: JSON.stringify({
						kind: "mentions",
						accountId: "acct_studio",
					}),
				}),
			);
		});
	});

	it("keeps Bird-only syncs account-neutral", async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body)) as {
					kind: string;
					accountId?: string;
				};
				return new Response(
					JSON.stringify({
						id: "sync_timeline_1",
						kind: body.kind,
						accountId: body.accountId,
						status: "succeeded",
						startedAt: "2026-05-15T12:00:00.000Z",
						summary: "Synced 5 items",
						inProgress: false,
						result: {
							ok: true,
							kind: body.kind,
							accountId: body.accountId,
							summary: "Synced 5 items",
							steps: [],
						},
					}),
				);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SyncNowButton
				accounts={[
					{
						id: "acct_primary",
						name: "Peter",
						handle: "@steipete",
						transport: "bird",
						isDefault: 1,
						createdAt: "2026-05-15T12:00:00.000Z",
					},
					{
						id: "acct_studio",
						name: "Studio",
						handle: "@studio",
						transport: "xurl",
						isDefault: 0,
						createdAt: "2026-05-15T12:00:00.000Z",
					},
				]}
				kind="timeline"
				label="Sync timeline"
				onSynced={vi.fn()}
			/>,
		);

		expect(screen.queryByLabelText("Sync account")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Sync timeline" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/sync",
				expect.objectContaining({
					body: JSON.stringify({ kind: "timeline" }),
				}),
			);
		});
	});

	it("disables Bird-only syncs for a selected non-default account", () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		setStoredAccountId("acct_studio");

		render(
			<SyncNowButton
				accounts={[
					{
						id: "acct_primary",
						name: "Peter",
						handle: "@steipete",
						transport: "bird",
						isDefault: 1,
						createdAt: "2026-05-15T12:00:00.000Z",
					},
					{
						id: "acct_studio",
						name: "Studio",
						handle: "@studio",
						transport: "xurl",
						isDefault: 0,
						createdAt: "2026-05-15T12:00:00.000Z",
					},
				]}
				kind="timeline"
				label="Sync timeline"
				onSynced={vi.fn()}
			/>,
		);

		const button = screen.getByRole("button", {
			name: "Sync timeline: default account only",
		});
		expect(button).toBeDisabled();
		expect(screen.getByText("Switch to default to sync")).toBeInTheDocument();

		fireEvent.click(button);
		expect(fetchMock).not.toHaveBeenCalled();
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
				kind="timeline"
				label="Sync timeline"
				onSynced={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Sync timeline" }));

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
