import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createContext,
	createElement,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";
import { tweetConversationResponseSchema } from "#/lib/api-contracts";
import { fetchJson } from "#/lib/api-client";
import { queryKeys } from "./query-client";

type ConversationStatus = "idle" | "loading" | "ready" | "error";

interface ConversationSurfaceState {
	expandedSurfaceId: string | null;
	setExpandedSurfaceId: (surfaceId: string | null) => void;
}

const ConversationSurfaceContext =
	createContext<ConversationSurfaceState | null>(null);

export function conversationQueryOptions(tweetId: string) {
	return queryOptions({
		queryKey: [...queryKeys.conversations, tweetId] as const,
		queryFn: () =>
			fetchJson(
				`/api/conversation?tweetId=${encodeURIComponent(tweetId)}`,
				undefined,
				tweetConversationResponseSchema,
				"Conversation unavailable",
			).then((data) => data.items),
		staleTime: Number.POSITIVE_INFINITY,
	});
}

export function ConversationSurfaceScope({
	children,
}: {
	children: ReactNode;
}) {
	const [expandedSurfaceId, setExpandedSurfaceId] = useState<string | null>(
		null,
	);
	const value = useMemo(
		() => ({ expandedSurfaceId, setExpandedSurfaceId }),
		[expandedSurfaceId],
	);
	return createElement(
		ConversationSurfaceContext.Provider,
		{ value },
		children,
	);
}

export function useConversationSurface(surfaceId: string, tweetId = surfaceId) {
	const scope = useContext(ConversationSurfaceContext);
	const [localExpandedSurfaceId, setLocalExpandedSurfaceId] = useState<
		string | null
	>(null);
	const expandedSurfaceId = scope?.expandedSurfaceId ?? localExpandedSurfaceId;
	const setExpandedSurfaceId =
		scope?.setExpandedSurfaceId ?? setLocalExpandedSurfaceId;
	const isOpen = expandedSurfaceId === surfaceId;
	const queryClient = useQueryClient();
	const query = useQuery({
		...conversationQueryOptions(tweetId),
		enabled: isOpen,
	});

	const toggle = useCallback(() => {
		setExpandedSurfaceId(isOpen ? null : surfaceId);
	}, [isOpen, setExpandedSurfaceId, surfaceId]);
	const prefetch = useCallback(() => {
		void queryClient.prefetchQuery(conversationQueryOptions(tweetId));
	}, [queryClient, tweetId]);
	const status: ConversationStatus = query.isError
		? "error"
		: query.isFetching
			? "loading"
			: query.data
				? "ready"
				: "idle";

	return {
		error: query.error instanceof Error ? query.error.message : null,
		isOpen,
		items: query.data ?? [],
		loading: query.isFetching,
		prefetch,
		status,
		toggle,
	};
}
