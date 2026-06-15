import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

test.beforeEach(async ({ context, baseURL }) => {
	if (!baseURL) throw new Error("Playwright baseURL is required");
	await context.addCookies([
		{
			name: "birdclaw_token",
			value: "birdclaw-e2e-token",
			url: baseURL,
		},
	]);
});

async function selectAccount(page: Page, accountHandle: string) {
	await page.getByRole("button", { name: /^Active account:/ }).click();
	await page
		.getByRole("listbox", { name: "Active account" })
		.getByRole("option", { name: new RegExp(accountHandle) })
		.click();
	await expect(
		page.getByRole("button", {
			name: new RegExp(`^Active account: ${accountHandle}$`),
		}),
	).toBeVisible();
}

async function waitForSyncSurface(page: Page, path: string) {
	if (path === "/mentions") {
		await expect(page.getByRole("heading", { name: "Mentions" })).toBeVisible();
		return;
	} else if (path === "/") {
		await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
		return;
	} else if (path === "/likes") {
		await expect(page.getByRole("heading", { name: "Likes" })).toBeVisible();
		return;
	} else if (path === "/bookmarks") {
		await expect(
			page.getByRole("heading", { name: "Bookmarks" }),
		).toBeVisible();
		return;
	}
	if (path === "/dms") {
		await expect(page.getByPlaceholder("Search DMs")).toBeVisible();
		return;
	}
}

