import {
	act,
	cleanup,
	fireEvent,
	screen,
	waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQueryClient as render } from "#/test/render";
import { fetchQueryResponse } from "#/lib/api-client";
import { queryKeys } from "#/lib/query-client";
import type { QueryEnvelope } from "#/lib/api-contracts";
import type { TimelineItem } from "#/lib/types";
import { TimelineCard } from "./TimelineCard";
import { TweetRichText } from "./TweetRichText";
import { useTimelineRouteData } from "./useTimelineRouteData";

vi.mock("./TweetRichText", () => ({
	TweetRichText: vi.fn(({ text }: { text: string }) => <span>{text}</span>),
}));
vi.mock("#/lib/api-client", () => ({
	fetchQueryResponse: vi.fn(),
	fetchQueryEnvelope: vi.fn(),
	postAction: vi.fn(),
}));

function Harness() {
	const [search, setSearch] = useState("");
	const { items, replyToTweet, loadMore } = useTimelineRouteData({
		resource: "home",
		search,
		errorFallback: "Unavailable",
	});
	return (
		<>
			<input
				aria-label="Search timeline"
				value={search}
				onChange={(event) => setSearch(event.target.value)}
			/>
			<button onClick={() => void loadMore()} type="button">
				More posts
			</button>
			{items.map((item) => (
				<TimelineCard key={item.id} item={item} onReply={replyToTweet} />
			))}
		</>
	);
}

function tweet(index: number): TimelineItem {
	return {
		id: `tweet_${index}`,
		accountId: "acct_demo",
		accountHandle: "@demo",
		kind: "home",
		text: `Demo post ${index}`,
		createdAt: "2026-01-01T00:00:00Z",
		isReplied: false,
		likeCount: 12,
		mediaCount: 0,
		bookmarked: false,
		liked: false,
		author: {
			id: "demo",
			handle: "demo",
			displayName: "Demo",
			bio: "",
			followersCount: 10,
			avatarHue: 200,
			createdAt: "2026-01-01T00:00:00Z",
		},
		entities: {},
		media: [],
	};
}

afterEach(() => {
	cleanup();
	vi.resetAllMocks();
	window.localStorage.clear();
});

describe("timeline rendering", () => {
	it.each([50, 500])(
		"keeps %i unchanged cards out of search, status, and append renders",
		async (count) => {
			vi.mocked(fetchQueryResponse)
				.mockResolvedValueOnce({
					resource: "home",
					items: Array.from({ length: count }, (_, index) => tweet(index)),
				})
				.mockResolvedValueOnce({ resource: "home", items: [tweet(count)] });
			const { queryClient, container } = render(<Harness />, {
				readOnly: true,
			});
			await waitFor(() =>
				expect(
					container.querySelectorAll('[data-perf="timeline-card"]'),
				).toHaveLength(count),
			);
			vi.mocked(TweetRichText).mockClear();
			const input = screen.getByRole("textbox", { name: "Search timeline" });
			for (const value of ["t", "ty", "typ", "type", ""])
				fireEvent.change(input, { target: { value } });
			expect(TweetRichText).not.toHaveBeenCalled();
			await act(async () => {
				queryClient.setQueryData<QueryEnvelope>(
					queryKeys.status,
					(previous) =>
						previous && {
							...previous,
							stats: { ...previous.stats, home: count + 1 },
						},
				);
			});
			expect(TweetRichText).not.toHaveBeenCalled();
			fireEvent.click(screen.getByRole("button", { name: "More posts" }));
			expect(await screen.findByText(`Demo post ${count}`)).toBeInTheDocument();
			expect(TweetRichText).toHaveBeenCalledTimes(1);
			queryClient.clear();
		},
	);
});
