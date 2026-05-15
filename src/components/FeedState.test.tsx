import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
	FeedEmpty,
	FeedError,
	FeedLoading,
	LinkSkeletonRows,
	TweetSkeletonRows,
} from "./FeedState";

describe("FeedState", () => {
	afterEach(() => {
		cleanup();
	});

	it("renders loading copy and row skeletons", () => {
		const { container } = render(
			<FeedLoading detail="Reading local posts" label="Loading posts">
				<TweetSkeletonRows count={5} />
				<LinkSkeletonRows count={3} />
			</FeedLoading>,
		);

		expect(screen.getByText("Loading posts")).toBeInTheDocument();
		expect(screen.getByText("Reading local posts")).toBeInTheDocument();
		expect(
			container.querySelectorAll('[data-perf="tweet-skeleton-row"]'),
		).toHaveLength(5);
		expect(
			container.querySelectorAll('[data-perf="link-skeleton-row"]'),
		).toHaveLength(3);
	});

	it("renders empty and error variants", () => {
		const { rerender } = render(
			<FeedEmpty detail="Try a different filter" label="No posts" />,
		);

		expect(screen.getByText("No posts")).toBeInTheDocument();
		expect(screen.getByText("Try a different filter")).toBeInTheDocument();

		rerender(<FeedError message="Network unavailable" />);
		expect(screen.getByText("Could not load this view")).toBeInTheDocument();
		expect(screen.getByText("Network unavailable")).toBeInTheDocument();

		rerender(
			<FeedError
				action={<button type="button">Retry</button>}
				message="Link insights unavailable"
				title="Could not load links"
			/>,
		);
		expect(screen.getByText("Could not load links")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
	});
});
