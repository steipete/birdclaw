import { getNativeDb } from "./db";
import {
	defaultServerRuntimeServices,
	type ServerRuntimeServices,
} from "./server-runtime-services";

export interface SyncCacheEntry<T> {
	value: T;
	updatedAt: string;
}

export interface SyncCacheInspection<T> {
	entry: SyncCacheEntry<T> | null;
	ageMs: number | null;
	fresh: boolean;
	ttlMs: number;
}

export interface SyncCachePolicy {
	ttlMs?: number;
	defaultTtlMs: number;
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

export function inspectSyncCache<T>(
	cacheKey: string,
	{ ttlMs, defaultTtlMs }: SyncCachePolicy,
	db = getNativeDb(),
	runtime: ServerRuntimeServices = defaultServerRuntimeServices,
): SyncCacheInspection<T> {
	const effectiveTtlMs =
		typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs >= 0
			? Math.floor(ttlMs)
			: defaultTtlMs;
	const entry = readSyncCache<T>(cacheKey, db);
	if (!entry) {
		return { entry: null, ageMs: null, fresh: false, ttlMs: effectiveTtlMs };
	}
	const updatedAtMs = new Date(entry.updatedAt).getTime();
	const ageMs = runtime.now().getTime() - updatedAtMs;
	return {
		entry,
		ageMs: Number.isFinite(ageMs) ? ageMs : null,
		fresh: Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= effectiveTtlMs,
		ttlMs: effectiveTtlMs,
	};
}

export function writeSyncCache(
	cacheKey: string,
	value: unknown,
	db = getNativeDb(),
	runtime: ServerRuntimeServices = defaultServerRuntimeServices,
) {
	const updatedAt = runtime.now().toISOString();
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
