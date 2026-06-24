import { z } from "zod";
import type {
	AccountRecord,
	ArchiveCandidate,
	DmConversationItem,
	DmMessageItem,
	DmSearchMatchItem,
	EmbeddedTweet,
	LinkInsightItem,
	ProfileAffiliation,
	ProfileRecord,
	TimelineItem,
	TransportStatus,
	TweetEntities,
	TweetMediaItem,
	UrlExpansionItem,
} from "./types";
import type {
	WebSyncJobSnapshot,
	WebSyncResponse,
	WebSyncStep,
} from "./web-sync";
import {
	dmDirectionSchema,
	inboxKindSchema,
	webSyncKindSchema,
} from "./api-enums";

const jsonRecordSchema = z.record(z.string(), z.unknown());
const unknownProfile: ProfileRecord = {
	id: "profile_unknown",
	handle: "unknown",
	displayName: "Unknown",
	bio: "",
	followersCount: 0,
	avatarHue: 0,
	createdAt: "",
};

export const profileAffiliationSchema: z.ZodType<ProfileAffiliation> = z.object(
	{
		organizationProfileId: z.string(),
		organizationName: z.string().optional(),
		organizationHandle: z.string().optional(),
		badgeUrl: z.string().nullable().optional(),
		url: z.string().nullable().optional(),
		label: z.string().nullable().optional(),
		source: z.string(),
		firstSeenAt: z.string(),
		lastSeenAt: z.string(),
		isActive: z.boolean(),
	},
);

export const profileRecordSchema = z.object({
	id: z.string().default("profile_unknown"),
	handle: z.string().default("unknown"),
	displayName: z.string().default("Unknown"),
	bio: z.string().default(""),
	followersCount: z.number().default(0),
	followingCount: z.number().optional(),
	avatarHue: z.number().default(0),
	avatarUrl: z.string().optional(),
	location: z.string().optional(),
	url: z.string().optional(),
	verifiedType: z.string().optional(),
	entities: jsonRecordSchema.optional(),
	affiliations: z.array(profileAffiliationSchema).optional(),
	primaryAffiliation: profileAffiliationSchema.optional(),
	createdAt: z.string().default(""),
}) satisfies z.ZodType<ProfileRecord>;

export const tweetEntitiesSchema: z.ZodType<TweetEntities> = z.object({
	mentions: z
		.array(
			z.object({
				username: z.string(),
				id: z.string().optional(),
				start: z.number(),
				end: z.number(),
				profile: profileRecordSchema.optional(),
			}),
		)
		.optional(),
	urls: z
		.array(
			z.object({
				url: z.string(),
				expandedUrl: z.string(),
				displayUrl: z.string(),
				start: z.number(),
				end: z.number(),
				title: z.string().optional(),
				description: z.string().nullable().optional(),
				imageUrl: z.string().nullable().optional(),
				siteName: z.string().nullable().optional(),
			}),
		)
		.optional(),
	hashtags: z
		.array(
			z.object({
				tag: z.string(),
				start: z.number(),
				end: z.number(),
			}),
		)
		.optional(),
	article: z
		.object({
			title: z.string(),
			previewText: z.string().optional(),
			url: z.string(),
			coverImageUrl: z.string().optional(),
		})
		.optional(),
});

export const tweetMediaSchema: z.ZodType<TweetMediaItem> = z.object({
	url: z.string(),
	type: z.preprocess(
		(value) =>
			value === "photo" ? "image" : value === "animated_gif" ? "gif" : value,
		z.enum(["image", "video", "gif", "unknown"]),
	),
	altText: z.string().optional(),
	width: z.number().optional(),
	height: z.number().optional(),
	thumbnailUrl: z.string().optional(),
	durationMs: z.number().optional(),
	variants: z
		.array(
			z.object({
				url: z.string(),
				contentType: z.string().optional(),
				bitRate: z.number().optional(),
			}),
		)
		.optional(),
});

export const embeddedTweetSchema: z.ZodType<EmbeddedTweet> = z.object({
	id: z.string(),
	text: z.string(),
	createdAt: z.string().default(""),
	replyToId: z.string().nullable().optional(),
	isReplied: z.boolean().optional(),
	likeCount: z.number().optional(),
	mediaCount: z.number().optional(),
	bookmarked: z.boolean().optional(),
	liked: z.boolean().optional(),
	author: profileRecordSchema.default(unknownProfile),
	entities: tweetEntitiesSchema.default({}),
	media: z.array(tweetMediaSchema).default([]),
});

