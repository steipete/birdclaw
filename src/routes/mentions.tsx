import { createFileRoute } from "@tanstack/react-router";
import { TimelineRouteFrame } from "#/components/TimelineRouteFrame";
import type { QueryEnvelope } from "#/lib/types";

export const Route = createFileRoute("/mentions")({
	component: MentionsRoute,
});

function mentionsSubtitle(meta: QueryEnvelope | null) {
	if (!meta) return "Loading mentions...";
	return `${String(meta.stats.mentions)} mention/reply items in local store`;
}

function MentionsRoute() {
	return (
		<TimelineRouteFrame
			emptyDetail="Try All, search less narrowly, or sync mentions."
			emptyLabel="No mentions in this view"
			errorFallback="Mentions unavailable"
			errorTitle="Could not load mentions"
			initialReplyFilter="unreplied"
			loadingDetail="Checking local mentions and reply context"
			loadingLabel="Loading mentions"
			resource="mentions"
			searchPlaceholder="Search mentions"
			subtitle={mentionsSubtitle}
			syncKind="mentions"
			syncLabel="Sync mentions"
			title="Mentions"
		/>
	);
}
