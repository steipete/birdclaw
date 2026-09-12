import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

export const queryKeys = {
	status: ["status"] as const,
	timelines: ["timeline"] as const,
	dms: ["dms"] as const,
	dmThreads: ["dm-thread"] as const,
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

export function createBirdclawQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				gcTime: 30 * 60_000,
				refetchOnWindowFocus: false,
				retry: 1,
				staleTime: 60_000,
			},
		},
	});
}

export function BirdclawQueryProvider({ children }: { children: ReactNode }) {
	const [queryClient] = useState(createBirdclawQueryClient);
	return (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
}
