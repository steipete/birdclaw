export type ResourceKind = "home" | "mentions" | "dms";
export type InboxKind = "mixed" | "mentions" | "dms";

export type ReplyFilter = "all" | "replied" | "unreplied";
export type TimelineQualityFilter = "all" | "summary";

export interface AccountRecord {
	id: string;
	name: string;
	handle: string;
	externalUserId?: string | null;
	transport: string;
	isDefault: number;
	createdAt: string;
}

export interface ProfileRecord {
	id: string;
	handle: string;
	displayName: string;
	bio: string;
	followersCount: number;
	avatarHue: number;
	avatarUrl?: string;
	createdAt: string;
}

export interface TweetMentionEntity {
	username: string;
	id?: string;
	start: number;
	end: number;
	profile?: ProfileRecord;
}

export interface TweetUrlEntity {
	url: string;
	expandedUrl: string;
	displayUrl: string;
	start: number;
	end: number;
	title?: string;
	description?: string | null;
}

export interface TweetHashtagEntity {
	tag: string;
	start: number;
	end: number;
}

export interface TweetEntities {
	mentions?: TweetMentionEntity[];
	urls?: TweetUrlEntity[];
	hashtags?: TweetHashtagEntity[];
}

export interface TweetMediaItem {
	url: string;
	type: "image" | "video" | "gif" | "unknown";
	altText?: string;
	width?: number;
	height?: number;
	thumbnailUrl?: string;
}

export interface EmbeddedTweet {
	id: string;
	text: string;
	createdAt: string;
	author: ProfileRecord;
	entities: TweetEntities;
	media: TweetMediaItem[];
}

export interface BlockItem {
	accountId: string;
	accountHandle: string;
	source: string;
	blockedAt: string;
	profile: ProfileRecord;
}

export interface BlockSearchItem {
	profile: ProfileRecord;
	isBlocked: boolean;
	blockedAt?: string;
}

export interface BlockListResponse {
	items: BlockItem[];
	matches: BlockSearchItem[];
}

export interface TimelineItem {
	id: string;
	accountId: string;
	accountHandle: string;
	kind: "home" | "mention" | "like" | "bookmark";
	text: string;
	createdAt: string;
	isReplied: boolean;
	likeCount: number;
	mediaCount: number;
	bookmarked: boolean;
	liked: boolean;
	author: ProfileRecord;
	entities: TweetEntities;
	media: TweetMediaItem[];
	replyToTweet?: EmbeddedTweet | null;
	quotedTweet?: EmbeddedTweet | null;
	qualityReason?: string | null;
}

export interface DmMessageItem {
	id: string;
	conversationId: string;
	text: string;
	createdAt: string;
	direction: "inbound" | "outbound";
	isReplied: boolean;
	mediaCount: number;
	sender: ProfileRecord;
}

export interface DmConversationItem {
	id: string;
	accountId: string;
	accountHandle: string;
	title: string;
	lastMessageAt: string;
	lastMessagePreview: string;
	unreadCount: number;
	needsReply: boolean;
	influenceScore: number;
	influenceLabel: string;
	participant: ProfileRecord;
}

export interface TimelineQuery {
	resource: Exclude<ResourceKind, "dms">;
	account?: string;
	search?: string;
	replyFilter?: ReplyFilter;
	since?: string;
	until?: string;
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
	participant?: string;
	search?: string;
	replyFilter?: ReplyFilter;
	minFollowers?: number;
	maxFollowers?: number;
	minInfluenceScore?: number;
	maxInfluenceScore?: number;
	sort?: "recent" | "influence";
	limit?: number;
}

export interface TransportStatus {
	installed: boolean;
	availableTransport: "xurl" | "local";
	statusText: string;
	rawStatus?: string;
}

export type ModerationAction = "block" | "unblock" | "mute" | "unmute";
export type ModerationTransportKind = "bird" | "xurl" | "x-web";

export interface ModerationActionTransportResult {
	ok: boolean;
	output: string;
	transport: ModerationTransportKind;
}

export interface ArchiveCandidate {
	path: string;
	name: string;
	size: number;
	sizeFormatted: string;
	modifiedTime: string;
	dateFormatted: string;
}

export interface QueryEnvelope {
	accounts: AccountRecord[];
	archives: ArchiveCandidate[];
	transport: TransportStatus;
	stats: {
		home: number;
		mentions: number;
		dms: number;
		needsReply: number;
		inbox: number;
	};
}

export interface QueryResponse {
	resource: ResourceKind;
	items: TimelineItem[] | DmConversationItem[];
	selectedConversation?: {
		conversation: DmConversationItem;
		messages: DmMessageItem[];
	} | null;
}

export interface InboxItem {
	id: string;
	entityId: string;
	entityKind: "mention" | "dm";
	accountId: string;
	accountHandle: string;
	title: string;
	text: string;
	createdAt: string;
	needsReply: boolean;
	influenceScore: number;
	participant: ProfileRecord;
	source: "heuristic" | "openai";
	score: number;
	summary: string;
	reasoning: string;
}

export interface InboxQuery {
	kind?: InboxKind;
	minScore?: number;
	hideLowSignal?: boolean;
	limit?: number;
}

export interface InboxResponse {
	items: InboxItem[];
	stats: {
		total: number;
		openai: number;
		heuristic: number;
	};
}

export interface XurlPublicMetrics {
	retweet_count?: number;
	reply_count?: number;
	like_count?: number;
	quote_count?: number;
	bookmark_count?: number;
	impression_count?: number;
	followers_count?: number;
}

export interface XurlMentionUser {
	id: string;
	name: string;
	username: string;
	description?: string;
	profile_image_url?: string;
	public_metrics?: XurlPublicMetrics;
	created_at?: string;
}

export interface XurlMentionData {
	id: string;
	author_id: string;
	text: string;
	created_at: string;
	conversation_id?: string;
	entities?: Record<string, unknown>;
	referenced_tweets?: XurlReferencedTweet[];
	public_metrics?: XurlPublicMetrics;
	edit_history_tweet_ids?: string[];
}

export interface XurlReferencedTweet {
	type: string;
	id: string;
}

export interface XurlUserTweet {
	id: string;
	text: string;
	created_at: string;
	conversation_id?: string;
	referenced_tweets?: XurlReferencedTweet[];
	public_metrics?: XurlPublicMetrics;
	edit_history_tweet_ids?: string[];
}

export interface XurlTweetData {
	id: string;
	author_id: string;
	text: string;
	created_at: string;
	conversation_id?: string;
	entities?: Record<string, unknown>;
	referenced_tweets?: XurlReferencedTweet[];
	public_metrics?: XurlPublicMetrics;
	edit_history_tweet_ids?: string[];
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

export interface XurlMentionsResponse {
	data: XurlMentionData[];
	includes?: {
		users?: XurlMentionUser[];
	};
	meta?: Record<string, unknown>;
}

export interface XurlTweetsResponse {
	data: XurlTweetData[];
	includes?: {
		users?: XurlMentionUser[];
	};
	meta?: Record<string, unknown>;
}
