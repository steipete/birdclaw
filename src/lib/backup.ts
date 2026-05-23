import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Data, Effect } from "effect";
import type { Database } from "./sqlite";
import { getBirdclawConfig } from "./config";
import { getNativeDb } from "./db";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import { safeHttpUrl } from "./url-safety";

const execFileAsync = promisify(execFile);
const BACKUP_SCHEMA_VERSION = 1;
const MANIFEST_PATH = "manifest.json";
const DATA_DIR = "data";
const AUTO_SYNC_CACHE_KEY = "backup:auto-sync";
const DEFAULT_STALE_AFTER_SECONDS = 15 * 60;
let autoUpdateInFlight: Promise<BackupAutoUpdateResult> | null = null;

type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

type JsonRecord = Record<string, JsonValue>;

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

function getErrorOutput(error: unknown, key: "stdout" | "stderr") {
	if (!error || typeof error !== "object" || !(key in error)) {
		return undefined;
	}
	const output = (error as Record<"stdout" | "stderr", unknown>)[key];
	return typeof output === "string" ? output : undefined;
}

function redactSecretUrl(value: string) {
	return value.replace(
		/([a-z][a-z0-9+.-]*:\/\/)([^/@:\s]+)(?::([^/@\s]+))?@/gi,
		(_match, protocol: string, username: string, password?: string) =>
			`${protocol}${username ? "REDACTED" : ""}${password ? ":REDACTED" : ""}@`,
	);
}

function gitCommandError(args: readonly string[], cause: unknown) {
	const redactedArgs = args.map((arg) => redactSecretUrl(arg));
	const command = `git ${redactedArgs.join(" ")}`;
	const message = redactSecretUrl(
		cause instanceof Error ? cause.message : `${command} failed`,
	);
	return new BackupGitCommandError({
		message,
		args: redactedArgs,
		stdout: redactSecretUrl(getErrorOutput(cause, "stdout") ?? ""),
		stderr: redactSecretUrl(getErrorOutput(cause, "stderr") ?? ""),
		cause,
	});
}

