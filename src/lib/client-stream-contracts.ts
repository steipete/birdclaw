import { z } from "zod";
import type { PeriodDigestStreamEvent } from "./period-digest";
import type { ProfileAnalysisStreamEvent } from "./profile-analysis";
import type { SearchDiscussionStreamEvent } from "./search-discussion";

const statusEventSchema = z.object({
	type: z.literal("status"),
	label: z.string(),
	detail: z.string().optional(),
});
const deltaEventSchema = z.object({
	type: z.literal("delta"),
	delta: z.string(),
});
const errorEventSchema = z.object({
	type: z.literal("error"),
	error: z.string(),
});

const periodContextSchema = z.looseObject({
	includeDms: z.boolean(),
	counts: z.looseObject({
		home: z.number(),
		mentions: z.number(),
		links: z.number(),
		dms: z.number(),
	}),
	tweets: z.array(z.unknown()),
});
const discussionContextSchema = z.looseObject({
	includeDms: z.boolean(),
	counts: z.looseObject({
		search: z.number(),
		home: z.number(),
		mentions: z.number(),
		authored: z.number(),
		likes: z.number(),
		bookmarks: z.number(),
		dms: z.number(),
	}),
	tweets: z.array(z.unknown()),
});
const profileContextSchema = z.looseObject({
	handle: z.string(),
	profile: z.looseObject({ handle: z.string() }),
	profiles: z.array(z.unknown()).optional(),
	tweets: z.array(z.unknown()),
	conversations: z.array(z.unknown()),
	counts: z.looseObject({
		tweets: z.number(),
		conversationTweets: z.number(),
		conversationsScanned: z.number(),
	}),
});

function reportEventSchema(context: z.ZodType, withStatus = true) {
	const events = [
		z.object({ type: z.literal("start"), context, cached: z.boolean() }),
		deltaEventSchema,
		z.object({
			type: z.literal("done"),
			result: z.looseObject({
				context,
				markdown: z.string(),
				cached: z.boolean(),
			}),
		}),
		errorEventSchema,
	] as const;
	return z.compile(
		z.discriminatedUnion(
			"type",
			withStatus ? [statusEventSchema, ...events] : events,
		),
	);
}

export const periodDigestStreamEventSchema = reportEventSchema(
	periodContextSchema,
) as z.ZodType<PeriodDigestStreamEvent>;
export const searchDiscussionStreamEventSchema = reportEventSchema(
	discussionContextSchema,
	false,
) as z.ZodType<SearchDiscussionStreamEvent>;
export const profileAnalysisStreamEventSchema = reportEventSchema(
	profileContextSchema,
) as z.ZodType<ProfileAnalysisStreamEvent>;

export function isTerminalStreamEvent(event: { type: string }) {
	return event.type === "done" || event.type === "error";
}
