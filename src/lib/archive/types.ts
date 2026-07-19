export const ARCHIVE_IMPORT_SLICES = [
	"tweets",
	"likes",
	"bookmarks",
	"directMessages",
	"profiles",
	"followers",
	"following",
] as const;

export type ArchiveImportSlice = (typeof ARCHIVE_IMPORT_SLICES)[number];

export type ImportProgressSlice =
	| "tweets"
	| "deletedTweets"
	| "noteTweets"
	| "directMessages"
	| "likes"
	| "bookmarks"
	| "media"
	| "followers"
	| "following";

export type ImportWritePhase =
	| "profiles"
	| "tweets"
	| "collections"
	| "dmMessages";

export type ImportProgressEvent =
	| { kind: "scanned"; entryCount: number }
	| { kind: "slice-start"; slice: ImportProgressSlice; files: number }
	| {
			kind: "slice-file";
			slice: ImportProgressSlice;
			processed: number;
			files: number;
	  }
	| { kind: "slice-done"; slice: ImportProgressSlice; count: number }
	| { kind: "writing" }
	| { kind: "write-start"; phase: ImportWritePhase; total: number }
	| {
			kind: "write-progress";
			phase: ImportWritePhase;
			processed: number;
			total: number;
	  }
	| { kind: "done" };

export interface ImportArchiveOptions {
	select?: ArchiveImportSlice[];
	restore?: boolean;
	onProgress?: (event: ImportProgressEvent) => void;
}

export type ArchiveRecord = Record<string, unknown>;

export interface ArchiveAccountPayload {
	accountId: string;
	username: string;
	displayName: string;
	createdAt: string;
	bio: string;
}

export type ArchiveMediaKind =
	| "tweets"
	| "dms"
	| "community"
	| "profile"
	| "deleted"
	| "moments"
	| "dmGroup";

export type ArchiveMediaFileCounts = Record<ArchiveMediaKind, number>;

export type ArchiveFollowDirection = "followers" | "following";
export type ArchiveFollowKey = "follower" | "following";

export interface ImportedArchiveSummary {
	ok: true;
	mode: "merge" | "restore";
	archivePath: string;
	account: {
		id: string;
		handle: string;
		displayName: string;
	};
	counts: {
		tweets: number;
		likes: number;
		bookmarks: number;
		dmConversations: number;
		dmMessages: number;
		profiles: number;
		mediaFiles: ArchiveMediaFileCounts;
		followers: number;
		following: number;
	};
}
