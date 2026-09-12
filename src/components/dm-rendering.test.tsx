import {
	act,
	cleanup,
	fireEvent,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderWithQueryClient as render } from "#/test/render";
import { DmsRouteView } from "#/routes/dms";
import { queryKeys } from "#/lib/query-client";
import type { QueryResponse } from "#/lib/api-contracts";
import type { DmConversationItem, DmMessageItem } from "#/lib/types";
import { SmartTimestamp } from "./SmartTimestamp";

vi.mock("./SmartTimestamp", () => ({
	SmartTimestamp: vi.fn(({ value }: { value: string }) => <time>{value}</time>),
}));
const messageDate = "2026-01-02T00:00:00Z";
const participant = {
	id: "demo",
	handle: "demo",
	displayName: "Demo",
	bio: "",
	followersCount: 100,
	avatarHue: 200,
	createdAt: "2026-01-01T00:00:00Z",
};
const conversations: DmConversationItem[] = Array.from(
	{ length: 100 },
	(_, i) => ({
		id: `dm_${i}`,
		accountId: "acct_demo",
		accountHandle: "@demo",
		title: `Conversation ${i}`,
		lastMessageAt: "2026-01-01T00:00:00Z",
		lastMessagePreview: "Hello",
		unreadCount: 0,
		needsReply: true,
		influenceScore: 24,
		influenceLabel: "low",
		participant,
	}),
);
const messages: DmMessageItem[] = Array.from({ length: 500 }, (_, i) => ({
	id: `message_${i}`,
	conversationId: "dm_0",
	text: `Message ${i}`,
	createdAt: messageDate,
	direction: "inbound",
	isReplied: false,
	mediaCount: 0,
	sender: participant,
}));
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	window.localStorage.clear();
});

it("does not render the loaded conversation list or messages while composing", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) =>
			String(input).endsWith("/api/status")
				? Response.json({
						stats: { home: 0, mentions: 0, dms: 100, needsReply: 0, inbox: 0 },
						transport: { statusText: "local" },
						accounts: [],
						archives: [],
					})
				: Response.json({
						resource: "dms",
						items: conversations,
						selectedConversation: { conversation: conversations[0], messages },
					}),
		),
	);
	const { queryClient, unmount } = render(<DmsRouteView />);
	await screen.findByText("Message 499");
	vi.mocked(SmartTimestamp).mockClear();
	const draft = screen.getByPlaceholderText("Reply to @demo");
	for (const value of ["h", "he", "hel", "hell", "hello"])
		fireEvent.change(draft, { target: { value } });
	const rendered = vi.mocked(SmartTimestamp).mock.calls.map(([props]) => props);
	expect({
		rows: rendered.filter((props) => props.className).length,
		messages: rendered.filter((props) => props.value === messageDate).length,
	}).toEqual({ rows: 0, messages: 0 });
	expect(draft).toHaveValue("hello");
	vi.mocked(SmartTimestamp).mockClear();
	await act(async () => {
		queryClient.setQueriesData<QueryResponse>(
			{ queryKey: queryKeys.dms },
			(old) =>
				old?.resource === "dms" && old.selectedConversation
					? {
							...old,
							selectedConversation: {
								...old.selectedConversation,
								messages: [
									...old.selectedConversation.messages,
									{ ...messages[0]!, id: "new", text: "New message" },
								],
							},
						}
					: old,
		);
	});
	await waitFor(() =>
		expect(screen.getByText("New message")).toBeInTheDocument(),
	);
	expect(
		vi
			.mocked(SmartTimestamp)
			.mock.calls.filter(([props]) => props.value === messageDate),
	).toHaveLength(1);
	unmount();
	queryClient.clear();
});
