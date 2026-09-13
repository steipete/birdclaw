import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStoredAccountId } from "./account-selection";
import { SyncNowButton } from "./SyncNowButton";
import { renderWithQueryClient } from "#/test/render";

describe("SyncNowButton", () => {
	it("does not mount saved auto-sync timers in a read-only deployment", async () => {
		vi.useFakeTimers();
		window.localStorage.setItem(
			"birdclaw:auto-sync:timeline:default",
			JSON.stringify({ enabled: true, intervalMs: 300000 }),
		);
		const fetch = vi.fn(async () => new Response("unexpected"));
		vi.stubGlobal("fetch", fetch);
		renderWithQueryClient(
			<SyncNowButton
				kind="timeline"
				label="Sync timeline"
				allowAutoSync
				onSynced={vi.fn()}
			/>,
			{ readOnly: true },
		);
		expect(
			screen.queryByRole("button", { name: "Sync timeline" }),
		).not.toBeInTheDocument();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(600000);
		});
		expect(fetch).not.toHaveBeenCalled();
	});
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
				accounts={[]}
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

	it.each(["manual", "auto"] as const)(
		"syncs secondary-account DMs through %s sync",
		async (source) => {
			vi.useFakeTimers();
			setStoredAccountId("acct_secondary");
			const onSynced = vi.fn();
			const fetchMock = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							id: "sync_dms_secondary",
							kind: "dms",
							status: "succeeded",
							startedAt: "2026-05-15T12:00:00.000Z",
							summary: "Synced 1 item",
							inProgress: false,
							result: {
								ok: true,
								kind: "dms",
								accountId: "acct_secondary",
								summary: "Synced 1 item",
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
					allowAutoSync
					onSynced={onSynced}
					accounts={["primary", "secondary"].map((name, index) => ({
						id: `acct_${name}`,
						name,
						handle: `@${name}`,
						transport: "xurl",
						isDefault: index === 0 ? 1 : 0,
						createdAt: "2026-05-15T12:00:00.000Z",
					}))}
					syncOptions={{ inbox: "requests", limit: 20 }}
				/>,
			);
			expect(screen.getByRole("button", { name: "Sync DMs" })).toBeEnabled();
			await act(async () => {
				if (source === "manual")
					fireEvent.click(screen.getByRole("button", { name: "Sync DMs" }));
				else
					fireEvent.click(
						screen.getByRole("checkbox", { name: "Auto sync dms" }),
					);
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(600000);
			});
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/sync",
				expect.objectContaining({
					body: JSON.stringify({
						kind: "dms",
						accountId: "acct_secondary",
						inbox: "requests",
						limit: 20,
					}),
				}),
			);
			expect(onSynced).toHaveBeenCalledWith(
				expect.objectContaining({ accountId: "acct_secondary" }),
			);
		},
	);

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

	it("waits for timeline account metadata when account selection is enabled", () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SyncNowButton
				kind="timeline"
				label="Sync timeline"
				onSynced={vi.fn()}
				showAccountPicker
			/>,
		);

		const button = screen.getByRole("button", { name: "Sync timeline" });
		expect(button).toBeDisabled();
		expect(screen.getByText("Loading account")).toBeInTheDocument();
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

	it("posts the default account for timeline syncs when accounts are supplied", async () => {
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
					body: JSON.stringify({
						kind: "timeline",
						accountId: "acct_primary",
					}),
				}),
			);
		});
	});

	it("posts selected accounts for timeline syncs", async () => {
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
			name: "Sync timeline",
		});

		fireEvent.click(button);
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/sync",
				expect.objectContaining({
					body: JSON.stringify({
						kind: "timeline",
						accountId: "acct_studio",
					}),
				}),
			);
		});
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

	it("runs opt-in auto sync on the selected interval and reschedules", async () => {
		vi.useFakeTimers();
		const onSynced = vi.fn();
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						id: "sync_timeline_auto",
						kind: "timeline",
						status: "succeeded",
						startedAt: "2026-05-15T12:00:00.000Z",
						summary: "Auto synced 6 items",
						inProgress: false,
						result: {
							ok: true,
							kind: "timeline",
							summary: "Auto synced 6 items",
							steps: [],
						},
					}),
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SyncNowButton
				allowAutoSync
				kind="timeline"
				label="Sync timeline"
				onSynced={onSynced}
			/>,
		);

		fireEvent.click(
			screen.getByRole("checkbox", { name: "Auto sync timeline" }),
		);
		fireEvent.change(
			screen.getByRole("combobox", {
				name: "Sync timeline auto-sync interval",
			}),
			{ target: { value: String(5 * 60_000) } },
		);

		await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(onSynced).toHaveBeenCalledTimes(1);
		expect(screen.getByText(/Last auto sync/)).toBeInTheDocument();

		await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(onSynced).toHaveBeenCalledTimes(2);
	});

	it("does not overlap auto sync runs", async () => {
		vi.useFakeTimers();
		let finishRequest: ((response: Response) => void) | undefined;
		const fetchMock = vi.fn(
			async () =>
				await new Promise<Response>((resolve) => {
					finishRequest = resolve;
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SyncNowButton
				allowAutoSync
				kind="timeline"
				label="Sync timeline"
				onSynced={vi.fn()}
			/>,
		);
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Auto sync timeline" }),
		);
		fireEvent.change(
			screen.getByRole("combobox", {
				name: "Sync timeline auto-sync interval",
			}),
			{ target: { value: String(5 * 60_000) } },
		);

		await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await act(async () => vi.advanceTimersByTimeAsync(15 * 60_000));
		expect(fetchMock).toHaveBeenCalledTimes(1);

		await act(async () => {
			finishRequest?.(
				new Response(
					JSON.stringify({
						id: "sync_timeline_auto_slow",
						kind: "timeline",
						status: "succeeded",
						startedAt: "2026-05-15T12:00:00.000Z",
						summary: "Auto sync complete",
						inProgress: false,
						result: {
							ok: true,
							kind: "timeline",
							summary: "Auto sync complete",
							steps: [],
						},
					}),
				),
			);
			await Promise.resolve();
		});
	});

	it("ignores an auto sync completion after the selected account changes", async () => {
		vi.useFakeTimers();
		setStoredAccountId("acct_primary");
		let finishRequest: ((response: Response) => void) | undefined;
		const fetchMock = vi.fn(
			async () =>
				await new Promise<Response>((resolve) => {
					finishRequest = resolve;
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const onSynced = vi.fn();
		const accounts = [
			{
				id: "acct_primary",
				name: "Primary",
				handle: "@primary",
				transport: "xurl" as const,
				isDefault: 1,
				createdAt: "2026-05-15T12:00:00.000Z",
			},
			{
				id: "acct_studio",
				name: "Studio",
				handle: "@studio",
				transport: "xurl" as const,
				isDefault: 0,
				createdAt: "2026-05-15T12:00:00.000Z",
			},
		];

		render(
			<SyncNowButton
				accounts={accounts}
				allowAutoSync
				kind="timeline"
				label="Sync timeline"
				onSynced={onSynced}
				showAccountPicker
			/>,
		);
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Auto sync timeline" }),
		);
		fireEvent.change(
			screen.getByRole("combobox", {
				name: "Sync timeline auto-sync interval",
			}),
			{ target: { value: String(5 * 60_000) } },
		);
		await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000));
		expect(fetchMock).toHaveBeenCalledTimes(1);

		act(() => setStoredAccountId("acct_studio"));
		expect(
			screen.getByRole("checkbox", { name: "Auto sync timeline" }),
		).not.toBeChecked();

		await act(async () => {
			finishRequest?.(
				new Response(
					JSON.stringify({
						id: "sync_timeline_stale_account",
						kind: "timeline",
						accountId: "acct_primary",
						status: "succeeded",
						startedAt: "2026-05-15T12:00:00.000Z",
						summary: "Primary account synced",
						inProgress: false,
						result: {
							ok: true,
							kind: "timeline",
							accountId: "acct_primary",
							summary: "Primary account synced",
							steps: [],
						},
					}),
				),
			);
			await Promise.resolve();
		});

		expect(onSynced).not.toHaveBeenCalled();
		expect(screen.getByText("Auto sync off")).toBeInTheDocument();
		expect(screen.queryByText(/Last auto sync/)).toBeNull();
	});

	it("backs off after auto sync failures", async () => {
		vi.useFakeTimers();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						id: "sync_timeline_auto_failed",
						kind: "timeline",
						status: "failed",
						startedAt: "2026-05-15T12:00:00.000Z",
						summary: "Rate limited",
						inProgress: false,
						result: {
							ok: false,
							kind: "timeline",
							summary: "Rate limited",
							error: "Rate limited",
							steps: [],
						},
					}),
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						id: "sync_timeline_auto_recovered",
						kind: "timeline",
						status: "succeeded",
						startedAt: "2026-05-15T12:10:00.000Z",
						summary: "Recovered",
						inProgress: false,
						result: {
							ok: true,
							kind: "timeline",
							summary: "Recovered",
							steps: [],
						},
					}),
				),
			);
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SyncNowButton
				allowAutoSync
				kind="timeline"
				label="Sync timeline"
				onSynced={vi.fn()}
			/>,
		);
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Auto sync timeline" }),
		);
		fireEvent.change(
			screen.getByRole("combobox", {
				name: "Sync timeline auto-sync interval",
			}),
			{ target: { value: String(5 * 60_000) } },
		);

		await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(
			screen.getByText("Auto sync failed: Rate limited"),
		).toBeInTheDocument();
		await act(async () => vi.advanceTimersByTimeAsync(10 * 60_000 - 1));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await act(async () => vi.advanceTimersByTimeAsync(1));
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("restores per-kind auto sync settings after remount", () => {
		const first = render(
			<SyncNowButton
				allowAutoSync
				kind="timeline"
				label="Sync timeline"
				onSynced={vi.fn()}
			/>,
		);
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Auto sync timeline" }),
		);
		fireEvent.change(
			screen.getByRole("combobox", {
				name: "Sync timeline auto-sync interval",
			}),
			{ target: { value: String(30 * 60_000) } },
		);
		first.unmount();

		render(
			<SyncNowButton
				allowAutoSync
				kind="timeline"
				label="Sync timeline"
				onSynced={vi.fn()}
			/>,
		);

		expect(
			screen.getByRole("checkbox", { name: "Auto sync timeline" }),
		).toBeChecked();
		expect(
			screen.getByRole("combobox", {
				name: "Sync timeline auto-sync interval",
			}),
		).toHaveValue(String(30 * 60_000));
	});
});
