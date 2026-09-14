import { expect, it } from "vitest";
import { isReadOnlyArchivePage } from "./api-enums";
import { tweetPermalinkPath } from "./tweet-permalink";

it("encodes tweet IDs as one URL path segment", () => {
	expect(tweetPermalinkPath("2030857479001960633")).toBe(
		"/tweets/2030857479001960633",
	);
	expect(tweetPermalinkPath("reply/with ?#&")).toBe(
		"/tweets/reply%2Fwith%20%3F%23%26",
	);
});

it("admits only a single tweet detail segment in read-only page navigation", () => {
	for (const path of [
		"/tweets/123",
		"/tweets/tweet_001",
		"/tweets/123/",
		"/tweets/reply%2Fone",
	])
		expect(isReadOnlyArchivePage(path)).toBe(true);
	for (const path of [
		"/tweets",
		"/tweets/",
		"/tweets/123/reply",
		"/api/action",
		"/profiles/example",
	])
		expect(isReadOnlyArchivePage(path)).toBe(false);
	expect(isReadOnlyArchivePage("/mentions")).toBe(true);
});