export const timelineItemSchema: z.ZodType<TimelineItem> = z.object({
	id: z.string(),
	accountId: z.string().default("acct_primary"),
	accountHandle: z.string().default(""),
	kind: z
		.enum(["home", "mention", "authored", "search", "like", "bookmark"])
		.default("home"),
	text: z.string(),
	searchSnippet: z.string().optional(),
	createdAt: z.string().default(""),
	replyToId: z.string().nullable().optional(),
	isReplied: z.boolean().default(false),
	likeCount: z.number().default(0),
	mediaCount: z.number().default(0),
	bookmarked: z.boolean().default(false),
	liked: z.boolean().default(false),
	author: profileRecordSchema.default(unknownProfile),
	entities: tweetEntitiesSchema.default({}),
	media: z.array(tweetMediaSchema).default([]),
	replyToTweet: embeddedTweetSchema.nullable().optional(),
	quotedTweet: embeddedTweetSchema.nullable().optional(),
	retweetedTweet: embeddedTweetSchema.nullable().optional(),
	qualityReason: z.string().nullable().optional(),
});

export const dmMessageSchema: z.ZodType<DmMessageItem> = z.object({
	id: z.string(),
	conversationId: z.string().default(""),
	text: z.string(),
	createdAt: z.string().default(""),
	direction: dmDirectionSchema.default("inbound"),
	isReplied: z.boolean().default(false),
	mediaCount: z.number().default(0),
	sender: profileRecordSchema.default(unknownProfile),
});

const urlExpansionSchema: z.ZodType<UrlExpansionItem> = z.object({
	url: z.string(),
	expandedUrl: z.string(),
	finalUrl: z.string(),
	status: z.enum(["hit", "miss", "error"]),
	source: z.enum(["cache", "network"]),
	title: z.string().optional(),
	description: z.string().nullable().optional(),
	error: z.string().optional(),
	updatedAt: z.string(),
});

const dmSearchMatchSchema: z.ZodType<DmSearchMatchItem> = z.object({
	message: dmMessageSchema,
	before: z.array(dmMessageSchema),
	after: z.array(dmMessageSchema),
	urlExpansions: z.array(urlExpansionSchema).optional(),
});

export const dmConversationSchema: z.ZodType<DmConversationItem> = z.object({
	id: z.string(),
	accountId: z.string(),
	accountHandle: z.string().default(""),
	title: z.string(),
	searchSnippet: z.string().optional(),
	inboxKind: z.enum(["accepted", "request"]).optional(),
	isMessageRequest: z.boolean().optional(),
	lastMessageAt: z.string().default(""),
	lastMessagePreview: z.string().default(""),
	unreadCount: z.number().default(0),
	needsReply: z.boolean().default(false),
	influenceScore: z.number().default(0),
	influenceLabel: z.string().default(""),
	participant: profileRecordSchema.default(unknownProfile),
	matches: z.array(dmSearchMatchSchema).optional(),
});

const accountRecordSchema: z.ZodType<AccountRecord> = z.object({
	id: z.string(),
	name: z.string().default(""),
	handle: z.string().default(""),
	externalUserId: z.string().nullable().optional(),
	birdProfileName: z.string().nullable().optional(),
	profileId: z.string().optional(),
	avatarHue: z.number().optional(),
	avatarUrl: z.string().optional(),
	transport: z.string().default("local"),
	isDefault: z.coerce.number().default(0),
	createdAt: z.string().default(""),
});

const archiveCandidateSchema: z.ZodType<ArchiveCandidate> = z.object({
	path: z.string(),
	name: z.string().default(""),
	size: z.number().default(0),
	sizeFormatted: z.string().default(""),
	modifiedTime: z.string().default(""),
	dateFormatted: z.string().default(""),
});

const transportStatusSchema: z.ZodType<TransportStatus> = z.object({
	installed: z.boolean().default(false),
	availableTransport: z.enum(["xurl", "local"]).default("local"),
	statusText: z.string(),
	rawStatus: z.string().optional(),
});