test("navigates across the primary surfaces", async ({ page }) => {
	await page.goto("/");

	await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
	await expect(page.getByText("Fast search for your archive.")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Sync timeline" }),
	).toBeVisible();
	await expect(
		page.locator('img[src="/birdclaw-mark.png"]').first(),
	).toBeVisible();

	await page.getByRole("link", { name: "Mentions" }).click();
	await expect(page.getByRole("heading", { name: "Mentions" })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Sync mentions" }),
	).toBeVisible();

	await page.getByRole("link", { name: "Likes" }).click();
	await expect(page.getByRole("heading", { name: "Likes" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Sync likes" })).toBeVisible();

	await page.getByRole("link", { name: "Bookmarks" }).click();
	await expect(page.getByRole("heading", { name: "Bookmarks" })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Sync bookmarks" }),
	).toBeVisible();

	await page.getByRole("link", { name: "Links" }).click();
	await expect(page.getByRole("heading", { name: "Links" })).toBeVisible();

	await page.getByRole("link", { name: "DMs" }).click();
	await expect(page.getByRole("heading", { name: "Messages" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Sync DMs" })).toBeVisible();

	await page.getByRole("link", { name: "Inbox" }).click();
	await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();

	await page.getByRole("link", { name: "Blocks" }).click();
	await expect(
		page.getByRole("heading", {
			name: "Maintain a clean blocklist locally.",
		}),
	).toBeVisible();
});

test("manual sync controls are available on syncable surfaces", async ({
	page,
}) => {
	async function expectSyncControl(path: string, buttonName: string) {
		const queryReady = page.waitForResponse(
			(response) =>
				response.url().includes("/api/query") &&
				response.request().method() === "GET" &&
				response.ok(),
		);
		await page.goto(path);
		await queryReady;
		await waitForSyncSurface(page, path);
		const button = page
			.locator("header")
			.getByRole("button", { name: buttonName });
		await expect(button).toBeVisible();
	}

	await expectSyncControl("/", "Sync timeline");
	await expectSyncControl("/dms", "Sync DMs");
});

test("filters the home timeline by reply state", async ({ page }) => {
	await page.goto("/");

	const cards = page.locator('[data-perf="timeline-card"]');
	await expect.poll(async () => cards.count()).toBeGreaterThanOrEqual(3);
	await expect(page.getByLabel("Part of a conversation").first()).toBeVisible();

	await page.getByRole("button", { name: /^Replied$/ }).click();
	await expect(cards.filter({ hasText: "best product teams" })).toHaveCount(1);
	await expect(page.getByLabel("We replied").first()).toBeVisible();

	await page.getByRole("button", { name: /^Unreplied$/ }).click();
	await expect.poll(async () => cards.count()).toBeGreaterThanOrEqual(1);
	await expect(page.getByLabel("Reply open").first()).toBeVisible();
});

test("shows the animated Birdclaw mark while the timeline loads", async ({
	page,
}) => {
	await page.route("**/api/query**", async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 250));
		await route.continue();
	});

	await page.goto("/");

	await expect(page.getByText("Loading posts")).toBeVisible();
	await expect(
		page.locator('.birdclaw-mark-animated img[src="/birdclaw-mark.png"]'),
	).toBeVisible();
	await expect(page.locator('[data-perf="tweet-skeleton-row"]')).toHaveCount(4);
	await expect(page.getByText("No posts to show")).toHaveCount(0);
});

test("expands timeline cards with media, quote context, and profile hover", async ({
	page,
}) => {
	await page.goto("/");

	const surveyCard = page.locator('[data-perf="timeline-card"]').filter({
		hasText: "New developer-platform pricing survey",
	});
	await expect(surveyCard.getByAltText("Pricing survey chart")).toBeVisible();
	await expect(
		surveyCard.getByRole("link", { name: "Developer platform pricing" }),
	).toBeVisible();
	await surveyCard.getByRole("link", { name: "Ava Wires @avawires" }).hover();
	await expect(
		surveyCard.getByText(
			"Reports on infrastructure, AI policy, and the business of software.",
		),
	).toBeVisible();

	await selectAccount(page, "@birdclaw_lab");
	const quoteCard = page.locator('[data-perf="timeline-card"]').filter({
		hasText: "Agents need retrieval surfaces",
	});
	await expect(quoteCard.getByText("Quoted tweet")).toBeVisible();
	await expect(
		quoteCard.getByText(
			"We need more software that defaults to local-first, legible state, and repairable failure modes.",
		),
	).toBeVisible();
});

test("searches saved likes and bookmarks", async ({ page }) => {
	await page.goto("/likes");

	const likeCards = page.locator('[data-perf="timeline-card"]');
	await expect.poll(async () => likeCards.count()).toBeGreaterThanOrEqual(2);
	await page.getByPlaceholder("Search likes").fill("pruning");
	await expect(likeCards).toHaveCount(1);
	await expect(likeCards.first()).toContainText("pruning scope");

	await page.goto("/bookmarks");

	const bookmarkCards = page.locator('[data-perf="timeline-card"]');
	await expect
		.poll(async () => bookmarkCards.count())
		.toBeGreaterThanOrEqual(1);
	await page.getByPlaceholder("Search bookmarks").fill("local-first");
	await expect(bookmarkCards.filter({ hasText: "local-first" })).toHaveCount(1);
});

test("browses link insights across links, videos, filters, and comments", async ({
	page,
}) => {
	await page.goto("/links");

	const rows = page.locator('[data-perf="link-insight-row"]');
	await expect(rows).toHaveCount(2);
	await expect(
		page.getByRole("link", { name: "Developer platform pricing survey" }),
	).toBeVisible();

	await page.getByPlaceholder("Search links").fill("local");
	await expect(rows).toHaveCount(1);
	await expect(
		page.getByRole("link", { name: "Local-first systems" }),
	).toBeVisible();

	await page.getByPlaceholder("Search links").fill("");
	await page.getByRole("button", { name: "videos" }).click();
	await expect(rows).toHaveCount(1);
	await expect(
		page.getByRole("link", { name: "Agent query walkthrough", exact: true }),
	).toBeVisible();
	await expect(page.getByText("youtu.be/GMIWm5y90xA")).toBeVisible();

	await page.getByRole("button", { name: "Show 1 comments" }).click();
	await expect(
		page.getByText("New developer-platform pricing survey out today."),
	).toBeVisible();

	await page.getByRole("button", { name: "dm" }).click();
	await expect(page.getByText("No links in this window")).toBeVisible();
});

test("replies to an unreplied mention and clears it from the queue", async ({
	page,
}) => {
	await page.goto("/mentions");

	await expect(page.locator('[data-perf="timeline-card"]')).toHaveCount(1);

	page.once("dialog", (dialog) =>
		dialog.accept("Replayability is the point where sync earns its keep."),
	);
	await page.getByRole("button", { name: "Reply" }).click();

	await expect(page.locator('[data-perf="timeline-card"]')).toHaveCount(0);
});

test("filters dms and shows sender context", async ({ page }) => {
	await page.goto("/dms");

	await page
		.locator('[aria-label="DM reply filter"]')
		.getByRole("button", { name: "all" })
		.click();
	await page.getByLabel("Followers").fill("1000000");

	await expect(page.getByText("@sam").first()).toBeVisible();
	await expect(page.getByText("Working on AGI")).toBeVisible();
	await expect(page.getByText("sender context")).toHaveCount(0);
});

test("replies from the inbox dm queue", async ({ page }) => {
	await page.goto("/inbox");

	await page.getByRole("button", { name: "dms" }).click();

	const ameliaCard = page.locator("article").filter({
		hasText: "DM from Amelia N",
	});

	await expect(ameliaCard).toHaveCount(1);
	await ameliaCard.getByRole("button", { name: "Reply" }).click();
	await ameliaCard
		.getByPlaceholder("Reply to @amelia")
		.fill("Please send the mock.");
	await ameliaCard.getByRole("button", { name: "Send" }).click();

	await expect(ameliaCard).toHaveCount(0);
});

test("adds and removes a local blocklist entry", async ({ page }) => {
	const initialRefresh = page.waitForResponse(
		(response) => response.url().includes("/api/blocks") && response.ok(),
	);
	await page.goto("/blocks");
	await initialRefresh;
	await expect(page.getByText("No blocks in this account.")).toBeVisible();

	const search = page.getByPlaceholder("Handle, name, bio, or Twitter URL");
	await expect(search).toBeEnabled();
	const searchResponse = page.waitForResponse(
		(response) =>
			response.url().includes("/api/blocks") &&
			response.url().includes("search=amelia") &&
			response.ok(),
	);
	await search.pressSequentially("amelia");
	await expect(search).toHaveValue("amelia");
	await searchResponse;
	await expect(page.getByText("Search matches")).toBeVisible();
	const ameliaMatch = page
		.locator("article")
		.filter({ hasText: "Amelia N" })
		.filter({ hasText: "Design systems" });
	await ameliaMatch.getByRole("button", { name: "Block" }).first().click();

	const ameliaBlock = page
		.locator("article")
		.filter({ hasText: "Amelia N" })
		.filter({ hasText: /Blocked/i });
	await expect(ameliaBlock).toHaveCount(1, { timeout: 15_000 });

	await ameliaBlock.getByRole("button", { name: "Unblock" }).click();

	await expect(page.getByText(/Unblocked @amelia/i)).toBeVisible();
});

test("switches theme and keeps it after reload", async ({ page }) => {
	await page.goto("/");

	const themeButton = page.getByTestId("theme-toggle");
	await expect(
		page.getByRole("button", {
			name: "Theme: System default. Switch to Light theme.",
		}),
	).toBeEnabled();
	await themeButton.click();
	await expect(
		page.getByRole("button", {
			name: "Theme: Light theme. Switch to Dark theme.",
		}),
	).toBeEnabled();
	await themeButton.click();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
	await expect(page.locator("html")).toHaveAttribute(
		"data-theme-preference",
		"dark",
	);

	await page.reload();

	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
	await expect(page.locator("html")).toHaveAttribute(
		"data-theme-preference",
		"dark",
	);
});
