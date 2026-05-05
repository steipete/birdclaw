import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/components/DmWorkspace", () => ({
	DmWorkspace: ({
		selectedConversation,
		replyDraft,
		onReplyDraftChange,
		onReplySend,
	}: {
		selectedConversation: { id: string; title: string } | null;
		replyDraft: string;
		onReplyDraftChange: (value: string) => void;
		onReplySend: (id: string) => void;
	}) => (
		<div>
			<div>{selectedConversation?.title ?? "none"}</div>
			<input
				aria-label="draft"
				onChange={(event) => onReplyDraftChange(event.target.value)}
				value={replyDraft}
			/>
			<button
				onClick={() =>
					selectedConversation && onReplySend(selectedConversation.id)
				}
				type="button"
			>
				send dm
			</button>
		</div>
	),
}));

import { Route } from "./dms";

const DmsRoute = Route.options.component as ComponentType;

describe("dms route", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("loads dms and posts an inline reply", async () => {
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/api/status")) {
					return new Response(
						JSON.stringify({
							stats: { home: 3, mentions: 1, dms: 4, needsReply: 2, inbox: 3 },
							transport: { statusText: "local" },
							accounts: [],
							archives: [],
						}),
					);
				}
				if (url.includes("/api/query")) {
					return new Response(
						JSON.stringify({
							resource: "dms",
							items: [
								{
									id: "dm_1",
									title: "Sam Altman",
									accountId: "acct_primary",
									accountHandle: "@steipete",
								},
							],
							selectedConversation: {
								conversation: {
									id: "dm_1",
									title: "Sam Altman",
									accountId: "acct_primary",
									accountHandle: "@steipete",
								},
								messages: [],
							},
						}),
					);
				}
				if (url.endsWith("/api/action") && init?.method === "POST") {
					return new Response(JSON.stringify({ ok: true }));
				}
				throw new Error(`Unexpected fetch ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		render(<DmsRoute />);

		expect(await screen.findByText("Sam Altman")).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("draft"), {
			target: { value: "Need details" },
		});
		fireEvent.click(screen.getByRole("button", { name: "send dm" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/action",
				expect.objectContaining({ method: "POST" }),
			);
		});
	});
});
