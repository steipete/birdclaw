// @vitest-environment node
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	lookupTweetsByIdsViaBird: vi.fn(),
	lookupTweetsByIdsViaXurl: vi.fn(),
}));

vi.mock("./bird", () => ({
	lookupTweetsByIdsViaBird: mocks.lookupTweetsByIdsViaBird,
	lookupTweetsByIdsViaBirdEffect: (ids: string[]) =>
		Effect.tryPromise({
			try: () => mocks.lookupTweetsByIdsViaBird(ids),
			catch: (error) => error,
		}),
}));

vi.mock("./xurl", async () => {
	const { Effect } = await import("effect");
	return {
		lookupTweetsByIds: mocks.lookupTweetsByIdsViaXurl,
		lookupTweetsByIdsEffect: (ids: string[]) =>
			Effect.tryPromise({
				try: () => mocks.lookupTweetsByIdsViaXurl(ids),
				catch: (error) =>
					error instanceof Error ? error : new Error(String(error)),
			}),
	};
});

describe("shared tweet lookup", () => {
	afterEach(() => {
		delete process.env.BIRDCLAW_PREFERRED_TRANSPORT;
		vi.resetModules();
		for (const mock of Object.values(mocks)) {
			mock.mockReset();
		}
	});

	it("prefers Bird in auto mode, falls back, and honors an explicit override", async () => {
		process.env.BIRDCLAW_PREFERRED_TRANSPORT = "bird";
		mocks.lookupTweetsByIdsViaBird.mockResolvedValue({ data: [] });
		mocks.lookupTweetsByIdsViaXurl.mockResolvedValue({ data: [] });
		const { lookupTweetsByIds } = await import("./tweet-lookup");
		await lookupTweetsByIds(["one"]);
		expect(mocks.lookupTweetsByIdsViaXurl).not.toHaveBeenCalled();
		mocks.lookupTweetsByIdsViaBird.mockRejectedValueOnce(new Error("offline"));
		await lookupTweetsByIds(["two"]);
		expect(mocks.lookupTweetsByIdsViaXurl).toHaveBeenCalledWith(["two"]);
		await lookupTweetsByIds(["three"], "xurl");
		expect(mocks.lookupTweetsByIdsViaBird).toHaveBeenCalledTimes(2);
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

	it("exposes tweet lookup as a lazy Effect program", async () => {
		mocks.lookupTweetsByIdsViaXurl.mockResolvedValue({
			data: [
				{ id: "tweet_1", author_id: "42", text: "xurl", created_at: "now" },
			],
		});
		const { lookupTweetsByIdsEffect } = await import("./tweet-lookup");

		const effect = lookupTweetsByIdsEffect(["tweet_1"]);
		expect(mocks.lookupTweetsByIdsViaXurl).not.toHaveBeenCalled();
		await expect(Effect.runPromise(effect)).resolves.toMatchObject({
			data: [{ id: "tweet_1", text: "xurl" }],
		});
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

	it("reports both transport failures in auto mode", async () => {
		mocks.lookupTweetsByIdsViaXurl.mockRejectedValue("xurl offline");
		mocks.lookupTweetsByIdsViaBird.mockRejectedValue(new Error("bird offline"));
		const { lookupTweetsByIds } = await import("./tweet-lookup");

		await expect(lookupTweetsByIds(["tweet_1"])).rejects.toThrow(
			"Tweet lookup failed via xurl and bird: xurl: xurl offline; bird: bird offline",
		);
	});
});