function gitEffect(args: string[]) {
	return Effect.tryPromise({
		try: () => execFileAsync("git", args),
		catch: (cause) => gitCommandError(args, cause),
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
		.map((key) => `${JSON.stringify(key)}:${JSON.stringify(row[key])}`)
		.join(",")}}`;
}

function yearFromTimestamp(value: unknown) {
	if (typeof value !== "string") {
		return "unknown";
	}
	const match = /^(\d{4})/.exec(value);
	if (!match || match[1] === "1970") {
		return "unknown";
	}
	return match[1];
}

function rowsForQuery(db: Database, sql: string, params: unknown[] = []) {
	return (db.prepare(sql).all(...params) as Record<string, unknown>[]).map(
		toJsonRecord,
	);
}

function getExportRowSets(db: Database) {
	const rowSets: Array<{ logicalName: string; rows: JsonRecord[] }> = [
		{
			logicalName: "accounts",
			rows: rowsForQuery(
				db,
				`
        select id, name, handle, external_user_id, transport, is_default, created_at
        from accounts
        order by id
        `,
			),
		},
		{
			logicalName: "profiles",
			rows: rowsForQuery(
				db,
				`
        select id, handle, display_name, bio, followers_count,
          following_count, public_metrics_json, avatar_hue, avatar_url,
          location, url, verified_type, entities_json, raw_json, created_at
        from profiles
        order by id
        `,
			),
		},
		{
			logicalName: "profile_affiliations",
			rows: rowsForQuery(
				db,
				`
        select subject_profile_id, organization_profile_id, organization_name,
          organization_handle, badge_url, url, label, source, is_active,
          first_seen_at, last_seen_at, raw_json, updated_at
        from profile_affiliations
        order by subject_profile_id, organization_profile_id
        `,
			),
		},
		{
			logicalName: "profile_snapshots",
			rows: rowsForQuery(
				db,
				`
        select profile_id, snapshot_hash, observed_at, last_seen_at, source,
          handle, display_name, bio, location, url, verified_type,
          followers_count, following_count, affiliations_json, raw_json
        from profile_snapshots
        order by profile_id, last_seen_at, snapshot_hash
        `,
			),
		},
		{
			logicalName: "profile_bio_entities",
			rows: rowsForQuery(
				db,
				`
        select profile_id, kind, value, source, is_active, first_seen_at,
          last_seen_at, raw_json
        from profile_bio_entities
        order by profile_id, kind, value
        `,
			),
		},
		{
			logicalName: "tweets",
			rows: rowsForQuery(
				db,
				`
        select id, account_id, author_profile_id, kind, text, created_at, is_replied,
          reply_to_id, like_count, media_count, bookmarked, liked, entities_json,
          media_json, quoted_tweet_id
        from tweets
        order by created_at, id
        `,
			),
		},
		{
			logicalName: "tweet_collections",
			rows: rowsForQuery(
				db,
				`
        select account_id, tweet_id, kind, collected_at, source, raw_json, updated_at
        from tweet_collections
        order by kind, account_id, coalesce(collected_at, ''), tweet_id
        `,
			),
		},
		{
			logicalName: "tweet_account_edges",
			rows: rowsForQuery(
				db,
				`
        select account_id, tweet_id, kind, first_seen_at, last_seen_at,
          seen_count, source, raw_json, updated_at
        from tweet_account_edges
        order by kind, account_id, last_seen_at, tweet_id
        `,
			),
		},
		{
			logicalName: "dm_conversations",
			rows: rowsForQuery(
				db,
				`
        select id, account_id, participant_profile_id, title, inbox_kind,
          last_message_at, unread_count, needs_reply
        from dm_conversations
        order by last_message_at, id
        `,
			),
		},
		{
			logicalName: "dm_messages",
			rows: rowsForQuery(
				db,
				`
        select id, conversation_id, sender_profile_id, text, created_at, direction,
          is_replied, media_count
        from dm_messages
        order by conversation_id, created_at, id
				`,
			),
		},
		{
			logicalName: "url_expansions",
			rows: rowsForQuery(
				db,
				`
        select short_url, expanded_url, final_url, status, expanded_tweet_id,
          expanded_handle, title, description, image_url, site_name, error,
          source, updated_at
        from url_expansions
        order by short_url
        `,
			),
		},
		{
			logicalName: "link_occurrences",
			rows: rowsForQuery(
				db,
				`
        select source_kind, source_id, source_position, short_url, account_id,
          conversation_id, direction, created_at
        from link_occurrences
        order by source_kind, source_id, source_position, short_url
        `,
			),
		},
		{
			logicalName: "blocks",
			rows: rowsForQuery(
				db,
				`
        select account_id, profile_id, source, created_at
        from blocks
        order by account_id, profile_id
        `,
			),
		},
		{
			logicalName: "mutes",
			rows: rowsForQuery(
				db,
				`
        select account_id, profile_id, source, created_at
        from mutes
        order by account_id, profile_id
        `,
			),
		},
		{
			logicalName: "tweet_actions",
			rows: rowsForQuery(
				db,
				`
        select id, account_id, tweet_id, kind, body, created_at
        from tweet_actions
        order by created_at, id
        `,
			),
		},
		{
			logicalName: "ai_scores",
			rows: rowsForQuery(
				db,
				`
        select entity_kind, entity_id, model, score, summary, reasoning, updated_at
        from ai_scores
        order by entity_kind, entity_id, model
        `,
			),
		},
		{
			logicalName: "follow_snapshots",
			rows: rowsForQuery(
				db,
				`
        select id, account_id, direction, source, status, page_count,
          result_count, started_at, completed_at, raw_meta_json
        from follow_snapshots
        order by account_id, direction, completed_at, id
        `,
			),
		},
		{
			logicalName: "follow_snapshot_members",
			rows: rowsForQuery(
				db,
				`
        select snapshot_id, profile_id, external_user_id, position
        from follow_snapshot_members
        order by snapshot_id, position, profile_id
        `,
			),
		},
		{
			logicalName: "follow_edges",
			rows: rowsForQuery(
				db,
				`
        select account_id, direction, profile_id, external_user_id, source,
          current, first_seen_at, last_seen_at, ended_at, updated_at
        from follow_edges
        order by account_id, direction, profile_id
        `,
			),
		},
		{
			logicalName: "follow_events",
			rows: rowsForQuery(
				db,
				`
        select id, account_id, direction, profile_id, external_user_id, kind,
          event_at, snapshot_id
        from follow_events
        order by account_id, direction, event_at, kind, profile_id, id
        `,
			),
		},
	];
	return rowSets;
}

function addRows(
	shards: Map<string, JsonRecord[]>,
	relativePath: string,
	rows: JsonRecord[],
) {
	if (rows.length === 0) {
		return;
	}
	const existing = shards.get(relativePath) ?? [];
	existing.push(...rows);
	shards.set(relativePath, existing);
}

function buildShards(db: Database) {
	const shards = new Map<string, JsonRecord[]>();
	const rowSets = getExportRowSets(db);

	for (const rowSet of rowSets) {
		switch (rowSet.logicalName) {
			case "accounts":
				addRows(shards, "data/accounts.jsonl", rowSet.rows);
				break;
			case "profiles":
				addRows(shards, "data/profiles.jsonl", rowSet.rows);
				break;
			case "profile_affiliations":
				addRows(shards, "data/profile_affiliations.jsonl", rowSet.rows);
				break;
			case "profile_snapshots":
				addRows(shards, "data/profile_snapshots.jsonl", rowSet.rows);
				break;
			case "profile_bio_entities":
				addRows(shards, "data/profile_bio_entities.jsonl", rowSet.rows);
				break;
			case "tweets":
				for (const row of rowSet.rows) {
					addRows(
						shards,
						`data/tweets/${yearFromTimestamp(row.created_at)}.jsonl`,
						[row],
					);
				}
				break;
			case "tweet_collections":
				for (const row of rowSet.rows) {
					const kind =
						row.kind === "likes" || row.kind === "bookmarks"
							? row.kind
							: "unknown";
					addRows(shards, `data/collections/${kind}.jsonl`, [row]);
				}
				break;
			case "tweet_account_edges":
				for (const row of rowSet.rows) {
					const kind =
						row.kind === "home" ||
						row.kind === "mention" ||
						row.kind === "authored" ||
						row.kind === "search"
							? row.kind
							: "unknown";
					addRows(shards, `data/timeline_edges/${kind}.jsonl`, [row]);
				}
				break;
			case "dm_conversations":
				addRows(shards, "data/dms/conversations.jsonl", rowSet.rows);
				break;
			case "dm_messages":
				for (const row of rowSet.rows) {
					addRows(
						shards,
						`data/dms/${yearFromTimestamp(row.created_at)}.jsonl`,
						[row],
					);
				}
				break;
			case "url_expansions":
				addRows(shards, "data/links/url_expansions.jsonl", rowSet.rows);
				break;
			case "link_occurrences":
				addRows(shards, "data/links/occurrences.jsonl", rowSet.rows);
				break;
			case "blocks":
			case "mutes":
				addRows(
					shards,
					`data/moderation/${rowSet.logicalName}.jsonl`,
					rowSet.rows,
				);
				break;
			case "tweet_actions":
				addRows(shards, "data/actions/tweet_actions.jsonl", rowSet.rows);
				break;
			case "ai_scores":
				addRows(shards, "data/ai_scores.jsonl", rowSet.rows);
				break;
			case "follow_snapshots":
				addRows(shards, "data/follow_snapshots.jsonl", rowSet.rows);
				break;
			case "follow_snapshot_members":
				addRows(shards, "data/follow_snapshot_members.jsonl", rowSet.rows);
				break;
			case "follow_edges":
				addRows(shards, "data/follow_edges.jsonl", rowSet.rows);
				break;
			case "follow_events":
				addRows(shards, "data/follow_events.jsonl", rowSet.rows);
				break;
		}
	}

	return shards;
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

function computeCounts(files: BackupFileManifest[]) {
	const counts: Record<string, number> = {};
	for (const file of files) {
		const [first, second, third] = file.path.split("/");
		if (first !== "data") {
			continue;
		}
		const key =
			second === "tweets"
				? "tweets"
				: second === "collections"
					? `collections_${third?.replace(/\.jsonl$/, "") ?? "unknown"}`
					: second === "timeline_edges"
						? `timeline_edges_${third?.replace(/\.jsonl$/, "") ?? "unknown"}`
						: second === "dms" && third === "conversations.jsonl"
							? "dm_conversations"
							: second === "dms"
								? "dm_messages"
								: second === "links"
									? third === "url_expansions.jsonl"
										? "url_expansions"
										: third === "occurrences.jsonl"
											? "link_occurrences"
											: "links"
									: second === "moderation"
										? third?.replace(/\.jsonl$/, "") || "moderation"
										: second === "actions"
											? third?.replace(/\.jsonl$/, "") || "actions"
											: second?.replace(/\.jsonl$/, "") || "unknown";
		counts[key] = (counts[key] ?? 0) + file.rows;
	}
	return counts;
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

		const counts = yield* trySync(() => computeCounts(files));
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
		if (parsed.schemaVersion !== BACKUP_SCHEMA_VERSION) {
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

function readJsonlFileEffect(
	repoPath: string,
	relativePath: string,
): Effect.Effect<JsonRecord[], unknown> {
	return Effect.gen(function* () {
		const filePath = yield* trySync(() =>
			resolveBackupFilePath(repoPath, relativePath),
		);
		yield* assertReadableBackupFileEffect(repoPath, filePath, relativePath);
		const content = yield* tryPromise(() => fs.readFile(filePath, "utf8"));
		return yield* trySync(() =>
			content
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line) as JsonRecord),
		);
	});
}

function readJsonlFilesEffect(
	repoPath: string,
	relativePaths: string[],
): Effect.Effect<JsonRecord[], unknown> {
	return Effect.gen(function* () {
		const nestedRows = yield* Effect.forEach(
			relativePaths,
			(relativePath) => readJsonlFileEffect(repoPath, relativePath),
			{ concurrency: "unbounded" },
		);
		return nestedRows.flat();
	});
}

function readBackupImportRowsEffect(
	resolvedRepoPath: string,
	manifest: BackupManifest,
): Effect.Effect<JsonRecord[][], unknown> {
	const readRows = (predicate: (relativePath: string) => boolean) =>
		readJsonlFilesEffect(
			resolvedRepoPath,
			rowsForManifestPath(manifest, predicate),
		);

	return Effect.all(
		[
			readRows((file) => file === "data/accounts.jsonl"),
			readRows((file) => file === "data/profiles.jsonl"),
			readRows((file) => file === "data/profile_affiliations.jsonl"),
			readRows((file) => file === "data/profile_snapshots.jsonl"),
			readRows((file) => file === "data/profile_bio_entities.jsonl"),
			readRows((file) => file.startsWith("data/tweets/")),
			readRows((file) => file.startsWith("data/collections/")),
			readRows((file) => file.startsWith("data/timeline_edges/")),
			readRows((file) => file === "data/dms/conversations.jsonl"),
			readRows(
				(file) =>
					file.startsWith("data/dms/") &&
					file !== "data/dms/conversations.jsonl",
			),
			readRows((file) => file === "data/moderation/blocks.jsonl"),
			readRows((file) => file === "data/moderation/mutes.jsonl"),
			readRows((file) => file === "data/actions/tweet_actions.jsonl"),
			readRows((file) => file === "data/ai_scores.jsonl"),
			readRows((file) => file === "data/links/url_expansions.jsonl"),
			readRows((file) => file === "data/links/occurrences.jsonl"),
			readRows((file) => file === "data/follow_snapshots.jsonl"),
			readRows((file) => file === "data/follow_snapshot_members.jsonl"),
			readRows((file) => file === "data/follow_edges.jsonl"),
			readRows((file) => file === "data/follow_events.jsonl"),
		],
		{ concurrency: "unbounded" },
	);
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

function insertRows(
	db: Database,
	sql: string,
	rows: JsonRecord[],
	keys: string[],
) {
	const statement = db.prepare(sql);
	for (const row of rows) {
		statement.run(...keys.map((key) => row[key] ?? null));
	}
}

const JSON_URL_KEYS = new Set([
	"url",
	"expandedUrl",
	"expanded_url",
	"imageUrl",
	"image_url",
	"mediaUrl",
	"media_url",
	"media_url_https",
	"thumbnailUrl",
	"thumbnail_url",
	"previewImageUrl",
	"preview_image_url",
]);

function sanitizeJsonUrlValue(key: string, value: JsonValue): JsonValue {
	if (!JSON_URL_KEYS.has(key)) return value;
	if (typeof value !== "string" || value.length === 0) return value;
	return safeHttpUrl(value) ?? "";
}

function sanitizeJsonUrls(value: JsonValue, key = ""): JsonValue {
	if (Array.isArray(value)) {
		return value.map((item) => sanitizeJsonUrls(item));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([entryKey, entryValue]) => [
				entryKey,
				sanitizeJsonUrls(entryValue, entryKey),
			]),
		);
	}
	return sanitizeJsonUrlValue(key, value);
}

function sanitizeJsonTextUrls(value: JsonValue, fallback: JsonValue) {
	if (typeof value !== "string" || value.length === 0) return value;
	try {
		return JSON.stringify(sanitizeJsonUrls(JSON.parse(value) as JsonValue));
	} catch {
		return JSON.stringify(fallback);
	}
}

function sanitizeImportedTweets(rows: JsonRecord[]) {
	return rows.map((row) => ({
		...row,
		entities_json: sanitizeJsonTextUrls(row.entities_json, {}),
		media_json: sanitizeJsonTextUrls(row.media_json, []),
	}));
}

function sanitizeImportedUrlExpansions(rows: JsonRecord[]) {
	return rows.map((row) => {
		const shortUrl =
			typeof row.short_url === "string" ? safeHttpUrl(row.short_url) : null;
		const expandedUrl =
			typeof row.expanded_url === "string"
				? safeHttpUrl(row.expanded_url)
				: null;
		const finalUrl =
			typeof row.final_url === "string" ? safeHttpUrl(row.final_url) : null;
		const safe = Boolean(shortUrl || expandedUrl || finalUrl);
		return {
			...row,
			short_url: shortUrl ?? "",
			expanded_url: expandedUrl ?? shortUrl ?? "",
			final_url: finalUrl ?? expandedUrl ?? shortUrl ?? "",
			status: safe ? row.status : "error",
			error: safe ? row.error : "unsafe URL stripped from backup import",
			image_url:
				typeof row.image_url === "string"
					? (safeHttpUrl(row.image_url) ?? "")
					: row.image_url,
		};
	});
}

function readFtsIds(
	db: Database,
	tableName: "tweets_fts" | "dm_fts",
	idColumn: "tweet_id" | "message_id",
) {
	const rows = db
		.prepare(`select ${idColumn} as id from ${tableName}`)
		.all() as { id: string }[];
	return new Set(rows.map((row) => row.id));
}

function insertFtsRows(
	db: Database,
	tableName: "tweets_fts" | "dm_fts",
	idColumn: "tweet_id" | "message_id",
	rows: JsonRecord[],
	idKey: string,
	textKey: string,
	existingIds = new Set<string>(),
) {
	const statement = db.prepare(
		`insert into ${tableName} (${idColumn}, text) values (?, ?)`,
	);
	for (const row of rows) {
		const id = row[idKey];
		if (typeof id !== "string" || existingIds.has(id)) {
			continue;
		}
		const text = row[textKey];
		statement.run(id, typeof text === "string" ? text : "");
		existingIds.add(id);
	}
}

function clearBackupImportData(db: Database) {
	db.exec(`
    delete from follow_events;
    delete from follow_edges;
    delete from follow_snapshot_members;
    delete from follow_snapshots;
    delete from ai_scores;
    delete from tweet_actions;
    delete from tweet_account_edges;
    delete from tweet_collections;
    delete from link_occurrences;
    delete from url_expansions;
    delete from blocks;
    delete from mutes;
    delete from dm_fts;
    delete from tweets_fts;
    delete from dm_messages;
    delete from dm_conversations;
    delete from tweets;
    delete from profile_bio_entities;
    delete from profile_snapshots;
    delete from profile_affiliations;
    delete from profiles;
    delete from accounts;
    delete from sync_cache;
  `);
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

		const [
			accounts,
			profiles,
			profileAffiliations,
			profileSnapshots,
			profileBioEntities,
			tweets,
			collections,
			timelineEdges,
			conversations,
			messages,
			blocks,
			mutes,
			actions,
			scores,
			urlExpansions,
			linkOccurrences,
			followSnapshots,
			followSnapshotMembers,
			followEdges,
			followEvents,
		] = yield* readBackupImportRowsEffect(resolvedRepoPath, manifest);
		const sanitizedTweets = yield* trySync(() =>
			sanitizeImportedTweets(tweets),
		);
		const sanitizedUrlExpansions = yield* trySync(() =>
			sanitizeImportedUrlExpansions(urlExpansions),
		);

		const fingerprint = yield* trySync(() => {
			db.transaction(() => {
				if (mode === "replace") {
					clearBackupImportData(db);
				}
				const tweetFtsIds =
					mode === "replace"
						? new Set<string>()
						: readFtsIds(db, "tweets_fts", "tweet_id");
				const dmFtsIds =
					mode === "replace"
						? new Set<string>()
						: readFtsIds(db, "dm_fts", "message_id");
				insertRows(
					db,
					`
      insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at)
      values (?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        name = coalesce(nullif(excluded.name, ''), accounts.name),
        handle = coalesce(nullif(excluded.handle, ''), accounts.handle),
        external_user_id = coalesce(excluded.external_user_id, accounts.external_user_id),
        transport = coalesce(nullif(excluded.transport, ''), accounts.transport),
        is_default = max(accounts.is_default, excluded.is_default),
        created_at = min(accounts.created_at, excluded.created_at)
      `,
					accounts,
					[
						"id",
						"name",
						"handle",
						"external_user_id",
						"transport",
						"is_default",
						"created_at",
					],
				);
				insertRows(
					db,
					`
      insert into profile_snapshots (
        profile_id, snapshot_hash, observed_at, last_seen_at, source, handle,
        display_name, bio, location, url, verified_type, followers_count,
        following_count, affiliations_json, raw_json
      ) values (?, ?, ?, ?, coalesce(?, 'backup'), ?, ?, ?, ?, ?, ?, coalesce(?, 0), coalesce(?, 0), coalesce(?, '[]'), coalesce(?, '{}'))
      on conflict(profile_id, snapshot_hash) do update set
        last_seen_at = max(profile_snapshots.last_seen_at, excluded.last_seen_at),
        source = excluded.source,
        raw_json = case
          when excluded.raw_json not in ('', '{}', 'null') then excluded.raw_json
          else profile_snapshots.raw_json
        end
      `,
					profileSnapshots,
					[
						"profile_id",
						"snapshot_hash",
						"observed_at",
						"last_seen_at",
						"source",
						"handle",
						"display_name",
						"bio",
						"location",
						"url",
						"verified_type",
						"followers_count",
						"following_count",
						"affiliations_json",
						"raw_json",
					],
				);
				insertRows(
					db,
					`
      insert into profile_bio_entities (
        profile_id, kind, value, source, is_active, first_seen_at, last_seen_at, raw_json
      ) values (?, ?, ?, coalesce(?, 'backup'), coalesce(?, 1), ?, ?, coalesce(?, '{}'))
      on conflict(profile_id, kind, value) do update set
        source = excluded.source,
        is_active = excluded.is_active,
        last_seen_at = max(profile_bio_entities.last_seen_at, excluded.last_seen_at),
        raw_json = case
          when excluded.raw_json not in ('', '{}', 'null') then excluded.raw_json
          else profile_bio_entities.raw_json
        end
      `,
					profileBioEntities,
					[
						"profile_id",
						"kind",
						"value",
						"source",
						"is_active",
						"first_seen_at",
						"last_seen_at",
						"raw_json",
					],
				);
				insertRows(
					db,
					`
      insert into profiles (
        id, handle, display_name, bio, followers_count, following_count,
        public_metrics_json, avatar_hue, avatar_url, location, url,
        verified_type, entities_json, raw_json, created_at
      ) values (?, ?, ?, ?, ?, coalesce(?, 0), coalesce(?, '{}'), ?, ?, ?, ?, ?, coalesce(?, '{}'), coalesce(?, '{}'), ?)
      on conflict(id) do update set
        handle = coalesce(nullif(excluded.handle, ''), profiles.handle),
        display_name = coalesce(nullif(excluded.display_name, ''), profiles.display_name),
        bio = coalesce(nullif(excluded.bio, ''), profiles.bio),
        followers_count = max(profiles.followers_count, excluded.followers_count),
        following_count = max(profiles.following_count, excluded.following_count),
        public_metrics_json = case
          when excluded.public_metrics_json not in ('', '{}', 'null') then excluded.public_metrics_json
          else profiles.public_metrics_json
        end,
        avatar_hue = case when profiles.avatar_hue = 0 then excluded.avatar_hue else profiles.avatar_hue end,
        avatar_url = coalesce(excluded.avatar_url, profiles.avatar_url),
        location = coalesce(excluded.location, profiles.location),
        url = coalesce(excluded.url, profiles.url),
        verified_type = coalesce(excluded.verified_type, profiles.verified_type),
        entities_json = case
          when excluded.entities_json not in ('', '{}', 'null') then excluded.entities_json
          else profiles.entities_json
        end,
        raw_json = case
          when excluded.raw_json not in ('', '{}', 'null') then excluded.raw_json
          else profiles.raw_json
        end,
        created_at = min(profiles.created_at, excluded.created_at)
      `,
					profiles,
					[
						"id",
						"handle",
						"display_name",
						"bio",
						"followers_count",
						"following_count",
						"public_metrics_json",
						"avatar_hue",
						"avatar_url",
						"location",
						"url",
						"verified_type",
						"entities_json",
						"raw_json",
						"created_at",
					],
				);
				insertRows(
					db,
					`
      insert into profile_affiliations (
        subject_profile_id, organization_profile_id, organization_name,
        organization_handle, badge_url, url, label, source, is_active,
        first_seen_at, last_seen_at, raw_json, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, coalesce(?, 'backup'), coalesce(?, 1), ?, ?, coalesce(?, '{}'), ?)
      on conflict(subject_profile_id, organization_profile_id) do update set
        organization_name = coalesce(excluded.organization_name, profile_affiliations.organization_name),
        organization_handle = coalesce(excluded.organization_handle, profile_affiliations.organization_handle),
        badge_url = coalesce(excluded.badge_url, profile_affiliations.badge_url),
        url = coalesce(excluded.url, profile_affiliations.url),
        label = coalesce(excluded.label, profile_affiliations.label),
        source = excluded.source,
        is_active = excluded.is_active,
        last_seen_at = max(profile_affiliations.last_seen_at, excluded.last_seen_at),
        raw_json = case
          when excluded.raw_json not in ('', '{}', 'null') then excluded.raw_json
          else profile_affiliations.raw_json
        end,
        updated_at = excluded.updated_at
      `,
					profileAffiliations,
					[
						"subject_profile_id",
						"organization_profile_id",
						"organization_name",
						"organization_handle",
						"badge_url",
						"url",
						"label",
						"source",
						"is_active",
						"first_seen_at",
						"last_seen_at",
						"raw_json",
						"updated_at",
					],
				);
				insertRows(
					db,
					`
      insert into follow_snapshots (
        id, account_id, direction, source, status, page_count, result_count,
        started_at, completed_at, raw_meta_json
      ) values (?, ?, ?, coalesce(?, 'backup'), ?, coalesce(?, 0), coalesce(?, 0), ?, ?, coalesce(?, '{}'))
      on conflict(id) do update set
        account_id = coalesce(nullif(excluded.account_id, ''), follow_snapshots.account_id),
        direction = coalesce(nullif(excluded.direction, ''), follow_snapshots.direction),
        source = coalesce(nullif(excluded.source, ''), follow_snapshots.source),
        status = coalesce(nullif(excluded.status, ''), follow_snapshots.status),
        page_count = max(follow_snapshots.page_count, excluded.page_count),
        result_count = max(follow_snapshots.result_count, excluded.result_count),
        started_at = min(follow_snapshots.started_at, excluded.started_at),
        completed_at = max(follow_snapshots.completed_at, excluded.completed_at),
        raw_meta_json = case
          when excluded.raw_meta_json not in ('', '{}', 'null') then excluded.raw_meta_json
          else follow_snapshots.raw_meta_json
        end
      `,
					followSnapshots,
					[
						"id",
						"account_id",
						"direction",
						"source",
						"status",
						"page_count",
						"result_count",
						"started_at",
						"completed_at",
						"raw_meta_json",
					],
				);
				insertRows(
					db,
					`
      insert into follow_snapshot_members (
        snapshot_id, profile_id, external_user_id, position
      ) values (?, ?, ?, coalesce(?, 0))
      on conflict(snapshot_id, profile_id) do update set
        external_user_id = coalesce(nullif(excluded.external_user_id, ''), follow_snapshot_members.external_user_id),
        position = excluded.position
      `,
					followSnapshotMembers,
					["snapshot_id", "profile_id", "external_user_id", "position"],
				);
				insertRows(
					db,
					`
      insert into follow_edges (
        account_id, direction, profile_id, external_user_id, source, current,
        first_seen_at, last_seen_at, ended_at, updated_at
      ) values (?, ?, ?, ?, coalesce(?, 'backup'), coalesce(?, 1), ?, ?, ?, ?)
      on conflict(account_id, direction, profile_id) do update set
        external_user_id = coalesce(nullif(excluded.external_user_id, ''), follow_edges.external_user_id),
        source = coalesce(nullif(excluded.source, ''), follow_edges.source),
        current = case
          when excluded.updated_at >= follow_edges.updated_at then excluded.current
          else follow_edges.current
        end,
        first_seen_at = min(follow_edges.first_seen_at, excluded.first_seen_at),
        last_seen_at = max(follow_edges.last_seen_at, excluded.last_seen_at),
        ended_at = case
          when excluded.updated_at >= follow_edges.updated_at then excluded.ended_at
          else follow_edges.ended_at
        end,
        updated_at = max(follow_edges.updated_at, excluded.updated_at)
      `,
					followEdges,
					[
						"account_id",
						"direction",
						"profile_id",
						"external_user_id",
						"source",
						"current",
						"first_seen_at",
						"last_seen_at",
						"ended_at",
						"updated_at",
					],
				);
				insertRows(
					db,
					`
      insert into follow_events (
        id, account_id, direction, profile_id, external_user_id, kind, event_at,
        snapshot_id
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        account_id = coalesce(nullif(excluded.account_id, ''), follow_events.account_id),
        direction = coalesce(nullif(excluded.direction, ''), follow_events.direction),
        profile_id = coalesce(nullif(excluded.profile_id, ''), follow_events.profile_id),
        external_user_id = coalesce(nullif(excluded.external_user_id, ''), follow_events.external_user_id),
        kind = coalesce(nullif(excluded.kind, ''), follow_events.kind),
        event_at = coalesce(nullif(excluded.event_at, ''), follow_events.event_at),
        snapshot_id = coalesce(nullif(excluded.snapshot_id, ''), follow_events.snapshot_id)
      `,
					followEvents,
					[
						"id",
						"account_id",
						"direction",
						"profile_id",
						"external_user_id",
						"kind",
						"event_at",
						"snapshot_id",
					],
				);
				insertRows(
					db,
					`
      insert into tweets (
        id, account_id, author_profile_id, kind, text, created_at, is_replied,
        reply_to_id, like_count, media_count, bookmarked, liked, entities_json,
        media_json, quoted_tweet_id
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        account_id = coalesce(nullif(excluded.account_id, ''), tweets.account_id),
        author_profile_id = coalesce(nullif(excluded.author_profile_id, ''), tweets.author_profile_id),
        kind = case
          when tweets.kind in ('home', 'mention', 'authored', 'search') then tweets.kind
          when excluded.kind in ('home', 'mention', 'authored', 'search') then excluded.kind
          else coalesce(nullif(excluded.kind, ''), tweets.kind)
        end,
        text = coalesce(nullif(excluded.text, ''), tweets.text),
        created_at = min(tweets.created_at, excluded.created_at),
        is_replied = max(tweets.is_replied, excluded.is_replied),
        reply_to_id = coalesce(excluded.reply_to_id, tweets.reply_to_id),
        like_count = max(tweets.like_count, excluded.like_count),
        media_count = max(tweets.media_count, excluded.media_count),
        bookmarked = max(tweets.bookmarked, excluded.bookmarked),
        liked = max(tweets.liked, excluded.liked),
        entities_json = case
          when excluded.entities_json not in ('', '{}', 'null') then excluded.entities_json
          else tweets.entities_json
        end,
        media_json = case
          when excluded.media_json not in ('', '[]', 'null') then excluded.media_json
          else tweets.media_json
        end,
        quoted_tweet_id = coalesce(excluded.quoted_tweet_id, tweets.quoted_tweet_id)
      `,
					sanitizedTweets,
					[
						"id",
						"account_id",
						"author_profile_id",
						"kind",
						"text",
						"created_at",
						"is_replied",
						"reply_to_id",
						"like_count",
						"media_count",
						"bookmarked",
						"liked",
						"entities_json",
						"media_json",
						"quoted_tweet_id",
					],
				);
				insertFtsRows(
					db,
					"tweets_fts",
					"tweet_id",
					sanitizedTweets,
					"id",
					"text",
					tweetFtsIds,
				);
				insertRows(
					db,
					`
      insert into tweet_collections (
        account_id, tweet_id, kind, collected_at, source, raw_json, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?)
      on conflict(account_id, tweet_id, kind) do update set
        collected_at = coalesce(tweet_collections.collected_at, excluded.collected_at),
        source = coalesce(nullif(excluded.source, ''), tweet_collections.source),
        raw_json = case
          when excluded.raw_json not in ('', '{}', 'null') then excluded.raw_json
          else tweet_collections.raw_json
        end,
        updated_at = max(tweet_collections.updated_at, excluded.updated_at)
      `,
					collections,
					[
						"account_id",
						"tweet_id",
						"kind",
						"collected_at",
						"source",
						"raw_json",
						"updated_at",
					],
				);
				insertRows(
					db,
					`
      insert into tweet_account_edges (
        account_id, tweet_id, kind, first_seen_at, last_seen_at, seen_count,
        source, raw_json, updated_at
      ) values (?, ?, ?, ?, ?, coalesce(?, 1), coalesce(?, 'backup'), coalesce(?, '{}'), ?)
      on conflict(account_id, tweet_id, kind) do update set
        first_seen_at = min(tweet_account_edges.first_seen_at, excluded.first_seen_at),
        last_seen_at = max(tweet_account_edges.last_seen_at, excluded.last_seen_at),
        seen_count = max(tweet_account_edges.seen_count, excluded.seen_count),
        source = coalesce(nullif(excluded.source, ''), tweet_account_edges.source),
        raw_json = case
          when excluded.raw_json not in ('', '{}', 'null') then excluded.raw_json
          else tweet_account_edges.raw_json
        end,
        updated_at = max(tweet_account_edges.updated_at, excluded.updated_at)
      `,
					timelineEdges,
					[
						"account_id",
						"tweet_id",
						"kind",
						"first_seen_at",
						"last_seen_at",
						"seen_count",
						"source",
						"raw_json",
						"updated_at",
					],
				);
				insertRows(
					db,
					`
      insert into dm_conversations (
        id, account_id, participant_profile_id, title, inbox_kind, last_message_at, unread_count, needs_reply
      ) values (?, ?, ?, ?, coalesce(?, 'accepted'), ?, ?, ?)
      on conflict(id) do update set
        account_id = coalesce(nullif(excluded.account_id, ''), dm_conversations.account_id),
        participant_profile_id = coalesce(nullif(excluded.participant_profile_id, ''), dm_conversations.participant_profile_id),
        title = coalesce(nullif(excluded.title, ''), dm_conversations.title),
        inbox_kind = case
          when excluded.last_message_at > dm_conversations.last_message_at
            then coalesce(nullif(excluded.inbox_kind, ''), dm_conversations.inbox_kind)
          else dm_conversations.inbox_kind
        end,
        last_message_at = max(dm_conversations.last_message_at, excluded.last_message_at),
        unread_count = max(dm_conversations.unread_count, excluded.unread_count),
        needs_reply = max(dm_conversations.needs_reply, excluded.needs_reply)
      `,
					conversations,
					[
						"id",
						"account_id",
						"participant_profile_id",
						"title",
						"inbox_kind",
						"last_message_at",
						"unread_count",
						"needs_reply",
					],
				);
				insertRows(
					db,
					`
      insert into dm_messages (
        id, conversation_id, sender_profile_id, text, created_at, direction, is_replied, media_count
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        conversation_id = coalesce(nullif(excluded.conversation_id, ''), dm_messages.conversation_id),
        sender_profile_id = coalesce(nullif(excluded.sender_profile_id, ''), dm_messages.sender_profile_id),
        text = coalesce(nullif(excluded.text, ''), dm_messages.text),
        created_at = min(dm_messages.created_at, excluded.created_at),
        direction = coalesce(nullif(excluded.direction, ''), dm_messages.direction),
        is_replied = max(dm_messages.is_replied, excluded.is_replied),
        media_count = max(dm_messages.media_count, excluded.media_count)
      `,
					messages,
					[
						"id",
						"conversation_id",
						"sender_profile_id",
						"text",
						"created_at",
						"direction",
						"is_replied",
						"media_count",
					],
				);
				insertFtsRows(
					db,
					"dm_fts",
					"message_id",
					messages,
					"id",
					"text",
					dmFtsIds,
				);
				insertRows(
					db,
					`
      insert into url_expansions (
        short_url, expanded_url, final_url, status, expanded_tweet_id,
        expanded_handle, title, description, image_url, site_name, error, source,
        updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(short_url) do update set
        expanded_url = excluded.expanded_url,
        final_url = excluded.final_url,
        status = excluded.status,
        expanded_tweet_id = excluded.expanded_tweet_id,
        expanded_handle = excluded.expanded_handle,
        title = excluded.title,
        description = excluded.description,
        image_url = excluded.image_url,
        site_name = excluded.site_name,
        error = excluded.error,
        source = excluded.source,
        updated_at = excluded.updated_at
      `,
					sanitizedUrlExpansions,
					[
						"short_url",
						"expanded_url",
						"final_url",
						"status",
						"expanded_tweet_id",
						"expanded_handle",
						"title",
						"description",
						"image_url",
						"site_name",
						"error",
						"source",
						"updated_at",
					],
				);
				insertRows(
					db,
					`
      insert into link_occurrences (
        source_kind, source_id, source_position, short_url, account_id,
        conversation_id, direction, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(source_kind, source_id, source_position, short_url) do update set
        account_id = excluded.account_id,
        conversation_id = excluded.conversation_id,
        direction = excluded.direction,
        created_at = excluded.created_at
      `,
					linkOccurrences,
					[
						"source_kind",
						"source_id",
						"source_position",
						"short_url",
						"account_id",
						"conversation_id",
						"direction",
						"created_at",
					],
				);
				insertRows(
					db,
					`
      insert into blocks (account_id, profile_id, source, created_at)
      values (?, ?, ?, ?)
      on conflict(account_id, profile_id) do update set
        source = coalesce(nullif(excluded.source, ''), blocks.source),
        created_at = min(blocks.created_at, excluded.created_at)
      `,
					blocks,
					["account_id", "profile_id", "source", "created_at"],
				);
				insertRows(
					db,
					`
      insert into mutes (account_id, profile_id, source, created_at)
      values (?, ?, ?, ?)
      on conflict(account_id, profile_id) do update set
        source = coalesce(nullif(excluded.source, ''), mutes.source),
        created_at = min(mutes.created_at, excluded.created_at)
      `,
					mutes,
					["account_id", "profile_id", "source", "created_at"],
				);
				insertRows(
					db,
					`
      insert into tweet_actions (id, account_id, tweet_id, kind, body, created_at)
      values (?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        account_id = coalesce(nullif(excluded.account_id, ''), tweet_actions.account_id),
        tweet_id = coalesce(excluded.tweet_id, tweet_actions.tweet_id),
        kind = coalesce(nullif(excluded.kind, ''), tweet_actions.kind),
        body = coalesce(nullif(excluded.body, ''), tweet_actions.body),
        created_at = min(tweet_actions.created_at, excluded.created_at)
      `,
					actions,
					["id", "account_id", "tweet_id", "kind", "body", "created_at"],
				);
				insertRows(
					db,
					`
      insert into ai_scores (
        entity_kind, entity_id, model, score, summary, reasoning, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?)
      on conflict(entity_kind, entity_id) do update set
        model = coalesce(nullif(excluded.model, ''), ai_scores.model),
        score = max(ai_scores.score, excluded.score),
        summary = coalesce(nullif(excluded.summary, ''), ai_scores.summary),
        reasoning = coalesce(nullif(excluded.reasoning, ''), ai_scores.reasoning),
        updated_at = max(ai_scores.updated_at, excluded.updated_at)
      `,
					scores,
					[
						"entity_kind",
						"entity_id",
						"model",
						"score",
						"summary",
						"reasoning",
						"updated_at",
					],
				);
			})();
			return getBackupDatabaseFingerprint(db);
		});

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

export function updateBackupFromGit(
	options: UpdateBackupFromGitOptions,
): Promise<UpdateBackupFromGitResult> {
	return runEffectPromise(updateBackupFromGitEffect(options));
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

		const counts = computeCounts(files);
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
