import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import type { QueryEnvelope } from "./api-contracts";

export const queryKeys = {
	status: ["status"] as const,
	timelines: ["timeline"] as const,
	dms: ["dms"] as const,
	conversations: ["conversation"] as const,
	linkInsights: ["link-insights"] as const,
	linkPreviews: ["link-preview"] as const,
	profileHydration: ["profile-hydration"] as const,
	networkMap: ["network-map"] as const,
	blocks: ["blocks"] as const,
	blockSync: ["block-sync"] as const,
	inbox: ["inbox"] as const,
	dataSources: ["data-sources"] as const,
	rateLimits: ["rate-limits"] as const,
};

export function createBirdclawQueryClient(
	initialStatus?: QueryEnvelope | null,
) {
	const client = new QueryClient({
		defaultOptions: {
			queries: {
				gcTime: typeof window === "undefined" ? Infinity : 30 * 60_000,
				refetchOnWindowFocus: false,
				retry: 1,
				staleTime: 60_000,
			},
		},
	});
	if (initialStatus) client.setQueryData(queryKeys.status, initialStatus);
	return client;
}

export function BirdclawQueryProvider({
	children,
	initialStatus,
}: {
	children: ReactNode;
	initialStatus?: QueryEnvelope | null;
}) {
	const [queryClient] = useState(() =>
		createBirdclawQueryClient(initialStatus),
	);
	return (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
}
