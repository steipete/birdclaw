import type { z } from "zod";
import type * as contracts from "./api-contracts";
import type { FollowDirection, InboxKind, ResourceKind } from "./api-enums";

export type { FollowDirection, InboxKind, ResourceKind } from "./api-enums";

export type ReplyFilter = "all" | "replied" | "unreplied";
export type TimelineQualityFilter = "all" | "summary";

export type AccountRecord = z.infer<typeof contracts.accountRecordSchema>;

export type ProfileRecord = z.infer<typeof contracts.profileRecordSchema>;

export type ProfileAffiliation = z.infer<
	typeof contracts.profileAffiliationSchema
>;

export interface ProfileSnapshot {
	profileId: string;
	snapshotHash: string;
	observedAt: string;
	lastSeenAt: string;
	source: string;
	handle: string;
	displayName: string;
	bio: string;
	location: string | null;
	url: string | null;
	verifiedType: string | null;
	followersCount: number;
	followingCount: number;
	affiliations: unknown[];
}

export interface ProfileBioEntity {
	profileId: string;
	kind: "handle" | "domain" | "company_phrase";
	value: string;
	source: string;
	firstSeenAt: string;
	lastSeenAt: string;
	isActive: boolean;
}

export type TweetMentionEntity = NonNullable<TweetEntities["mentions"]>[number];

export type TweetUrlEntity = NonNullable<TweetEntities["urls"]>[number];

export type TweetHashtagEntity = NonNullable<TweetEntities["hashtags"]>[number];

export type TweetArticle = NonNullable<TweetEntities["article"]>;

export type TweetEntities = z.infer<typeof contracts.tweetEntitiesSchema>;

export type NoteTweet = z.infer<typeof contracts.noteTweetSchema>;

export type TweetMediaItem = z.infer<typeof contracts.tweetMediaSchema>;

export type EmbeddedTweet = z.infer<typeof contracts.embeddedTweetSchema>;

export interface TweetConversation {
	anchorId: string;
	items: EmbeddedTweet[];
	truncated: boolean;
}

export type BlockItem = z.infer<typeof contracts.blockItemSchema>;

export type BlockSearchItem = z.infer<typeof contracts.blockSearchItemSchema>;

export type TimelineItem = z.infer<typeof contracts.timelineItemSchema>;

export type DmMessageItem = z.infer<typeof contracts.dmMessageSchema>;

export type UrlExpansionItem = z.infer<typeof contracts.urlExpansionSchema>;

export interface LinkOccurrenceItem {
	sourceKind: "dm" | "tweet";
	sourceId: string;
	sourcePosition: number;
	shortUrl: string;
	accountId?: string | null;
	conversationId?: string | null;
	direction?: string | null;
	createdAt: string;
}

export interface LinkIndexItem {
	shortUrl: string;
	expandedUrl: string;
	finalUrl: string;
	status: "hit" | "miss" | "error";
	expandedTweetId?: string | null;
	expandedHandle?: string | null;
	title?: string | null;
	description?: string | null;
	imageUrl?: string | null;
	siteName?: string | null;
	error?: string | null;
	source: string;
	updatedAt: string;
}

export interface LinkSearchItem {
	occurrence: LinkOccurrenceItem;
	expansion: LinkIndexItem;
	sourceText: string;
	sourceAuthor?: ProfileRecord | null;
	participant?: ProfileRecord | null;
	linkedTweet?: TimelineItem | null;
}

export type LinkInsightKind = "links" | "videos";
export type LinkInsightRange = "today" | "week" | "month" | "year" | "all";
export type LinkInsightSort = "rank" | "recent" | "comments";
export type LinkInsightSource = "all" | "tweet" | "dm";

export type LinkInsightMention = z.infer<
	typeof contracts.linkInsightMentionSchema
>;

export type LinkInsightItem = z.infer<typeof contracts.linkInsightItemSchema>;

export interface LinkInsightQuery {
	account?: string;
	kind?: LinkInsightKind;
	range?: LinkInsightRange;
	sort?: LinkInsightSort;
	source?: LinkInsightSource;
	since?: string;
	until?: string;
	limit?: number;
	commentsLimit?: number;
	now?: Date;
}

export type DmSearchMatchItem = z.infer<typeof contracts.dmSearchMatchSchema>;

export type DmConversationItem = z.infer<typeof contracts.dmConversationSchema>;

export interface TimelineQuery {
	resource: Exclude<ResourceKind, "dms">;
	account?: string;
	listAccountId?: string;
	listId?: string;
	search?: string;
	replyFilter?: ReplyFilter;
	since?: string;
	until?: string;
	untilId?: string;
	includeReplies?: boolean;
	qualityFilter?: TimelineQualityFilter;
	lowQualityThreshold?: number;
	includeQualityReason?: boolean;
	likedOnly?: boolean;
	bookmarkedOnly?: boolean;
	limit?: number;
}

export interface DmQuery {
	account?: string;
	conversationIds?: string[];
	inbox?: "all" | "accepted" | "requests";
	participant?: string;
	search?: string;
	replyFilter?: ReplyFilter;
	since?: string;
	until?: string;
	minFollowers?: number;
	maxFollowers?: number;
	minInfluenceScore?: number;
	maxInfluenceScore?: number;
	sort?: "recent" | "followers" | "influence";
	context?: number;
	limit?: number;
}

export type TransportStatus = z.infer<typeof contracts.transportStatusSchema>;

export type LiveDataSourceKind = "birdclaw" | "bird" | "xurl";

export type LiveDataSourceAccount = z.infer<
	typeof contracts.liveDataSourceAccountSchema
>;

export type LiveDataSourceStatus = z.infer<
	typeof contracts.liveDataSourceStatusSchema
