import { createFileRoute } from "@tanstack/react-router";
import { getOrFetchLinkPreview } from "#/lib/link-preview-metadata";

function json(data: unknown, init?: ResponseInit) {
	return new Response(JSON.stringify(data), {
		...init,
		headers: {
			"content-type": "application/json",
			...init?.headers,
		},
	});
}

function parseUrl(value: string | null) {
	if (!value) return null;
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return null;
		}
		return parsed.toString();
	} catch {
		return null;
	}
}

export const Route = createFileRoute("/api/link-preview")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const url = new URL(request.url);
				const previewUrl = parseUrl(url.searchParams.get("url"));
				const shortUrl = parseUrl(url.searchParams.get("shortUrl"));
				if (!previewUrl) {
					return json({ ok: false, message: "Missing url" }, { status: 400 });
				}

				const preview = await getOrFetchLinkPreview(previewUrl, { shortUrl });
				return json({ ok: true, preview });
			},
		},
	},
});
