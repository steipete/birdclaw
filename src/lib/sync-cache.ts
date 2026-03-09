import { getNativeDb } from "./db";

export interface SyncCacheEntry<T> {
	value: T;
	updatedAt: string;
}

function readSyncCacheRow(cacheKey: string, db = getNativeDb()) {
	return db
		.prepare(
			`
      select value_json, updated_at
      from sync_cache
      where cache_key = ?
      `,
		)
		.get(cacheKey) as
		| {
				value_json: string;
				updated_at: string;
		  }
		| undefined;
}

export function readSyncCache<T>(
	cacheKey: string,
	db = getNativeDb(),
): SyncCacheEntry<T> | null {
	const row = readSyncCacheRow(cacheKey, db);
	if (!row) {
		return null;
	}

	try {
		return {
			value: JSON.parse(row.value_json) as T,
			updatedAt: row.updated_at,
		};
	} catch {
		return null;
	}
}

export function writeSyncCache(
	cacheKey: string,
	value: unknown,
	db = getNativeDb(),
) {
	const updatedAt = new Date().toISOString();
	db.prepare(
		`
    insert into sync_cache (cache_key, value_json, updated_at)
    values (?, ?, ?)
    on conflict(cache_key) do update set
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
    `,
	).run(cacheKey, JSON.stringify(value), updatedAt);

	return updatedAt;
}

export function deleteSyncCache(cacheKey: string, db = getNativeDb()) {
	db.prepare("delete from sync_cache where cache_key = ?").run(cacheKey);
}