>;

export type LiveDataSourceCapability = z.infer<
	typeof contracts.liveDataSourceCapabilitySchema
>;

export type ModerationAction = "block" | "unblock" | "mute" | "unmute";
export type ModerationTransportKind = "bird" | "xurl";

export interface ModerationActionTransportResult {
	ok: boolean;
	output: string;
	transport: ModerationTransportKind;
}

export type ArchiveCandidate = z.infer<typeof contracts.archiveCandidateSchema>;

export type InboxItem = z.infer<typeof contracts.inboxItemSchema>;

export interface InboxQuery {
	kind?: InboxKind;
	account?: string;
	minScore?: number;
	hideLowSignal?: boolean;
	limit?: number;
}

export interface XurlPublicMetrics {
	retweet_count?: number;
	reply_count?: number;
	like_count?: number;
	quote_count?: number;
	bookmark_count?: number;
	impression_count?: number;
	followers_count?: number;
	following_count?: number;
	tweet_count?: number;
	listed_count?: number;
}

export interface XurlMentionUser {
	id: string;
	name: string;
	username: string;
	description?: string;
	location?: string;
	url?: string;
	verified?: boolean;
	verified_type?: string;
	profile_image_url?: string;
	entities?: Record<string, unknown>;
	affiliation?: Record<string, unknown>;
	public_metrics?: XurlPublicMetrics;
	created_at?: string;
	protected?: boolean;
}

export type XurlMentionData = XurlTweetData;

export interface XurlReferencedTweet {
	type: string;
	id: string;
}

export interface XurlUserTweet extends Omit<
	XurlTweetData,
	"author_id" | "in_reply_to_user_id"
> {
	author_id?: string;
}

export interface XurlTweetData {
	id: string;
	author_id: string;
	text: string;
	note_tweet?: XurlNoteTweet;
	created_at: string;
	conversation_id?: string;
	in_reply_to_user_id?: string;
	attachments?: XurlTweetAttachments;
	entities?: Record<string, unknown>;
	referenced_tweets?: XurlReferencedTweet[];
	public_metrics?: XurlPublicMetrics;
	edit_history_tweet_ids?: string[];
}

export interface XurlNoteTweet {
	text: string;
	entities?: Record<string, unknown>;
}

export interface XurlTweetAttachments {
	media_keys?: string[];
	poll_ids?: string[];
}

export interface XurlMediaItem {
	media_key: string;
	type: "photo" | "video" | "animated_gif" | string;
	url?: string;
	preview_image_url?: string;
	duration_ms?: number;
	width?: number;
	height?: number;
	alt_text?: string;
	public_metrics?: XurlPublicMetrics;
	variants?: Array<{
		url: string;
		content_type: string;
		bit_rate?: number;
	}>;
}

export type XurlMedia = XurlMediaItem;

export interface XurlTweetIncludes {
	users?: XurlMentionUser[];
	tweets?: XurlTweetData[];
	media?: XurlMedia[];
}

export interface XurlUserTweetsResponse {
	items: XurlUserTweet[];
	nextToken: string | null;
	includes?: XurlTweetIncludes;
}

export interface ProfileReplyItem {
	id: string;
	text: string;
	createdAt: string;
	conversationId?: string;
	replyToTweetId?: string;
	likeCount: number;
	replyCount: number;
	retweetCount: number;
	quoteCount: number;
	bookmarkCount: number;
	impressionCount: number;
}

export interface ProfileRepliesResponse {
	profile: ProfileRecord;
	externalUserId: string;
	items: ProfileReplyItem[];
	meta: {
		scannedCount: number;
		returnedCount: number;
		nextToken: string | null;
	};
}

export type XurlMentionsResponse = XurlTweetsResponse;

export interface XurlDmEvent {
	id: string;
	event_type?: string;
	text?: string;
	created_at?: string;
	dm_conversation_id?: string;
	sender_id?: string;
	participant_ids?: string[];
	attachments?: Record<string, unknown>;
	entities?: Record<string, unknown>;
	referenced_tweets?: XurlReferencedTweet[];
}

export interface XurlDmEventsResponse {
	data: XurlDmEvent[];
	includes?: {
		users?: XurlMentionUser[];
	};
	meta?: Record<string, unknown>;
}

export interface XurlTweetsResponse {
	data: XurlTweetData[];
	includes?: XurlTweetIncludes;
	meta?: Record<string, unknown>;
}

export interface XurlFollowUsersResponse {
	data: XurlMentionUser[];
	meta?: Record<string, unknown>;
}

export interface XListRecord {
	id: string;
	name: string;
	description?: string;
	memberCount?: number;
	followerCount?: number;
	isPrivate?: boolean;
	ownerId?: string;
	ownerUsername?: string;
	ownerName?: string;
	createdAt?: string;
	raw?: Record<string, unknown>;
}

export interface XListPage {
	data: XListRecord[];
	meta: {
		result_count: number;
		next_token?: string | null;
	};
}

export interface FollowGraphProfile {
	id: string;
	externalUserId: string;
	handle: string;
	displayName: string;
	bio: string;
	followersCount: number;
	publicMetrics: XurlPublicMetrics;
	avatarUrl?: string;
}

export type FollowEventKind = "started" | "ended";

export interface FollowGraphEvent {
	eventAt: string;
	direction: FollowDirection;
	kind: FollowEventKind;
	snapshotId: string;
	profile: FollowGraphProfile;
}

export interface FollowGraphSummary {
	accountId: string;
	followers: number;
	following: number;
	mutuals: number;
	nonMutualFollowing: number;
	lastCompleteSnapshots: Partial<Record<FollowDirection, string>>;
	lastIncompleteSnapshots: Partial<Record<FollowDirection, string>>;
}
