import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Data, Effect } from "effect";
import type { Database } from "./sqlite";
import {
	BACKUP_TABLE_CODECS,
	adaptLegacyTweetState,
	backupCodecForPath,
	buildBackupShardsFromRowSets,
	countBackupFiles,
	createBackupImportRows,
	type BackupImportRows,
	type BackupJsonRecord as JsonRecord,
	type BackupJsonValue as JsonValue,
} from "./backup-table-codecs";
import { getBirdclawConfig } from "./config";
import { getNativeDb } from "./db";
import { databaseWriteEffect } from "./database-writer";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import { getImportRepository } from "./import-repository";
import {
	collectIngestionSourcesEffect,
	streamJsonLines,
} from "./streaming-ingestion";
import { runSubprocessEffect, SubprocessError } from "./subprocess";

const BACKUP_SCHEMA_VERSION = 2;
const MIN_SUPPORTED_BACKUP_SCHEMA_VERSION = 1;
const MANIFEST_PATH = "manifest.json";
const DATA_DIR = "data";
const AUTO_SYNC_CACHE_KEY = "backup:auto-sync";
const DEFAULT_STALE_AFTER_SECONDS = 15 * 60;
let autoUpdateInFlight: Promise<BackupAutoUpdateResult> | null = null;

export interface BackupFileManifest {
	path: string;
	rows: number;
	sha256: string;
	bytes: number;
}

export interface BackupManifest {
	app: "birdclaw";
	schemaVersion: number;
	generatedAt: string;
	counts: Record<string, number>;
	files: BackupFileManifest[];
	backupHash: string;
}

export interface BackupExportResult {
	ok: true;
	repoPath: string;
	manifest: BackupManifest;
	validation: BackupValidationResult;
	git?: {
		committed: boolean;
		pushed: boolean;
		commit?: string;
	};
}

export interface BackupImportResult {
	ok: true;
	repoPath: string;
	mode: BackupImportMode;
	manifest: BackupManifest;
	validation?: BackupValidationResult;
	fingerprint: BackupDatabaseFingerprint;
}

export interface BackupSyncResult {
	ok: true;
	repoPath: string;
	remote?: string;
	pulled: boolean;
	imported: boolean;
	importResult?: BackupImportResult;
	exportResult: BackupExportResult;
}

export interface BackupAutoUpdateResult {
	ok: boolean;
	enabled: boolean;
	skipped: boolean;
	reason?: string;
	repoPath?: string;
	remote?: string;
	pulled?: boolean;
	imported?: boolean;
	error?: string;
}

export interface BackupValidationResult {
	ok: boolean;
	repoPath: string;
	files: BackupFileManifest[];
	counts: Record<string, number>;
	backupHash: string;
	errors: string[];
}

export interface BackupDatabaseFingerprint {
	counts: Record<string, number>;
	hash: string;
}

export type BackupImportMode = "merge" | "replace";

export interface BackupImportOptions {
	repoPath: string;
	db?: Database;
	validate?: boolean;
	mode?: BackupImportMode;
}

export class BackupGitCommandError extends Data.TaggedError(
	"BackupGitCommandError",
)<{
	readonly message: string;
	readonly args: readonly string[];
	readonly stdout?: string;
	readonly stderr?: string;
	readonly cause?: unknown;
}> {}

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function trySync<T>(try_: () => T) {
	return Effect.try({
		try: try_,
		catch: toError,
	});
}

function redactSecretUrl(value: string) {
	return value.replace(
		/([a-z][a-z0-9+.-]*:\/\/)([^/@:\s]+)(?::([^/@\s]+))?@/gi,
		(_match, protocol: string, username: string, password?: string) =>
			`${protocol}${username ? "REDACTED" : ""}${password ? ":REDACTED" : ""}@`,
	);
}

function gitCommandError(args: readonly string[], cause: unknown) {
	const redactedArgs =
		cause instanceof SubprocessError
			? cause.args
			: args.map((arg) => redactSecretUrl(arg));
	const command = `git ${redactedArgs.join(" ")}`;
	return new BackupGitCommandError({
		message:
			cause instanceof Error
				? redactSecretUrl(cause.message)
				: `${command} failed`,
		args: redactedArgs,
		stdout: cause instanceof SubprocessError ? cause.stdout : "",
		stderr: cause instanceof SubprocessError ? cause.stderr : "",
		cause,
	});
}

function gitEffect(args: string[]) {
	return runSubprocessEffect({
		command: "git",
		args,
		redact: redactSecretUrl,
	}).pipe(Effect.mapError((cause) => gitCommandError(args, cause)));
}

