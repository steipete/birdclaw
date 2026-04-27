import { createFileRoute } from "@tanstack/react-router";
import { SavedTimelineView } from "#/components/SavedTimelineView";

export const Route = createFileRoute("/likes")({
	component: LikesRoute,
});

function LikesRoute() {
	return (
		<SavedTimelineView
			eyebrow="liked posts"
			filter="liked"
			loadingLabel="Loading liked posts..."
			searchPlaceholder="Search likes"
			title="Things worth keeping in the orbit."
		/>
	);
}
