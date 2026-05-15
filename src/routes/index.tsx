import { createFileRoute } from "@tanstack/react-router";
import { TimelineRouteFrame } from "#/components/TimelineRouteFrame";
import type { QueryEnvelope } from "#/lib/types";

export const Route = createFileRoute("/")({
	component: HomeRoute,
});

function homeSubtitle(meta: QueryEnvelope | null) {
	if (!meta) return "Loading local context...";
	return `${String(meta.stats.home)} items · ${String(meta.stats.needsReply)} waiting · ${meta.transport.statusText}`;
}

function HomeRoute() {
	return (
		<TimelineRouteFrame
			emptyDetail="Try a different filter or sync the timeline again."
			emptyLabel="No posts in this view"
			errorFallback="Timeline unavailable"
			errorTitle="Could not load posts"
			initialReplyFilter="all"
			loadingDetail="Reading the local timeline store"
			loadingLabel="Loading posts"
			resource="home"
			searchPlaceholder="Search local timeline"
			subtitle={homeSubtitle}
			syncKind="timeline"
			syncLabel="Sync timeline"
			title="Home"
		/>
	);
}