function canonicalStringify(value: JsonValue): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
	}
	const keys = Object.keys(value).sort();
	return `{${keys
		.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`)
		.join(",")}}`;
}

function toJsonRecord(row: Record<string, unknown>): JsonRecord {
	const result: JsonRecord = {};
	for (const [key, value] of Object.entries(row)) {
		if (
			value === null ||
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		) {
			result[key] = value;
			continue;
		}
		result[key] = JSON.parse(JSON.stringify(value)) as JsonValue;
	}
	return result;
}

function sha256(content: string | Buffer) {
	return createHash("sha256").update(content).digest("hex");
}

const jsonlKeyOrderCache = new Map<string, string[]>();

function jsonlStringify(row: JsonRecord): string {
	const keys = Object.keys(row);
	const signature = keys.join("\0");
	let sortedKeys = jsonlKeyOrderCache.get(signature);
	if (!sortedKeys) {
		sortedKeys = [...keys].sort();
		jsonlKeyOrderCache.set(signature, sortedKeys);
	}
	return `{${sortedKeys
		.map(
			(key) =>
				`${JSON.stringify(key)}:${escapeJsonLineSeparators(JSON.stringify(row[key]))}`,
		)
		.join(",")}}`;
}

function escapeJsonLineSeparators(value: string) {
	return value.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function rowsForQuery(db: Database, sql: string, params: unknown[] = []) {
	return (db.prepare(sql).all(...params) as Record<string, unknown>[]).map(
		toJsonRecord,
	);
}

function getExportRowSets(db: Database) {
	return BACKUP_TABLE_CODECS.map((codec) => ({
		logicalName: codec.name,
		rows: rowsForQuery(db, codec.exportSql),
	}));
}

function buildShards(db: Database) {
	return buildBackupShardsFromRowSets(getExportRowSets(db));
}

function writeJsonlFileEffect(
	repoPath: string,
	relativePath: string,
	rows: JsonRecord[],
): Effect.Effect<BackupFileManifest, unknown> {
	return Effect.gen(function* () {
		const fullPath = yield* trySync(() =>
			resolveBackupFilePath(repoPath, relativePath),
		);
		const content = yield* trySync(
			() => `${rows.map((row) => jsonlStringify(row)).join("\n")}\n`,
		);
		yield* assertNoSymlinkAncestorEffect(repoPath, path.dirname(fullPath));
		yield* tryPromise(() =>
			fs.mkdir(path.dirname(fullPath), { recursive: true }),
		);
		yield* assertNoSymlinkAncestorEffect(repoPath, path.dirname(fullPath));
		yield* assertBackupPathInsideRealRootEffect(
			repoPath,
			path.dirname(fullPath),
		);
		const outputStat = yield* tryPromise(() => fs.lstat(fullPath)).pipe(
			Effect.option,
		);
		if (outputStat._tag === "Some" && !outputStat.value.isFile()) {
			return yield* Effect.fail(
				new Error(`Backup output path is not a regular file: ${relativePath}`),
			);
		}
		const current = yield* tryPromise(() => fs.readFile(fullPath, "utf8")).pipe(
			Effect.option,
		);
		if (current._tag === "None" || current.value !== content) {
			yield* tryPromise(() => fs.writeFile(fullPath, content, "utf8"));
		}
		return {
			path: relativePath,
			rows: rows.length,
			sha256: sha256(content),
			bytes: Buffer.byteLength(content),
		};
	});
}

function removeStaleBackupFilesEffect(
	repoPath: string,
	expectedPaths: Set<string>,
	directory = DATA_DIR,
): Effect.Effect<void, unknown> {
	return Effect.gen(function* () {
		const fullDirectory = yield* trySync(() =>
			resolveBackupFilePath(repoPath, directory),
		);
		const directoryStat = yield* tryPromise(() => fs.lstat(fullDirectory)).pipe(
			Effect.option,
		);
		if (directoryStat._tag === "None" || !directoryStat.value.isDirectory()) {
			return;
		}
		yield* assertBackupPathInsideRealRootEffect(repoPath, fullDirectory);
		const entries = yield* tryPromise(() =>
			fs.readdir(fullDirectory, { withFileTypes: true }),
		).pipe(Effect.catchAll(() => Effect.succeed([])));

		yield* Effect.forEach(
			entries,
			(entry) =>
				Effect.gen(function* () {
					const relativePath = path.posix.join(directory, entry.name);
					const fullPath = yield* trySync(() =>
						resolveBackupFilePath(repoPath, relativePath),
					);
					if (entry.isDirectory()) {
						yield* removeStaleBackupFilesEffect(
							repoPath,
							expectedPaths,
							relativePath,
						);
						const remaining = yield* tryPromise(() => fs.readdir(fullPath));
						if (remaining.length === 0) {
							yield* tryPromise(() => fs.rmdir(fullPath));
						}
						return;
					}
					if (
						relativePath.endsWith(".jsonl") &&
						!expectedPaths.has(relativePath)
					) {
						const stat = yield* tryPromise(() => fs.lstat(fullPath)).pipe(
							Effect.option,
						);
						if (stat._tag === "Some" && !stat.value.isFile()) return;
						yield* tryPromise(() => fs.rm(fullPath, { force: true }));
					}
				}),
			{ concurrency: "unbounded" },
		);
	});
}

function computeBackupHash(files: BackupFileManifest[]) {
	const content = files
		.map((file) => `${file.path}\t${file.rows}\t${file.bytes}\t${file.sha256}`)
		.sort()
		.join("\n");
	return sha256(content);
}

function ensureBackupReadmeEffect(
	repoPath: string,
): Effect.Effect<void, unknown> {
	return Effect.gen(function* () {
		const readmePath = yield* trySync(() =>
			resolveBackupFilePath(repoPath, "README.md"),
		);
		yield* assertNoSymlinkAncestorEffect(repoPath, readmePath);
		if (yield* trySync(() => existsSync(readmePath))) {
			return;
		}
		yield* tryPromise(() =>
			fs.writeFile(
				readmePath,
				`# Birdclaw Store

Private text backup for Birdclaw data. The committed files are canonical JSONL shards that can rebuild the local SQLite index.

## Layout

