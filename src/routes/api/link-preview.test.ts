// @vitest-environment node
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const getOrFetchLinkPreviewMock = vi.fn();
const readPreviewImageMock = vi.fn();
vi.mock("#/lib/preview-image-cache", () => ({
	readPreviewImageEffect: (...args: unknown[]) =>
		Effect.succeed(readPreviewImageMock(...args)),
}));

vi.mock("#/lib/link-preview-metadata", () => ({
	getOrFetchLinkPreview: (...args: unknown[]) =>
		getOrFetchLinkPreviewMock(...args),
	getOrFetchLinkPreviewEffect: (...args: unknown[]) =>
		Effect.promise(() => Promise.resolve(getOrFetchLinkPreviewMock(...args))),
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

it("serves exactly a sliced raster buffer without exposing its backing allocation", async () => {
	const backing = Buffer.alloc(128, 0x61);
	const buffer = backing.subarray(20, 28);
	buffer.set([137, 80, 78, 71, 13, 10, 26, 10]);
	readPreviewImageMock.mockReturnValue({ buffer, contentType: "image/png" });
	const response = await GET({
		request: new Request(
			"http://localhost/api/link-preview?imageUrl=https%3A%2F%2Fexample.com%2Fimage.png",
		),
	});
	expect(response.status).toBe(200);
	expect(Buffer.from(await response.arrayBuffer())).toEqual(buffer);
	expect(response.headers.get("content-type")).toBe("image/png");
	readPreviewImageMock.mockReturnValue(null);
	const missing = await GET({
		request: new Request(
			"http://localhost/api/link-preview?imageUrl=https%3A%2F%2Fexample.com%2Fmissing.png",
		),
	});
	expect(missing.status).toBe(404);
	expect(missing.headers.get("cache-control")).toBe("no-store");
});
