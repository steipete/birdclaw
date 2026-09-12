import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQueryClient as render } from "#/test/render";
import { DmsRouteView } from "#/routes/dms";
import { InboxRouteView } from "#/routes/inbox";
import { fetchJson, fetchQueryEnvelope } from "#/lib/api-client";
import type { QueryEnvelope } from "#/lib/api-contracts";
import { useNetworkMapController } from "./network-map-controller";

vi.mock("#/lib/api-client", () => ({
	fetchQueryEnvelope: vi.fn(),
	fetchJson: vi.fn(),
	postAction: vi.fn(),
	postSync: vi.fn(),
}));

function MapView() {
	useNetworkMapController({ type: "all", q: "" }, () => {});
	return null;
}

const account = {
	id: "acct_demo",
	name: "Demo",
	handle: "@demo",
	isDefault: 1,
	transport: "local",
	createdAt: "2026-01-01T00:00:00Z",
};
const envelope: QueryEnvelope = {
	accounts: [account],
	archives: [],
	stats: { home: 0, mentions: 0, dms: 0, needsReply: 0, inbox: 0 },
	transport: {
		installed: false,
		availableTransport: "local",
		statusText: "local",
	},
};

afterEach(() => {
	cleanup();
	window.localStorage.clear();
	vi.resetAllMocks();
});

describe.each([
	["Map", MapView],
	["DMs", DmsRouteView],
	["Inbox", InboxRouteView],
] as const)("%s account readiness", (_name, View) => {
	it.each([
		{
			name: "no saved account",
			stored: null,
			accounts: [account],
			fail: false,
			expected: ["acct_demo"],
		},
		{
			name: "valid saved account",
			stored: "acct_demo",
			accounts: [account],
			fail: false,
			expected: ["acct_demo"],
		},
		{
			name: "stale saved account",
			stored: "acct_removed",
			accounts: [account],
			fail: false,
			expected: ["acct_removed", "acct_demo"],
		},
		{
			name: "empty archive",
			stored: null,
			accounts: [],
			fail: false,
			expected: [null],
		},
		{
			name: "status failure",
			stored: null,
			accounts: [],
			fail: true,
			expected: [null],
		},
	])(
		"settles $name without a speculative unscoped read",
		async ({ stored, accounts, fail, expected }) => {
			window.localStorage.clear();
			if (stored)
				window.localStorage.setItem("birdclaw:selected-account-id", stored);
			let resolveStatus!: (value: QueryEnvelope) => void;
			let rejectStatus!: (error: Error) => void;
			const status = new Promise<QueryEnvelope>((resolve, reject) => {
				resolveStatus = resolve;
				rejectStatus = reject;
			});
			vi.mocked(fetchQueryEnvelope).mockReturnValue(status);
			vi.mocked(fetchJson).mockResolvedValue({
				resource: "dms",
				items: [],
				selectedConversation: null,
				features: [],
				stats: { total: 0, openai: 0, heuristic: 0 },
			});
			const { queryClient } = render(<View />);
			await act(async () => {});
			expect(fetchJson).toHaveBeenCalledTimes(stored ? 1 : 0);
			await act(async () => {
				if (fail) rejectStatus(new Error("status offline"));
				else resolveStatus({ ...envelope, accounts });
			});
			await waitFor(() =>
				expect(fetchJson).toHaveBeenCalledTimes(expected.length),
			);
			expect(
				vi
					.mocked(fetchJson)
					.mock.calls.map(([url]) =>
						new URL(String(url)).searchParams.get("account"),
					),
			).toEqual(expected);
			queryClient.clear();
		},
	);
});
