import { createFileRoute } from "@tanstack/react-router";
import { parseWebSyncKind, runWebSync } from "#/lib/web-sync";

function json(data: unknown, init?: ResponseInit) {
	return new Response(JSON.stringify(data), {
		...init,
		headers: {
			"content-type": "application/json",
			...init?.headers,
		},
	});
}

export const Route = createFileRoute("/api/sync")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const body = (await request.json().catch(() => ({}))) as Record<
					string,
					unknown
				>;
				const kind = parseWebSyncKind(body.kind);
				if (!kind) {
					return json(
						{ ok: false, message: "Unknown sync kind" },
						{ status: 400 },
					);
				}

				try {
					const result = await runWebSync(kind);
					return json(result, { status: result.inProgress ? 409 : 200 });
				} catch (error) {
					return json(
						{
							ok: false,
							kind,
							message: error instanceof Error ? error.message : "Sync failed",
						},
						{ status: 500 },
					);
				}
			},
		},
	},
});
