import path from "node:path";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { inlineMediaTweet } from "./media-fixture";

test("plays video inside a read-only feed and renders compact link previews", async ({
	page,
	context,
	baseURL,
}, testInfo) => {
	await context.addCookies([
		{ name: "birdclaw_token", value: "birdclaw-e2e-token", url: baseURL! },
	]);
	const poster = await sharp(
		path.resolve("playwright/fixtures/media-poster.svg"),
	)
		.png()
		.toBuffer();
	const linkArt = await sharp(path.resolve("playwright/fixtures/link-art.svg"))
		.png()
		.toBuffer();
	const videoBytes = await page.evaluate(async () => {
		const canvas = document.createElement("canvas");
		canvas.width = 640;
		canvas.height = 360;
		const ctx = canvas.getContext("2d")!;
		const stream = canvas.captureStream(24);
		const recorder = new MediaRecorder(stream, {
			mimeType: "video/webm;codecs=vp8",
		});
		const chunks: Blob[] = [];
		recorder.ondataavailable = (event) => chunks.push(event.data);
		const stopped = new Promise<void>((resolve) => {
			recorder.onstop = () => resolve();
		});
		let frame = 0;
		const draw = () => {
			ctx.fillStyle = "#14282d";
			ctx.fillRect(0, 0, 640, 360);
			ctx.fillStyle = "#fc865d";
			ctx.beginPath();
			ctx.arc(470 + Math.sin(frame++ / 5) * 35, 180, 90, 0, Math.PI * 2);
			ctx.fill();
			ctx.fillStyle = "#f7f6ed";
			ctx.font = "32px Georgia";
			ctx.fillText("A small experiment", 35, 145);
			ctx.fillText("in motion.", 35, 190);
		};
		draw();
		recorder.start();
		const timer = window.setInterval(draw, 40);
		await new Promise((resolve) => window.setTimeout(resolve, 1000));
		recorder.stop();
		await stopped;
		window.clearInterval(timer);
		stream.getTracks().forEach((track) => track.stop());
		return Array.from(
			new Uint8Array(
				await new Blob(chunks, { type: "video/webm" }).arrayBuffer(),
			),
		);
	});
	await page.route("**/api/status", async (route) => {
		await route.fulfill({
			json: {
				readOnly: true,
				accounts: [
					{
						id: "acct_primary",
						name: "Archive",
						handle: "@archive",
						isDefault: 1,
						transport: "local",
						createdAt: "2026-01-01T00:00:00.000Z",
					},
				],
				archives: [],
				transport: {
					installed: false,
					availableTransport: "local",
					statusText: "Read-only archive",
				},
				stats: { home: 1, mentions: 0, dms: 0, needsReply: 0, inbox: 0 },
			},
		});
	});
	await page.route("**/api/query**", (route) =>
		route.fulfill({ json: { resource: "home", items: [inlineMediaTweet] } }),
	);
	await page.route("**/proof-video.webm", (route) =>
		route.fulfill({
			body: Buffer.from(videoBytes),
			contentType: "video/webm",
		}),
	);
	await page.route("**/unavailable.mp4", (route) =>
		route.fulfill({ status: 404, body: "Unavailable fixture variant" }),
	);
	await page.route("**/proof-poster.png", (route) =>
		route.fulfill({
			body: poster,
			contentType: "image/png",
		}),
	);
	await page.route("**/api/link-preview?**", (route) => {
		const url = new URL(route.request().url());
		return url.searchParams.has("imageUrl")
			? route.fulfill({
					body: linkArt,
					contentType: "image/png",
				})
			: route.fulfill({
					json: {
						ok: true,
						preview: {
							url: url.searchParams.get("url"),
							title: null,
							description: null,
							imageUrl: null,
							siteName: null,
						},
					},
				});
	});
	await page.goto("/");
	const card = page.locator('[data-perf="timeline-card"]');
	await expect(card).toContainText("A small experiment in motion.");
	await expect(
		page.getByText("Read-only archive", { exact: true }),
	).toBeVisible();
	await expect(
		card.getByText("Small movements, thoughtful interfaces"),
	).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("inline-media-desktop.png"),
		fullPage: true,
	});
	const video = card.locator("video");
	await expect(video).toBeVisible();
	await expect(video).toHaveAttribute("playsinline", "");
	await video.evaluate(async (element: HTMLVideoElement) => {
		element.muted = true;
		await element.play();
	});
	await expect
		.poll(() =>
			video.evaluate((element: HTMLVideoElement) => element.currentSrc),
		)
		.toContain("/proof-video.webm");
	await expect
		.poll(() =>
			video.evaluate((element: HTMLVideoElement) => element.currentTime),
		)
		.toBeGreaterThan(0.1);
	await video.evaluate((element: HTMLVideoElement) => element.pause());
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(
		card.getByText("tools.example.org", { exact: true }),
	).toHaveCount(1);
	await expect(
		card.getByText("/stories/a-study-in-motion", { exact: true }),
	).toBeVisible();
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(video).toBeVisible();
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true);
	await page.screenshot({
		path: testInfo.outputPath("inline-media-mobile.png"),
		fullPage: true,
	});
});
