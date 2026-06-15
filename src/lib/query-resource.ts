import { getConversationThread, listDmConversations } from "./dm-read-model";
import { listTimelineItems } from "./timeline-read-model";
import type { DmQuery, QueryResponse, TimelineQuery } from "./types";

export type { QueryResponse } from "./types";

export function queryResource(
	resource: "home" | "mentions" | "authored" | "search" | "dms",
	filters: (TimelineQuery | DmQuery) & { conversationId?: string },
): QueryResponse {
	if (resource === "dms") {
		const dmFilters = filters as DmQuery & { conversationId?: string };
		const items = listDmConversations(dmFilters);
		const requestedConversationId = dmFilters.conversationId;
		const selectedConversationId =
			requestedConversationId &&
			items.some((item) => item.id === requestedConversationId)
				? requestedConversationId
				: items[0]?.id;
		return {
			resource,
			items,
			selectedConversation: selectedConversationId
				? getConversationThread(selectedConversationId, {
						account: dmFilters.account,
					})
				: null,
		};
	}

	const { resource: _filterResource, ...timelineFilters } =
		filters as TimelineQuery;

	return {
		resource,
		items: listTimelineItems({
			resource,
			...timelineFilters,
		}),
	};
}
