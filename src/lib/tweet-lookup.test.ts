// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	lookupTweetsByIdsViaBird: vi.fn(),
	lookupTweetsByIdsViaXurl: vi.fn(),
}));

vi.mock("./bird", () => ({
	lookupTweetsByIdsViaBird: mocks.lookupTweetsByIdsViaBird,
}));

vi.mock("./xurl", () => ({
	lookupTweetsByIds: mocks.lookupTweetsByIdsViaXurl,
}));

describe("shared tweet lookup", () => {
	afterEach(() => {
		vi.resetModules();
		for (const mock of Object.values(mocks)) {
			mock.mockReset();
		}
	});

	it("uses xurl first in auto mode", async () => {
		mocks.lookupTweetsByIdsViaXurl.mockResolvedValue({
			data: [
				{ id: "tweet_1", author_id: "42", text: "xurl", created_at: "now" },
			],
		});
		const { lookupTweetsByIds } = await import("./tweet-lookup");

		await expect(lookupTweetsByIds(["tweet_1"])).resolves.toMatchObject({
			data: [{ id: "tweet_1", text: "xurl" }],
		});
		expect(mocks.lookupTweetsByIdsViaXurl).toHaveBeenCalledWith(["tweet_1"]);
		expect(mocks.lookupTweetsByIdsViaBird).not.toHaveBeenCalled();
	});

	it("falls back to bird when xurl lookup fails in auto mode", async () => {
		mocks.lookupTweetsByIdsViaXurl.mockRejectedValue(new Error("xurl 401"));
		mocks.lookupTweetsByIdsViaBird.mockResolvedValue({
			data: [
				{
					id: "tweet_1",
					author_id: "42",
					text: "bird",
					created_at: "now",
					referenced_tweets: [{ type: "replied_to", id: "tweet_root" }],
				},
			],
		});
		const { lookupTweetsByIds } = await import("./tweet-lookup");

		await expect(lookupTweetsByIds(["tweet_1"])).resolves.toMatchObject({
			data: [
				{
					id: "tweet_1",
					text: "bird",
					referenced_tweets: [{ type: "replied_to", id: "tweet_root" }],
				},
			],
		});
		expect(mocks.lookupTweetsByIdsViaXurl).toHaveBeenCalledWith(["tweet_1"]);
		expect(mocks.lookupTweetsByIdsViaBird).toHaveBeenCalledWith(["tweet_1"]);
	});

	it("honors explicit transport modes", async () => {
		mocks.lookupTweetsByIdsViaXurl.mockResolvedValue({ data: [] });
		mocks.lookupTweetsByIdsViaBird.mockResolvedValue({ data: [] });
		const { lookupTweetsByIds } = await import("./tweet-lookup");

		await lookupTweetsByIds(["tweet_1"], "xurl");
		await lookupTweetsByIds(["tweet_2"], "bird");

		expect(mocks.lookupTweetsByIdsViaXurl).toHaveBeenCalledWith(["tweet_1"]);
		expect(mocks.lookupTweetsByIdsViaBird).toHaveBeenCalledWith(["tweet_2"]);
	});
});
