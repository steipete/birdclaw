import path from "node:path";
import { expect, test } from "@playwright/test";
import NativeSqliteDatabase from "../src/lib/sqlite";

const targetId = "permalink_target";
const targetText = "A stable link should bring you straight to this reply.";

test.beforeAll(() => {
	const db = new NativeSqliteDatabase(
		path.resolve(".playwright-home/birdclaw.sqlite"),
	);
	try {
		db.transaction(() => {
			db.prepare(
				"insert or ignore into profiles (id,handle,display_name,bio,created_at) values (?,?,?,?,?)",
			).run(
				"permalink_author",
				"avery_notes",
				"Avery Finch",
				"Synthetic conversation fixture",
				"2026-01-01",
			);
			const insert = db.prepare(
				"insert or replace into tweets (id,author_profile_id,text,created_at,reply_to_id,deleted_at) values (?,?,?,?,?,?)",
			);
			insert.run(
				"permalink_root",
				"permalink_author",
				"How can we make saved conversations easy to share?",
				"2026-09-01T10:00:00.000Z",
				null,
				null,
			);
			for (let index = 0; index < 100; index++) {
				const id = index === 99 ? targetId : `permalink_reply_${index}`;
				const text =
					index === 99
						? targetText
						: `A note from the conversation, reply ${index + 1}.`;
				insert.run(
					id,
					"permalink_author",
					text,
					new Date(
						Date.parse("2026-09-01T10:00:00Z") + (index + 1) * 60000,
					).toISOString(),
					"permalink_root",
					null,
				);
			}
			insert.run(
				"permalink_solo",
				"permalink_author",
				"A saved post can stand on its own.",
				"2026-09-01T13:00:00Z",
				null,
				null,
			);
			insert.run(
				"permalink_deleted",
				"permalink_author",
				"Deleted synthetic post must stay hidden",
				"2026-09-01T14:00:00Z",
				null,
				"2026-09-02T00:00:00Z",
			);
			for (const id of ["permalink_root", targetId]) {
				db.prepare(
					"insert or replace into tweet_account_edges (account_id,tweet_id,kind,first_seen_at,last_seen_at,source,updated_at) values (?,?, 'home',?,?, 'test',?)",
				).run("acct_primary", id, "2026-09-01", "2026-09-01", "2026-09-01");
			}
		})();
	} finally {
		db.close();
	}
});

test.beforeEach(async ({ context, baseURL }) => {
	await context.addCookies([
		{ name: "birdclaw_token", value: "birdclaw-e2e-token", url: baseURL! },
	]);
});

test("opens a late reply directly, scrolls to it, and preserves the target after reload", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	const pending = page.waitForResponse((response) =>
		response.url().includes(`/api/conversation?tweetId=${targetId}`),
	);
	await page.goto(`/tweets/${targetId}`);
	const response = await pending;
	expect(response.status()).toBe(200);
	const data = await response.json();
	expect(data.anchorId).toBe(targetId);
	expect(data.items.length).toBeLessThanOrEqual(80);
	expect(data.truncated).toBe(true);
	const selected = page.getByRole("article", { name: "Selected post" });
	await expect(selected).toHaveAttribute("data-tweet-id", targetId);
	await expect(selected).toContainText(targetText);
	await expect(selected).toBeFocused();
	await expect(selected).toBeInViewport();
	await expect(selected).toHaveClass(/bg-\[var\(--accent-soft\)\]/);
	const image = testInfo.outputPath("reply-permalink.png");
	await page.screenshot({ path: image });
	await testInfo.attach("Reply permalink", {
		path: image,
		contentType: "image/png",
	});
	await page.reload();
	await expect(selected).toHaveAttribute("data-tweet-id", targetId);
	await expect(selected).toBeFocused();
	await expect(selected).toBeInViewport();
	await expect(
		page.getByRole("button", { name: "Reply", exact: true }),
	).toHaveCount(0);
});

test("follows permalinks from a feed and a different reply, then restores browser history", async ({
	page,
}) => {
	let targetReads = 0;
	let documentNavigations = 0;
	page.on("request", (request) => {
		if (request.url().includes(`/api/conversation?tweetId=${targetId}`))
			targetReads++;
		if (request.isNavigationRequest() && request.frame() === page.mainFrame())
			documentNavigations++;
	});
	await page.goto("/");
	const permalink = page
		.locator(`a[aria-label="Open archived post"][href="/tweets/${targetId}"]`)
		.first();
	const prefetched = page.waitForResponse((response) =>
		response.url().includes(`/api/conversation?tweetId=${targetId}`),
	);
	await permalink.hover();
	await prefetched;
	await permalink.click();
	await expect(page).toHaveURL(new RegExp(`/tweets/${targetId}$`));
	await expect(
		page.getByRole("article", { name: "Selected post" }),
	).toHaveAttribute("data-tweet-id", targetId);
	expect(targetReads).toBe(1);
	expect(documentNavigations).toBe(1);
	await page
		.locator(
			'a[aria-label="Open archived post"][href="/tweets/permalink_root"]',
		)
		.first()
		.click();
	await expect(page).toHaveURL(/\/tweets\/permalink_root$/);
	await expect(
		page.getByRole("article", { name: "Selected post" }),
	).toHaveAttribute("data-tweet-id", "permalink_root");
	await page.goBack();
	await expect(
		page.getByRole("article", { name: "Selected post" }),
	).toHaveAttribute("data-tweet-id", targetId);
	expect(targetReads).toBe(1);
	expect(documentNavigations).toBe(1);
});

test("renders a single saved post and clear missing/deleted states", async ({
	page,
}) => {
	await page.goto("/tweets/permalink_solo");
	await expect(
		page.getByRole("article", { name: "Selected post" }),
	).toContainText("A saved post can stand on its own.");
	await expect(page.getByText("1 tweet in conversation")).toBeVisible();
	for (const id of ["permalink_missing", "permalink_deleted"]) {
		const response = page.waitForResponse((response) =>
			response.url().includes(`/api/conversation?tweetId=${id}`),
		);
		await page.goto(`/tweets/${id}`);
		expect((await response).status()).toBe(404);
		await expect(
			page.getByText("Post not found", { exact: true }),
		).toBeVisible();
		await expect(
			page.getByText("Deleted synthetic post must stay hidden"),
		).toHaveCount(0);
	}
});

test("offers the canonical URL when clipboard access is unavailable", async ({
	page,
	baseURL,
}) => {
	await page.addInitScript(() => {
		Object.defineProperty(navigator, "clipboard", {
			value: {
				writeText: () => Promise.reject(new Error("Clipboard denied")),
			},
		});
	});
	await page.goto(`/tweets/${targetId}`);
	await page.getByRole("button", { name: "Copy link" }).click();
	const input = page.getByRole("textbox", { name: "Post permalink" });
	const url = new URL(`/tweets/${targetId}`, baseURL).href;
	await expect(input).toHaveValue(url);
	await input.focus();
	expect(
		await input.evaluate((element: HTMLInputElement) =>
			element.value.slice(element.selectionStart!, element.selectionEnd!),
		),
	).toBe(url);
});
