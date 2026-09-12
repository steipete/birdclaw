import { createIsomorphicFn } from "@tanstack/react-start";

export const loadStatusBootstrap = createIsomorphicFn()
	.server(async () => {
		try {
			const [{ getRequest }, { readStatusBootstrap }] = await Promise.all([
				import("@tanstack/react-start/server"),
				import("./status-bootstrap.server"),
			]);
			return await readStatusBootstrap(getRequest());
		} catch {
			return null;
		}
	})
	.client(() => null);
