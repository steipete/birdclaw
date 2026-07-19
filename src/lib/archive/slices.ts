import { getFirstEntry, getMatchingEntries } from "./reader";
import type { ArchiveImportSlice, ImportArchiveOptions } from "./types";

export interface ArchiveSliceEntries {
	accountEntry: string | undefined;
	profileEntry: string | undefined;
	tweetEntries: string[];
	deletedTweetEntries: string[];
	noteTweetEntries: string[];
	likeEntries: string[];
	bookmarkEntries: string[];
	dmEntries: string[];
	followerEntries: string[];
	followingEntries: string[];
}

export function selectedSlices(options: ImportArchiveOptions) {
	return options.select && options.select.length > 0
		? new Set<ArchiveImportSlice>(options.select)
		: null;
}

export function includesSlice(
	selection: Set<ArchiveImportSlice> | null,
	slice: ArchiveImportSlice,
) {
	return selection === null || selection.has(slice);
}

export function selectArchiveSliceEntries(
	entries: string[],
	selection: Set<ArchiveImportSlice> | null,
): ArchiveSliceEntries {
	const selected = (slice: ArchiveImportSlice, pattern: RegExp) =>
		includesSlice(selection, slice) ? getMatchingEntries(entries, pattern) : [];

	return {
		accountEntry: getFirstEntry(entries, /(?:^|\/)data\/account\.js$/i),
		profileEntry: getFirstEntry(entries, /(?:^|\/)data\/profile\.js$/i),
		tweetEntries: selected(
			"tweets",
			/(?:^|\/)data\/(?:tweets|community-tweet)(?:-part\d+)?\.js$/i,
		),
		deletedTweetEntries: selected(
			"tweets",
			/(?:^|\/)data\/(?:deleted-tweets?|deleted-tweet-headers)(?:-part\d+)?\.js$/i,
		),
		noteTweetEntries: selected(
			"tweets",
			/(?:^|\/)data\/note-tweet(?:-part\d+)?\.js$/i,
		),
		likeEntries: selected(
			"likes",
			/(?:^|\/)data\/(?:like|likes)(?:-part\d+)?\.js$/i,
		),
		bookmarkEntries: selected(
			"bookmarks",
			/(?:^|\/)data\/(?:bookmark|bookmarks)(?:-part\d+)?\.js$/i,
		),
		dmEntries: selected(
			"directMessages",
			/(?:^|\/)data\/direct-messages(?:-group)?(?:-part\d+)?\.js$/i,
		),
		followerEntries: selected(
			"followers",
			/(?:^|\/)data\/follower(?:-part\d+)?\.js$/i,
		),
		followingEntries: selected(
			"following",
			/(?:^|\/)data\/following(?:-part\d+)?\.js$/i,
		),
	};
}
