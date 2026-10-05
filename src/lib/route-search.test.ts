import { describe, expect, it } from "vitest";
import {
	validateBlocksSearch,
	validateDiscussSearch,
	validateDmsSearch,
	validateInboxSearch,
	validateLinksSearch,
	validateNetworkMapSearch,
	validateTodaySearch,
} from "./route-search";

describe("route search schemas", () => {
	it("applies defaults and rejects invalid enum values", () => {
		expect(
			validateDmsSearch({ inbox: "invalid", reply: "replied" }),
		).toMatchObject({
			inbox: "all",
			reply: "replied",
			sort: "recent",
		});
		expect(
			validateLinksSearch({ range: "forever", kind: "videos" }),
		).toMatchObject({
			kind: "videos",
			range: "week",
		});
		expect(validateDiscussSearch({ mode: "bad" }).mode).toBe("auto");
		expect(validateTodaySearch({ period: "bad" }).period).toBe("today");
		expect(validateNetworkMapSearch({ type: "bad" }).type).toBe("all");
	});

	it("normalizes booleans and string filters", () => {
		expect(validateInboxSearch({ hideLowSignal: "0", minScore: "70" })).toEqual(
			{
				kind: "mixed",
				minScore: "70",
				hideLowSignal: false,
			},
		);
		expect(validateTodaySearch({ includeDms: "1" }).includeDms).toBe(true);
		expect(validateBlocksSearch({ account: 3, q: "sam" })).toEqual({
			account: "acct_primary",
			q: "sam",
		});
	});
});
