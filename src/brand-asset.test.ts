// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { expect, it } from "vitest";
import { prepareBrandAsset } from "../scripts/brand-asset";

it("concurrent builds produce a valid compact asset without changing the original", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "birdclaw-brand-"));
	try {
		const original = await readFile(
			new URL("../public/birdclaw-mark.png", import.meta.url),
		);
		await mkdir(path.join(root, "public"));
		await writeFile(path.join(root, "public", "birdclaw-mark.png"), original);
		const paths = await Promise.all([
			prepareBrandAsset(root),
			prepareBrandAsset(root),
			prepareBrandAsset(root),
		]);
		expect(new Set(paths).size).toBe(1);
		const image = await readFile(paths[0]!);
		expect(await sharp(image).metadata()).toMatchObject({
			width: 256,
			height: 256,
			hasAlpha: true,
		});
		expect(image.byteLength).toBeLessThan(original.byteLength / 4);
		expect(
			await readFile(path.join(root, "public", "birdclaw-mark.png")),
		).toEqual(original);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
