import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterContextProvider,
} from "@tanstack/react-router";
import {
	render as testingLibraryRender,
	type RenderOptions,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { DeploymentModeProvider } from "#/lib/deployment-mode";
import { queryKeys } from "#/lib/query-client";
import type { QueryEnvelope } from "#/lib/api-contracts";

export function createTestQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				gcTime: Infinity,
				retry: false,
			},
			mutations: {
				retry: false,
			},
		},
	});
}

export function renderWithQueryClient(
	ui: ReactNode,
	options?: Omit<RenderOptions, "wrapper"> & {
		queryClient?: QueryClient;
		readOnly?: boolean;
	},
) {
	const {
		queryClient = createTestQueryClient(),
		readOnly,
		...renderOptions
	} = options ?? {};
	if (readOnly !== undefined) {
		queryClient.setQueryDefaults(queryKeys.status, { staleTime: Infinity });
		queryClient.setQueryData(queryKeys.status, {
			readOnly,
			accounts: [],
			archives: [],
			transport: {
				installed: false,
				availableTransport: "local",
				statusText: "Cached archive",
			},
			stats: { home: 0, mentions: 0, dms: 0, needsReply: 0, inbox: 0 },
		} satisfies QueryEnvelope);
	}
	const router = createRouter({
		routeTree: createRootRoute(),
		history: createMemoryHistory(),
	});
	const result = testingLibraryRender(ui, {
		...renderOptions,
		wrapper: ({ children }) => (
			<RouterContextProvider router={router}>
				<QueryClientProvider client={queryClient}>
					{readOnly === undefined ? (
						children
					) : (
						<DeploymentModeProvider>{children}</DeploymentModeProvider>
					)}
				</QueryClientProvider>
			</RouterContextProvider>
		),
	});
	return { ...result, queryClient };
}
