export type ResourceKind = "home" | "mentions" | "authored" | "dms";
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
	followingCount?: number;
	avatarHue: number;
	avatarUrl?: string;
	location?: string;
	url?: string;
	verifiedType?: string;
	entities?: Record<string, unknown>;
	affiliations?: ProfileAffiliation[];
	primaryAffiliation?: ProfileAffiliation;
	createdAt: string;
}

export interface ProfileAffiliation {
	organizationProfileId: string;
	organizationName?: string;
	organizationHandle?: string;
	badgeUrl?: string | null;
	url?: string | null;
	label?: string | null;
	source: string;
	firstSeenAt: string;
	lastSeenAt: string;
	isActive: boolean;
}

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
	imageUrl?: string | null;
	siteName?: string | null;
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
	replyToId?: string | null;
	author: ProfileRecord;
	entities: TweetEntities;
	media: TweetMediaItem[];
}

export interface TweetConversationResponse {
	anchorId: string;
	items: EmbeddedTweet[];
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
	kind: "home" | "mention" | "authored" | "like" | "bookmark";
	text: string;
	searchSnippet?: string;
	createdAt: string;
	replyToId?: string | null;
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

export interface UrlExpansionItem {
	url: string;
	expandedUrl: string;
	finalUrl: string;
	status: "hit" | "miss" | "error";
	source: "cache" | "network";
	title?: string;
	description?: string | null;
	error?: string;
	updatedAt: string;
}

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

export interface LinkInsightMention {
	id: string;
	sourceKind: "dm" | "tweet";
	sourceId: string;
	sourceUrl?: string | null;
	sourceLabel: string;
	shortUrl: string;
	conversationId?: string | null;
	createdAt: string;
	text: string;
	rawText: string;
	commentText: string;
	sharedContentText?: string | null;
	hasComment: boolean;
	isPureShare: boolean;
	timelineTweetId?: string | null;
	contentTweetId?: string | null;
	contentTweetUrl?: string | null;
	contentAuthor?: ProfileRecord | null;
	media: TweetMediaItem[];
	direction?: string | null;
	accountHandle?: string | null;
	sharedBy?: ProfileRecord | null;
	participant?: ProfileRecord | null;
}

export interface LinkInsightItem {
	id: string;
	kind: LinkInsightKind;
	url: string;
	canonicalKey: string;
	displayUrl: string;
	host: string;
	title?: string | null;
	description?: string | null;
	shareCount: number;
	uniqueSharers: number;
	totalInfluence: number;
	mentionCount: number;
	commentCount: number;
	pureShareCount: number;
	hiddenMentionCount: number;
	firstSeenAt: string;
	lastSeenAt: string;
	topSharer?: ProfileRecord | null;
	sharers: ProfileRecord[];
	mentions: LinkInsightMention[];
}

export interface LinkInsightQuery {
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

export interface LinkInsightResponse {
	kind: LinkInsightKind;
	range: LinkInsightRange;
	sort: LinkInsightSort;
	source: LinkInsightSource;
	since: string | null;
	until: string | null;
	items: LinkInsightItem[];
	stats: {
		occurrences: number;
		groups: number;
	};
}

export interface DmSearchMatchItem {
	message: DmMessageItem;
	before: DmMessageItem[];
	after: DmMessageItem[];
	urlExpansions?: UrlExpansionItem[];
}

export interface DmConversationItem {
	id: string;
	accountId: string;
	accountHandle: string;
	title: string;
	searchSnippet?: string;
	lastMessageAt: string;
	lastMessagePreview: string;
	unreadCount: number;
	needsReply: boolean;
	influenceScore: number;
	influenceLabel: string;
	participant: ProfileRecord;
	matches?: DmSearchMatchItem[];
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
	conversationIds?: string[];
	participant?: string;
	search?: string;
	replyFilter?: ReplyFilter;
	minFollowers?: number;
	maxFollowers?: number;
	minInfluenceScore?: number;
	maxInfluenceScore?: number;
	sort?: "recent" | "influence";
	context?: number;
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

export interface XurlMentionData {
	id: string;
	author_id: string;
	text: string;
	created_at: string;
	conversation_id?: string;
	in_reply_to_user_id?: string;
	attachments?: XurlTweetAttachments;
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
	author_id?: string;
	text: string;
	created_at: string;
	conversation_id?: string;
	attachments?: XurlTweetAttachments;
	entities?: Record<string, unknown>;
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
	in_reply_to_user_id?: string;
	attachments?: XurlTweetAttachments;
	entities?: Record<string, unknown>;
	referenced_tweets?: XurlReferencedTweet[];
	public_metrics?: XurlPublicMetrics;
	edit_history_tweet_ids?: string[];
}

export interface XurlTweetAttachments {
	media_keys?: string[];
	poll_ids?: string[];
}

export interface XurlMedia {
	media_key: string;
	type: string;
	url?: string;
	preview_image_url?: string;
	width?: number;
	height?: number;
	alt_text?: string;
}

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

export type FollowDirection = "followers" | "following";

export interface XurlFollowUsersResponse {
	data: XurlMentionUser[];
	meta?: Record<string, unknown>;
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
