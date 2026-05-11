import { createFileRoute } from "@tanstack/react-router";
import { resolveProfilesForHandles } from "#/lib/profile-resolver";

function json(data: unknown, init?: ResponseInit) {
	return new Response(JSON.stringify(data), {
		...init,
		headers: {
			"content-type": "application/json",
			...init?.headers,
		},
	});
}

function parseHandles(url: URL) {
	const rawValues = [
		...url.searchParams.getAll("handle"),
		...(url.searchParams.get("handles")?.split(",") ?? []),
	];
	return Array.from(
		new Set(
			rawValues
				.map((value) => value.trim().replace(/^@/, ""))
				.filter((value) => /^[A-Za-z0-9_]{1,15}$/.test(value)),
		),
	).slice(0, 50);
}

export const Route = createFileRoute("/api/profile-hydrate")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const url = new URL(request.url);
				const handles = parseHandles(url);
				if (handles.length === 0) {
					return json(
						{ ok: false, message: "Missing handles" },
						{ status: 400 },
					);
				}

				const results = await resolveProfilesForHandles(handles);
				return json({
					ok: true,
					results,
					hydratedProfiles: results.filter((result) => result.status === "hit")
						.length,
				});
			},
		},
	},
});
