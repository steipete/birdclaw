import { describe, expect, it } from "vitest";
import {
	adaptUserTimelinePage,
	mergeTweetPages,
	type TweetPage,
} from "./tweet-page";

function tweet(id: string, text = id) {
	return { id, author_id: `author-${id}`, text, created_at: "2026-01-01" };
}

describe("mergeTweetPages", () => {
	it("normalizes user timeline pages at the transport boundary", () => {
		expect(
			adaptUserTimelinePage(
				{
					items: [{ id: "1", text: "one", created_at: "2026-01-01" }],
					nextToken: "next",
				},
				"author",
			),
		).toMatchObject({
			data: [{ id: "1", author_id: "author" }],
			meta: { next_token: "next" },
		});
	});

	it("deduplicates tweets, merges every include, and preserves page metadata", () => {
		const pages: TweetPage[] = [
			{
				data: [tweet("1", "first"), tweet("2")],
				includes: {
					users: [{ id: "u1", name: "Old", username: "one" }],
					tweets: [tweet("quoted", "old")],
					media: [{ media_key: "m1", type: "photo", url: "old" }],
				},
			},
			{
				data: [tweet("1", "second"), tweet("3")],
				includes: {
					users: [
						{ id: "u1", name: "New", username: "one" },
						{ id: "u2", name: "Two", username: "two" },
					],
					tweets: [tweet("quoted", "new"), tweet("late")],
					media: [
						{ media_key: "m1", type: "photo", url: "new" },
						{ media_key: "m2", type: "video" },
					],
				},
				meta: { next_token: "raw-next", result_count: 99 },
			},
		];

		const merged = mergeTweetPages(pages, { itemLimit: 2 });

		expect(merged.data.map(({ id, text }) => ({ id, text }))).toEqual([
			{ id: "1", text: "first" },
			{ id: "2", text: "2" },
		]);
		expect(
			merged.includes?.users?.map(({ id, name }) => ({ id, name })),
		).toEqual([
			{ id: "u1", name: "New" },
			{ id: "u2", name: "Two" },
		]);
		expect(
			merged.includes?.tweets?.map(({ id, text }) => ({ id, text })),
		).toEqual([
			{ id: "quoted", text: "new" },
			{ id: "late", text: "late" },
		]);
		expect(
			merged.includes?.media?.map(({ media_key, url }) => ({ media_key, url })),
		).toEqual([
			{ media_key: "m1", url: "new" },
			{ media_key: "m2", url: undefined },
		]);
		expect(merged.meta).toMatchObject({
			result_count: 2,
			page_count: 2,
			next_token: "raw-next",
		});
	});
});
