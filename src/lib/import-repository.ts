import type { Database } from "./sqlite";

export type ImportRow = Record<string, unknown>;
export type ImportFtsTable =
	| { table: "tweets_fts"; idColumn: "tweet_id" }
	| { table: "dm_fts"; idColumn: "message_id" };

export class ImportRepository {
	constructor(readonly db: Database) {}

	readRows<T>(sql: string, ...parameters: unknown[]) {
		return this.db.prepare(sql).all(...parameters) as T[];
	}

	readRow<T>(sql: string, ...parameters: unknown[]) {
		return this.db.prepare(sql).get(...parameters) as T | undefined;
	}

	insertRows(sql: string, rows: readonly ImportRow[], keys: readonly string[]) {
		const statement = this.db.prepare(sql);
		for (const row of rows) {
			statement.run(...keys.map((key) => row[key] ?? null));
		}
	}

	readFtsIds({ table, idColumn }: ImportFtsTable) {
		const rows = this.db
			.prepare(`select ${idColumn} as id from ${table}`)
			.all() as { id: string }[];
		return new Set(rows.map((row) => row.id));
	}

	insertFtsRows({
		target,
		rows,
		idKey,
		textKey,
		existingIds = new Set<string>(),
	}: {
		target: ImportFtsTable;
		rows: readonly ImportRow[];
		idKey: string;
		textKey: string;
		existingIds?: Set<string>;
	}) {
		const statement = this.db.prepare(
			`insert into ${target.table} (${target.idColumn}, text) values (?, ?)`,
		);
		for (const row of rows) {
			const id = row[idKey];
			if (typeof id !== "string" || existingIds.has(id)) continue;
			if (
				(row.deleted_at !== undefined && row.deleted_at !== null) ||
				(row.superseded_at !== undefined && row.superseded_at !== null)
			) {
				continue;
			}
			const text = row[textKey];
			statement.run(id, typeof text === "string" ? text : "");
			existingIds.add(id);
		}
	}

	clearArchiveImport() {
		this.db.exec(`
      delete from ai_scores;
      delete from tweet_actions;
      delete from tweet_account_edges;
      delete from tweet_collections;
      delete from link_occurrences;
      delete from url_expansions;
      delete from dm_fts;
      delete from tweets_fts;
      delete from dm_messages;
      delete from dm_conversations;
	  delete from tweet_subordinate_tombstones;
	  delete from tweet_revisions;
      delete from tweets;
      delete from profiles;
      delete from accounts;
    `);
		this.clearAuthoredSyncCursors();
	}

	clearAuthoredSyncCursors(accountId?: string) {
		if (accountId) {
			this.db
				.prepare("delete from sync_cache where cache_key = ?")
				.run(`authored:xurl:${accountId}:cursor`);
			return;
		}
		this.db
			.prepare(
				"delete from sync_cache where cache_key like 'authored:xurl:%:cursor'",
			)
			.run();
	}

	clearMentionSyncState() {
		this.db
			.prepare("delete from sync_cache where cache_key like 'mentions:sync:%'")
			.run();
	}

	clearBackupImport() {
		this.db.exec(`
      delete from x_list_members;
      delete from x_lists;
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
	  delete from tweet_subordinate_tombstones;
	  delete from tweet_revisions;
      delete from tweets;
      delete from profile_bio_entities;
      delete from profile_snapshots;
      delete from profile_affiliations;
      delete from profiles;
      delete from accounts;
      delete from sync_cache;
    `);
	}
}

let repositories = new WeakMap<Database, ImportRepository>();

export function getImportRepository(db: Database) {
	const existing = repositories.get(db);
	if (existing) return existing;
	const repository = new ImportRepository(db);
	repositories.set(db, repository);
	return repository;
}

export function resetImportRepositoriesForTests() {
	repositories = new WeakMap();
}
