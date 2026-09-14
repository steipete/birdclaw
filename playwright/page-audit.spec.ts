import { expect, test } from "@playwright/test";
import { queryEnvelopeSchema } from "../src/lib/api-contracts";

test("loads every archive page and gates every provider-only page", async ({
	page,
	context,
	baseURL,
}) => {
	if (!baseURL) throw new Error("Missing base URL");
	await context.addCookies([
		{ name: "birdclaw_token", value: "birdclaw-e2e-token", url: baseURL },
	]);
	const status = queryEnvelopeSchema.parse({
		readOnly: true,
		accounts: [
			{
				id: "acct_primary",
				name: "Synthetic archive",
				handle: "@archive",
				isDefault: 1,
				transport: "local",
				createdAt: "2026-01-01T00:00:00Z",
			},
		],
		archives: [],
		transport: {
			installed: false,
			availableTransport: "local",
			statusText: "Read-only archive",
		},
		stats: { home: 1, mentions: 1, dms: 1, needsReply: 0, inbox: 1 },
	});
	await page.route("**/api/status", (route) => route.fulfill({ json: status }));

	await page.route("**/api/data-sources", (route) =>
		route.fulfill({
			json: {
				generatedAt: "2026-09-13T00:00:00Z",
				sources: [],
				capabilities: [],
			},
		}),
	);
	// These routes can mount before deployment status resolves; keep the audit offline.
	for (const endpoint of [
		"profile-analysis",
		"period-digest",
		"search-discussion",
	]) {
		await page.route(`**/api/${endpoint}**`, (route) =>
			route.fulfill({
				contentType: "application/x-ndjson",
				body:
					JSON.stringify({
						type: "error",
						error: "Synthetic provider disabled",
					}) + "\n",
			}),
		);
	}
	const pages = [
		["/", "Home", "/api/query"],
		["/mentions", "Mentions", "/api/query"],
		["/likes", "Likes", "/api/query"],
		["/bookmarks", "Bookmarks", "/api/query"],
		["/dms", "Messages", "/api/query"],
		["/inbox", "Inbox", "/api/inbox"],
		["/blocks", "Blocks", "/api/blocks"],
		["/links", "Links", "/api/link-insights"],
		["/network-map", "Network Map", "/api/network-map"],
	];
	for (const [path, heading, endpoint] of pages) {
		const data = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname === endpoint && response.ok(),
		);
		await page.goto(path);
		await expect(
			page.getByText("Read-only archive", { exact: true }),
		).toHaveCount(1);
		await data;
		await expect(
			page.getByRole("heading", { name: heading, exact: true }),
		).toBeVisible();
	}
	for (const path of [
		"/today",
		"/discuss",
		"/profile-analyze",
		"/profiles/synthetic",
		"/data-sources",
		"/rate-limits",
	]) {
		await page.goto(path);
		await expect(
			page.getByText("Read-only archive", { exact: true }),
		).toHaveCount(1);
		await expect(
			page.getByText(
				"This page is unavailable in a read-only archive deployment.",
			),
		).toBeVisible();
	}
});