\`\`\`text
manifest.json
data/accounts.jsonl
data/profiles.jsonl
data/profile_affiliations.jsonl
data/profile_snapshots.jsonl
data/profile_bio_entities.jsonl
data/tweets/YYYY.jsonl
data/tweets/unknown.jsonl
data/timeline_edges/home.jsonl
data/timeline_edges/mention.jsonl
data/collections/likes.jsonl
data/collections/bookmarks.jsonl
data/dms/conversations.jsonl
data/dms/YYYY.jsonl
data/links/url_expansions.jsonl
data/links/occurrences.jsonl
data/moderation/blocks.jsonl
data/moderation/mutes.jsonl
data/follow_snapshots.jsonl
data/follow_snapshot_members.jsonl
data/follow_edges.jsonl
data/follow_events.jsonl
\`\`\`

Tweets are sharded by creation year. Collection-only tweets whose creation date is unknown live in \`data/tweets/unknown.jsonl\`. Timeline edges keep account-scoped home/mention membership separate from canonical tweet content. DMs are sharded by year and keep \`conversation_id\` in each row.
The links shard stores expanded short URLs and their source tweet/DM occurrences so linked-tweet search can be rebuilt without re-expanding every \`t.co\` URL.

Never commit live tokens, browser cookies, raw SQLite WAL/SHM sidecars, or temporary cache files here.
`,
				"utf8",
			),
		);
	});
}

function writeManifestEffect(
	repoPath: string,
	manifest: BackupManifest,
): Effect.Effect<void, unknown> {
	return Effect.gen(function* () {
		const manifestPath = yield* trySync(() =>
			resolveBackupFilePath(repoPath, MANIFEST_PATH),
		);
		yield* assertNoSymlinkAncestorEffect(repoPath, manifestPath);
		const content = yield* trySync(
			() => `${canonicalStringify(manifest as unknown as JsonRecord)}\n`,
		);
		const current = yield* tryPromise(() =>
			fs.readFile(manifestPath, "utf8"),
		).pipe(Effect.option);
		if (current._tag === "Some" && current.value === content) {
			return;
		}
		yield* tryPromise(() => fs.writeFile(manifestPath, content, "utf8"));
	});
}

function readPreviousManifestEffect(
	repoPath: string,
): Effect.Effect<BackupManifest | undefined, never> {
	return readManifestEffect(repoPath).pipe(
		Effect.catchAll(() => Effect.succeed(undefined)),
	);
}

function maybeCommitAndPushEffect({
	repoPath,
	message,
	commit,
	push,
}: {
	repoPath: string;
	message: string;
	commit: boolean;
	push: boolean;
}) {
	if (!commit && !push) {
		return Effect.succeed(undefined);
	}

	return Effect.gen(function* () {
		yield* gitEffect([
			"-C",
			repoPath,
			"rev-parse",
			"--is-inside-work-tree",
		]).pipe(
			Effect.catchAll(() =>
				gitEffect(["-C", repoPath, "init"]).pipe(Effect.asVoid),
			),
		);

		yield* gitEffect([
			"-C",
			repoPath,
			"add",
			"README.md",
			MANIFEST_PATH,
			DATA_DIR,
		]);

		yield* gitEffect(["-C", repoPath, "config", "user.email"]).pipe(
			Effect.catchAll(() =>
				gitEffect([
					"-C",
					repoPath,
					"config",
					"user.email",
					"birdclaw@example.invalid",
				]),
			),
		);
		yield* gitEffect(["-C", repoPath, "config", "user.name"]).pipe(
			Effect.catchAll(() =>
				gitEffect(["-C", repoPath, "config", "user.name", "Birdclaw Backup"]),
			),
		);

		const commitResult = yield* gitEffect([
			"-C",
			repoPath,
			"diff",
			"--cached",
			"--quiet",
		]).pipe(
			Effect.as({ committed: false as const, commitHash: undefined }),
			Effect.catchAll(() =>
				Effect.gen(function* () {
					yield* gitEffect([
						"-C",
						repoPath,
						"-c",
						"commit.gpgsign=false",
						"commit",
						"-m",
						message,
					]);
					const { stdout } = yield* gitEffect([
						"-C",
						repoPath,
						"rev-parse",
						"HEAD",
					]);
					return {
						committed: true as const,
						commitHash: stdout.trim(),
					};
				}),
			),
		);

		if (push) {
			yield* gitEffect(["-C", repoPath, "push"]).pipe(
				Effect.catchAll(() =>
					gitEffect(["-C", repoPath, "push", "-u", "origin", "HEAD:main"]),
				),
			);
		}

		return {
			committed: commitResult.committed,
			pushed: push,
			commit: commitResult.commitHash,
		};
	});
}

function isGitRepoEffect(repoPath: string) {
	return gitEffect(["-C", repoPath, "rev-parse", "--is-inside-work-tree"]).pipe(
		Effect.as(true),
		Effect.catchAll(() => Effect.succeed(false)),
	);
}

function hasGitCommitsEffect(repoPath: string) {
	return gitEffect(["-C", repoPath, "rev-parse", "--verify", "HEAD"]).pipe(
		Effect.as(true),
		Effect.catchAll(() => Effect.succeed(false)),
	);
}

