import type { Database } from "./sqlite";
import { refreshSearchRows } from "./search-index";

export type ImportRow = Record<string, unknown>;

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

	refreshSearchRows(kind: "tweet" | "dm", rows: readonly ImportRow[]) {
		refreshSearchRows(
			this.db,
			kind,
			rows
				.map((row) => row.id)
				.filter((id): id is string => typeof id === "string"),
		);
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

	clearMentionSyncState(accountId: string) {
		const encodedAccountId = encodeURIComponent(accountId);
		const accountPattern = encodedAccountId.replace(/[\\%_]/g, "\\$&");
		this.db
			.prepare(`
				delete from sync_cache
				where cache_key = ?
				   or cache_key like ? escape '\\'
				   or cache_key like ? escape '\\'
				   or cache_key like ? escape '\\'
			`)
			.run(
				`mentions:sync:high-water:v1:mode=xurl:account=${encodedAccountId}`,
				`mentions:sync:cursor:v2:mode=xurl:account=${accountPattern}:page=%:boundary=%`,
				`mentions:sync:result:v2:mode=xurl:account=${accountPattern}:page=%:boundary=%`,
				`mentions:sync:result:v2:mode=bird:account=${accountPattern}:page=%:boundary=%`,
			);
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
	  delete from search_rows;
      delete from dm_messages;
      delete from dm_conversations;
	  delete from tweet_subordinate_tombstones;
	  delete from tweet_revision_edges;
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
