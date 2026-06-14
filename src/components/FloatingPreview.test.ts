import { describe, expect, it } from "vitest";
import { __test__ } from "./FloatingPreview";

const viewport = {
	top: 0,
	right: 800,
	bottom: 600,
	left: 0,
	width: 800,
	height: 600,
};

const wrappedReference = [
	{ top: 100, right: 650, bottom: 120, left: 300, width: 350, height: 20 },
	{ top: 125, right: 650, bottom: 145, left: 100, width: 550, height: 20 },
	{ top: 150, right: 340, bottom: 170, left: 100, width: 240, height: 20 },
];

describe("floating preview placement", () => {
	it("places a preview below the final fragment of a wrapped link", () => {
		const position = __test__.calculatePreviewPosition({
			referenceRects: wrappedReference,
			floatingWidth: 360,
			floatingHeight: 220,
			viewport,
		});

		expect(position.side).toBe("bottom");
		expect(position.top).toBe(180);
		expect(position.left).toBe(40);
	});

	it("places a preview above the first fragment when space below is tight", () => {
		const position = __test__.calculatePreviewPosition({
			referenceRects: wrappedReference.map((rect) => ({
				...rect,
				top: rect.top + 300,
				bottom: rect.bottom + 300,
			})),
			floatingWidth: 360,
			floatingHeight: 220,
			viewport,
		});

		expect(position.side).toBe("top");
		expect(position.top).toBe(170);
		expect(position.top + 220).toBe(390);
	});

	it("uses the roomier side and constrains height when neither side fits", () => {
		const position = __test__.calculatePreviewPosition({
			referenceRects: wrappedReference.map((rect) => ({
				...rect,
				top: rect.top + 100,
				bottom: rect.bottom + 100,
			})),
			floatingWidth: 360,
			floatingHeight: 500,
			viewport: { ...viewport, bottom: 420, height: 420 },
		});

		expect(position.side).toBe("top");
		expect(position.maxHeight).toBe(178);
		expect(position.top).toBe(12);
	});

	it("keeps wide previews inside a narrow viewport gutter", () => {
		const position = __test__.calculatePreviewPosition({
			referenceRects: [
				{ top: 100, right: 315, bottom: 120, left: 275, width: 40, height: 20 },
			],
			floatingWidth: 360,
			floatingHeight: 180,
			viewport: {
				...viewport,
				right: 320,
				bottom: 480,
				width: 320,
				height: 480,
			},
		});

		expect(position.maxWidth).toBe(296);
		expect(position.left).toBe(12);
	});

	it("applies width constraints while a narrow preview is still hidden", () => {
		expect(
			__test__.floatingStyle({
				top: 130,
				left: 12,
				maxWidth: 296,
				maxHeight: 320,
				side: "bottom",
				measured: true,
				ready: false,
			}),
		).toMatchObject({
			maxWidth: 296,
			maxHeight: 320,
			visibility: "hidden",
		});
	});

	it("hides a preview when every wrapped-link fragment leaves the viewport", () => {
		expect(
			__test__.referenceIntersectsViewport(
				wrappedReference.map((rect) => ({
					...rect,
					top: rect.top - 300,
					bottom: rect.bottom - 300,
				})),
				viewport,
			),
		).toBe(false);
		expect(
			__test__.referenceIntersectsViewport(wrappedReference, viewport),
		).toBe(true);
	});
});
