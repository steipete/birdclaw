import { createFileRoute } from "@tanstack/react-router";
import { getWebSyncJob, parseWebSyncKind, startWebSync } from "#/lib/web-sync";

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
			GET: ({ request }) => {
				const url = new URL(request.url);
				const id = url.searchParams.get("id");
				if (!id) {
					return json(
						{ ok: false, message: "Missing sync job id" },
						{ status: 400 },
					);
				}

				const job = getWebSyncJob(id);
				if (!job) {
					return json(
						{ ok: false, message: "Sync job not found" },
						{ status: 404 },
					);
				}

				return json(job);
			},
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

				const job = startWebSync(kind);
				return json(job, { status: job.inProgress ? 202 : 200 });
			},
		},
	},
});