function ensureBackupGitRepoEffect({
	repoPath,
	remote,
}: {
	repoPath: string;
	remote?: string;
}) {
	return Effect.gen(function* () {
		if (!(yield* isGitRepoEffect(repoPath))) {
			if (remote && !existsSync(repoPath)) {
				yield* gitEffect(["clone", remote, repoPath]);
			} else {
				yield* tryPromise(() => fs.mkdir(repoPath, { recursive: true }));
				yield* gitEffect(["-C", repoPath, "init"]);
			}
		}

		if (remote) {
			const origin = yield* gitEffect([
				"-C",
				repoPath,
				"remote",
				"get-url",
				"origin",
			]).pipe(
				Effect.map(({ stdout }) => ({ ok: true as const, stdout })),
				Effect.catchAll(() => Effect.succeed({ ok: false as const })),
			);
			if (origin.ok) {
				if (origin.stdout.trim() !== remote) {
					yield* gitEffect([
						"-C",
						repoPath,
						"remote",
						"set-url",
						"origin",
						remote,
					]);
				}
			} else {
				yield* gitEffect(["-C", repoPath, "remote", "add", "origin", remote]);
			}
		}

		if (remote && !(yield* hasGitCommitsEffect(repoPath))) {
			const fetched = yield* gitEffect([
				"-C",
				repoPath,
				"fetch",
				"origin",
				"main",
			]).pipe(
				Effect.flatMap(() =>
					gitEffect(["-C", repoPath, "checkout", "-B", "main", "origin/main"]),
				),
				Effect.as(true),
				Effect.catchAll(() => Effect.succeed(false)),
			);
			if (fetched) return;
		}

		if (!(yield* hasGitCommitsEffect(repoPath))) {
			yield* gitEffect(["-C", repoPath, "checkout", "-B", "main"]);
		}
	});
}

function pullBackupGitRepoEffect(repoPath: string) {
	return Effect.gen(function* () {
		if (
			!(yield* isGitRepoEffect(repoPath)) ||
			!(yield* hasGitCommitsEffect(repoPath))
		) {
			return false;
		}
		return yield* gitEffect(["-C", repoPath, "pull", "--ff-only"]).pipe(
			Effect.as(true),
			Effect.catchAll(() =>
				gitEffect(["-C", repoPath, "pull", "--ff-only", "origin", "main"]).pipe(
					Effect.as(true),
					Effect.catchAll(() => Effect.succeed(false)),
				),
			),
		);
	});
}

export function exportBackupEffect({
	repoPath,
	db,
	commit = false,
	push = false,
	message = "archive: update birdclaw backup",
	validate = true,
}: {
	repoPath: string;
	db?: Database;
	commit?: boolean;
	push?: boolean;
	message?: string;
	validate?: boolean;
}): Effect.Effect<BackupExportResult, unknown> {
	return Effect.gen(function* () {
		const resolvedRepoPath = yield* trySync(() => path.resolve(repoPath));
		const database =
			db ?? (yield* trySync(() => getNativeDb({ seedDemoData: false })));
		yield* tryPromise(() => fs.mkdir(resolvedRepoPath, { recursive: true }));
		const repoStat = yield* tryPromise(() => fs.lstat(resolvedRepoPath));
		if (!repoStat.isDirectory() || repoStat.isSymbolicLink()) {
			return yield* Effect.fail(
				new Error("Backup repository path must be a real directory"),
			);
		}
		yield* ensureBackupReadmeEffect(resolvedRepoPath);

		const shards = yield* trySync(() => buildShards(database));
		const shardEntries = yield* trySync(() =>
			[...shards.entries()].sort(([left], [right]) =>
				left.localeCompare(right),
			),
		);
		const expectedPaths = yield* trySync(
			() => new Set(shardEntries.map(([relativePath]) => relativePath)),
		);
		const files = yield* Effect.forEach(
			shardEntries,
			([relativePath, rows]) =>
				writeJsonlFileEffect(resolvedRepoPath, relativePath, rows),
			{ concurrency: "unbounded" },
		);
		yield* removeStaleBackupFilesEffect(resolvedRepoPath, expectedPaths);

		const counts = yield* trySync(() => countBackupFiles(files));
		const backupHash = yield* trySync(() => computeBackupHash(files));
		const previousManifest =
			yield* readPreviousManifestEffect(resolvedRepoPath);
		const manifest: BackupManifest = {
			app: "birdclaw",
			schemaVersion: BACKUP_SCHEMA_VERSION,
			generatedAt:
				previousManifest?.backupHash === backupHash
					? previousManifest.generatedAt
					: new Date().toISOString(),
			counts,
			files,
			backupHash,
		};
		yield* writeManifestEffect(resolvedRepoPath, manifest);

		const validation = validate
			? yield* validateBackupEffect(resolvedRepoPath)
			: {
					ok: true,
					repoPath: resolvedRepoPath,
					files,
					counts,
					backupHash: manifest.backupHash,
					errors: [],
				};
		if (!validation.ok) {
			return yield* Effect.fail(
				new Error(`Backup validation failed: ${validation.errors.join("; ")}`),
			);
		}

		const git = yield* maybeCommitAndPushEffect({
			repoPath: resolvedRepoPath,
			message,
			commit,
			push,
		});

		return {
			ok: true,
			repoPath: resolvedRepoPath,
			manifest,
			validation,
			...(git ? { git } : {}),
		};
	});
}

export function exportBackup(
	options: Parameters<typeof exportBackupEffect>[0],
): Promise<BackupExportResult> {
	return runEffectPromise(exportBackupEffect(options));
}