export const queryEnvelopeSchema = z.object({
	accounts: z.array(accountRecordSchema),
	archives: z.array(archiveCandidateSchema),
	transport: transportStatusSchema,
	stats: z.object({
		home: z.number(),
		mentions: z.number(),
		dms: z.number(),
		needsReply: z.number(),
		inbox: z.number(),
	}),
});
export type QueryEnvelope = z.infer<typeof queryEnvelopeSchema>;

const timelineQueryResponseBaseSchema = z.object({
	items: z.array(timelineItemSchema),
	selectedConversation: z.undefined().optional(),
});

export const dmQueryResponseSchema = z.object({
	resource: z.literal("dms"),
	items: z.array(dmConversationSchema),
	selectedConversation: z
		.object({
			conversation: dmConversationSchema,
			messages: z.array(dmMessageSchema),
		})
		.nullable()
		.optional(),
});

export const queryResponseSchema = z.discriminatedUnion("resource", [
	timelineQueryResponseBaseSchema.extend({ resource: z.literal("home") }),
	timelineQueryResponseBaseSchema.extend({ resource: z.literal("mentions") }),
	timelineQueryResponseBaseSchema.extend({ resource: z.literal("authored") }),
	timelineQueryResponseBaseSchema.extend({ resource: z.literal("search") }),
	dmQueryResponseSchema,
]);
export type QueryResponse = z.infer<typeof queryResponseSchema>;
export { webSyncKindSchema } from "./api-enums";

const webSyncStepSchema: z.ZodType<WebSyncStep> = z.object({
	kind: z.union([webSyncKindSchema, z.literal("mention-threads")]),
	label: z.string(),
	count: z.number(),
	source: z.string().optional(),
	partial: z.boolean().optional(),
	warnings: z.array(z.string()).optional(),
});

export const webSyncResponseSchema: z.ZodType<WebSyncResponse> = z.object({
	ok: z.boolean(),
	kind: webSyncKindSchema,
	accountId: z.string().optional(),
	startedAt: z.string().default(""),
	finishedAt: z.string().optional(),
	summary: z.string(),
	steps: z.array(webSyncStepSchema).default([]),
	inProgress: z.boolean().optional(),
	backup: z.custom<WebSyncResponse["backup"]>().optional(),
	error: z.string().optional(),
});

export const webSyncJobSchema: z.ZodType<WebSyncJobSnapshot> = z.object({
	id: z.string(),
	kind: webSyncKindSchema,
	accountId: z.string().optional(),
	status: z.enum(["running", "succeeded", "failed"]),
	startedAt: z.string(),
	finishedAt: z.string().optional(),
	summary: z.string(),
	inProgress: z.boolean(),
	result: webSyncResponseSchema.optional(),
	error: z.string().optional(),
});

export const tweetConversationResponseSchema = z.object({
	ok: z.literal(true),
	anchorId: z.string().default(""),
	items: z.array(embeddedTweetSchema),
});

const blockItemSchema = z.object({
	accountId: z.string(),
	accountHandle: z.string(),
	source: z.string(),
	blockedAt: z.string(),
	profile: profileRecordSchema,
});
const blockSearchItemSchema = z.object({
	profile: profileRecordSchema,
	isBlocked: z.boolean(),
	blockedAt: z.string().optional(),
});
export const blockListResponseSchema = z.object({
	items: z.array(blockItemSchema),
	matches: z.array(blockSearchItemSchema),
});
export type BlockListResponse = z.infer<typeof blockListResponseSchema>;

const inboxItemSchema = z.object({
	id: z.string(),
	entityId: z.string().default(""),
	entityKind: z.enum(["mention", "dm"]).default("dm"),
	accountId: z.string().default("acct_primary"),
	accountHandle: z.string().default(""),
	title: z.string(),
	text: z.string().default(""),
	createdAt: z.string().default(""),
	needsReply: z.boolean().default(false),
	influenceScore: z.number().default(0),
	participant: profileRecordSchema.default(unknownProfile),
	source: z.enum(["heuristic", "openai"]).default("heuristic"),
	score: z.number().default(0),
	summary: z.string().default(""),
	reasoning: z.string().default(""),
});
export const inboxResponseSchema = z.object({
	items: z.array(inboxItemSchema),
	stats: z.object({
		total: z.number(),
		openai: z.number(),
		heuristic: z.number(),
	}),
});
export type InboxResponse = z.infer<typeof inboxResponseSchema>;

