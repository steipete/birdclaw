export type ArchiveTweetRow = {
	id: string;
	kind: "home" | "like" | "bookmark";
	authorProfileId: string;
	text: string;
	createdAt: string;
	isReplied: number;
	replyToId: string | null;
	likeCount: number;
	mediaCount: number;
	bookmarked: number;
	liked: number;
	entitiesJson: string;
	mediaJson: string;
	quotedTweetId: string | null;
	deletedAt?: string | null;
	deletionSource?: string | null;
	deletionReason?: string | null;
	editHistoryIds?: string[];
	rawJson?: string | null;
};

export type ArchiveCollectionRow = {
	tweetId: string;
	kind: "likes" | "bookmarks";
	collectedAt: string | null;
	source: string;
	rawJson: string;
};

export type ArchiveProfileRow = {
	id: string;
	handle: string;
	displayName: string;
	bio: string;
	followersCount: number;
	followingCount: number;
	publicMetricsJson: string;
	avatarHue: number;
	avatarUrl: string | null;
	location: string | null;
	url: string | null;
	verifiedType: string | null;
	entitiesJson: string;
	rawJson: string;
	createdAt: string;
};

export type ArchiveConversationRow = {
	id: string;
	title: string;
	accountId: string;
	participantProfileId: string;
	lastMessageAt: string;
	unreadCount: number;
	needsReply: number;
};

export type ArchiveMessageRow = {
	id: string;
	conversationId: string;
	senderProfileId: string;
	text: string;
	createdAt: string;
	direction: "inbound" | "outbound";
	mediaCount: number;
};

export type ArchiveFollowRow = {
	profileId: string;
	externalUserId: string;
};

export class ArchiveImportPlan {
	readonly mentionDirectory = new Map<
		string,
		{ handle?: string; displayName?: string }
	>();
	readonly tweets: ArchiveTweetRow[] = [];
	readonly collections: ArchiveCollectionRow[] = [];
	readonly profiles = new Map<string, ArchiveProfileRow>();
	readonly conversations = new Map<string, ArchiveConversationRow>();
	readonly dmMessages: ArchiveMessageRow[] = [];
	readonly followers: ArchiveFollowRow[] = [];
	readonly following: ArchiveFollowRow[] = [];
	readonly followerIds = new Set<string>();
	readonly followingIds = new Set<string>();

	private readonly tweetsById = new Map<string, ArchiveTweetRow>();

	addTweet(row: ArchiveTweetRow) {
		const existing = this.tweetsById.get(row.id);
		if (existing) {
			const epoch = new Date(0).toISOString();
			existing.bookmarked = Math.max(existing.bookmarked, row.bookmarked);
			existing.liked = Math.max(existing.liked, row.liked);
			if (!existing.text && row.text) existing.text = row.text;
			if (existing.createdAt === epoch && row.createdAt !== epoch) {
				existing.createdAt = row.createdAt;
			}
			existing.isReplied = Math.max(existing.isReplied, row.isReplied);
			existing.replyToId ??= row.replyToId;
			existing.likeCount = Math.max(existing.likeCount, row.likeCount);
			existing.mediaCount = Math.max(existing.mediaCount, row.mediaCount);
			if (existing.entitiesJson === "{}" && row.entitiesJson !== "{}") {
				existing.entitiesJson = row.entitiesJson;
			}
			if (existing.mediaJson === "[]" && row.mediaJson !== "[]") {
				existing.mediaJson = row.mediaJson;
			}
			existing.quotedTweetId ??= row.quotedTweetId;
			if (
				row.deletedAt &&
				(!existing.deletedAt || row.deletedAt < existing.deletedAt)
			) {
				existing.deletedAt = row.deletedAt;
				existing.deletionSource = row.deletionSource;
				existing.deletionReason = row.deletionReason;
			}
			const existingEditIds = existing.editHistoryIds ?? [];
			const rowEditIds = row.editHistoryIds ?? [];
			const primaryEditIds =
				rowEditIds.length > existingEditIds.length
					? rowEditIds
					: existingEditIds;
			const secondaryEditIds =
				primaryEditIds === rowEditIds ? existingEditIds : rowEditIds;
			existing.editHistoryIds = Array.from(
				new Set([...primaryEditIds, ...secondaryEditIds]),
			);
			if (!existing.rawJson && row.rawJson) existing.rawJson = row.rawJson;
			return existing;
		}
		this.tweets.push(row);
		this.tweetsById.set(row.id, row);
		return row;
	}

	getTweet(id: string) {
		return this.tweetsById.get(id);
	}
}
