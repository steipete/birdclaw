import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

/** Generate an app-sized derivative without changing the original documentation artwork. */
export async function prepareBrandAsset(root: string): Promise<string> {
	const source = await readFile(path.join(root, "public", "birdclaw-mark.png"));
	const image = await sharp(source)
		.resize(256, 256, { fit: "inside", withoutEnlargement: true })
		.png({ compressionLevel: 9 })
		.toBuffer();
	const hash = createHash("sha256").update(image).digest("hex").slice(0, 16);
	const directory = path.join(root, ".generated", "birdclaw-brand", hash);
	const destination = path.join(directory, "birdclaw-mark.png");
	await mkdir(directory, { recursive: true });
	try {
		if ((await readFile(destination)).equals(image)) return destination;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const temporary = `${destination}.${randomUUID()}.tmp`;
	await writeFile(temporary, image);
	await rename(temporary, destination);
	return destination;
}