function readManifestEffect(
	repoPath: string,
): Effect.Effect<BackupManifest, unknown> {
	return Effect.gen(function* () {
		const manifestPath = yield* trySync(() =>
			resolveBackupFilePath(repoPath, MANIFEST_PATH),
		);
		yield* assertReadableBackupFileEffect(
			repoPath,
			manifestPath,
			MANIFEST_PATH,
		);
		const content = yield* tryPromise(() => fs.readFile(manifestPath, "utf8"));
		const parsed = yield* trySync(() => JSON.parse(content) as BackupManifest);
		if (parsed.app !== "birdclaw") {
			return yield* Effect.fail(
				new Error("Backup manifest is not a birdclaw backup"),
			);
		}
		if (
			parsed.schemaVersion < MIN_SUPPORTED_BACKUP_SCHEMA_VERSION ||
			parsed.schemaVersion > BACKUP_SCHEMA_VERSION
		) {
			return yield* Effect.fail(
				new Error(
					`Unsupported backup schema version ${String(parsed.schemaVersion)}`,
				),
			);
		}
		return parsed;
	});
}

function resolveBackupFilePath(repoPath: string, relativePath: string) {
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

function assertBackupPathInsideRealRootEffect(
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

function assertReadableBackupFileEffect(
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

function assertNoSymlinkAncestorEffect(
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

function readJsonlFilesEffect(
	repoPath: string,
	relativePaths: string[],
): Effect.Effect<JsonRecord[], unknown> {
	return Effect.gen(function* () {
		const sources = yield* Effect.forEach(
			relativePaths,
			(relativePath) =>
				Effect.gen(function* () {
					const filePath = yield* trySync(() =>
						resolveBackupFilePath(repoPath, relativePath),
					);
					yield* assertReadableBackupFileEffect(
						repoPath,
						filePath,
						relativePath,
					);
					return {
						id: relativePath,
						stream: async function* () {
							for await (const row of streamJsonLines(filePath)) {
								yield row.value as JsonRecord;
							}
						},
					};
				}),
			{ concurrency: "unbounded" },
		);
		return yield* collectIngestionSourcesEffect(sources);
	});
}

function readBackupImportRowsEffect(
	resolvedRepoPath: string,
	manifest: BackupManifest,
): Effect.Effect<BackupImportRows, unknown> {
	return Effect.gen(function* () {
		yield* trySync(() => {
			for (const file of manifest.files) {
				if (file.path.startsWith("data/")) backupCodecForPath(file.path);
			}
		});
		const entries = yield* Effect.forEach(
			BACKUP_TABLE_CODECS,
			(codec) =>
				readJsonlFilesEffect(
					resolvedRepoPath,
					rowsForManifestPath(manifest, codec.matchesPath),
				).pipe(Effect.map((rows) => [codec.name, rows] as const)),
			{ concurrency: "unbounded" },
		);
		return Object.assign(createBackupImportRows(), Object.fromEntries(entries));
	});
}

function rowsForManifestPath(
	manifest: BackupManifest,
	predicate: (relativePath: string) => boolean,
) {
	return manifest.files
		.map((file) => file.path)
		.filter(predicate)
		.sort();
}

export function importBackupEffect({
	repoPath,
	db: providedDb,
	validate = true,
	mode = "merge",
}: BackupImportOptions): Effect.Effect<BackupImportResult, unknown> {
	return Effect.gen(function* () {
		const resolvedRepoPath = yield* trySync(() => path.resolve(repoPath));
		const db =
			providedDb ??
			(yield* trySync(() => getNativeDb({ seedDemoData: false })));
		const manifest = yield* readManifestEffect(resolvedRepoPath);
		const validation = validate
			? yield* validateBackupEffect(resolvedRepoPath)
			: undefined;
		if (validation && !validation.ok) {
			return yield* Effect.fail(
				new Error(`Backup validation failed: ${validation.errors.join("; ")}`),
			);
		}

		const importRows = yield* readBackupImportRowsEffect(
			resolvedRepoPath,
			manifest,
		);
		yield* trySync(() => {
			for (const codec of BACKUP_TABLE_CODECS) {
				const transform = codec.merge.transform;
				if (transform)
					importRows[codec.name] = transform(importRows[codec.name]);
			}
		});
		const canonicalTweetState = yield* trySync(() =>
			adaptLegacyTweetState(
				manifest.schemaVersion,
				importRows.tweets,
				importRows.tweet_collections,
				importRows.tweet_account_edges,
			),
		);
		importRows.tweet_collections = canonicalTweetState.collections;
		importRows.tweet_account_edges = canonicalTweetState.timelineEdges;
		const fingerprint = yield* databaseWriteEffect((writeDb) => {
			const repository = getImportRepository(writeDb);
			if (mode === "replace") {
				repository.clearBackupImport();
			}
			const existingFtsIds = new Map<string, Set<string>>();
			for (const codec of BACKUP_TABLE_CODECS) {
				const fts = codec.merge.fts;
				if (!fts) continue;
				existingFtsIds.set(
					codec.name,
					mode === "replace"
						? new Set<string>()
						: repository.readFtsIds(fts.target),
				);
			}
			const mergeCodecs = [...BACKUP_TABLE_CODECS].sort(
				(left, right) => left.merge.order - right.merge.order,
			);
			for (const codec of mergeCodecs) {
				const rows = importRows[codec.name];
				repository.insertRows(codec.merge.sql, rows, codec.merge.columns);
				const fts = codec.merge.fts;
				if (!fts) continue;
				repository.insertFtsRows({
					target: fts.target,
					rows,
					idKey: fts.idKey,
					textKey: fts.textKey,
					existingIds: existingFtsIds.get(codec.name),
				});
			}
			return getBackupDatabaseFingerprint(writeDb);
		}, db);

		return {
			ok: true,
			repoPath: resolvedRepoPath,
			mode,
			manifest,
			...(validation ? { validation } : {}),
			fingerprint,
		};
	});
}

export function importBackup(
	options: BackupImportOptions,
): Promise<BackupImportResult> {
	return runEffectPromise(importBackupEffect(options));
}

export interface SyncBackupOptions {
	repoPath: string;
	remote?: string;
	db?: Database;
	message?: string;
}

export function syncBackupEffect({
	repoPath,
	remote,
	message = "archive: sync birdclaw backup",
	db,
}: SyncBackupOptions): Effect.Effect<BackupSyncResult, unknown> {
	return Effect.gen(function* () {
		const resolvedRepoPath = path.resolve(repoPath);
		const database =
			db ?? (yield* trySync(() => getNativeDb({ seedDemoData: false })));
		yield* ensureBackupGitRepoEffect({ repoPath: resolvedRepoPath, remote });
		const pulled = yield* pullBackupGitRepoEffect(resolvedRepoPath);
		const manifestExists = yield* trySync(() =>
			existsSync(path.join(resolvedRepoPath, MANIFEST_PATH)),
		);
		const importResult = manifestExists
			? yield* importBackupEffect({
					repoPath: resolvedRepoPath,
					db: database,
					mode: "merge",
				})
			: undefined;
		const exportResult = yield* exportBackupEffect({
			repoPath: resolvedRepoPath,
			db: database,
			commit: true,
			push: true,
			message,
		});

		return {
			ok: true,
			repoPath: resolvedRepoPath,
			...(remote ? { remote: redactSecretUrl(remote) } : {}),
			pulled,
			imported: Boolean(importResult),
			...(importResult ? { importResult } : {}),
			exportResult,
		};
	});
}

export function syncBackup(
	options: SyncBackupOptions,
): Promise<BackupSyncResult> {
	return runEffectPromise(syncBackupEffect(options));
}

export interface UpdateBackupFromGitOptions {
	repoPath: string;
	remote?: string;
	db?: Database;
}

export interface UpdateBackupFromGitResult {
	ok: true;
	repoPath: string;
	remote?: string;
	pulled: boolean;
	imported: boolean;
	importResult?: BackupImportResult;
}

export function updateBackupFromGitEffect({
	repoPath,
	remote,
	db,
}: UpdateBackupFromGitOptions): Effect.Effect<
	UpdateBackupFromGitResult,
	unknown
> {
	return Effect.gen(function* () {
		const resolvedRepoPath = path.resolve(repoPath);
		const database =
			db ?? (yield* trySync(() => getNativeDb({ seedDemoData: false })));
		yield* ensureBackupGitRepoEffect({ repoPath: resolvedRepoPath, remote });
		const pulled = yield* pullBackupGitRepoEffect(resolvedRepoPath);
		const manifestExists = yield* trySync(() =>
			existsSync(path.join(resolvedRepoPath, MANIFEST_PATH)),
		);
		const importResult = manifestExists
			? yield* importBackupEffect({
					repoPath: resolvedRepoPath,
					db: database,
					mode: "merge",
				})
			: undefined;

		return {
			ok: true,
			repoPath: resolvedRepoPath,
			...(remote ? { remote: redactSecretUrl(remote) } : {}),
			pulled,
			imported: Boolean(importResult),
			...(importResult ? { importResult } : {}),
		};
	});
}

function readAutoSyncState(db: Database) {
	const row = db
		.prepare("select value_json from sync_cache where cache_key = ?")
		.get(AUTO_SYNC_CACHE_KEY) as { value_json: string } | undefined;
	if (!row) {
		return null;
	}
	try {
		return JSON.parse(row.value_json) as {
			checkedAt?: string;
			ok?: boolean;
			error?: string;
		};
	} catch {
		return null;
	}
}

function writeAutoSyncState(
	db: Database,
	value: { checkedAt: string; ok: boolean; error?: string },
) {
	db.prepare(
		`
    insert into sync_cache (cache_key, value_json, updated_at)
    values (?, ?, ?)
    on conflict(cache_key) do update set
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
    `,
	).run(AUTO_SYNC_CACHE_KEY, JSON.stringify(value), value.checkedAt);
}

function resolveAutoSyncConfig() {
	const backup = getBirdclawConfig().backup;
	if (!backup || backup.autoSync === false) {
		return null;
	}
	const repoPath = backup.repoPath?.trim();
	const remote = backup.remote?.trim();
	if (!repoPath && !remote) {
		return null;
	}
	const staleAfterSeconds =
		typeof backup.staleAfterSeconds === "number" &&
		Number.isFinite(backup.staleAfterSeconds) &&
		backup.staleAfterSeconds >= 0
			? Math.floor(backup.staleAfterSeconds)
			: DEFAULT_STALE_AFTER_SECONDS;

	return {
		repoPath:
			repoPath ||
			path.join(process.env.HOME || ".", "Projects", "backup-birdclaw"),
		remote,
		staleAfterSeconds,
	};
}

function autoSyncConfigError(error: unknown): BackupAutoUpdateResult {
	return {
		ok: false,
		enabled: true,
		skipped: false,
		error: error instanceof Error ? error.message : String(error),
	};
}

function runMaybeAutoUpdateBackupEffect(
	db?: Database,
): Effect.Effect<BackupAutoUpdateResult, never> {
	return Effect.gen(function* () {
		if (process.env.BIRDCLAW_BACKUP_AUTO_SYNC === "0") {
			return {
				ok: true,
				enabled: false,
				skipped: true,
				reason: "disabled by BIRDCLAW_BACKUP_AUTO_SYNC=0",
			};
		}
		const configResult = yield* trySync(() => resolveAutoSyncConfig()).pipe(
			Effect.map((config) => ({ ok: true as const, config })),
			Effect.catchAll((error) => Effect.succeed({ ok: false as const, error })),
		);
		if (!configResult.ok) return autoSyncConfigError(configResult.error);
		const { config } = configResult;
		if (!config) {
			return {
				ok: true,
				enabled: false,
				skipped: true,
				reason: "backup auto-sync is not configured",
			};
		}

		const database = yield* trySync(
			() => db ?? getNativeDb({ seedDemoData: false }),
		).pipe(Effect.orDie);
		const state = yield* trySync(() => readAutoSyncState(database)).pipe(
			Effect.catchAll(() => Effect.succeed(null)),
		);
		const checkedAt = state?.checkedAt
			? new Date(state.checkedAt).getTime()
			: 0;
		const ageMs = Date.now() - checkedAt;
		if (ageMs >= 0 && ageMs < config.staleAfterSeconds * 1000) {
			return {
				ok: true,
				enabled: true,
				skipped: true,
				reason: "backup auto-sync is fresh",
				repoPath: config.repoPath,
				...(config.remote ? { remote: redactSecretUrl(config.remote) } : {}),
			};
		}

		const now = new Date().toISOString();
		const result = yield* updateBackupFromGitEffect({
			repoPath: config.repoPath,
			remote: config.remote,
			db: database,
		}).pipe(
			Effect.map((value) => ({ ok: true as const, value })),
			Effect.catchAll((error) => Effect.succeed({ ok: false as const, error })),
		);

		if (result.ok) {
			yield* trySync(() =>
				writeAutoSyncState(database, { checkedAt: now, ok: true }),
			).pipe(Effect.orDie);
			return {
				ok: true,
				enabled: true,
				skipped: false,
				repoPath: result.value.repoPath,
				...(result.value.remote
					? { remote: redactSecretUrl(result.value.remote) }
					: {}),
				pulled: result.value.pulled,
				imported: result.value.imported,
			};
		}

		const message =
			result.error instanceof Error
				? result.error.message
				: String(result.error);
		yield* trySync(() =>
			writeAutoSyncState(database, {
				checkedAt: now,
				ok: false,
				error: message,
			}),
		).pipe(Effect.orDie);
		return {
			ok: false,
			enabled: true,
			skipped: false,
			repoPath: config.repoPath,
			...(config.remote ? { remote: redactSecretUrl(config.remote) } : {}),
			error: redactSecretUrl(message),
		};
	});
}

export function maybeAutoUpdateBackupEffect(
	db?: Database,
): Effect.Effect<BackupAutoUpdateResult, never> {
	if (autoUpdateInFlight) {
		return Effect.promise(() => autoUpdateInFlight!);
	}

	return Effect.promise(() => {
		const promise = runEffectPromise(
			runMaybeAutoUpdateBackupEffect(db),
		).finally(() => {
			if (autoUpdateInFlight === promise) {
				autoUpdateInFlight = null;
			}
		});
		autoUpdateInFlight = promise;
		return promise;
	});
}

export function maybeAutoUpdateBackup(
	db?: Database,
): Promise<BackupAutoUpdateResult> {
	return runEffectPromise(maybeAutoUpdateBackupEffect(db));
}

export function maybeAutoSyncBackupEffect(
	db?: Database,
): Effect.Effect<BackupAutoUpdateResult, never> {
	return Effect.gen(function* () {
		if (process.env.BIRDCLAW_BACKUP_AUTO_SYNC === "0") {
			return {
				ok: true,
				enabled: false,
				skipped: true,
				reason: "disabled by BIRDCLAW_BACKUP_AUTO_SYNC=0",
			};
		}
		const configResult = yield* trySync(() => resolveAutoSyncConfig()).pipe(
			Effect.map((config) => ({ ok: true as const, config })),
			Effect.catchAll((error) => Effect.succeed({ ok: false as const, error })),
		);
		if (!configResult.ok) return autoSyncConfigError(configResult.error);
		const { config } = configResult;
		if (!config) {
			return {
				ok: true,
				enabled: false,
				skipped: true,
				reason: "backup auto-sync is not configured",
			};
		}
		const database = yield* trySync(
			() => db ?? getNativeDb({ seedDemoData: false }),
		).pipe(Effect.orDie);
		const now = new Date().toISOString();
		const result = yield* syncBackupEffect({
			repoPath: config.repoPath,
			remote: config.remote,
			db: database,
		}).pipe(
			Effect.map((value) => ({ ok: true as const, value })),
			Effect.catchAll((error) => Effect.succeed({ ok: false as const, error })),
		);

		if (result.ok) {
			yield* trySync(() =>
				writeAutoSyncState(database, { checkedAt: now, ok: true }),
			).pipe(Effect.orDie);
			return {
				ok: true,
				enabled: true,
				skipped: false,
				repoPath: result.value.repoPath,
				...(result.value.remote ? { remote: result.value.remote } : {}),
				pulled: result.value.pulled,
				imported: result.value.imported,
			};
		}

		const message =
			result.error instanceof Error
				? result.error.message
				: String(result.error);
		yield* trySync(() =>
			writeAutoSyncState(database, {
				checkedAt: now,
				ok: false,
				error: message,
			}),
		).pipe(Effect.orDie);
		return {
			ok: false,
			enabled: true,
			skipped: false,
			repoPath: config.repoPath,
			...(config.remote ? { remote: config.remote } : {}),
			error: message,
		};
	});
}

export function maybeAutoSyncBackup(
	db?: Database,
): Promise<BackupAutoUpdateResult> {
	return runEffectPromise(maybeAutoSyncBackupEffect(db));
}

export function validateBackupEffect(
	repoPath: string,
): Effect.Effect<BackupValidationResult, unknown> {
	return Effect.gen(function* () {
		const resolvedRepoPath = yield* trySync(() => path.resolve(repoPath));
		const errors: string[] = [];
		const manifestResult = yield* readManifestEffect(resolvedRepoPath).pipe(
			Effect.match({
				onFailure: (error) => ({ ok: false as const, error }),
				onSuccess: (manifest) => ({ ok: true as const, manifest }),
			}),
		);
		if (!manifestResult.ok) {
			return {
				ok: false,
				repoPath: resolvedRepoPath,
				files: [],
				counts: {},
				backupHash: "",
				errors: [
					manifestResult.error instanceof Error
						? manifestResult.error.message
						: String(manifestResult.error),
				],
			};
		}
		const { manifest } = manifestResult;

		const results = yield* Effect.forEach(
			manifest.files,
			(expected) =>
				Effect.gen(function* () {
					const fileErrors: string[] = [];
					let file: BackupFileManifest | undefined;
					const filePath = yield* trySync(() =>
						resolveBackupFilePath(resolvedRepoPath, expected.path),
					).pipe(
						Effect.match({
							onFailure: (error) => {
								fileErrors.push(
									`${expected.path}: ${error instanceof Error ? error.message : String(error)}`,
								);
								return undefined;
							},
							onSuccess: (value) => value,
						}),
					);
					if (!filePath) {
						return { file, errors: fileErrors };
					}
					const stat = yield* assertReadableBackupFileEffect(
						resolvedRepoPath,
						filePath,
						expected.path,
					).pipe(
						Effect.match({
							onFailure: (error) => {
								fileErrors.push(
									`${expected.path}: ${error instanceof Error ? error.message : String(error)}`,
								);
								return undefined;
							},
							onSuccess: (value) => value,
						}),
					);
					if (!stat) {
						return { file, errors: fileErrors };
					}
					const content = yield* tryPromise(() => fs.readFile(filePath)).pipe(
						Effect.match({
							onFailure: (error) => {
								fileErrors.push(
									`${expected.path}: ${error instanceof Error ? error.message : String(error)}`,
								);
								return undefined;
							},
							onSuccess: (value) => value,
						}),
					);
					if (content) {
						const text = content.toString("utf8");
						const rows = text.split("\n").filter((line) => line.length > 0);
						for (const [index, line] of rows.entries()) {
							const parseError = yield* trySync(() => JSON.parse(line)).pipe(
								Effect.match({
									onFailure: (error) => error,
									onSuccess: () => undefined,
								}),
							);
							if (parseError) {
								fileErrors.push(
									`${expected.path}:${index + 1}: ${
										parseError instanceof Error
											? parseError.message
											: String(parseError)
									}`,
								);
							}
						}
						file = {
							path: expected.path,
							rows: rows.length,
							sha256: sha256(content),
							bytes: content.byteLength,
						};
					}
					return { file, errors: fileErrors };
				}),
			{ concurrency: "unbounded" },
		);

		const files: BackupFileManifest[] = [];
		for (const result of results) {
			errors.push(...result.errors);
			if (result.file) {
				files.push(result.file);
			}
		}

		for (const expected of manifest.files) {
			const file = files.find((entry) => entry.path === expected.path);
			if (!file) {
				continue;
			}
			if (file.rows !== expected.rows) {
				errors.push(`${file.path}: row count ${file.rows} != ${expected.rows}`);
			}
			if (file.sha256 !== expected.sha256) {
				errors.push(
					`${file.path}: sha256 ${file.sha256} != ${expected.sha256}`,
				);
			}
			if (file.bytes !== expected.bytes) {
				errors.push(`${file.path}: bytes ${file.bytes} != ${expected.bytes}`);
			}
		}

		const counts = yield* trySync(() => countBackupFiles(files)).pipe(
			Effect.match({
				onFailure: (error) => {
					errors.push(error instanceof Error ? error.message : String(error));
					return {};
				},
				onSuccess: (value) => value,
			}),
		);
		const backupHash = computeBackupHash(files);
		if (backupHash !== manifest.backupHash) {
			errors.push(`backup hash ${backupHash} != ${manifest.backupHash}`);
		}
		if (canonicalStringify(counts) !== canonicalStringify(manifest.counts)) {
			errors.push("manifest counts do not match backup files");
		}

		return {
			ok: errors.length === 0,
			repoPath: resolvedRepoPath,
			files,
			counts,
			backupHash,
			errors,
		};
	});
}

export function validateBackup(
	repoPath: string,
): Promise<BackupValidationResult> {
	return runEffectPromise(validateBackupEffect(repoPath));
}

export function getBackupDatabaseFingerprint(
	db = getNativeDb({ seedDemoData: false }),
): BackupDatabaseFingerprint {
	const counts: Record<string, number> = {};
	const hash = createHash("sha256");
	for (const rowSet of getExportRowSets(db)) {
		counts[rowSet.logicalName] = rowSet.rows.length;
		hash.update(`${rowSet.logicalName}\n`);
		for (const row of rowSet.rows) {
			hash.update(canonicalStringify(row));
			hash.update("\n");
		}
	}
	return { counts, hash: hash.digest("hex") };
}
