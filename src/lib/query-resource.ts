import {
	getConversationThread,
	listDmConversations,
	type DmMessageCursor,
} from "./dm-read-model";
import { listTimelineItems } from "./timeline-read-model";
import type { QueryResponse } from "./api-contracts";
import type { DmQuery, TimelineQuery } from "./types";

export type { QueryResponse } from "./api-contracts";

export function queryResource(
	resource: "home" | "mentions" | "authored" | "search" | "dms",
	filters: (TimelineQuery | DmQuery) & {
		conversationId?: string;
		view?: "list" | "conversation";
		messageLimit?: number;
		before?: DmMessageCursor;
	},
): QueryResponse {
	if (resource === "dms") {
		const dmFilters = filters as DmQuery & {
			conversationId?: string;
			view?: "list" | "conversation";
			messageLimit?: number;
			before?: DmMessageCursor;
		};
		if (dmFilters.view === "conversation") {
			return {
				resource,
				items: [],
				selectedConversation: dmFilters.conversationId
					? getConversationThread(dmFilters.conversationId, {
							account: dmFilters.account,
							messageLimit: dmFilters.messageLimit,
							before: dmFilters.before,
						})
					: null,
			};
		}
		const items = listDmConversations(dmFilters);
		if (dmFilters.view === "list") return { resource, items };
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
						messageLimit: dmFilters.messageLimit,
						before: dmFilters.before,
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
