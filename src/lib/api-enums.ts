import { z } from "zod";
import { isTweetPermalinkPath } from "./tweet-permalink";

export const READ_ONLY_ARCHIVE_PAGES: readonly string[] = [
	"/",
	"/inbox",
	"/mentions",
	"/likes",
	"/bookmarks",
	"/links",
	"/dms",
	"/blocks",
	"/network-map",
];

export function isReadOnlyArchivePage(pathname: string) {
	return (
		READ_ONLY_ARCHIVE_PAGES.includes(pathname) || isTweetPermalinkPath(pathname)
	);
}

export const resourceKindSchema = z.enum([
	"home",
	"mentions",
	"authored",
	"search",
	"dms",
]);
export type ResourceKind = z.infer<typeof resourceKindSchema>;

export const inboxKindSchema = z.enum(["mixed", "mentions", "dms"]);
export type InboxKind = z.infer<typeof inboxKindSchema>;

export const dmDirectionSchema = z.enum(["inbound", "outbound"]);

export const timelineCollectionKindSchema = z.enum(["likes", "bookmarks"]);
export type TimelineCollectionKind = z.infer<
	typeof timelineCollectionKindSchema
>;

export const followDirectionSchema = z.enum(["followers", "following"]);
export type FollowDirection = z.infer<typeof followDirectionSchema>;

export const webSyncKindSchema = z.enum([
	"timeline",
	"mentions",
	"likes",
	"bookmarks",
	"dms",
]);
export type WebSyncKind = z.infer<typeof webSyncKindSchema>;