const linkInsightMentionSchema = z.object({
	id: z.string(),
	sourceKind: z.enum(["dm", "tweet"]),
	sourceId: z.string(),
	sourceUrl: z.string().nullable().optional(),
	sourceLabel: z.string(),
	shortUrl: z.string(),
	conversationId: z.string().nullable().optional(),
	createdAt: z.string(),
	text: z.string(),
	rawText: z.string(),
	commentText: z.string(),
	sharedContentText: z.string().nullable().optional(),
	hasComment: z.boolean(),
	isPureShare: z.boolean(),
	timelineTweetId: z.string().nullable().optional(),
	contentTweetId: z.string().nullable().optional(),
	contentTweetUrl: z.string().nullable().optional(),
	contentAuthor: profileRecordSchema.nullable().optional(),
	media: z.array(tweetMediaSchema),
	direction: z.string().nullable().optional(),
	accountHandle: z.string().nullable().optional(),
	sharedBy: profileRecordSchema.nullable().optional(),
	participant: profileRecordSchema.nullable().optional(),
});
const linkInsightItemSchema: z.ZodType<LinkInsightItem> = z.object({
	id: z.string(),
	kind: z.enum(["links", "videos"]),
	url: z.string(),
	canonicalKey: z.string(),
	displayUrl: z.string(),
	host: z.string(),
	title: z.string().nullable().optional(),
	description: z.string().nullable().optional(),
	shareCount: z.number(),
	uniqueSharers: z.number(),
	totalInfluence: z.number(),
	mentionCount: z.number(),
	commentCount: z.number(),
	pureShareCount: z.number(),
	hiddenMentionCount: z.number(),
	firstSeenAt: z.string(),
	lastSeenAt: z.string(),
	topSharer: profileRecordSchema.nullable().optional(),
	sharers: z.array(profileRecordSchema),
	mentions: z.array(linkInsightMentionSchema),
});
export const linkInsightResponseSchema = z.object({
	kind: z.enum(["links", "videos"]),
	range: z.enum(["today", "week", "month", "year", "all"]),
	sort: z.enum(["rank", "recent", "comments"]),
	source: z.enum(["all", "tweet", "dm"]),
	since: z.string().nullable(),
	until: z.string().nullable(),
	items: z.array(linkInsightItemSchema),
	stats: z.object({ occurrences: z.number(), groups: z.number() }),
});
export type LinkInsightResponse = z.infer<typeof linkInsightResponseSchema>;

const liveDataSourceKindSchema = z.enum(["birdclaw", "bird", "xurl"]);
const liveDataSourceAccountSchema = z.object({
	id: z.string().optional(),
	username: z.string().optional(),
	handle: z.string().optional(),
	app: z.string().optional(),
	isDefault: z.boolean().optional(),
});
const liveDataSourceStatusSchema = z.object({
	source: liveDataSourceKindSchema,
	label: z.string(),
	works: z.boolean(),
	installed: z.boolean().optional(),
	status: z.enum(["ok", "warning", "error"]),
	detail: z.string(),
	accounts: z.array(liveDataSourceAccountSchema),
});
const liveDataSourceCapabilitySchema = z.object({
	key: z.string(),
	label: z.string(),
	primary: liveDataSourceKindSchema,
	fallbacks: z.array(liveDataSourceKindSchema),
	notes: z.string().optional(),
});
export const liveDataSourcesResponseSchema = z.object({
	generatedAt: z.string(),
	sources: z.array(liveDataSourceStatusSchema),
	capabilities: z.array(liveDataSourceCapabilitySchema),
});
export type LiveDataSourcesResponse = z.infer<
	typeof liveDataSourcesResponseSchema
>;

export const networkMapResponseSchema = z.object({
	type: z.literal("FeatureCollection"),
	features: z.array(
		z.object({
			type: z.literal("Feature"),
			geometry: z.object({
				type: z.literal("Point"),
				coordinates: z.tuple([z.number(), z.number()]),
			}),
			properties: z.object({
				profileId: z.string(),
				handle: z.string(),
				name: z.string(),
				avatarUrl: z.string().nullable(),
				location: z.string(),
				resolvedLocation: z.string().nullable(),
				followersCount: z.number(),
				followingCount: z.number(),
				verified: z.boolean().nullable(),
				relationship: z.enum(["followers", "following", "mutual"]),
				approxRadiusM: z.number().nullable(),
			}),
		}),
	),
	meta: z.object({
		accountId: z.string(),
		type: z.enum(["all", "followers", "following", "mutual"]),
		totalProfiles: z.number(),
		profilesWithLocation: z.number(),
		meaningfulProfiles: z.number(),
		locatedProfiles: z.number(),
		missingGeocodes: z.number(),
		geocodedThisRun: z.number(),
		suppressedGeocodes: z.number(),
		opencageConfigured: z.boolean(),
		mapboxTokenConfigured: z.boolean(),
	}),
	config: z.object({ mapboxToken: z.string().nullable() }),
});
export type NetworkMapResponse = z.infer<typeof networkMapResponseSchema>;

