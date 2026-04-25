import { expect, test } from "@playwright/test";

test("navigates across the primary surfaces", async ({ page }) => {
	await page.goto("/");

	await expect(
		page.getByRole("heading", { name: "Quiet signal for X." }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", {
			name: "Read first. Act only where signal survives.",
		}),
	).toBeVisible();

	await page.getByRole("link", { name: "Mentions" }).click();
	await expect(
		page.getByRole("heading", {
			name: "Keep the actionable queue small and visible.",
		}),
	).toBeVisible();

	await page.getByRole("link", { name: "DMs" }).click();
	await expect(
		page.getByRole("heading", {
			name: "Influence, bio, and reply state. No hunting.",
		}),
	).toBeVisible();

	await page.getByRole("link", { name: "Inbox" }).click();
	await expect(
		page.getByRole("heading", { name: "AI triage for mentions and DMs." }),
	).toBeVisible();
	await expect(page.locator(".inbox-card")).toHaveCount(3);

	await page.getByRole("link", { name: "Blocks" }).click();
	await expect(
		page.getByRole("heading", {
			name: "Maintain a clean blocklist locally.",
		}),
	).toBeVisible();
});

test("filters the home timeline by reply state", async ({ page }) => {
	await page.goto("/");

	const cards = page.locator(".content-card");
	await expect(cards).toHaveCount(4);

	await page.getByRole("button", { name: /^replied$/ }).click();
	await expect(cards).toHaveCount(1);
	await expect(cards.first()).toContainText("best product teams");

	await page.getByRole("button", { name: /^unreplied$/ }).click();
	await expect(cards).toHaveCount(3);
});

test("expands timeline cards with media, quote context, and profile hover", async ({
	page,
}) => {
	await page.goto("/");

	const surveyCard = page.locator(".content-card").filter({
		hasText: "New developer-platform pricing survey",
	});
	await expect(surveyCard.getByAltText("Pricing survey chart")).toBeVisible();
	await expect(
		surveyCard.getByRole("link", {
			name: "example.com/developer-platform-pricing",
		}),
	).toBeVisible();
	await surveyCard.locator(".profile-preview-trigger").first().hover();
	await expect(
		surveyCard.locator(".profile-preview-card .profile-preview-bio").filter({
			hasText:
				"Reports on infrastructure, AI policy, and the business of software.",
		}),
	).toBeVisible();

	const quoteCard = page.locator(".content-card").filter({
		hasText: "Agents need retrieval surfaces",
	});
	await expect(
		quoteCard.locator(".embedded-tweet-label", { hasText: "Quoted tweet" }),
	).toBeVisible();
	await expect(
		quoteCard.getByText(
			"We need more software that defaults to local-first, legible state, and repairable failure modes.",
		),
	).toBeVisible();
});

test("replies to an unreplied mention and clears it from the queue", async ({
	page,
}) => {
	await page.goto("/mentions");

	await expect(page.locator(".content-card")).toHaveCount(1);

	page.once("dialog", (dialog) =>
		dialog.accept("Replayability is the point where sync earns its keep."),
	);
	await page.getByRole("button", { name: "Reply" }).click();

	await expect(page.locator(".content-card")).toHaveCount(0);
});

test("filters dms and shows sender context", async ({ page }) => {
	await page.goto("/dms");

	await page.getByRole("button", { name: "all" }).click();
	await page.getByPlaceholder("Min followers").fill("1000000");

	await expect(page.locator(".context-handle")).toHaveText("@sam");
	await expect(page.locator(".context-bio")).toContainText("Working on AGI");
	await expect(page.getByText("sender context")).toHaveCount(0);
});

test("replies from the inbox dm queue", async ({ page }) => {
	await page.goto("/inbox");

	await page.getByRole("button", { name: "dms" }).click();

	const ameliaCard = page.locator(".inbox-card").filter({
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
	await page.goto("/blocks");

	const blockResult = await page.evaluate(async () => {
		const response = await fetch("/api/action", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				kind: "blockProfile",
				accountId: "acct_primary",
				query: "amelia",
			}),
		});
		return response.json();
	});
	expect(blockResult).toMatchObject({ ok: true });
	expect(String(blockResult.profile?.handle).toLowerCase()).toBe("amelia");

	await page.reload();

	const ameliaBlock = page
		.locator(".block-card")
		.filter({ hasText: /@amelia/i });
	await expect(ameliaBlock).toHaveCount(1, { timeout: 15_000 });

	await ameliaBlock.getByRole("button", { name: "Unblock" }).click();

	await expect(page.getByText(/Unblocked @amelia/i)).toBeVisible();
});

test("switches theme and keeps it after reload", async ({ page }) => {
	await page.goto("/");

	const darkButton = page.getByRole("button", { name: "Dark theme" });
	await expect(darkButton).toBeEnabled();
	await darkButton.click();
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
