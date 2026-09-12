import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { tryPromise } from "./effect-runtime";

export async function syncDirectory(directory: string) {
	const handle = await fs.open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export async function durableMkdir(directory: string) {
	const missing: string[] = [];
	let cursor = directory;
	while (!existsSync(cursor)) {
		missing.push(cursor);
		const parent = path.dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	for (const created of missing.reverse()) {
		await syncDirectory(created);
		await syncDirectory(path.dirname(created));
	}
	if (missing.length === 0) await syncDirectory(directory);
}

export async function durableMkdtemp(prefix: string) {
	const directory = await fs.mkdtemp(prefix);
	await syncDirectory(directory);
	await syncDirectory(path.dirname(directory));
	return directory;
}

export async function durableRename(source: string, destination: string) {
	await fs.rename(source, destination);
	await syncDirectory(path.dirname(source));
	if (path.dirname(destination) !== path.dirname(source)) {
		await syncDirectory(path.dirname(destination));
	}
}

export async function durableRemove(
	target: string,
	options: { recursive?: boolean; force?: boolean } = {},
) {
	await fs.rm(target, options);
	await syncDirectory(path.dirname(target));
}

export async function durableCopyFile(source: string, destination: string) {
	await fs.copyFile(source, destination);
	const handle = await fs.open(destination, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
	await syncDirectory(path.dirname(destination));
}

export async function durableWriteFile(
	target: string,
	content: string | Buffer,
	encoding?: BufferEncoding,
) {
	const handle = await fs.open(target, "w", 0o600);
	try {
		await handle.writeFile(content, encoding ? { encoding } : undefined);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await syncDirectory(path.dirname(target));
}

export async function probeBackupTransactionRoot(root: string) {
	const probePath = path.join(root, `.write-probe-${randomUUID()}`);
	let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
	try {
		handle = await fs.open(probePath, "wx", 0o600);
		await handle.writeFile(randomUUID(), "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fs.rm(probePath);
		await syncDirectory(root);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await fs.rm(probePath, { force: true }).catch(() => undefined);
		await syncDirectory(root).catch(() => undefined);
		throw error;
	}
}

export function assertOwnedPathStat(
	stat: {
		uid: number;
		mode: number;
		isDirectory(): boolean;
		isFile(): boolean;
		isSymbolicLink(): boolean;
	},
	label: string,
	type: "directory" | "file",
) {
	if (
		stat.isSymbolicLink() ||
		(type === "directory" ? !stat.isDirectory() : !stat.isFile())
	) {
		throw new Error(`Unsafe backup transaction ${label}`);
	}
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== uid) {
		throw new Error(`Backup transaction ${label} is owned by another user`);
	}
	if ((stat.mode & 0o022) !== 0) {
		throw new Error(`Backup transaction ${label} is group/world writable`);
	}
}

export async function validateRealTransactionDirectory(
	directory: string,
	label: string,
	expectedDevice: number,
) {
	const resolved = path.resolve(directory);
	const stat = await fs.lstat(resolved);
	assertOwnedPathStat(stat, label, "directory");
	if (
		(await fs.realpath(resolved)) !== resolved ||
		stat.dev !== expectedDevice
	) {
		throw new Error(
			`Backup transaction ${label} is not a canonical local directory`,
		);
	}
	return resolved;
}

export async function validateTransactionTree(
	root: string,
	allowedRootEntries: ReadonlySet<string>,
) {
	const visit = async (directory: string, topLevel: boolean): Promise<void> => {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			if (topLevel && !allowedRootEntries.has(entry.name)) {
				throw new Error(`Unexpected backup transaction entry: ${entry.name}`);
			}
			const target = path.join(directory, entry.name);
			const stat = await fs.lstat(target);
			if (stat.isSymbolicLink()) {
				throw new Error("Backup transaction paths must not contain symlinks");
			}
			const uid = process.getuid?.();
			if (uid !== undefined && stat.uid !== uid) {
				throw new Error("Backup transaction path is owned by another user");
			}
			if (stat.isDirectory()) await visit(target, false);
			else if (!stat.isFile())
				throw new Error("Backup transaction path is not a regular file");
		}
	};
	await visit(root, true);
}

export function resolveBackupFilePath(repoPath: string, relativePath: string) {
	if (path.isAbsolute(relativePath)) {
		throw new Error(`Backup manifest path must be relative: ${relativePath}`);
	}
	const normalized = path.normalize(relativePath);
	if (
		normalized === "." ||
		normalized.startsWith("..") ||
		path.isAbsolute(normalized)
	) {
		throw new Error(`Backup manifest path escapes repository: ${relativePath}`);
	}
	const root = path.resolve(repoPath);
	const resolved = path.resolve(root, normalized);
	const relative = path.relative(root, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`Backup manifest path escapes repository: ${relativePath}`);
	}
	return resolved;
}

function isPathInsideRoot(root: string, candidate: string) {
	const relative = path.relative(root, candidate);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
}

export function assertBackupPathInsideRealRootEffect(
	repoPath: string,
	fullPath: string,
): Effect.Effect<void, unknown> {
	return Effect.gen(function* () {
		const realRoot = yield* tryPromise(() => fs.realpath(repoPath));
		const realPath = yield* tryPromise(() => fs.realpath(fullPath));
		if (!isPathInsideRoot(realRoot, realPath)) {
			return yield* Effect.fail(new Error("Backup path escapes repository"));
		}
	});
}

export function assertReadableBackupFileEffect(
	repoPath: string,
	fullPath: string,
	label: string,
) {
	return Effect.gen(function* () {
		yield* assertNoSymlinkAncestorEffect(repoPath, fullPath);
		const stat = yield* tryPromise(() => fs.lstat(fullPath));
		if (!stat.isFile()) {
			return yield* Effect.fail(
				new Error(`Backup path is not a regular file: ${label}`),
			);
		}
		yield* assertBackupPathInsideRealRootEffect(repoPath, fullPath);
		return stat;
	});
}

export function assertNoSymlinkAncestorEffect(
	repoPath: string,
	fullPath: string,
): Effect.Effect<void, unknown> {
	return Effect.gen(function* () {
		const root = path.resolve(repoPath);
		const target = path.resolve(fullPath);
		if (!isPathInsideRoot(root, target)) {
			return yield* Effect.fail(new Error("Backup path escapes repository"));
		}
		const relative = path.relative(root, target);
		let current = root;
		for (const part of relative.split(path.sep).filter(Boolean)) {
			current = path.join(current, part);
			const stat = yield* tryPromise(() => fs.lstat(current)).pipe(
				Effect.catchAll((error) =>
					error &&
					typeof error === "object" &&
					"code" in error &&
					error.code === "ENOENT"
						? Effect.succeed(null)
						: Effect.fail(error),
				),
			);
			if (!stat) return;
			if (stat.isSymbolicLink()) {
				return yield* Effect.fail(
					new Error(
						`Backup path contains symlink: ${path.relative(root, current)}`,
					),
				);
			}
		}
	});
}
