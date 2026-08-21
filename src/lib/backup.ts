import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { Data, Effect } from "effect";
import NativeSqliteDatabase, { type Database } from "./sqlite";
import {
	BACKUP_TABLE_CODECS,
	adaptLegacyTweetState,
	backupCodecForPath,
	buildBackupShardsFromRowSets,
	countBackupFiles,
	createBackupImportRows,
	logicalBackupShardPath,
	type BackupImportRows,
	type BackupJsonRecord as JsonRecord,
	type BackupJsonValue as JsonValue,
} from "./backup-table-codecs";
import { getBirdclawConfig, getBirdclawPaths } from "./config";
import { getNativeDb, refreshReadDatabasePoolAfterBulkWrite } from "./db";
import { databaseWriteEffect } from "./database-writer";
import {
	runEffectBackground,
	runEffectPromise,
	trySync,
	tryPromise,
} from "./effect-runtime";
import { getImportRepository } from "./import-repository";
import {
	mergeTweetRevisionChain,
	reconcileTweetTombstones,
} from "./tweet-retention";
import {
	collectIngestionSourcesEffect,
	streamJsonLines,
} from "./streaming-ingestion";
import { runSubprocessEffect, SubprocessError } from "./subprocess";
import { acquireScheduledJobLockEffect } from "./scheduled-job";
import {
	finalizeBackupProfileRows,
	reconcileBackupProfileRows,
	type BackupLegacyProfileMergePlan,
} from "./profile-identity";
import { resolveLiveSyncAccount } from "./live-sync-engine";

const BACKUP_SCHEMA_VERSION = 9;
const MIN_SUPPORTED_BACKUP_SCHEMA_VERSION = 1;
const DEFAULT_MAX_BACKUP_SHARD_BYTES = 48 * 1024 * 1024;
const MANIFEST_PATH = "manifest.json";
const DATA_DIR = "data";
const GITATTRIBUTES_PATH = ".gitattributes";
const AUTO_SYNC_CACHE_KEY = "backup:auto-sync";
const DEFAULT_STALE_AFTER_SECONDS = 15 * 60;
const BACKGROUND_AUTO_UPDATE_DELAY_MS = 5_000;
const BACKUP_LOCK_STALE_MS = 6 * 60 * 60 * 1000;
const BACKUP_TRANSACTION_DIR = "birdclaw-backup-transaction";
const PENDING_PUSH_RECEIPT_PATH = "pending-push.json";
const BACKUP_PUSH_REMOTE = "origin";
const BACKUP_PUSH_REMOTE_REF = "refs/heads/main";
const MANAGED_BACKUP_PATHS = [
	DATA_DIR,
	"README.md",
	GITATTRIBUTES_PATH,
	MANIFEST_PATH,
] as const;
let autoUpdateInFlight: Promise<BackupAutoUpdateResult> | null = null;
let autoUpdateBackgroundScheduled = false;
let beforeStagedValidationForTests:
	| ((stagingPath: string) => void | Promise<void>)
	| undefined;
let afterPublicationRenameForTests:
	| ((
			relativePath: string,
			phase: "rollback" | "install",
	  ) => void | Promise<void>)
	| undefined;
let beforeDatabaseOpenForTests: (() => void) | undefined;
let beforeCommittedCleanupForTests: (() => void | Promise<void>) | undefined;
let afterPublicationForTests: (() => void | Promise<void>) | undefined;
let afterRecoveryCleanupBoundaryForTests:
	| ((
			boundary: "journal" | "stage" | "rollback" | "root",
	  ) => void | Promise<void>)
	| undefined;

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
	pushOnly?: boolean;
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
	backupHash?: string;
	error?: string;
}

interface BackupAutoSyncState {
	checkedAt?: string;
	ok?: boolean;
	error?: string;
	backupHash?: string;
}

interface BackupTransactionJournal {
	version: 1;
	repoPath: string;
	repoDevice: number;
	repoInode: number;
	repoBirthTimeNs: string;
	stagePath: string;
	rollbackPath: string;
	state: "publishing" | "published" | "rolled_back" | "committed";
	liveExisted: Record<string, boolean>;
	gitIndexPath?: string;
	gitIndexBackupPath?: string;
	gitIndexExisted?: boolean;
	headBefore?: string;
	gitCommonDir?: string;
	gitCommonDevice?: number;
	gitCommonInode?: number;
}

type BackupRemoteBranchState =
	| { kind: "absent" }
	| { kind: "commit"; commit: string };