const xurlRateLimitEndpointKeySchema = z.enum([
	"tweets_search_recent",
	"users_id_tweets",
]);
const xurlRateLimitEventSchema = z.object({
	id: z.string(),
	endpoint: xurlRateLimitEndpointKeySchema,
	status: z.enum(["ok", "rate_limited", "error"]),
	at: z.string(),
	source: z.string(),
	handle: z.string().optional(),
	detail: z.string().optional(),
});
const xurlRateLimitEndpointSchema = z.object({
	key: xurlRateLimitEndpointKeySchema,
	label: z.string(),
	method: z.string(),
	path: z.string(),
	description: z.string(),
	perAppLimit: z.number(),
	perUserLimit: z.number(),
	windowMs: z.number(),
	callsLastWindow: z.number(),
	estimatedRemaining: z.number(),
	usagePercent: z.number(),
	rateLimitedLastWindow: z.number(),
	errorsLastWindow: z.number(),
	lastEventAt: z.string().nullable(),
	lastRateLimitAt: z.string().nullable(),
	estimatedResetAt: z.string().nullable(),
	status: z.enum(["healthy", "warning", "critical", "quiet"]),
});
export const xurlRateLimitSnapshotSchema = z.object({
	generatedAt: z.string(),
	windowMs: z.number(),
	docsUrl: z.string(),
	summary: z.object({
		totalCallsLastWindow: z.number(),
		rateLimitedLastWindow: z.number(),
		errorLastWindow: z.number(),
		criticalEndpoints: z.number(),
		lastEventAt: z.string().nullable(),
	}),
	endpoints: z.array(xurlRateLimitEndpointSchema),
	events: z.array(xurlRateLimitEventSchema),
	throttle: z.object({
		conversationDelayMs: z.number(),
		rateLimitRetryMs: z.number(),
		rateLimitMaxRetries: z.number(),
	}),
});
export type XurlRateLimitSnapshot = z.infer<typeof xurlRateLimitSnapshotSchema>;

const profileHydrationResultSchema = z.object({
	handle: z.string(),
	status: z.enum(["hit", "miss", "error"]),
	source: z.enum(["cache", "bird", "xurl"]),
	profile: profileRecordSchema.optional(),
	error: z.string().optional(),
});
export const profileHydrationResponseSchema = z.object({
	ok: z.literal(true),
	results: z.array(profileHydrationResultSchema),
	hydratedProfiles: z.number().default(0),
});
export type ProfileHydrationResponse = z.infer<
	typeof profileHydrationResponseSchema
>;

export const linkPreviewMetadataSchema = z.object({
	url: z.string(),
	title: z.string().nullable(),
	description: z.string().nullable(),
	imageUrl: z.string().nullable(),
	siteName: z.string().nullable(),
	error: z.string().nullable().optional(),
});
export const linkPreviewResponseSchema = z.object({
	ok: z.literal(true),
	preview: linkPreviewMetadataSchema,
});
export type LinkPreviewResponse = z.infer<typeof linkPreviewResponseSchema>;

