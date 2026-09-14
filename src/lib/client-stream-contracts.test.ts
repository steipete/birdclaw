import { describe, expect, it } from "vitest";
import {
	periodDigestStreamEventSchema,
	profileAnalysisStreamEventSchema,
	searchDiscussionStreamEventSchema,
} from "./client-stream-contracts";

describe("compiled report events", () => {
	it.each([
		{
			name: "digest",
			schema: periodDigestStreamEventSchema,
			context: {
				includeDms: true,
				counts: { home: 1, mentions: 0, links: 0, dms: 0 },
				tweets: [],
			},
		},
		{
			name: "discussion",
			schema: searchDiscussionStreamEventSchema,
			context: {
				includeDms: false,
				counts: {
					search: 1,
					home: 0,
					mentions: 0,
					authored: 0,
					likes: 0,
					bookmarks: 0,
					dms: 0,
				},
				tweets: [],
			},
		},
		{
			name: "profile",
			schema: profileAnalysisStreamEventSchema,
			context: {
				handle: "demo",
				profile: { handle: "demo" },
				tweets: [],
				conversations: [],
				counts: { tweets: 0, conversationTweets: 0, conversationsScanned: 0 },
			},
		},
	])(
		"preserves $name context fields and rejects malformed events",
		({ schema, context }) => {
			const completeContext = { ...context, extra: { retained: true } };
			const events = [
				{ type: "start", context: completeContext, cached: false },
				{ type: "delta", delta: "Demo report" },
				{
					type: "done",
					result: {
						context: completeContext,
						markdown: "Demo report",
						cached: false,
						extra: "retained",
					},
				},
				{ type: "error", error: "Request failed" },
			];
			for (const event of events) {
				expect(schema.parse({ ...event, stripped: true })).toEqual(event);
				expect(schema.parse(event)).toEqual(schema.clone().parse(event));
			}
			for (const event of [
				{ type: "delta", delta: 42 },
				{
					type: "done",
					result: { context: {}, markdown: "Demo", cached: false },
				},
				{ type: "unknown" },
			]) {
				const result = schema.safeParse(event);
				const runtime = schema.clone().safeParse(event);
				if (result.success || runtime.success)
					throw new Error("expected invalid event");
				expect(result.error.issues).toEqual(runtime.error.issues);
			}
		},
	);

	it("retains the report-specific status event contract", () => {
		const event = { type: "status", label: "Loading" };
		expect(periodDigestStreamEventSchema.parse(event)).toEqual(event);
		expect(profileAnalysisStreamEventSchema.parse(event)).toEqual(event);
		expect(searchDiscussionStreamEventSchema.safeParse(event).success).toBe(
			false,
		);
	});
});