interface PendingBackupPushReceipt {
	version: 1;
	token: string;
	commit: string;
	remote: typeof BACKUP_PUSH_REMOTE;
	remoteIdentity: string;
	remoteRef: typeof BACKUP_PUSH_REMOTE_REF;
	remoteBranch: BackupRemoteBranchState;
	createdAt: string;
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

function openBackupDatabase() {
	beforeDatabaseOpenForTests?.();
	return getNativeDb({ seedDemoData: false });
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

function gitEffect(args: string[], options: { maxBufferBytes?: number } = {}) {
	return runSubprocessEffect({
		command: "git",
		args,
		redact: redactSecretUrl,
		...options,
	}).pipe(Effect.mapError((cause) => gitCommandError(args, cause)));
}

function backupLockPath(repoPath: string) {
	const resolved = path.resolve(repoPath);
	const digest = createHash("sha256")
		.update(resolved)
		.digest("hex")
		.slice(0, 12);
	return path.join(
		path.dirname(resolved),
		`.birdclaw-backup-${path.basename(resolved)}-${digest}.lock`,
	);
}

async function canonicalizeBackupRepoPath(repoPath: string) {
	const absolute = path.resolve(repoPath);
	const suffix: string[] = [];
	let existing = absolute;
	while (true) {
		try {
			await fs.lstat(existing);
			break;
		} catch (error) {
			if (
				!error ||
				typeof error !== "object" ||
				!("code" in error) ||
				error.code !== "ENOENT"
			) {
				throw error;
			}
			const parent = path.dirname(existing);
			if (parent === existing) throw error;
			suffix.unshift(path.basename(existing));
			existing = parent;
		}
	}
	return path.join(await fs.realpath(existing), ...suffix);
}

function withBackupRepositoryLockEffect<A, E>(
	repoPath: string,
	use: (resolvedRepoPath: string) => Effect.Effect<A, E, never>,
): Effect.Effect<A, E | unknown, never> {
	return Effect.gen(function* () {
		const resolvedRepoPath = yield* tryPromise(() =>
			canonicalizeBackupRepoPath(repoPath),
		);
		return yield* Effect.acquireUseRelease(
			acquireScheduledJobLockEffect(
				backupLockPath(resolvedRepoPath),
				BACKUP_LOCK_STALE_MS,
			).pipe(
				Effect.flatMap((release) =>
					release
						? Effect.succeed(release)
						: Effect.fail(
								new Error(
									`Backup repository is locked by another process: ${resolvedRepoPath}`,
								),
							),
				),
			),
			() =>
				Effect.gen(function* () {
					yield* recoverBackupTransactionEffect(resolvedRepoPath);
					return yield* use(resolvedRepoPath);
				}),
			(release) => release(),
		);
	});
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

function normalizeMaxBackupShardBytes(value: number | undefined) {
	const maxBytes = value ?? DEFAULT_MAX_BACKUP_SHARD_BYTES;
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
		throw new Error("Backup shard byte limit must be a positive integer");
	}
	return maxBytes;
}

function partPath(relativePath: string, partNumber: number) {
	if (!relativePath.endsWith(".jsonl")) {
		throw new Error(`Backup shard path must end in .jsonl: ${relativePath}`);
	}
	return relativePath.replace(
		/\.jsonl$/u,
		`.part-${String(partNumber).padStart(4, "0")}.jsonl`,
	);
}

function splitJsonlShard(
	relativePath: string,
	rows: JsonRecord[],
	maxBytes: number,
) {
	const parts: JsonRecord[][] = [];
	let currentRows: JsonRecord[] = [];
	let currentBytes = 0;
	for (const [index, row] of rows.entries()) {
		const rowBytes = Buffer.byteLength(jsonlStringify(row)) + 1;
		if (rowBytes > maxBytes) {
			throw new Error(
				`Backup row exceeds shard byte limit: ${relativePath}:${index + 1} is ${rowBytes} bytes (limit ${maxBytes})`,
			);
		}
		if (currentRows.length > 0 && currentBytes + rowBytes > maxBytes) {
			parts.push(currentRows);
			currentRows = [];
			currentBytes = 0;
		}
		currentRows.push(row);
		currentBytes += rowBytes;
	}
	if (currentRows.length > 0) parts.push(currentRows);
	if (parts.length <= 1) {
		return [{ relativePath, rows: parts[0] ?? [] }];
	}
	return parts.map((partRows, index) => ({
		relativePath: partPath(relativePath, index + 1),
		rows: partRows,
	}));
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
		yield* tryPromise(() => durableMkdir(path.dirname(fullPath)));
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
			yield* tryPromise(() => durableWriteFile(fullPath, content, "utf8"));
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
						yield* tryPromise(() => durableRemove(fullPath, { force: true }));
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
			durableWriteFile(
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
data/fxtwitter/fetches.jsonl
data/fxtwitter/observations.jsonl
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
data/lists/lists.jsonl
data/lists/members.jsonl
data/follow_events.jsonl
\`\`\`

Tweets are sharded by creation year. Collection-only tweets whose creation date is unknown live in \`data/tweets/unknown.jsonl\`. Timeline edges keep account-scoped home/mention membership separate from canonical tweet content. DMs are sharded by year and keep \`conversation_id\` in each row.
Logical shards larger than 48 MiB are split into deterministic \`.part-0001.jsonl\` files so ordinary Git hosting remains usable without Git LFS.
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
		yield* tryPromise(() => durableWriteFile(manifestPath, content, "utf8"));
	});
}

function readPreviousManifestEffect(
	repoPath: string,
): Effect.Effect<BackupManifest | undefined, never> {
	return readManifestEffect(repoPath).pipe(
		Effect.catchAll(() => Effect.succeed(undefined)),
	);
}

function ensureBackupGitattributesEffect(repoPath: string) {
	return Effect.gen(function* () {
		const attributesPath = yield* trySync(() =>
			resolveBackupFilePath(repoPath, GITATTRIBUTES_PATH),
		);
		yield* assertNoSymlinkAncestorEffect(repoPath, attributesPath);
		const requiredLines = [
			"data/**/*.jsonl text eol=lf",
			`${MANIFEST_PATH} text eol=lf`,
		];
		const generatedBlock = [
			"# BEGIN birdclaw backup attributes",
			"# Backup hashes use the raw LF-delimited bytes written by Birdclaw.",
			...requiredLines,
			"# END birdclaw backup attributes",
			"",
		].join("\n");
		const current = yield* tryPromise(() =>
			fs.readFile(attributesPath, "utf8"),
		).pipe(Effect.option);
		if (current._tag === "Some" && current.value.endsWith(generatedBlock)) {
			return;
		}
		const preserved =
			current._tag === "Some"
				? current.value.replaceAll(generatedBlock, "").replace(/[\r\n]+$/u, "")
				: "";
		const content = preserved
			? `${preserved}\n\n${generatedBlock}`
			: generatedBlock;
		yield* tryPromise(() => durableWriteFile(attributesPath, content, "utf8"));
	});
}

function maybeCommitEffect({
	repoPath,
	message,
	commit,
}: {
	repoPath: string;
	message: string;
	commit: boolean;
}) {
	return Effect.gen(function* () {
		if (!commit) return undefined;
		if (!(yield* isGitRepoEffect(repoPath))) {
			yield* gitEffect(["-C", repoPath, "init"]);
		}
		if (!(yield* isGitRepoEffect(repoPath))) {
			return yield* Effect.fail(
				new Error(
					"Backup Git operations must run at the configured repository root",
				),
			);
		}

		yield* gitEffect([
			"-C",
			repoPath,
			"add",
			GITATTRIBUTES_PATH,
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

		return {
			committed: commitResult.committed,
			commit: commitResult.commitHash,
		};
	});
}

function isGitRepoEffect(repoPath: string) {
	if (!existsSync(path.join(repoPath, ".git"))) {
		return Effect.succeed(false);
	}
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

function assertBackupIndexUnlockedEffect(repoPath: string) {
	return Effect.gen(function* () {
		if (!(yield* isGitRepoEffect(repoPath))) return;
		const { stdout } = yield* gitEffect([
			"-C",
			repoPath,
			"rev-parse",
			"--git-path",
			"index.lock",
		]);
		const indexLockPath = path.isAbsolute(stdout.trim())
			? stdout.trim()
			: path.resolve(repoPath, stdout.trim());
		if (yield* trySync(() => existsSync(indexLockPath))) {
			return yield* Effect.fail(
				new Error(`Backup Git index is locked: ${indexLockPath}`),
			);
		}
	});
}

function assertBackupCheckoutCleanEffect(repoPath: string) {
	return Effect.gen(function* () {
		if (!(yield* isGitRepoEffect(repoPath))) return;
		yield* assertBackupIndexUnlockedEffect(repoPath);
		const { stdout } = yield* gitEffect([
			"-C",
			repoPath,
			"status",
			"--porcelain=v1",
			"--untracked-files=all",
		]);
		if (stdout.trim().length > 0) {
			return yield* Effect.fail(
				new Error("Backup checkout is dirty; refusing to import or publish"),
			);
		}
	});
}

function assertCurrentManifestValidEffect(repoPath: string) {
	return Effect.gen(function* () {
		if (
			!(yield* trySync(() => existsSync(path.join(repoPath, MANIFEST_PATH))))
		) {
			yield* assertManagedDataInventoryEffect(repoPath);
			return undefined;
		}
		const validation = yield* validateBackupEffect(repoPath);
		if (!validation.ok) {
			return yield* Effect.fail(
				new Error(
					`Current backup manifest is invalid: ${validation.errors.join("; ")}`,
				),
			);
		}
		yield* assertManagedDataInventoryEffect(repoPath);
		return validation;
	});
}

function assertManagedDataInventoryEffect(repoPath: string) {
	return Effect.gen(function* () {
		const manifestPath = path.join(repoPath, MANIFEST_PATH);
		const manifest = (yield* trySync(() => existsSync(manifestPath)))
			? yield* readManifestEffect(repoPath)
			: undefined;
		const expectedFiles = new Set(
			(manifest?.files ?? [])
				.map((file) => file.path)
				.filter((relativePath) => relativePath.startsWith(`${DATA_DIR}/`)),
		);
		const expectedDirectories = new Set<string>([DATA_DIR]);
		for (const relativePath of expectedFiles) {
			let directory = path.posix.dirname(relativePath);
			while (directory === DATA_DIR || directory.startsWith(`${DATA_DIR}/`)) {
				expectedDirectories.add(directory);
				if (directory === DATA_DIR) break;
				directory = path.posix.dirname(directory);
			}
		}
		const dataPath = path.join(repoPath, DATA_DIR);
		const rootStat = yield* tryPromise(() => fs.lstat(dataPath)).pipe(
			Effect.option,
		);
		if (rootStat._tag === "None") return;
		if (!rootStat.value.isDirectory() || rootStat.value.isSymbolicLink()) {
			return yield* Effect.fail(
				new Error("Backup data path must be a real directory"),
			);
		}
		const visit = (relativeDirectory: string): Effect.Effect<void, unknown> =>
			Effect.gen(function* () {
				const entries = yield* tryPromise(() =>
					fs.readdir(path.join(repoPath, relativeDirectory), {
						withFileTypes: true,
					}),
				);
				for (const entry of entries) {
					const relativePath = path.posix.join(relativeDirectory, entry.name);
					const fullPath = path.join(repoPath, relativePath);
					const stat = yield* tryPromise(() => fs.lstat(fullPath));
					if (stat.isSymbolicLink()) {
						return yield* Effect.fail(
							new Error(`Unexpected symlink in backup data: ${relativePath}`),
						);
					}
					if (stat.isDirectory()) {
						if (!expectedDirectories.has(relativePath)) {
							return yield* Effect.fail(
								new Error(`Unexpected backup data directory: ${relativePath}`),
							);
						}
						yield* visit(relativePath);
						continue;
					}
					if (!stat.isFile() || !expectedFiles.has(relativePath)) {
						return yield* Effect.fail(
							new Error(`Unexpected backup data file: ${relativePath}`),
						);
					}
				}
			});
		yield* visit(DATA_DIR);
	});
}

function inspectNonGitBackupAdoptionEffect(repoPath: string) {
	return Effect.gen(function* () {
		if (!(yield* trySync(() => existsSync(repoPath)))) return false;
		const entries = yield* tryPromise(() => fs.readdir(repoPath));
		if (entries.length === 0) return false;
		if (!entries.includes(MANIFEST_PATH)) {
			return yield* Effect.fail(
				new Error(
					"Non-Git backup directory contains content without a manifest",
				),
			);
		}
		yield* assertCurrentManifestValidEffect(repoPath);
		const allowed = new Set<string>(MANAGED_BACKUP_PATHS);
		for (const entry of entries) {
			if (!allowed.has(entry)) {
				return yield* Effect.fail(
					new Error(`Unexpected non-Git backup root entry: ${entry}`),
				);
			}
			const stat = yield* tryPromise(() =>
				fs.lstat(path.join(repoPath, entry)),
			);
			if (stat.isSymbolicLink()) {
				return yield* Effect.fail(
					new Error(`Unexpected symlink in non-Git backup: ${entry}`),
				);
			}
			if (entry === DATA_DIR ? !stat.isDirectory() : !stat.isFile()) {
				return yield* Effect.fail(
					new Error(`Invalid non-Git backup root entry: ${entry}`),
				);
			}
		}
		return true;
	});
}

function getBackupTransactionRootPathsEffect(repoPath: string) {
	return Effect.gen(function* () {
		const key = createHash("sha256")
			.update(repoPath)
			.digest("hex")
			.slice(0, 12);
		const name = `${BACKUP_TRANSACTION_DIR}-${key}`;
		const adjacentRoot = path.join(path.dirname(repoPath), `.${name}`);
		const gitCommonRoot = (candidatePath: string) =>
			gitEffect(["-C", candidatePath, "rev-parse", "--git-common-dir"]).pipe(
				Effect.map(({ stdout }) => {
					const commonDir = path.isAbsolute(stdout.trim())
						? stdout.trim()
						: path.resolve(candidatePath, stdout.trim());
					return path.join(commonDir, name);
				}),
				Effect.catchAll(() => Effect.succeed(undefined)),
			);
		const enclosingGitRoot = yield* gitCommonRoot(path.dirname(repoPath));
		if (yield* isGitRepoEffect(repoPath)) {
			const ownGitRoot = yield* gitCommonRoot(repoPath);
			return Array.from(
				new Set(
					[ownGitRoot, enclosingGitRoot, adjacentRoot].filter(
						(value): value is string => Boolean(value),
					),
				),
			);
		}
		return Array.from(
			new Set(
				[enclosingGitRoot, adjacentRoot].filter((value): value is string =>
					Boolean(value),
				),
			),
		);
	});
}

function getBackupTransactionRootEffect(repoPath: string) {
	return Effect.gen(function* () {
		const roots = yield* getBackupTransactionRootPathsEffect(repoPath);
		if (roots.length === 0)
			return yield* Effect.fail(
				new Error("Backup transaction root is unavailable"),
			);
		return yield* tryPromise(async () => {
			const errors: unknown[] = [];
			for (const root of roots) {
				const existed = existsSync(root);
				try {
					await durableMkdir(root);
					const validatedRoot = await validateBackupTransactionRoot(
						repoPath,
						root,
					);
					await probeBackupTransactionRoot(validatedRoot);
					return validatedRoot;
				} catch (error) {
					errors.push(error);
					if (!existed) await fs.rmdir(root).catch(() => undefined);
				}
			}
			throw new AggregateError(
				errors,
				"No backup transaction root is writable on the repository filesystem",
			);
		});
	});
}

async function syncDirectory(directory: string) {
	const handle = await fs.open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function durableMkdir(directory: string) {
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

async function durableMkdtemp(prefix: string) {
	const directory = await fs.mkdtemp(prefix);
	await syncDirectory(directory);
	await syncDirectory(path.dirname(directory));
	return directory;
}

async function durableRename(source: string, destination: string) {
	await fs.rename(source, destination);
	await syncDirectory(path.dirname(source));
	if (path.dirname(destination) !== path.dirname(source)) {
		await syncDirectory(path.dirname(destination));
	}
}

async function durableRemove(
	target: string,
	options: { recursive?: boolean; force?: boolean } = {},
) {
	await fs.rm(target, options);
	await syncDirectory(path.dirname(target));
}

async function durableCopyFile(source: string, destination: string) {
	await fs.copyFile(source, destination);
	const handle = await fs.open(destination, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
	await syncDirectory(path.dirname(destination));
}

async function durableWriteFile(
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

async function probeBackupTransactionRoot(root: string) {
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

function assertOwnedPathStat(
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

async function validateRealTransactionDirectory(
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

async function validateTransactionTree(
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

function streamGitBlobToFileEffect({
	repoPath,
	objectId,
	destination,
}: {
	repoPath: string;
	objectId: string;
	destination: string;
}) {
	const args = ["-C", repoPath, "cat-file", "blob", objectId];
	return tryPromise(async () => {
		await durableMkdir(path.dirname(destination));
		const child = spawn("git", args, {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			if (stderr.length < 1024 * 1024) stderr += chunk;
		});
		const exited = new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code) => resolve(code));
		});
		try {
			const output = createWriteStream(destination, { mode: 0o600 });
			const [, exitCode] = await Promise.all([
				pipeline(child.stdout, output),
				exited,
			]);
			if (exitCode !== 0) {
				throw new BackupGitCommandError({
					message: `git cat-file failed: ${redactSecretUrl(stderr.trim()) || `exit ${String(exitCode)}`}`,
					args,
					stderr: redactSecretUrl(stderr),
				});
			}
			const handle = await fs.open(destination, "r");
			try {
				await handle.sync();
			} finally {
				await handle.close();
			}
			await syncDirectory(path.dirname(destination));
		} catch (error) {
			if (!child.killed) child.kill();
			await durableRemove(destination, { force: true }).catch(() => undefined);
			throw error;
		}
	});
}

async function writeBackupJournal(
	journalPath: string,
	journal: BackupTransactionJournal,
) {
	const temporaryPath = `${journalPath}.tmp-${randomUUID()}`;
	const handle = await fs.open(temporaryPath, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(journal)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await durableRename(temporaryPath, journalPath);
}

async function validateBackupTransactionRoot(repoPath: string, root: string) {
	const repoRealPath = await fs.realpath(repoPath);
	if (repoRealPath !== path.resolve(repoPath)) {
		throw new Error("Backup repository path is not canonical during recovery");
	}
	const repoStat = await fs.stat(repoRealPath);
	return validateRealTransactionDirectory(root, "root", repoStat.dev);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function validateBackupTransactionJournal({
	repoPath,
	root,
	journalPath,
	value,
}: {
	repoPath: string;
	root: string;
	journalPath: string;
	value: unknown;
}): Promise<BackupTransactionJournal> {
	if (!isPlainRecord(value)) {
		throw new Error("Backup transaction journal must be an object");
	}
	const allowedKeys = new Set([
		"version",
		"repoPath",
		"repoDevice",
		"repoInode",
		"repoBirthTimeNs",
		"stagePath",
		"rollbackPath",
		"state",
		"liveExisted",
		"gitIndexPath",
		"gitIndexBackupPath",
		"gitIndexExisted",
		"headBefore",
		"gitCommonDir",
		"gitCommonDevice",
		"gitCommonInode",
	]);
	if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
		throw new Error("Backup transaction journal contains unknown fields");
	}
	const journalFileStat = await fs.lstat(journalPath);
	assertOwnedPathStat(journalFileStat, "journal", "file");
	if (
		path.resolve(journalPath) !== path.join(root, "journal.json") ||
		(await fs.realpath(journalPath)) !== path.resolve(journalPath)
	) {
		throw new Error("Backup transaction journal path is not canonical");
	}
	if (
		value.version !== 1 ||
		typeof value.repoPath !== "string" ||
		value.repoPath !== repoPath ||
		typeof value.repoDevice !== "number" ||
		!Number.isSafeInteger(value.repoDevice) ||
		typeof value.repoInode !== "number" ||
		!Number.isSafeInteger(value.repoInode) ||
		typeof value.repoBirthTimeNs !== "string" ||
		!/^\d+$/u.test(value.repoBirthTimeNs) ||
		!(
			["publishing", "published", "rolled_back", "committed"] as unknown[]
		).includes(value.state) ||
		typeof value.stagePath !== "string" ||
		typeof value.rollbackPath !== "string" ||
		!isPlainRecord(value.liveExisted)
	) {
		throw new Error("Backup transaction journal schema is invalid");
	}
	const currentRepoStat = await fs.lstat(repoPath, { bigint: true });
	const currentRepoDevice = Number(currentRepoStat.dev);
	const currentRepoInode = Number(currentRepoStat.ino);
	if (
		!Number.isSafeInteger(currentRepoDevice) ||
		!Number.isSafeInteger(currentRepoInode) ||
		!currentRepoStat.isDirectory() ||
		currentRepoStat.isSymbolicLink() ||
		currentRepoDevice !== value.repoDevice ||
		currentRepoInode !== value.repoInode ||
		currentRepoStat.birthtimeNs.toString() !== value.repoBirthTimeNs
	) {
		throw new Error("Backup transaction journal repository identity changed");
	}
	const liveKeys = Object.keys(value.liveExisted).sort();
	const expectedLiveKeys = [...MANAGED_BACKUP_PATHS].sort();
	if (
		JSON.stringify(liveKeys) !== JSON.stringify(expectedLiveKeys) ||
		expectedLiveKeys.some(
			(key) =>
				typeof (value.liveExisted as Record<string, unknown>)[key] !==
				"boolean",
		)
	) {
		throw new Error("Backup transaction live-path inventory is invalid");
	}
	if (
		(value.headBefore !== undefined &&
			(typeof value.headBefore !== "string" ||
				!/^[0-9a-f]{40,64}$/iu.test(value.headBefore))) ||
		(value.gitIndexPath !== undefined &&
			typeof value.gitIndexPath !== "string") ||
		(value.gitIndexBackupPath !== undefined &&
			typeof value.gitIndexBackupPath !== "string") ||
		(value.gitIndexExisted !== undefined &&
			typeof value.gitIndexExisted !== "boolean") ||
		(value.gitCommonDir !== undefined &&
			typeof value.gitCommonDir !== "string") ||
		(value.gitCommonDevice !== undefined &&
			typeof value.gitCommonDevice !== "number") ||
		(value.gitCommonInode !== undefined &&
			typeof value.gitCommonInode !== "number")
	) {
		throw new Error("Backup transaction optional fields are invalid");
	}

	const repoStat = await fs.stat(repoPath);
	const validateChild = async (
		candidate: string,
		prefix: "stage-" | "rollback-",
	) => {
		if (
			!path.isAbsolute(candidate) ||
			path.dirname(path.resolve(candidate)) !== root ||
			!path.basename(candidate).startsWith(prefix) ||
			path.basename(candidate).length <= prefix.length
		) {
			throw new Error(`Backup transaction ${prefix} path escapes its root`);
		}
		return validateRealTransactionDirectory(candidate, prefix, repoStat.dev);
	};
	const stagePath = await validateChild(value.stagePath, "stage-");
	const rollbackPath = await validateChild(value.rollbackPath, "rollback-");
	await validateTransactionTree(stagePath, new Set(MANAGED_BACKUP_PATHS));
	await validateTransactionTree(
		rollbackPath,
		new Set([...MANAGED_BACKUP_PATHS, "git-index"]),
	);

	const gitRepository = existsSync(path.join(repoPath, ".git"));
	const hasJournalGitFields =
		value.gitIndexPath !== undefined ||
		value.gitIndexBackupPath !== undefined ||
		value.gitIndexExisted !== undefined ||
		value.headBefore !== undefined ||
		value.gitCommonDir !== undefined ||
		value.gitCommonDevice !== undefined ||
		value.gitCommonInode !== undefined;
	if (gitRepository && hasJournalGitFields) {
		const actualIndexRaw = await new Promise<string>((resolve, reject) => {
			const child = spawn(
				"git",
				["-C", repoPath, "rev-parse", "--git-path", "index"],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => (stdout += String(chunk)));
			child.stderr.on("data", (chunk) => (stderr += String(chunk)));
			child.once("error", reject);
			child.once("close", (code) =>
				code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim())),
			);
		});
		const actualIndexPath = path.isAbsolute(actualIndexRaw)
			? path.resolve(actualIndexRaw)
			: path.resolve(repoPath, actualIndexRaw);
		if (
			value.gitIndexPath !== actualIndexPath ||
			typeof value.gitIndexExisted !== "boolean"
		) {
			throw new Error("Backup transaction Git index path is invalid");
		}
		const commonRaw = await new Promise<string>((resolve, reject) => {
			const child = spawn(
				"git",
				["-C", repoPath, "rev-parse", "--git-common-dir"],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
			let stdout = "";
			child.stdout.on("data", (chunk) => (stdout += String(chunk)));
			child.once("error", reject);
			child.once("close", (code) =>
				code === 0
					? resolve(stdout.trim())
					: reject(new Error("Unable to resolve Git common directory")),
			);
		});
		const commonPath = await fs.realpath(
			path.isAbsolute(commonRaw)
				? commonRaw
				: path.resolve(repoPath, commonRaw),
		);
		const commonStat = await fs.lstat(commonPath);
		if (
			value.gitCommonDir !== commonPath ||
			value.gitCommonDevice !== commonStat.dev ||
			value.gitCommonInode !== commonStat.ino
		) {
			throw new Error(
				"Backup transaction Git common directory identity changed",
			);
		}
		const indexStat = await fs.lstat(actualIndexPath).catch((error) => {
			if (
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "ENOENT"
			)
				return undefined;
			throw error;
		});
		if (indexStat) assertOwnedPathStat(indexStat, "Git index", "file");
		if (value.gitIndexExisted) {
			const expectedBackup = path.join(rollbackPath, "git-index");
			if (value.gitIndexBackupPath !== expectedBackup) {
				throw new Error("Backup transaction Git index backup path is invalid");
			}
			const backupStat = await fs.lstat(expectedBackup);
			assertOwnedPathStat(backupStat, "Git index backup", "file");
			if ((await fs.realpath(expectedBackup)) !== expectedBackup) {
				throw new Error("Backup transaction Git index backup is not canonical");
			}
		} else if (value.gitIndexBackupPath !== undefined) {
			throw new Error("Backup transaction has an unexpected Git index backup");
		}
	} else if (!gitRepository && hasJournalGitFields) {
		throw new Error("Non-Git backup transaction contains Git fields");
	}

	return {
		version: 1,
		repoPath,
		repoDevice: value.repoDevice,
		repoInode: value.repoInode,
		repoBirthTimeNs: value.repoBirthTimeNs,
		stagePath,
		rollbackPath,
		state: value.state as BackupTransactionJournal["state"],
		liveExisted: value.liveExisted as Record<string, boolean>,
		...(value.gitIndexPath ? { gitIndexPath: value.gitIndexPath } : {}),
		...(value.gitIndexBackupPath
			? { gitIndexBackupPath: value.gitIndexBackupPath }
			: {}),
		...(typeof value.gitIndexExisted === "boolean"
			? { gitIndexExisted: value.gitIndexExisted }
			: {}),
		...(value.headBefore ? { headBefore: value.headBefore } : {}),
		...(value.gitCommonDir ? { gitCommonDir: value.gitCommonDir } : {}),
		...(typeof value.gitCommonDevice === "number"
			? { gitCommonDevice: value.gitCommonDevice }
			: {}),
		...(typeof value.gitCommonInode === "number"
			? { gitCommonInode: value.gitCommonInode }
			: {}),
	};
}

function isPendingBackupPushReceipt(
	value: unknown,
): value is PendingBackupPushReceipt {
	if (!value || typeof value !== "object") return false;
	const receipt = value as Partial<PendingBackupPushReceipt>;
	const remoteBranch = receipt.remoteBranch as
		| Partial<BackupRemoteBranchState>
		| undefined;
	return (
		receipt.version === 1 &&
		typeof receipt.token === "string" &&
		receipt.token.length > 0 &&
		typeof receipt.commit === "string" &&
		/^[0-9a-f]{40,64}$/iu.test(receipt.commit) &&
		receipt.remote === BACKUP_PUSH_REMOTE &&
		typeof receipt.remoteIdentity === "string" &&
		/^[0-9a-f]{64}$/iu.test(receipt.remoteIdentity) &&
		receipt.remoteRef === BACKUP_PUSH_REMOTE_REF &&
		(remoteBranch?.kind === "absent" ||
			(remoteBranch?.kind === "commit" &&
				typeof remoteBranch.commit === "string" &&
				/^[0-9a-f]{40,64}$/iu.test(remoteBranch.commit))) &&
		typeof receipt.createdAt === "string"
	);
}

async function canonicalBackupRemoteIdentity(
	repoPath: string,
	remoteUrl: string,
) {
	const credentialQueryKey = (key: string) => {
		const normalized = key.toLowerCase().replace(/[^a-z0-9]+/gu, "_");
		return (
			[
				"token",
				"access_token",
				"auth",
				"authorization",
				"password",
				"passwd",
				"signature",
				"sig",
				"key",
				"api_key",
				"apikey",
				"secret",
				"client_secret",
				"private_token",
				"x_amz_signature",
				"x_amz_credential",
				"x_amz_security_token",
				"x_goog_signature",
				"x_goog_credential",
			].includes(normalized) ||
			normalized.endsWith("_token") ||
			normalized.endsWith("_password") ||
			normalized.endsWith("_signature") ||
			normalized.endsWith("_secret")
		);
	};
	let canonical = remoteUrl;
	if (remoteUrl.startsWith("file:")) {
		canonical = await canonicalizeBackupRepoPath(fileURLToPath(remoteUrl));
	} else if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(remoteUrl)) {
		const url = new URL(remoteUrl);
		if (url.protocol === "http:" || url.protocol === "https:") {
			url.username = "";
		}
		url.password = "";
		if (url.protocol === "ssh:" && url.port === "22") url.port = "";
		const query = [...url.searchParams.entries()]
			.filter(([key]) => !credentialQueryKey(key))
			.sort(([leftKey, leftValue], [rightKey, rightValue]) =>
				leftKey === rightKey
					? leftValue.localeCompare(rightValue)
					: leftKey.localeCompare(rightKey),
			);
		url.search = "";
		for (const [key, value] of query) url.searchParams.append(key, value);
		url.hash = "";
		if (url.pathname.length > 1)
			url.pathname = url.pathname.replace(/\/+$/u, "");
		canonical = url.toString();
	} else if (/^[^/]+@[^/:]+:/u.test(remoteUrl)) {
		const match = /^([^@]+)@([^:]+):(.+)$/u.exec(remoteUrl);
		canonical = match
			? `${match[1]}@${match[2]!.toLowerCase()}:${match[3]!.replace(/\/+$/u, "")}`
			: remoteUrl;
	} else {
		canonical = await canonicalizeBackupRepoPath(
			path.resolve(repoPath, remoteUrl),
		);
	}
	return createHash("sha256").update(canonical).digest("hex");
}

function currentBackupRemoteIdentityEffect(repoPath: string) {
	return Effect.gen(function* () {
		const { stdout } = yield* gitEffect([
			"-C",
			repoPath,
			"remote",
			"get-url",
			BACKUP_PUSH_REMOTE,
		]);
		return yield* tryPromise(() =>
			canonicalBackupRemoteIdentity(repoPath, stdout.trim()),
		);
	});
}

function pendingBackupPushReceiptPathsEffect(repoPath: string) {
	return Effect.gen(function* () {
		const roots = yield* getBackupTransactionRootPathsEffect(repoPath);
		const paths = yield* Effect.forEach(
			roots,
			(root) =>
				tryPromise(async () => {
					try {
						await fs.lstat(root);
					} catch (error) {
						if (
							error &&
							typeof error === "object" &&
							"code" in error &&
							error.code === "ENOENT"
						)
							return undefined;
						throw error;
					}
					const validatedRoot = await validateBackupTransactionRoot(
						repoPath,
						root,
					);
					const receiptPath = path.join(
						validatedRoot,
						PENDING_PUSH_RECEIPT_PATH,
					);
					let stat;
					try {
						stat = await fs.lstat(receiptPath);
					} catch (error) {
						if (
							error &&
							typeof error === "object" &&
							"code" in error &&
							error.code === "ENOENT"
						)
							return undefined;
						throw error;
					}
					assertOwnedPathStat(stat, "pending push receipt", "file");
					if (
						path.dirname(receiptPath) !== validatedRoot ||
						(await fs.realpath(receiptPath)) !== receiptPath
					) {
						throw new Error(
							"Pending backup push receipt path is not canonical",
						);
					}
					return receiptPath;
				}).pipe(Effect.catchAll(() => Effect.succeed(undefined))),
			{ concurrency: 1 },
		);
		return paths.filter((value): value is string => Boolean(value));
	});
}

function readPendingBackupPushReceiptEffect(repoPath: string) {
	return Effect.gen(function* () {
		const receiptPaths = yield* pendingBackupPushReceiptPathsEffect(repoPath);
		if (receiptPaths.length > 1) {
			return yield* Effect.fail(
				new Error("Multiple pending backup push receipts require recovery"),
			);
		}
		const receiptPath = receiptPaths[0];
		if (!receiptPath) return undefined;
		const stat = yield* tryPromise(() => fs.lstat(receiptPath));
		yield* trySync(() =>
			assertOwnedPathStat(stat, "pending push receipt", "file"),
		);
		const realReceiptPath = yield* tryPromise(() => fs.realpath(receiptPath));
		if (realReceiptPath !== receiptPath)
			return yield* Effect.fail(
				new Error("Pending backup push receipt path is not canonical"),
			);
		const parsed = yield* tryPromise(async () =>
			JSON.parse(await fs.readFile(receiptPath, "utf8")),
		);
		if (!isPendingBackupPushReceipt(parsed)) {
			return yield* Effect.fail(
				new Error("Pending backup push receipt is invalid"),
			);
		}
		return { repoPath, path: receiptPath, receipt: parsed };
	});
}

function writePendingBackupPushReceiptEffect({
	repoPath,
	commit,
	remoteIdentity,
	remoteBranch,
}: {
	repoPath: string;
	commit: string;
	remoteIdentity: string;
	remoteBranch: BackupRemoteBranchState;
}) {
	return Effect.gen(function* () {
		const transactionRoot = yield* getBackupTransactionRootEffect(repoPath);
		const receiptPath = path.join(transactionRoot, PENDING_PUSH_RECEIPT_PATH);
		const receipt: PendingBackupPushReceipt = {
			version: 1,
			token: randomUUID(),
			commit,
			remote: BACKUP_PUSH_REMOTE,
			remoteIdentity,
			remoteRef: BACKUP_PUSH_REMOTE_REF,
			remoteBranch,
			createdAt: new Date().toISOString(),
		};
		const temporaryPath = `${receiptPath}.tmp-${randomUUID()}`;
		yield* tryPromise(async () => {
			const handle = await fs.open(temporaryPath, "wx", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(receipt)}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await durableRename(temporaryPath, receiptPath);
		});
		return { path: receiptPath, receipt };
	});
}

function removePendingBackupPushReceiptEffect({
	repoPath,
	path: receiptPath,
	receipt,
}: {
	repoPath: string;
	path: string;
	receipt: PendingBackupPushReceipt;
}) {
	return Effect.gen(function* () {
		const validPaths = yield* pendingBackupPushReceiptPathsEffect(repoPath);
		if (!validPaths.includes(receiptPath)) {
			return yield* Effect.fail(
				new Error("Pending backup push receipt path is no longer safe"),
			);
		}
		yield* tryPromise(async () => {
			const stat = await fs.lstat(receiptPath);
			assertOwnedPathStat(stat, "pending push receipt", "file");
			if ((await fs.realpath(receiptPath)) !== receiptPath) {
				throw new Error("Pending backup push receipt path is not canonical");
			}
			const current = JSON.parse(
				await fs.readFile(receiptPath, "utf8"),
			) as unknown;
			if (
				!isPendingBackupPushReceipt(current) ||
				current.token !== receipt.token
			) {
				throw new Error("Pending backup push receipt changed during recovery");
			}
			await durableRemove(receiptPath, { force: true });
			const root = path.dirname(receiptPath);
			try {
				await fs.rmdir(root);
				await syncDirectory(path.dirname(root));
			} catch (error) {
				if (
					!error ||
					typeof error !== "object" ||
					!("code" in error) ||
					(error.code !== "ENOTEMPTY" && error.code !== "ENOENT")
				) {
					throw error;
				}
			}
		});
	});
}

async function cleanupBackupTransaction(
	journalPath: string,
	journal: BackupTransactionJournal,
) {
	await durableRemove(journalPath, { force: true });
	await afterRecoveryCleanupBoundaryForTests?.("journal");
	await durableRemove(journal.stagePath, { recursive: true, force: true });
	await afterRecoveryCleanupBoundaryForTests?.("stage");
	await durableRemove(journal.rollbackPath, { recursive: true, force: true });
	await afterRecoveryCleanupBoundaryForTests?.("rollback");
	const root = path.dirname(journalPath);
	await fs.rmdir(root).catch(() => undefined);
	await syncDirectory(path.dirname(root));
	await afterRecoveryCleanupBoundaryForTests?.("root");
}

function headOwnsPublishedBackupGenerationEffect(repoPath: string) {
	return Effect.gen(function* () {
		const trackedPathsMatch = yield* gitSucceedsEffect([
			"-C",
			repoPath,
			"diff",
			"--quiet",
			"HEAD",
			"--",
			...MANAGED_BACKUP_PATHS,
		]);
		if (!trackedPathsMatch) return false;

		for (const inventoryArgs of [
			["ls-files", "--others", "--exclude-standard", "-z"],
			["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
		]) {
			const { stdout } = yield* gitEffect([
				"-C",
				repoPath,
				...inventoryArgs,
				"--",
				...MANAGED_BACKUP_PATHS,
			]);
			if (stdout.length > 0) return false;
		}
		return true;
	});
}

function recoverBackupTransactionEffect(repoPath: string) {
	return Effect.gen(function* () {
		if (!(yield* trySync(() => existsSync(repoPath)))) return;
		const rootCandidates = (yield* getBackupTransactionRootPathsEffect(
			repoPath,
		)).filter((root) => existsSync(root));
		const roots = (yield* Effect.forEach(
			rootCandidates,
			(root) =>
				tryPromise(() => validateBackupTransactionRoot(repoPath, root)).pipe(
					Effect.map((validatedRoot) => validatedRoot as string | undefined),
					Effect.catchAll(() => Effect.succeed(undefined)),
				),
			{ concurrency: 1 },
		)).filter((root): root is string => Boolean(root));
		const journalPaths = roots
			.map((root) => path.join(root, "journal.json"))
			.filter((journalPath) => existsSync(journalPath));
		if (journalPaths.length > 1) {
			return yield* Effect.fail(
				new Error("Multiple backup transaction journals require recovery"),
			);
		}
		const journalPath = journalPaths[0];
		if (!journalPath) {
			yield* Effect.forEach(
				roots,
				(root) =>
					tryPromise(async () => {
						for (const entry of await fs.readdir(root)) {
							if (
								entry.startsWith("stage-") ||
								entry.startsWith("rollback-") ||
								entry.startsWith("candidate-") ||
								entry.startsWith("journal.json.tmp-") ||
								entry.startsWith(`${PENDING_PUSH_RECEIPT_PATH}.tmp-`)
							) {
								const target = path.join(root, entry);
								const stat = await fs.lstat(target);
								if (stat.isSymbolicLink()) {
									throw new Error(
										"Backup transaction orphan must not be a symlink",
									);
								}
								if (stat.isDirectory()) {
									await validateRealTransactionDirectory(
										target,
										"orphan",
										(await fs.stat(repoPath)).dev,
									);
									await validateTransactionTree(
										target,
										new Set([...MANAGED_BACKUP_PATHS, "git-index"]),
									);
								} else {
									assertOwnedPathStat(stat, "orphan", "file");
								}
								await durableRemove(target, {
									recursive: true,
									force: true,
								});
							}
						}
						await fs.rmdir(root);
						await syncDirectory(path.dirname(root));
					}).pipe(Effect.catchAll(() => Effect.void)),
				{ concurrency: 1 },
			);
			return;
		}
		const journalValue = yield* tryPromise(async () =>
			JSON.parse(await fs.readFile(journalPath, "utf8")),
		);
		const journal = yield* tryPromise(() =>
			validateBackupTransactionJournal({
				repoPath,
				root: path.dirname(journalPath),
				journalPath,
				value: journalValue,
			}),
		);
		if (journal.state === "committed" || journal.state === "rolled_back") {
			yield* tryPromise(() =>
				cleanupBackupTransaction(journalPath, journal),
			).pipe(Effect.catchAll(() => Effect.void));
			return;
		}
		let headAdvanced = false;
		const gitRepository = yield* isGitRepoEffect(repoPath);
		if (gitRepository) {
			const currentHead = yield* gitEffect([
				"-C",
				repoPath,
				"rev-parse",
				"HEAD",
			]).pipe(
				Effect.map(({ stdout }) => stdout.trim()),
				Effect.catchAll(() => Effect.succeed(undefined)),
			);
			headAdvanced = Boolean(currentHead && currentHead !== journal.headBefore);
			if (
				headAdvanced &&
				(yield* headOwnsPublishedBackupGenerationEffect(repoPath))
			) {
				const validation = yield* validateBackupEffect(repoPath);
				if (!validation.ok) {
					return yield* Effect.fail(
						new Error(
							"Backup commit advanced with an invalid published generation",
						),
					);
				}
				journal.state = "committed";
				yield* tryPromise(() => writeBackupJournal(journalPath, journal));
				yield* tryPromise(() =>
					cleanupBackupTransaction(journalPath, journal),
				).pipe(Effect.catchAll(() => Effect.void));
				return;
			}
		}
		yield* tryPromise(async () => {
			for (const relativePath of [...MANAGED_BACKUP_PATHS].reverse()) {
				const livePath = path.join(repoPath, relativePath);
				const rollbackPath = path.join(journal.rollbackPath, relativePath);
				if (existsSync(rollbackPath)) {
					await durableRemove(livePath, { recursive: true, force: true });
					await durableMkdir(path.dirname(livePath));
					await durableRename(rollbackPath, livePath);
				} else if (!journal.liveExisted[relativePath]) {
					await durableRemove(livePath, { recursive: true, force: true });
				}
			}
		});
		if (gitRepository) {
			if (journal.headBefore) {
				yield* gitEffect([
					"-C",
					repoPath,
					"reset",
					"-q",
					journal.headBefore,
					"--",
					...MANAGED_BACKUP_PATHS,
				]);
			} else {
				yield* gitEffect([
					"-C",
					repoPath,
					"rm",
					"--cached",
					"-r",
					"--ignore-unmatch",
					"--",
					...MANAGED_BACKUP_PATHS,
				]);
			}
		}
		yield* tryPromise(async () => {
			journal.state = "rolled_back";
			await writeBackupJournal(journalPath, journal);
			await cleanupBackupTransaction(journalPath, journal);
		});
		if (yield* trySync(() => existsSync(path.join(repoPath, MANIFEST_PATH)))) {
			yield* assertCurrentManifestValidEffect(repoPath);
		}
	});
}

function copyExistingSupportFileEffect(
	repoPath: string,
	stagingPath: string,
	relativePath: "README.md" | typeof GITATTRIBUTES_PATH,
) {
	return Effect.gen(function* () {
		const source = path.join(repoPath, relativePath);
		if (!(yield* trySync(() => existsSync(source)))) return;
		yield* assertNoSymlinkAncestorEffect(repoPath, source);
		const stat = yield* tryPromise(() => fs.lstat(source));
		if (!stat.isFile()) {
			return yield* Effect.fail(
				new Error(`Backup support path is not a regular file: ${relativePath}`),
			);
		}
		yield* tryPromise(() =>
			durableCopyFile(source, path.join(stagingPath, relativePath)),
		);
	});
}

function publishStagedBackupEffect(repoPath: string, stagingPath: string) {
	return Effect.gen(function* () {
		const repoStat = yield* tryPromise(() =>
			fs.lstat(repoPath, { bigint: true }),
		);
		const repoDevice = Number(repoStat.dev);
		const repoInode = Number(repoStat.ino);
		if (!Number.isSafeInteger(repoDevice) || !Number.isSafeInteger(repoInode)) {
			return yield* Effect.fail(
				new Error("Backup repository identity exceeds safe integer range"),
			);
		}
		const transactionRoot = yield* getBackupTransactionRootEffect(repoPath);
		const rollbackPath = yield* tryPromise(() =>
			durableMkdtemp(path.join(transactionRoot, "rollback-")),
		);
		const journalPath = path.join(transactionRoot, "journal.json");
		const liveExisted = Object.fromEntries(
			MANAGED_BACKUP_PATHS.map((relativePath) => [
				relativePath,
				existsSync(path.join(repoPath, relativePath)),
			]),
		);
		let gitIndexPath: string | undefined;
		let gitIndexBackupPath: string | undefined;
		let gitIndexExisted: boolean | undefined;
		let headBefore: string | undefined;
		let gitCommonDir: string | undefined;
		let gitCommonDevice: number | undefined;
		let gitCommonInode: number | undefined;
		if (yield* isGitRepoEffect(repoPath)) {
			const { stdout: commonStdout } = yield* gitEffect([
				"-C",
				repoPath,
				"rev-parse",
				"--git-common-dir",
			]);
			gitCommonDir = yield* tryPromise(() =>
				fs.realpath(
					path.isAbsolute(commonStdout.trim())
						? commonStdout.trim()
						: path.resolve(repoPath, commonStdout.trim()),
				),
			);
			const commonStat = yield* tryPromise(() => fs.lstat(gitCommonDir!));
			gitCommonDevice = commonStat.dev;
			gitCommonInode = commonStat.ino;
			const { stdout: indexStdout } = yield* gitEffect([
				"-C",
				repoPath,
				"rev-parse",
				"--git-path",
				"index",
			]);
			gitIndexPath = path.isAbsolute(indexStdout.trim())
				? indexStdout.trim()
				: path.resolve(repoPath, indexStdout.trim());
			gitIndexExisted = yield* trySync(() => existsSync(gitIndexPath!));
			if (gitIndexExisted) {
				gitIndexBackupPath = path.join(rollbackPath, "git-index");
				yield* tryPromise(() =>
					durableCopyFile(gitIndexPath!, gitIndexBackupPath!),
				);
			}
			if (yield* hasGitCommitsEffect(repoPath)) {
				const { stdout } = yield* gitEffect([
					"-C",
					repoPath,
					"rev-parse",
					"HEAD",
				]);
				headBefore = stdout.trim();
			}
		}
		const journal: BackupTransactionJournal = {
			version: 1,
			repoPath,
			repoDevice,
			repoInode,
			repoBirthTimeNs: repoStat.birthtimeNs.toString(),
			stagePath: stagingPath,
			rollbackPath,
			state: "publishing",
			liveExisted,
			...(gitIndexPath ? { gitIndexPath } : {}),
			...(gitIndexBackupPath ? { gitIndexBackupPath } : {}),
			...(gitIndexExisted !== undefined ? { gitIndexExisted } : {}),
			...(headBefore ? { headBefore } : {}),
			...(gitCommonDir ? { gitCommonDir } : {}),
			...(gitCommonDevice !== undefined ? { gitCommonDevice } : {}),
			...(gitCommonInode !== undefined ? { gitCommonInode } : {}),
		};
		yield* tryPromise(() => writeBackupJournal(journalPath, journal));
		const publish = async () => {
			for (const relativePath of MANAGED_BACKUP_PATHS) {
				const livePath = path.join(repoPath, relativePath);
				const stagedPath = path.join(stagingPath, relativePath);
				const rollbackTarget = path.join(rollbackPath, relativePath);
				if (existsSync(livePath)) {
					await durableMkdir(path.dirname(rollbackTarget));
					await durableRename(livePath, rollbackTarget);
					await afterPublicationRenameForTests?.(relativePath, "rollback");
				}
				await durableRename(stagedPath, livePath);
				await afterPublicationRenameForTests?.(relativePath, "install");
			}
			journal.state = "published";
			await writeBackupJournal(journalPath, journal);
			await afterPublicationForTests?.();
		};
		yield* tryPromise(publish).pipe(
			Effect.catchAll((error) =>
				recoverBackupTransactionEffect(repoPath).pipe(
					Effect.matchEffect({
						onSuccess: () => Effect.fail(error),
						onFailure: (rollbackError) =>
							Effect.fail(
								new AggregateError(
									[error, rollbackError],
									`Backup publication failed and recovery material remains at ${rollbackPath}`,
								),
							),
					}),
				),
			),
		);
		return { journalPath, journal };
	});
}

function finalizeBackupTransactionEffect({
	journalPath,
	journal,
}: {
	journalPath: string;
	journal: BackupTransactionJournal;
}) {
	return Effect.gen(function* () {
		journal.state = "committed";
		yield* tryPromise(() => writeBackupJournal(journalPath, journal));
		yield* tryPromise(async () => {
			await beforeCommittedCleanupForTests?.();
			await cleanupBackupTransaction(journalPath, journal);
		}).pipe(Effect.catchAll(() => Effect.void));
	});
}

function ensureBackupGitRepoEffect({
	repoPath,
	remote,
	adoptExistingGeneration = false,
	message = "archive: adopt birdclaw backup",
}: {
	repoPath: string;
	remote?: string;
	adoptExistingGeneration?: boolean;
	message?: string;
}) {
	return Effect.gen(function* () {
		if (adoptExistingGeneration && remote) {
			const { stdout } = yield* gitEffect([
				"ls-remote",
				"--heads",
				remote,
				BACKUP_PUSH_REMOTE_REF,
			]);
			if (stdout.trim()) {
				return yield* Effect.fail(
					new Error(
						"Cannot adopt a non-Git backup while origin/main already exists",
					),
				);
			}
		}
		if (!(yield* isGitRepoEffect(repoPath))) {
			yield* tryPromise(() => durableMkdir(repoPath));
			yield* gitEffect(["-C", repoPath, "init"]);
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

		if (adoptExistingGeneration) {
			if (remote) {
				const remoteBranch = yield* observeBackupRemoteBranchEffect(repoPath);
				if (remoteBranch.kind !== "absent") {
					return yield* Effect.fail(
						new Error(
							"Cannot adopt a non-Git backup because origin/main appeared during initialization",
						),
					);
				}
			}
			yield* gitEffect(["-C", repoPath, "checkout", "-B", "main"]);
			const commitResult = yield* maybeCommitEffect({
				repoPath,
				message,
				commit: true,
			});
			if (!commitResult?.committed || !commitResult.commit) {
				return yield* Effect.fail(
					new Error(
						"Validated non-Git backup did not create an initial commit",
					),
				);
			}
			return { adoptedCommit: commitResult.commit };
		}

		if (remote && !(yield* hasGitCommitsEffect(repoPath))) {
			const remoteMain = yield* gitEffect([
				"-C",
				repoPath,
				"ls-remote",
				"--heads",
				"origin",
				"main",
			]);
			if (remoteMain.stdout.trim()) {
				yield* gitEffect([
					"-C",
					repoPath,
					"fetch",
					"--no-tags",
					"origin",
					"refs/heads/main",
				]);
				const { stdout } = yield* gitEffect([
					"-C",
					repoPath,
					"rev-parse",
					"FETCH_HEAD",
				]);
				const fetchedCommit = stdout.trim();
				yield* validateBackupCommitEffect(repoPath, fetchedCommit);
				yield* gitEffect([
					"-C",
					repoPath,
					"update-ref",
					"refs/remotes/origin/main",
					fetchedCommit,
				]);
				yield* gitEffect([
					"-C",
					repoPath,
					"checkout",
					"-B",
					"main",
					fetchedCommit,
				]);
				yield* gitEffect([
					"-C",
					repoPath,
					"branch",
					"--set-upstream-to=origin/main",
					"main",
				]);
				return { adoptedCommit: undefined };
			}
		}

		if (!(yield* hasGitCommitsEffect(repoPath))) {
			yield* gitEffect(["-C", repoPath, "checkout", "-B", "main"]);
		}
		return { adoptedCommit: undefined };
	});
}

function gitSucceedsEffect(args: string[]) {
	return gitEffect(args).pipe(
		Effect.as(true),
		Effect.catchAll(() => Effect.succeed(false)),
	);
}

function observeBackupRemoteBranchEffect(repoPath: string) {
	return Effect.gen(function* () {
		const { stdout } = yield* gitEffect([
			"-C",
			repoPath,
			"ls-remote",
			"--heads",
			BACKUP_PUSH_REMOTE,
			BACKUP_PUSH_REMOTE_REF,
		]);
		const lines = stdout.split("\n").filter(Boolean);
		if (lines.length === 0) {
			return { kind: "absent" as const };
		}
		if (lines.length !== 1) {
			return yield* Effect.fail(
				new Error("origin/main resolved to multiple remote branches"),
			);
		}
		const [commit, remoteRef, ...extra] = lines[0]!.split("\t");
		if (
			extra.length > 0 ||
			remoteRef !== BACKUP_PUSH_REMOTE_REF ||
			!commit ||
			!/^[0-9a-f]{40,64}$/iu.test(commit)
		) {
			return yield* Effect.fail(
				new Error("origin/main returned an invalid remote branch identity"),
			);
		}
		return { kind: "commit" as const, commit };
	});
}

function fetchBackupRemoteEffect(repoPath: string) {
	return Effect.gen(function* () {
		if (!(yield* isGitRepoEffect(repoPath))) return undefined;
		const remote = yield* gitEffect([
			"-C",
			repoPath,
			"remote",
			"get-url",
			"origin",
		]).pipe(
			Effect.as(true),
			Effect.catchAll(() => Effect.succeed(false)),
		);
		if (!remote) return undefined;
		const remoteHead = yield* gitEffect([
			"-C",
			repoPath,
			"ls-remote",
			"--heads",
			"origin",
			"main",
		]);
		if (!remoteHead.stdout.trim()) return undefined;
		yield* gitEffect(["-C", repoPath, "fetch", "origin", "main"]);
		const { stdout } = yield* gitEffect([
			"-C",
			repoPath,
			"rev-parse",
			"FETCH_HEAD",
		]);
		return stdout.trim();
	});
}

function validateBackupCommitEffect(repoPath: string, commit: string) {
	return Effect.gen(function* () {
		const transactionRoot = yield* getBackupTransactionRootEffect(repoPath);
		const candidatePath = yield* tryPromise(() =>
			durableMkdtemp(path.join(transactionRoot, "candidate-")),
		);
		return yield* Effect.gen(function* () {
			const { stdout } = yield* gitEffect([
				"-C",
				repoPath,
				"ls-tree",
				"-r",
				"-z",
				commit,
			]);
			const treeEntries = stdout
				.split("\0")
				.filter(Boolean)
				.map((value) => {
					const separator = value.indexOf("\t");
					const header = separator >= 0 ? value.slice(0, separator) : value;
					const [mode = "", type = "", objectId = ""] = header.split(" ");
					return {
						mode,
						type,
						objectId,
						relativePath: separator >= 0 ? value.slice(separator + 1) : "",
					};
				});
			const invalidManagedShape = treeEntries.find(
				({ relativePath }) =>
					relativePath === DATA_DIR ||
					[MANIFEST_PATH, "README.md", GITATTRIBUTES_PATH].some((filePath) =>
						relativePath.startsWith(`${filePath}/`),
					),
			);
			if (invalidManagedShape) {
				return yield* Effect.fail(
					new Error(
						`Fetched backup commit contains an invalid managed path: ${JSON.stringify(invalidManagedShape.relativePath)}`,
					),
				);
			}
			const managedEntries = treeEntries.filter(
				({ relativePath }) =>
					relativePath === MANIFEST_PATH ||
					relativePath === "README.md" ||
					relativePath === GITATTRIBUTES_PATH ||
					relativePath.startsWith(`${DATA_DIR}/`),
			);
			for (const entry of managedEntries) {
				if (
					entry.relativePath.includes("\n") ||
					entry.relativePath.includes("\r")
				) {
					return yield* Effect.fail(
						new Error(
							`Fetched backup commit contains an unsafe managed path: ${JSON.stringify(entry.relativePath)}`,
						),
					);
				}
				if (
					(entry.mode !== "100644" && entry.mode !== "100755") ||
					entry.type !== "blob" ||
					!/^[0-9a-f]{40,64}$/i.test(entry.objectId)
				) {
					return yield* Effect.fail(
						new Error(
							`Fetched backup commit contains a non-file path: ${entry.relativePath}`,
						),
					);
				}
			}
			yield* Effect.forEach(
				managedEntries,
				(entry) =>
					Effect.gen(function* () {
						const fullPath = resolveBackupFilePath(
							candidatePath,
							entry.relativePath,
						);
						yield* streamGitBlobToFileEffect({
							repoPath,
							objectId: entry.objectId,
							destination: fullPath,
						});
					}),
				{ concurrency: 8 },
			);
			const validation = yield* validateBackupEffect(candidatePath);
			if (!validation.ok) {
				return yield* Effect.fail(
					new Error(
						`Fetched backup commit is invalid: ${validation.errors.join("; ")}`,
					),
				);
			}
			yield* assertManagedDataInventoryEffect(candidatePath);
			return validation;
		}).pipe(
			Effect.ensuring(
				tryPromise(async () => {
					await durableRemove(candidatePath, {
						recursive: true,
						force: true,
					});
					await fs.rmdir(transactionRoot).catch(() => undefined);
					await syncDirectory(path.dirname(transactionRoot));
				}).pipe(Effect.catchAll(() => Effect.void)),
			),
		);
	});
}

function reconcileBackupGitHistoryEffect(repoPath: string) {
	return Effect.gen(function* () {
		if (
			!(yield* isGitRepoEffect(repoPath)) ||
			!(yield* hasGitCommitsEffect(repoPath))
		) {
			return { pulled: false, pushOnly: false };
		}
		const pendingPush = yield* readPendingBackupPushReceiptEffect(repoPath);
		if (pendingPush) {
			const remoteIdentity = yield* currentBackupRemoteIdentityEffect(repoPath);
			if (
				pendingPush.receipt.remote !== BACKUP_PUSH_REMOTE ||
				pendingPush.receipt.remoteRef !== BACKUP_PUSH_REMOTE_REF ||
				pendingPush.receipt.remoteIdentity !== remoteIdentity
			) {
				return yield* Effect.fail(
					new Error("Pending backup push receipt does not match origin/main"),
				);
			}
		}
		const { stdout: headStdout } = yield* gitEffect([
			"-C",
			repoPath,
			"rev-parse",
			"HEAD",
		]);
		const headCommit = headStdout.trim();
		if (pendingPush && pendingPush.receipt.commit !== headCommit) {
			return yield* Effect.fail(
				new Error("Pending backup push receipt does not match local HEAD"),
			);
		}
		const remoteCommit = yield* fetchBackupRemoteEffect(repoPath);
		if (!remoteCommit) {
			if (pendingPush) {
				if (pendingPush.receipt.remoteBranch.kind === "absent") {
					return { pulled: false, pushOnly: true, pendingPush };
				}
				return yield* Effect.fail(
					new Error(
						"Pending backup push receipt expected origin/main to exist",
					),
				);
			}
			return { pulled: false, pushOnly: false };
		}
		if (headCommit === remoteCommit) {
			if (pendingPush) {
				yield* removePendingBackupPushReceiptEffect(pendingPush);
			}
			return { pulled: false, pushOnly: false };
		}
		const remoteIsAncestor = yield* gitSucceedsEffect([
			"-C",
			repoPath,
			"merge-base",
			"--is-ancestor",
			remoteCommit,
			"HEAD",
		]);
		if (remoteIsAncestor) {
			if (!pendingPush) return { pulled: false, pushOnly: false };
			if (pendingPush.receipt.remoteBranch.kind === "commit") {
				const observedRemoteIsAncestor = yield* gitSucceedsEffect([
					"-C",
					repoPath,
					"merge-base",
					"--is-ancestor",
					pendingPush.receipt.remoteBranch.commit,
					remoteCommit,
				]);
				if (!observedRemoteIsAncestor) {
					return yield* Effect.fail(
						new Error(
							"origin/main changed incompatibly with the pending backup push receipt",
						),
					);
				}
			}
			// A branch that appeared after an observed absence, or advanced after
			// the failed push, is safe only as a validated fast-forward base.
			yield* validateBackupCommitEffect(repoPath, remoteCommit);
			return { pulled: false, pushOnly: true, pendingPush };
		}
		const localIsAncestor = yield* gitSucceedsEffect([
			"-C",
			repoPath,
			"merge-base",
			"--is-ancestor",
			"HEAD",
			remoteCommit,
		]);
		if (!localIsAncestor) {
			return yield* Effect.fail(
				new Error(
					"Backup local and remote histories have diverged; refusing to continue",
				),
			);
		}
		yield* validateBackupCommitEffect(repoPath, remoteCommit);
		if (pendingPush) {
			// The fetched remote already contains the receipt commit, so the receipt
			// is stale even though origin/main advanced further.
			yield* removePendingBackupPushReceiptEffect(pendingPush);
		}
		yield* gitEffect(["-C", repoPath, "merge", "--ff-only", remoteCommit]);
		return { pulled: true, pushOnly: false };
	});
}

function pushBackupHeadEffect(repoPath: string) {
	return gitEffect(["-C", repoPath, "push", "origin", "HEAD:main"]).pipe(
		Effect.asVoid,
	);
}

function clearSatisfiedPendingBackupPushReceiptEffect(repoPath: string) {
	return Effect.gen(function* () {
		const pendingPush = yield* readPendingBackupPushReceiptEffect(repoPath);
		if (!pendingPush) return;
		const remoteIdentity = yield* currentBackupRemoteIdentityEffect(repoPath);
		if (
			pendingPush.receipt.remoteIdentity !== remoteIdentity ||
			pendingPush.receipt.remote !== BACKUP_PUSH_REMOTE ||
			pendingPush.receipt.remoteRef !== BACKUP_PUSH_REMOTE_REF
		) {
			return;
		}
		const receiptIsIncluded = yield* gitSucceedsEffect([
			"-C",
			repoPath,
			"merge-base",
			"--is-ancestor",
			pendingPush.receipt.commit,
			"HEAD",
		]);
		if (receiptIsIncluded) {
			yield* removePendingBackupPushReceiptEffect(pendingPush);
		}
	});
}

function pushGeneratedBackupHeadEffect(
	repoPath: string,
	committedGeneration?: string,
) {
	return Effect.gen(function* () {
		const remoteIdentity = yield* currentBackupRemoteIdentityEffect(repoPath);
		const remoteBranch = yield* observeBackupRemoteBranchEffect(repoPath);
		const pushed = yield* pushBackupHeadEffect(repoPath).pipe(
			Effect.matchEffect({
				onFailure: (pushError) =>
					committedGeneration
						? writePendingBackupPushReceiptEffect({
								repoPath,
								commit: committedGeneration,
								remoteIdentity,
								remoteBranch,
							}).pipe(
								Effect.matchEffect({
									onFailure: (receiptError) =>
										Effect.fail(
											new AggregateError(
												[pushError, receiptError],
												"Backup push failed and its retry receipt could not be persisted",
											),
										),
									onSuccess: () => Effect.fail(pushError),
								}),
							)
						: Effect.fail(pushError),
				onSuccess: () => Effect.succeed(true),
			}),
		);
		if (pushed) {
			yield* clearSatisfiedPendingBackupPushReceiptEffect(repoPath);
		}
	});
}

function retryPendingBackupPushEffect(
	repoPath: string,
	pendingPush: {
		repoPath: string;
		path: string;
		receipt: PendingBackupPushReceipt;
	},
) {
	return Effect.gen(function* () {
		yield* pushBackupHeadEffect(repoPath);
		const remoteBranch = yield* observeBackupRemoteBranchEffect(repoPath);
		if (
			remoteBranch.kind !== "commit" ||
			remoteBranch.commit !== pendingPush.receipt.commit
		) {
			return yield* Effect.fail(
				new Error(
					"Pending backup push did not update origin/main to local HEAD",
				),
			);
		}
		yield* removePendingBackupPushReceiptEffect(pendingPush);
	});
}

function currentBackupExportResultEffect(repoPath: string) {
	return Effect.gen(function* () {
		const manifest = yield* readManifestEffect(repoPath);
		const validation = yield* validateBackupEffect(repoPath);
		if (!validation.ok) {
			return yield* Effect.fail(
				new Error(`Backup validation failed: ${validation.errors.join("; ")}`),
			);
		}
		const { stdout } = yield* gitEffect(["-C", repoPath, "rev-parse", "HEAD"]);
		return {
			ok: true as const,
			repoPath,
			manifest,
			validation,
			git: {
				committed: false,
				pushed: true,
				commit: stdout.trim(),
			},
		};
	});
}

export interface BackupExportOptions {
	repoPath: string;
	db?: Database;
	commit?: boolean;
	push?: boolean;
	message?: string;
	validate?: boolean;
	maxShardBytes?: number;
}

interface BackupExportUnlockedOptions extends BackupExportOptions {
	generatedCommitForPushReceipt?: string;
}

function exportBackupUnlockedEffect({
	repoPath,
	db,
	commit = false,
	push = false,
	message = "archive: update birdclaw backup",
	validate = true,
	maxShardBytes,
	generatedCommitForPushReceipt,
}: BackupExportUnlockedOptions): Effect.Effect<BackupExportResult, unknown> {
	return Effect.gen(function* () {
		const resolvedRepoPath = path.resolve(repoPath);
		// Keep the option source-compatible; staged generations are always validated.
		void validate;
		yield* tryPromise(() => durableMkdir(resolvedRepoPath));
		const repoStat = yield* tryPromise(() => fs.lstat(resolvedRepoPath));
		if (!repoStat.isDirectory() || repoStat.isSymbolicLink()) {
			return yield* Effect.fail(
				new Error("Backup repository path must be a real directory"),
			);
		}
		const existingGitRepository = yield* isGitRepoEffect(resolvedRepoPath);
		if (
			existingGitRepository &&
			(yield* readPendingBackupPushReceiptEffect(resolvedRepoPath))
		) {
			return yield* Effect.fail(
				new Error(
					"Backup repository has a pending push receipt; run backup sync before exporting another generation",
				),
			);
		}
		for (const relativePath of MANAGED_BACKUP_PATHS) {
			const managedPath = path.join(resolvedRepoPath, relativePath);
			if (yield* trySync(() => existsSync(managedPath))) {
				yield* assertNoSymlinkAncestorEffect(resolvedRepoPath, managedPath);
			}
		}
		if (existingGitRepository) {
			yield* assertBackupCheckoutCleanEffect(resolvedRepoPath);
		}
		yield* assertCurrentManifestValidEffect(resolvedRepoPath);
		if ((commit || push) && !existingGitRepository) {
			yield* gitEffect(["-C", resolvedRepoPath, "init"]);
		}
		const database = db ?? (yield* trySync(() => openBackupDatabase()));
		const previousManifest =
			yield* readPreviousManifestEffect(resolvedRepoPath);
		const transactionRoot =
			yield* getBackupTransactionRootEffect(resolvedRepoPath);
		const stagingPath = yield* tryPromise(() =>
			durableMkdtemp(path.join(transactionRoot, "stage-")),
		);

		return yield* Effect.gen(function* () {
			yield* copyExistingSupportFileEffect(
				resolvedRepoPath,
				stagingPath,
				"README.md",
			);
			yield* copyExistingSupportFileEffect(
				resolvedRepoPath,
				stagingPath,
				GITATTRIBUTES_PATH,
			);
			yield* ensureBackupGitattributesEffect(stagingPath);
			yield* ensureBackupReadmeEffect(stagingPath);
			yield* tryPromise(() => durableMkdir(path.join(stagingPath, DATA_DIR)));

			const maxBytes = yield* trySync(() =>
				normalizeMaxBackupShardBytes(maxShardBytes),
			);
			const rowSets = yield* trySync(() =>
				database.readTransaction(() => getExportRowSets(database))(),
			);
			const shards = yield* trySync(() =>
				buildBackupShardsFromRowSets(rowSets),
			);
			const shardEntries = yield* trySync(() =>
				[...shards.entries()].sort(([left], [right]) =>
					left.localeCompare(right),
				),
			);
			const shardParts = yield* trySync(() =>
				shardEntries.flatMap(([relativePath, rows]) =>
					splitJsonlShard(relativePath, rows, maxBytes),
				),
			);
			const expectedPaths = yield* trySync(
				() => new Set(shardParts.map(({ relativePath }) => relativePath)),
			);
			const files = yield* Effect.forEach(
				shardParts,
				({ relativePath, rows }) =>
					writeJsonlFileEffect(stagingPath, relativePath, rows),
				{ concurrency: 1 },
			);
			yield* removeStaleBackupFilesEffect(stagingPath, expectedPaths);

			const counts = yield* trySync(() => countBackupFiles(files));
			const backupHash = yield* trySync(() => computeBackupHash(files));
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
			yield* writeManifestEffect(stagingPath, manifest);
			if (beforeStagedValidationForTests) {
				yield* tryPromise(() =>
					Promise.resolve(beforeStagedValidationForTests?.(stagingPath)),
				);
			}

			const stagedValidation = yield* validateBackupEffect(stagingPath);
			if (!stagedValidation.ok) {
				return yield* Effect.fail(
					new Error(
						`Backup validation failed: ${stagedValidation.errors.join("; ")}`,
					),
				);
			}
			const publication = yield* publishStagedBackupEffect(
				resolvedRepoPath,
				stagingPath,
			);
			const validation = {
				...stagedValidation,
				repoPath: resolvedRepoPath,
			};

			const commitResult = yield* maybeCommitEffect({
				repoPath: resolvedRepoPath,
				message,
				commit: commit || push,
			}).pipe(
				Effect.catchAll((error) =>
					recoverBackupTransactionEffect(resolvedRepoPath).pipe(
						Effect.matchEffect({
							onSuccess: () => Effect.fail(error),
							onFailure: (rollbackError) =>
								Effect.fail(new AggregateError([error, rollbackError])),
						}),
					),
				),
			);
			yield* finalizeBackupTransactionEffect(publication);
			if (push) {
				yield* pushGeneratedBackupHeadEffect(
					resolvedRepoPath,
					commitResult?.committed
						? commitResult.commit
						: generatedCommitForPushReceipt,
				);
			}
			const git =
				commit || push
					? {
							committed: commitResult?.committed ?? false,
							pushed: push,
							commit: commitResult?.commit,
						}
					: undefined;

			return {
				ok: true as const,
				repoPath: resolvedRepoPath,
				manifest,
				validation,
				...(git ? { git } : {}),
			};
		}).pipe(
			Effect.ensuring(
				tryPromise(async () => {
					if (existsSync(path.join(transactionRoot, "journal.json"))) return;
					await durableRemove(stagingPath, {
						recursive: true,
						force: true,
					});
					await fs.rmdir(transactionRoot).catch(() => undefined);
					await syncDirectory(path.dirname(transactionRoot));
				}).pipe(Effect.catchAll(() => Effect.void)),
			),
		);
	});
}

export function exportBackupEffect(
	options: BackupExportOptions,
): Effect.Effect<BackupExportResult, unknown> {
	return withBackupRepositoryLockEffect(options.repoPath, (resolvedRepoPath) =>
		exportBackupUnlockedEffect({ ...options, repoPath: resolvedRepoPath }),
	);
}

export function exportBackup(
	options: BackupExportOptions,
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
		.filter((relativePath) => predicate(logicalBackupShardPath(relativePath)))
		.sort();
}

function importBackupUnlockedEffect({
	repoPath,
	db: providedDb,
	validate = true,
	mode = "merge",
}: BackupImportOptions): Effect.Effect<BackupImportResult, unknown> {
	return Effect.gen(function* () {
		const resolvedRepoPath = yield* trySync(() => path.resolve(repoPath));
		const db = providedDb ?? (yield* trySync(() => openBackupDatabase()));
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
		if (manifest.schemaVersion < 7) {
			const revisionsByRoot = new Map<string, JsonRecord[]>();
			for (const row of importRows.tweet_revisions) {
				if (typeof row.root_tweet_id !== "string") continue;
				const revisions = revisionsByRoot.get(row.root_tweet_id) ?? [];
				revisions.push(row);
				revisionsByRoot.set(row.root_tweet_id, revisions);
			}
			for (const revisions of revisionsByRoot.values()) {
				const ordered = revisions
					.filter(
						(row) =>
							typeof row.revision_id === "string" &&
							typeof row.revision_index === "number",
					)
					.sort(
						(left, right) =>
							Number(left.revision_index) - Number(right.revision_index) ||
							(String(left.revision_id) < String(right.revision_id)
								? -1
								: String(left.revision_id) > String(right.revision_id)
									? 1
									: 0),
					);
				const rankGroups = new Map<number, JsonRecord[]>();
				for (const revision of ordered) {
					const rank = Number(revision.revision_index);
					const group = rankGroups.get(rank) ?? [];
					group.push(revision);
					rankGroups.set(rank, group);
				}
				const groups = [...rankGroups.values()];
				for (let groupIndex = 1; groupIndex < groups.length; groupIndex += 1) {
					const older = groups[groupIndex - 1]?.[0];
					if (!older) continue;
					for (const newer of groups[groupIndex] ?? []) {
						importRows.tweet_revision_edges.push({
							older_revision_id: String(older.revision_id),
							newer_revision_id: String(newer.revision_id),
							source: "backup_migration",
							observed_at:
								typeof newer.observed_at === "string"
									? newer.observed_at
									: new Date(0).toISOString(),
						});
					}
				}
			}
		}
		yield* databaseWriteEffect((writeDb) => {
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
			let legacyProfileMergePlans: BackupLegacyProfileMergePlan[] = [];
			for (const codec of mergeCodecs) {
				let rows = importRows[codec.name];
				if (mode === "merge" && codec.name === "profiles") {
					const selectedAccount = writeDb
						.prepare("select 1 from accounts limit 1")
						.get()
						? resolveLiveSyncAccount(writeDb)
						: undefined;
					const reconciled = reconcileBackupProfileRows({
						db: writeDb,
						profileRows: importRows.profiles,
						profileSnapshotRows: importRows.profile_snapshots,
						selectedAccount,
					});
					rows = reconciled.rows;
					legacyProfileMergePlans = reconciled.legacyProfileMergePlans;
				}
				repository.insertRows(codec.merge.sql, rows, codec.merge.columns);
				const fts = codec.merge.fts;
				if (!fts) continue;
				if (fts.target.table === "tweets_fts") {
					repository.reindexTweets(rows, fts.idKey);
					continue;
				}
				repository.insertFtsRows({
					target: fts.target,
					rows,
					idKey: fts.idKey,
					textKey: fts.textKey,
					existingIds: existingFtsIds.get(codec.name),
				});
			}
			if (mode === "merge") {
				finalizeBackupProfileRows({
					db: writeDb,
					legacyProfileMergePlans,
				});
			}
			const importedRevisionChains = new Map<
				string,
				Array<{ revisionId: string; revisionIndex: number }>
			>();
			const connectedRevisionIds = new Set<string>();
			for (const row of importRows.tweet_revision_edges) {
				if (typeof row.older_revision_id === "string") {
					connectedRevisionIds.add(row.older_revision_id);
				}
				if (typeof row.newer_revision_id === "string") {
					connectedRevisionIds.add(row.newer_revision_id);
				}
			}
			for (const row of importRows.tweet_revisions) {
				if (
					typeof row.root_tweet_id !== "string" ||
					typeof row.revision_id !== "string" ||
					typeof row.revision_index !== "number"
				)
					continue;
				const chain = importedRevisionChains.get(row.root_tweet_id) ?? [];
				chain.push({
					revisionId: row.revision_id,
					revisionIndex: row.revision_index,
				});
				importedRevisionChains.set(row.root_tweet_id, chain);
			}
			const processedRevisionIds = new Set<string>();
			for (const [rootTweetId, chain] of importedRevisionChains) {
				const onlyRevision = chain.length === 1 ? chain[0] : undefined;
				if (
					onlyRevision?.revisionId === rootTweetId &&
					!connectedRevisionIds.has(onlyRevision.revisionId)
				) {
					continue;
				}
				if (
					chain.some((revision) =>
						processedRevisionIds.has(revision.revisionId),
					)
				)
					continue;
				const component = mergeTweetRevisionChain(
					writeDb,
					chain.map((revision) => revision.revisionId),
				);
				for (const revisionId of component) {
					processedRevisionIds.add(revisionId);
				}
			}
			reconcileTweetTombstones(writeDb);
		}, db);
		yield* trySync(() => refreshReadDatabasePoolAfterBulkWrite(db));
		const fingerprint = yield* trySync(() =>
			db.readTransaction(() => getBackupDatabaseFingerprint(db))(),
		);

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

export function importBackupEffect(
	options: BackupImportOptions,
): Effect.Effect<BackupImportResult, unknown> {
	return withBackupRepositoryLockEffect(options.repoPath, (resolvedRepoPath) =>
		Effect.gen(function* () {
			yield* assertBackupCheckoutCleanEffect(resolvedRepoPath);
			yield* assertCurrentManifestValidEffect(resolvedRepoPath);
			return yield* importBackupUnlockedEffect({
				...options,
				repoPath: resolvedRepoPath,
			});
		}),
	);
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

function rollbackPromotedGitRepositoryEffect(
	repoPath: string,
	remote: string | undefined,
) {
	return Effect.gen(function* () {
		const gitPath = path.join(repoPath, ".git");
		if (!(yield* trySync(() => existsSync(gitPath)))) return;
		const pendingPush = yield* readPendingBackupPushReceiptEffect(repoPath);
		if (pendingPush) return;
		if (remote && (yield* hasGitCommitsEffect(repoPath))) {
			const { stdout } = yield* gitEffect([
				"-C",
				repoPath,
				"rev-parse",
				"HEAD",
			]);
			const remoteBranch = yield* observeBackupRemoteBranchEffect(repoPath);
			if (
				remoteBranch.kind === "commit" &&
				remoteBranch.commit === stdout.trim()
			) {
				return;
			}
		}
		yield* assertCurrentManifestValidEffect(repoPath);
		yield* tryPromise(async () => {
			const stat = await fs.lstat(gitPath);
			if (!stat.isDirectory() || stat.isSymbolicLink()) {
				throw new Error("Promoted backup Git path is not an owned directory");
			}
			if ((await fs.realpath(gitPath)) !== gitPath) {
				throw new Error("Promoted backup Git path is not canonical");
			}
			await durableRemove(gitPath, { recursive: true });
			await syncDirectory(repoPath);
		});
		yield* assertCurrentManifestValidEffect(repoPath);
	});
}

function syncBackupUnlockedEffect({
	repoPath,
	remote,
	message = "archive: sync birdclaw backup",
	db,
}: SyncBackupOptions): Effect.Effect<BackupSyncResult, unknown> {
	let rollbackCreatedGit = false;
	return Effect.gen(function* () {
		const resolvedRepoPath = path.resolve(repoPath);
		const existingGitRepository = yield* isGitRepoEffect(resolvedRepoPath);
		let adoptExistingGeneration = false;
		if (existingGitRepository) {
			yield* assertBackupCheckoutCleanEffect(resolvedRepoPath);
			yield* assertCurrentManifestValidEffect(resolvedRepoPath);
		} else {
			adoptExistingGeneration =
				yield* inspectNonGitBackupAdoptionEffect(resolvedRepoPath);
		}
		rollbackCreatedGit = adoptExistingGeneration;
		const initialization = yield* ensureBackupGitRepoEffect({
			repoPath: resolvedRepoPath,
			remote,
			adoptExistingGeneration,
			message,
		});
		yield* assertBackupCheckoutCleanEffect(resolvedRepoPath);
		yield* assertCurrentManifestValidEffect(resolvedRepoPath);
		const history = yield* reconcileBackupGitHistoryEffect(resolvedRepoPath);
		yield* assertCurrentManifestValidEffect(resolvedRepoPath);
		if (history.pushOnly) {
			if (!history.pendingPush) {
				return yield* Effect.fail(
					new Error("Push-only backup recovery is missing its receipt"),
				);
			}
			yield* retryPendingBackupPushEffect(
				resolvedRepoPath,
				history.pendingPush,
			);
			const exportResult =
				yield* currentBackupExportResultEffect(resolvedRepoPath);
			return {
				ok: true as const,
				repoPath: resolvedRepoPath,
				...(remote ? { remote: redactSecretUrl(remote) } : {}),
				pulled: false,
				imported: false,
				exportResult,
				pushOnly: true,
			};
		}
		const database = db ?? (yield* trySync(() => openBackupDatabase()));
		const manifestExists = yield* trySync(() =>
			existsSync(path.join(resolvedRepoPath, MANIFEST_PATH)),
		);
		const importResult = manifestExists
			? yield* importBackupUnlockedEffect({
					repoPath: resolvedRepoPath,
					db: database,
					mode: "merge",
				})
			: undefined;
		const exportResult = yield* exportBackupUnlockedEffect({
			repoPath: resolvedRepoPath,
			db: database,
			commit: true,
			push: true,
			message,
			generatedCommitForPushReceipt: initialization.adoptedCommit,
		});

		return {
			ok: true as const,
			repoPath: resolvedRepoPath,
			...(remote ? { remote: redactSecretUrl(remote) } : {}),
			pulled: history.pulled,
			imported: Boolean(importResult),
			...(importResult ? { importResult } : {}),
			exportResult,
		};
	}).pipe(
		Effect.catchAll((error) =>
			rollbackCreatedGit
				? rollbackPromotedGitRepositoryEffect(
						path.resolve(repoPath),
						remote,
					).pipe(
						Effect.matchEffect({
							onFailure: (rollbackError) =>
								Effect.fail(new AggregateError([error, rollbackError])),
							onSuccess: () => Effect.fail(error),
						}),
					)
				: Effect.fail(error),
		),
	);
}

export function syncBackupEffect(
	options: SyncBackupOptions,
): Effect.Effect<BackupSyncResult, unknown> {
	return withBackupRepositoryLockEffect(options.repoPath, (resolvedRepoPath) =>
		syncBackupUnlockedEffect({ ...options, repoPath: resolvedRepoPath }),
	);
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
	appliedBackupHash?: string;
}

export interface UpdateBackupFromGitResult {
	ok: true;
	repoPath: string;
	remote?: string;
	pulled: boolean;
	imported: boolean;
	backupHash?: string;
	importResult?: BackupImportResult;
	pushOnly?: boolean;
}

function updateBackupFromGitUnlockedEffect({
	repoPath,
	remote,
	db,
	appliedBackupHash,
}: UpdateBackupFromGitOptions): Effect.Effect<
	UpdateBackupFromGitResult,
	unknown
> {
	return Effect.gen(function* () {
		const resolvedRepoPath = path.resolve(repoPath);
		if (yield* isGitRepoEffect(resolvedRepoPath)) {
			yield* assertBackupCheckoutCleanEffect(resolvedRepoPath);
			yield* assertCurrentManifestValidEffect(resolvedRepoPath);
		}
		yield* ensureBackupGitRepoEffect({ repoPath: resolvedRepoPath, remote });
		yield* assertBackupCheckoutCleanEffect(resolvedRepoPath);
		yield* assertCurrentManifestValidEffect(resolvedRepoPath);
		const history = yield* reconcileBackupGitHistoryEffect(resolvedRepoPath);
		yield* assertCurrentManifestValidEffect(resolvedRepoPath);
		if (history.pushOnly) {
			if (!history.pendingPush) {
				return yield* Effect.fail(
					new Error("Push-only backup recovery is missing its receipt"),
				);
			}
			yield* retryPendingBackupPushEffect(
				resolvedRepoPath,
				history.pendingPush,
			);
			const manifest = yield* readManifestEffect(resolvedRepoPath);
			return {
				ok: true,
				repoPath: resolvedRepoPath,
				...(remote ? { remote: redactSecretUrl(remote) } : {}),
				pulled: false,
				imported: false,
				backupHash: manifest.backupHash,
				pushOnly: true,
			};
		}
		const manifestExists = yield* trySync(() =>
			existsSync(path.join(resolvedRepoPath, MANIFEST_PATH)),
		);
		const manifest = manifestExists
			? yield* readManifestEffect(resolvedRepoPath)
			: undefined;
		const importResult =
			manifest && manifest.backupHash !== appliedBackupHash
				? yield* importBackupUnlockedEffect({
						repoPath: resolvedRepoPath,
						db: db ?? (yield* trySync(() => openBackupDatabase())),
						mode: "merge",
					})
				: undefined;

		return {
			ok: true,
			repoPath: resolvedRepoPath,
			...(remote ? { remote: redactSecretUrl(remote) } : {}),
			pulled: history.pulled,
			imported: Boolean(importResult),
			...(manifest ? { backupHash: manifest.backupHash } : {}),
			...(importResult ? { importResult } : {}),
		};
	});
}

export function updateBackupFromGitEffect(
	options: UpdateBackupFromGitOptions,
): Effect.Effect<UpdateBackupFromGitResult, unknown> {
	return withBackupRepositoryLockEffect(options.repoPath, (resolvedRepoPath) =>
		updateBackupFromGitUnlockedEffect({
			...options,
			repoPath: resolvedRepoPath,
		}),
	);
}

function readAutoSyncState(db: Database) {
	const row = db
		.prepare("select value_json from sync_cache where cache_key = ?")
		.get(AUTO_SYNC_CACHE_KEY) as { value_json: string } | undefined;
	if (!row) {
		return null;
	}
	try {
		return JSON.parse(row.value_json) as BackupAutoSyncState;
	} catch {
		return null;
	}
}

function readAutoSyncStateWithoutCreatingDatabase() {
	const dbPath = getBirdclawPaths().dbPath;
	if (!existsSync(dbPath)) return null;
	const db = new NativeSqliteDatabase(dbPath, {
		readonly: true,
		fileMustExist: true,
	});
	try {
		return readAutoSyncState(db);
	} catch {
		return null;
	} finally {
		db.close();
	}
}

function writeAutoSyncState(
	db: Database,
	value: BackupAutoSyncState & { checkedAt: string; ok: boolean },
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

		const state = db
			? yield* trySync(() => readAutoSyncState(db)).pipe(
					Effect.catchAll(() => Effect.succeed(null)),
				)
			: yield* trySync(() => readAutoSyncStateWithoutCreatingDatabase()).pipe(
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
			db,
			appliedBackupHash: state?.backupHash,
		}).pipe(
			Effect.map((value) => ({ ok: true as const, value })),
			Effect.catchAll((error) => Effect.succeed({ ok: false as const, error })),
		);

		if (result.ok) {
			if (db || !result.value.pushOnly) {
				const database = yield* trySync(() => db ?? openBackupDatabase()).pipe(
					Effect.orDie,
				);
				yield* trySync(() =>
					writeAutoSyncState(database, {
						checkedAt: now,
						ok: true,
						...(result.value.backupHash
							? { backupHash: result.value.backupHash }
							: state?.backupHash
								? { backupHash: state.backupHash }
								: {}),
					}),
				).pipe(Effect.orDie);
			}
			return {
				ok: true,
				enabled: true,
				skipped: Boolean(result.value.backupHash) && !result.value.imported,
				...(result.value.backupHash && !result.value.imported
					? { reason: "backup auto-sync manifest is unchanged" }
					: {}),
				repoPath: result.value.repoPath,
				...(result.value.remote
					? { remote: redactSecretUrl(result.value.remote) }
					: {}),
				pulled: result.value.pulled,
				imported: result.value.imported,
				...(result.value.backupHash
					? { backupHash: result.value.backupHash }
					: {}),
			};
		}

		const message =
			result.error instanceof Error
				? result.error.message
				: String(result.error);
		if (db) {
			yield* trySync(() =>
				writeAutoSyncState(db, {
					checkedAt: now,
					ok: false,
					error: message,
					...(state?.backupHash ? { backupHash: state.backupHash } : {}),
				}),
			).pipe(Effect.orDie);
		}
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

export function requestBackupAutoUpdate(db?: Database) {
	if (autoUpdateBackgroundScheduled || autoUpdateInFlight) return;
	autoUpdateBackgroundScheduled = true;
	const timer = setTimeout(() => {
		autoUpdateBackgroundScheduled = false;
		runEffectBackground(maybeAutoUpdateBackupEffect(db), {
			onSuccess: (result) => {
				if (!result.ok) {
					console.error(`birdclaw backup auto-sync failed: ${result.error}`);
				}
			},
			onFailure: (error) => {
				console.error(
					`birdclaw backup auto-sync failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			},
		});
	}, BACKGROUND_AUTO_UPDATE_DELAY_MS);
	timer.unref();
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
		const state = db
			? yield* trySync(() => readAutoSyncState(db)).pipe(
					Effect.catchAll(() => Effect.succeed(null)),
				)
			: yield* trySync(() => readAutoSyncStateWithoutCreatingDatabase()).pipe(
					Effect.catchAll(() => Effect.succeed(null)),
				);
		const now = new Date().toISOString();
		const result = yield* syncBackupEffect({
			repoPath: config.repoPath,
			remote: config.remote,
			db,
		}).pipe(
			Effect.map((value) => ({ ok: true as const, value })),
			Effect.catchAll((error) => Effect.succeed({ ok: false as const, error })),
		);

		if (result.ok) {
			if (db || !result.value.pushOnly) {
				const database = yield* trySync(() => db ?? openBackupDatabase()).pipe(
					Effect.orDie,
				);
				yield* trySync(() =>
					writeAutoSyncState(database, {
						checkedAt: now,
						ok: true,
						backupHash: result.value.exportResult.manifest.backupHash,
					}),
				).pipe(Effect.orDie);
			}
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
		if (db) {
			yield* trySync(() =>
				writeAutoSyncState(db, {
					checkedAt: now,
					ok: false,
					error: message,
					...(state?.backupHash ? { backupHash: state.backupHash } : {}),
				}),
			).pipe(Effect.orDie);
		}
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
			{ concurrency: 1 },
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
		const inventoryError = yield* assertManagedDataInventoryEffect(
			resolvedRepoPath,
		).pipe(
			Effect.match({
				onFailure: (error) =>
					error instanceof Error ? error.message : String(error),
				onSuccess: () => undefined,
			}),
		);
		if (inventoryError) errors.push(inventoryError);

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
	for (const codec of BACKUP_TABLE_CODECS) {
		let count = 0;
		hash.update(`${codec.name}\n`);
		const rows = db.prepare(codec.exportSql).iterate() as IterableIterator<
			Record<string, unknown>
		>;
		for (const rawRow of rows) {
			const row = toJsonRecord(rawRow);
			hash.update(canonicalStringify(row));
			hash.update("\n");
			count += 1;
		}
		counts[codec.name] = count;
	}
	return { counts, hash: hash.digest("hex") };
}

