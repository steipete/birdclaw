import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { fetchQueryEnvelope } from "./api-client";
import { queryKeys } from "./query-client";

const DeploymentModeContext = createContext({ readOnly: false, ready: true });

export function DeploymentModeProvider({ children }: { children: ReactNode }) {
	const status = useQuery({
		queryKey: queryKeys.status,
		queryFn: ({ signal }) => fetchQueryEnvelope({ signal }),
	});
	const readOnly = status.data?.readOnly === true;
	const ready = status.isSuccess;
	const value = useMemo(() => ({ readOnly, ready }), [readOnly, ready]);
	return (
		<DeploymentModeContext.Provider value={value}>
			{children}
		</DeploymentModeContext.Provider>
	);
}

export function useDeploymentMode() {
	return useContext(DeploymentModeContext);
}
