// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const getOrFetchLinkPreviewMock = vi.fn();

vi.mock("#/lib/link-preview-metadata", () => ({
	getOrFetchLinkPreview: (...args: unknown[]) =>
		getOrFetchLinkPreviewMock(...args),
}));

import { Route } from "./link-preview";

const GET = getRouteHandler(Route, "GET");

describe("api link preview route", () => {
	beforeEach(() => {
		getOrFetchLinkPreviewMock.mockReset();
	});

	it("hydrates a URL preview", async () => {
		getOrFetchLinkPreviewMock.mockResolvedValue({
			url: "https://peekaboo.sh/",
			title: "Peekaboo",
			description: "Mac automation",
			imageUrl: "https://peekaboo.sh/og.png",
			siteName: "Peekaboo",
		});

		const response = await GET({
			request: new Request(
				"http://localhost/api/link-preview?url=https%3A%2F%2Fpeekaboo.sh%2F&shortUrl=https%3A%2F%2Ft.co%2Fdemo",
			),
		});

		expect(getOrFetchLinkPreviewMock).toHaveBeenCalledWith(
			"https://peekaboo.sh/",
			{ shortUrl: "https://t.co/demo" },
		);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			preview: {
				url: "https://peekaboo.sh/",
				title: "Peekaboo",
				description: "Mac automation",
				imageUrl: "https://peekaboo.sh/og.png",
				siteName: "Peekaboo",
			},
		});
	});

	it("rejects missing and non-http URLs", async () => {
		const missing = await GET({
			request: new Request("http://localhost/api/link-preview"),
		});
		const invalid = await GET({
			request: new Request(
				"http://localhost/api/link-preview?url=file%3A%2F%2F%2Ftmp%2Fx",
			),
		});

		expect(missing.status).toBe(400);
		expect(invalid.status).toBe(400);
		expect(getOrFetchLinkPreviewMock).not.toHaveBeenCalled();
	});
});
