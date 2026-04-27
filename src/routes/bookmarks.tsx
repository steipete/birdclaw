import { createFileRoute } from "@tanstack/react-router";
import { SavedTimelineView } from "#/components/SavedTimelineView";

export const Route = createFileRoute("/bookmarks")({
	component: BookmarksRoute,
});

function BookmarksRoute() {
	return (
		<SavedTimelineView
			eyebrow="bookmarks"
			filter="bookmarked"
			loadingLabel="Loading bookmarks..."
			searchPlaceholder="Search bookmarks"
			title="Saved threads, receipts, and future rabbit holes."
		/>
	);
}
