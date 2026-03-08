import { createFileRoute } from "@tanstack/react-router";
import { getBlocksResponse } from "#/lib/blocks";

function parseNumber(value: string | null) {
	if (!value) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export const Route = createFileRoute("/api/blocks")({
	server: {
		handlers: {
			GET: ({ request }) => {
				const url = new URL(request.url);
				return new Response(
					JSON.stringify(
						getBlocksResponse({
							accountId: url.searchParams.get("account") ?? undefined,
							search: url.searchParams.get("search") ?? undefined,
							limit: parseNumber(url.searchParams.get("limit")) ?? 12,
						}),
					),
					{
						headers: {
							"content-type": "application/json",
						},
					},
				);
			},
		},
	},
});
