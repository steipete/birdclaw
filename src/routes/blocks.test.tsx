import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Route } from "./blocks";

const BlocksRoute = Route.options.component as ComponentType;

describe("blocks route", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("loads blocks and submits block/unblock actions", async () => {
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/api/status")) {
					return new Response(
						JSON.stringify({
							stats: { home: 3, mentions: 1, dms: 4, needsReply: 2, inbox: 3 },
							transport: { statusText: "xurl available" },
							accounts: [
								{ id: "acct_primary", handle: "@steipete", name: "Peter" },
							],
							archives: [],
						}),
					);
				}
				if (url.includes("/api/blocks")) {
					return new Response(
						JSON.stringify({
							items: [
								{
									accountId: "acct_primary",
									accountHandle: "@steipete",
									source: "manual",
									blockedAt: "2026-03-08T12:00:00.000Z",
									profile: {
										id: "profile_user_7",
										handle: "amelia",
										displayName: "Amelia N",
										bio: "Design systems",
										followersCount: 4200,
										avatarHue: 320,
										createdAt: "2026-03-08T12:00:00.000Z",
									},
								},
							],
							matches: [
								{
									profile: {
										id: "profile_user_42",
										handle: "sam",
										displayName: "Sam Altman",
										bio: "Working on AGI",
										followersCount: 3180000,
										avatarHue: 210,
										createdAt: "2026-03-08T12:00:00.000Z",
									},
									isBlocked: false,
								},
							],
						}),
					);
				}
				if (url.endsWith("/api/action") && init?.method === "POST") {
					return new Response(
						JSON.stringify({
							ok: true,
							profile: { handle: "sam" },
							transport: { output: "live writes disabled" },
						}),
					);
				}
				throw new Error(`Unexpected fetch ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		render(<BlocksRoute />);

		expect(
			await screen.findByRole("heading", {
				name: "Maintain a clean blocklist locally.",
			}),
		).toBeInTheDocument();
		fireEvent.change(
			screen.getByPlaceholderText("Handle, name, bio, or X URL"),
			{
				target: { value: "@sam" },
			},
		);
		const [heroBlockButton] = screen.getAllByRole("button", { name: "Block" });
		if (!heroBlockButton) {
			throw new Error("Missing block button");
		}
		fireEvent.click(heroBlockButton);

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/action",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({
						kind: "blockProfile",
						accountId: "acct_primary",
						query: "@sam",
					}),
				}),
			);
		});

		fireEvent.click(screen.getByRole("button", { name: "Unblock" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/action",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({
						kind: "unblockProfile",
						accountId: "acct_primary",
						query: "profile_user_7",
					}),
				}),
			);
		});
	});
});
