export type ResourceKind = "home" | "mentions" | "dms";
export type InboxKind = "mixed" | "mentions" | "dms";

export type ReplyFilter = "all" | "replied" | "unreplied";

export interface AccountRecord {
	id: string;
	name: string;
	handle: string;
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
	createdAt: string;
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
	kind: Exclude<ResourceKind, "dms">;
	text: string;
	createdAt: string;
	isReplied: boolean;
	likeCount: number;
	mediaCount: number;
	bookmarked: boolean;
	liked: boolean;
	author: ProfileRecord;
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
