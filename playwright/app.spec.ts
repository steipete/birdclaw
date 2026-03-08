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
	await expect(cards.first()).toContainText("The best product teams");

	await page.getByRole("button", { name: /^unreplied$/ }).click();
	await expect(cards).toHaveCount(3);
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

test("filters dms and shows sender context", async ({
	page,
}) => {
	await page.goto("/dms");

	await page.getByRole("button", { name: "all" }).click();
	await page.getByPlaceholder("Min followers").fill("1000000");

	await expect(page.locator(".context-handle")).toHaveText("@sam");
	await expect(page.locator(".context-bio")).toContainText("Working on AGI");
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

	await page.getByPlaceholder("Handle, name, bio, or X URL").fill("amelia");
	const ameliaMatch = page.locator(".block-card").filter({ hasText: "Amelia N" });
	await expect(ameliaMatch).toHaveCount(1);
	await ameliaMatch.getByRole("button", { name: "Block" }).click();

	await expect(page.getByText(/Blocked @amelia/i)).toBeVisible();

	await page.getByRole("button", { name: "Unblock" }).first().click();

	await expect(page.getByText(/Unblocked @amelia/i)).toBeVisible();
});
