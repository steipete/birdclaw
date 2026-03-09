import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DmWorkspace } from "./DmWorkspace";

afterEach(() => {
	cleanup();
});

const conversation = {
	id: "dm_1",
	accountId: "acct_primary",
	accountHandle: "@steipete",
	title: "Sam Altman",
	lastMessageAt: "2026-03-08T12:00:00.000Z",
	lastMessagePreview: "Need the sketch",
	unreadCount: 1,
	needsReply: true,
	influenceScore: 150,
	influenceLabel: "very high",
	participant: {
		id: "profile_1",
		handle: "sam",
		displayName: "Sam Altman",
		bio: "Working on AGI",
		followersCount: 3000000,
		avatarHue: 210,
		createdAt: "2026-03-08T12:00:00.000Z",
	},
};

describe("DmWorkspace", () => {
	it("renders selected conversation and sends reply", () => {
		const onSelectConversation = vi.fn();
		const onReplyDraftChange = vi.fn();
		const onReplySend = vi.fn();

		render(
			<DmWorkspace
				conversations={[conversation]}
				onReplyDraftChange={onReplyDraftChange}
				onReplySend={onReplySend}
				onSelectConversation={onSelectConversation}
				replyDraft="On it."
				selectedConversation={conversation}
				selectedMessages={[
					{
						id: "msg_1",
						conversationId: "dm_1",
						text: "hello",
						createdAt: "2026-03-08T12:00:00.000Z",
						direction: "inbound",
						isReplied: false,
						mediaCount: 0,
						sender: conversation.participant,
					},
				]}
			/>,
		);

		expect(screen.getAllByText("Sam Altman").length).toBeGreaterThan(1);
		expect(screen.getByText("Working on AGI")).toBeInTheDocument();
		expect(screen.queryByText("sender context")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Reply" }));
		expect(onReplySend).toHaveBeenCalledWith("dm_1");
		fireEvent.change(screen.getByPlaceholderText("Reply to @sam"), {
			target: { value: "Need more detail" },
		});
		expect(onReplyDraftChange).toHaveBeenCalledWith("Need more detail");
	});

	it("renders empty state without a selected conversation", () => {
		render(
			<DmWorkspace
				conversations={[conversation]}
				onReplyDraftChange={vi.fn()}
				onReplySend={vi.fn()}
				onSelectConversation={vi.fn()}
				replyDraft=""
				selectedConversation={null}
				selectedMessages={[]}
			/>,
		);

		expect(screen.getByText("No DM selected.")).toBeInTheDocument();
	});

	it("renders clear thread metadata and outbound bubbles", () => {
		const onSelectConversation = vi.fn();
		const clearConversation = {
			...conversation,
			id: "dm_2",
			needsReply: false,
			influenceScore: 88,
			influenceLabel: "emerging",
		};

		render(
			<DmWorkspace
				conversations={[clearConversation]}
				onReplyDraftChange={vi.fn()}
				onReplySend={vi.fn()}
				onSelectConversation={onSelectConversation}
				replyDraft=""
				selectedConversation={clearConversation}
				selectedMessages={[
					{
						id: "msg_2",
						conversationId: "dm_2",
						text: "done",
						createdAt: "2026-03-08T12:05:00.000Z",
						direction: "outbound",
						isReplied: true,
						mediaCount: 0,
						sender: clearConversation.participant,
					},
				]}
			/>,
		);

		const [conversationButton] = screen.getAllByRole("button", {
			name: /sam altman/i,
		});
		if (!conversationButton) {
			throw new Error("Conversation button missing");
		}
		fireEvent.click(conversationButton);
		expect(onSelectConversation).toHaveBeenCalledWith("dm_2");
		expect(screen.getByText("clear")).toBeInTheDocument();
		expect(screen.getByText("Thread clear")).toBeInTheDocument();
		expect(screen.getByText("Replied")).toBeInTheDocument();
		expect(screen.getByText("@steipete")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Send reply" })).toBeDisabled();
		expect(screen.getByText("done")).toBeInTheDocument();
	});
});