const actionTransportSchema = z.looseObject({
	ok: z.boolean().default(true),
	output: z.string().optional(),
	transport: z.enum(["bird", "xurl"]).optional(),
});
const profileActionResponseBaseSchema = z.looseObject({
	ok: z.boolean(),
	accountId: z.string().optional(),
	profile: profileRecordSchema.optional(),
	transport: actionTransportSchema.optional(),
	blockedAt: z.string().optional(),
	mutedAt: z.string().optional(),
});
const postActionResponseSchema = z.looseObject({
	ok: z.literal(true),
	transport: actionTransportSchema.optional(),
	tweetId: z.string().default(""),
});
const tweetReplyActionResponseSchema = z.looseObject({
	ok: z.literal(true),
	transport: actionTransportSchema.optional(),
	replyId: z.string().default(""),
});
const dmReplyActionResponseSchema = z.looseObject({
	ok: z.literal(true),
	transport: actionTransportSchema.optional(),
	messageId: z.string().default(""),
});
const scoreInboxActionResponseSchema = z.looseObject({
	ok: z.literal(true),
	scored: z.number().default(0),
	items: z
		.array(
			z.object({
				id: z.string(),
				score: z.number(),
				source: z.literal("openai"),
			}),
		)
		.default([]),
});
const syncBlocksActionResponseSchema = z.looseObject({
	ok: z.boolean(),
	accountId: z.string().optional(),
	synced: z.boolean().default(false),
	syncedCount: z.number().default(0),
	partial: z.boolean().optional(),
	transport: actionTransportSchema.optional(),
});

export const actionRequestSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("post"),
		accountId: z.string().optional(),
		text: z.string().default(""),
	}),
	z.object({
		kind: z.literal("replyTweet"),
		accountId: z.string().optional(),
		tweetId: z.string().default(""),
		text: z.string().default(""),
	}),
	z.object({
		kind: z.literal("replyDm"),
		conversationId: z.string().default(""),
		text: z.string().default(""),
		transport: z.enum(["bird", "xurl"]).optional(),
	}),
	z.object({
		kind: z.literal("scoreInbox"),
		scoreKind: inboxKindSchema.default("mixed"),
		account: z.string().optional(),
		limit: z.coerce.number().optional(),
	}),
	z.object({
		kind: z.literal("blockProfile"),
		accountId: z.string().optional(),
		query: z.string().default(""),
		transport: z.enum(["auto", "bird", "xurl"]).optional(),
	}),
	z.object({
		kind: z.literal("unblockProfile"),
		accountId: z.string().optional(),
		query: z.string().default(""),
		transport: z.enum(["auto", "bird", "xurl"]).optional(),
	}),
	z.object({
		kind: z.literal("muteProfile"),
		accountId: z.string().optional(),
		query: z.string().default(""),
		transport: z.enum(["auto", "bird", "xurl"]).optional(),
	}),
	z.object({
		kind: z.literal("unmuteProfile"),
		accountId: z.string().optional(),
		query: z.string().default(""),
		transport: z.enum(["auto", "bird", "xurl"]).optional(),
	}),
	z.object({
		kind: z.literal("syncBlocks"),
		accountId: z.string().optional(),
	}),
]);
export type ActionRequest = z.infer<typeof actionRequestSchema>;
export type ActionKind = ActionRequest["kind"];

export const actionResponseSchemas = {
	post: postActionResponseSchema,
	replyTweet: tweetReplyActionResponseSchema,
	replyDm: dmReplyActionResponseSchema,
	scoreInbox: scoreInboxActionResponseSchema,
	blockProfile: profileActionResponseBaseSchema.extend({
		action: z.literal("block").default("block"),
	}),
	unblockProfile: profileActionResponseBaseSchema.extend({
		action: z.literal("unblock").default("unblock"),
	}),
	muteProfile: profileActionResponseBaseSchema.extend({
		action: z.literal("mute").default("mute"),
	}),
	unmuteProfile: profileActionResponseBaseSchema.extend({
		action: z.literal("unmute").default("unmute"),
	}),
	syncBlocks: syncBlocksActionResponseSchema,
} as const;
export const actionResponseSchema = z.union([
	postActionResponseSchema,
	tweetReplyActionResponseSchema,
	dmReplyActionResponseSchema,
	scoreInboxActionResponseSchema,
	profileActionResponseBaseSchema.extend({ action: z.literal("block") }),
	profileActionResponseBaseSchema.extend({ action: z.literal("unblock") }),
	profileActionResponseBaseSchema.extend({ action: z.literal("mute") }),
	profileActionResponseBaseSchema.extend({ action: z.literal("unmute") }),
	syncBlocksActionResponseSchema,
]);
export type ActionResponseFor<K extends ActionKind> = z.infer<
	(typeof actionResponseSchemas)[K]
>;

export function actionResponseSchemaFor<K extends ActionKind>(kind: K) {
	return actionResponseSchemas[kind] as unknown as z.ZodType<
		ActionResponseFor<K>
	>;
}
