import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		children,
		to,
		className,
	}: {
		children: ReactNode;
		to: string;
		className: string;
	}) => (
		<a className={className} href={to}>
			{children}
		</a>
	),
}));

import { InboxCard } from "./InboxCard";

afterEach(() => {
	cleanup();
});

const item = {
	id: "dm:dm_1",
	entityId: "dm_1",
	entityKind: "dm" as const,
	accountId: "acct_primary",
	accountHandle: "@steipete",
	title: "DM from Sam Altman",
	text: "Need the sketch",
	createdAt: "2026-03-08T12:00:00.000Z",
	needsReply: true,
	influenceScore: 150,
	source: "heuristic" as const,
	score: 92,
	summary: "Worth answering",
	reasoning: "Concrete ask",
	participant: {
		id: "profile_1",
		handle: "sam",
		displayName: "Sam Altman",
		bio: "bio",
		followersCount: 1000,
		avatarHue: 210,
		createdAt: "2026-03-08T12:00:00.000Z",
	},
};

describe("InboxCard", () => {
	it("renders score details and toggles reply composer", () => {
		const onReplyToggle = vi.fn();
		render(
			<InboxCard
				isReplying={false}
				item={item}
				onReplyChange={vi.fn()}
				onReplySend={vi.fn()}
				onReplyToggle={onReplyToggle}
				replyDraft=""
			/>,
		);

		expect(screen.getByText("Worth answering")).toBeInTheDocument();
		expect(screen.queryByText(/^bio$/)).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Reply" }));
		expect(onReplyToggle).toHaveBeenCalled();
	});

	it("renders the inline composer for dm replies", () => {
		render(
			<InboxCard
				isReplying
				item={item}
				onReplyChange={vi.fn()}
				onReplySend={vi.fn()}
				onReplyToggle={vi.fn()}
				replyDraft="On it."
			/>,
		);

		expect(screen.getByPlaceholderText("Reply to @sam")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
		expect(
			screen.getAllByRole("link", { name: "Open" }).at(-1),
		).toHaveAttribute("href", "/dms");
	});

	it("uses mention-specific reply copy and navigation", () => {
		render(
			<InboxCard
				isReplying
				item={{
					...item,
					id: "mention:tweet_1",
					entityId: "tweet_1",
					entityKind: "mention",
					title: "Mention from Sam Altman",
				}}
				onReplyChange={vi.fn()}
				onReplySend={vi.fn()}
				onReplyToggle={vi.fn()}
				replyDraft=""
			/>,
		);

		expect(
			screen.getByPlaceholderText("Reply to mention from @sam"),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
		expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute(
			"href",
			"/mentions",
		);
	});
});