export const __test__ = {
	backupLockPath,
	canonicalizeBackupRepoPath,
	canonicalBackupRemoteIdentity,
	async transactionRootPaths(repoPath: string) {
		return runEffectPromise(
			getBackupTransactionRootPathsEffect(
				await canonicalizeBackupRepoPath(repoPath),
			),
		);
	},
	async pendingPushReceiptPaths(repoPath: string) {
		const resolvedRepoPath = await canonicalizeBackupRepoPath(repoPath);
		return runEffectPromise(
			pendingBackupPushReceiptPathsEffect(resolvedRepoPath),
		);
	},
	setBeforeStagedValidation(
		hook: ((stagingPath: string) => void | Promise<void>) | undefined,
	) {
		beforeStagedValidationForTests = hook;
	},
	setAfterPublicationRename(
		hook:
			| ((
					relativePath: string,
					phase: "rollback" | "install",
			  ) => void | Promise<void>)
			| undefined,
	) {
		afterPublicationRenameForTests = hook;
	},
	setBeforeDatabaseOpen(hook: (() => void) | undefined) {
		beforeDatabaseOpenForTests = hook;
	},
	setBeforeCommittedCleanup(hook: (() => void | Promise<void>) | undefined) {
		beforeCommittedCleanupForTests = hook;
	},
	setAfterPublication(hook: (() => void | Promise<void>) | undefined) {
		afterPublicationForTests = hook;
	},
	setAfterRecoveryCleanupBoundary(
		hook:
			| ((
					boundary: "journal" | "stage" | "rollback" | "root",
			  ) => void | Promise<void>)
			| undefined,
	) {
		afterRecoveryCleanupBoundaryForTests = hook;
	},
};
