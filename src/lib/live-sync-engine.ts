import { Effect } from "effect";
import { findOperationAccount } from "./account-selection";
import { databaseWriteEffect } from "./database-writer";
import { toError } from "./effect-runtime";
import type { Database } from "./sqlite";
import { inspectSyncCache, writeSyncCache } from "./sync-cache";

export type LiveSyncMode = "auto" | "bird" | "xurl";

export interface LiveTransportAdapter<Source extends string, Payload> {
	source: Source;
	fetch: Effect.Effect<Payload, Error>;
}

export interface LiveSyncAccount {
	accountId: string;
	username: string;
	externalUserId?: string;
	isDefault: boolean;
}

export interface LiveAccountIdentity {
	accountId: string;
	username: string;
	externalUserId?: string;
	isDefault?: boolean;
}

interface CachedLiveSyncOptions<Source extends string, Payload, Persisted> {
	db: Database;
	cacheKey: string;
	refresh: boolean;
	cacheTtlMs?: number;
	defaultCacheTtlMs: number;
	transports: readonly LiveTransportAdapter<Source, Payload>[];
	persistLive: (db: Database, payload: Payload, source: Source) => Persisted;
	persistCached?: (db: Database, payload: Payload) => Persisted;
}

export interface CachedLiveSyncResult<
	Source extends string,
	Payload,
	Persisted,
> {
	source: Source | "cache";
	payload: Payload;
	persisted: Persisted | undefined;
}

export function resolveLiveSyncAccount(
	db: Database,
	accountId?: string,
): LiveSyncAccount {
	const selected = findOperationAccount(db, accountId);
	const row = selected
		? (db
				.prepare(
					"select id, handle, external_user_id, is_default from accounts where id = ?",
				)
				.get(selected.id) as
				| {
						id: string;
						handle: string;
						external_user_id: string | null;
						is_default: number;
				  }
				| undefined)
		: undefined;

	if (!row) {
		throw new Error(`Unknown account: ${accountId ?? "default"}`);
	}

	const externalUserId = row.external_user_id?.trim();
	return {
		accountId: row.id,
		username: row.handle.replace(/^@/, ""),
		...(externalUserId ? { externalUserId } : {}),
		isDefault: row.is_default === 1,
	};
}

export function createLiveTransportAdapter<Source extends string, Payload>(
	source: Source,
	fetch: Effect.Effect<Payload, unknown>,
): LiveTransportAdapter<Source, Payload> {
	return {
		source,
		fetch: fetch.pipe(Effect.mapError(toError)),
	};
}

export function assertLiveAccountMatches({
	source,
	account,
	liveUsername,
	liveExternalUserId,
}: {
	source: string;
	account: LiveAccountIdentity;
	liveUsername: string;
	liveExternalUserId?: string;
}) {
	if (
		account.externalUserId &&
		liveExternalUserId &&
		account.externalUserId === liveExternalUserId
	) {
		return;
	}
	if (account.externalUserId && liveExternalUserId) {
		throw new Error(
			`${source} is authenticated as user ${liveExternalUserId}; refusing to sync into ${account.accountId} (${account.externalUserId})`,
		);
	}
	if (liveUsername.toLowerCase() !== account.username.toLowerCase()) {
		throw new Error(
			`${source} is authenticated as @${liveUsername}; refusing to sync into ${account.accountId} (@${account.username})`,
		);
	}
}

export function parseLiveSyncMode(
	value: unknown,
	defaultMode: Exclude<LiveSyncMode, "auto">,
	options: { allowAuto: false },
): Exclude<LiveSyncMode, "auto">;
export function parseLiveSyncMode(
	value: unknown,
	defaultMode: LiveSyncMode,
	options?: { allowAuto?: true },
): LiveSyncMode;
export function parseLiveSyncMode(
	value: unknown,
	defaultMode: LiveSyncMode,
	{ allowAuto = true }: { allowAuto?: boolean } = {},
): LiveSyncMode {
	if (value === undefined) return defaultMode;
	if (value === "bird" || value === "xurl" || (allowAuto && value === "auto")) {
		return value;
	}
	throw new Error(
		allowAuto
			? "--mode must be auto, bird, or xurl"
			: "--mode must be bird or xurl",
	);
}

export function parseLivePageSize(
	value: number,
	{
		min = 1,
		max,
		name = "--limit",
		message,
	}: { min?: number; max?: number; name?: string; message?: string } = {},
) {
	if (
		!Number.isInteger(value) ||
		value < min ||
		(max !== undefined && value > max)
	) {
		if (message) throw new Error(message);
		throw new Error(
			max === undefined
				? `${name} must be at least ${String(min)}`
				: `${name} must be between ${String(min)} and ${String(max)}`,
		);
	}
	return value;
}

export function parseOptionalMaxPages(
	value: number | undefined,
	{ allowZero = false }: { allowZero?: boolean } = {},
) {
	if (value === undefined) return undefined;
	return parseLivePageSize(value, {
		min: allowZero ? 0 : 1,
		name: "--max-pages",
	});
}

export function parseOptionalPageDelayMs(
	value: number | undefined,
	name = "--delay-ms",
) {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`${name} must be a non-negative integer`);
	}
	return value;
}

export function fetchWithTransportFallbackEffect<
	Source extends string,
	Payload,
>(
	transports: readonly LiveTransportAdapter<Source, Payload>[],
): Effect.Effect<{ source: Source; payload: Payload }, Error> {
	const [first, ...rest] = transports;
	if (!first) {
		return Effect.fail(new Error("No live transport adapters configured"));
	}
	return first.fetch.pipe(
		Effect.map((payload) => ({ source: first.source, payload })),
		Effect.catchAll((error) =>
			rest.length > 0
				? fetchWithTransportFallbackEffect(rest)
				: Effect.fail(toError(error)),
		),
	);
}

export function runCachedLiveSyncEffect<
	Source extends string,
	Payload,
	Persisted,
>({
	db,
	cacheKey,
	refresh,
	cacheTtlMs,
	defaultCacheTtlMs,
	transports,
	persistLive,
	persistCached,
}: CachedLiveSyncOptions<Source, Payload, Persisted>): Effect.Effect<
	CachedLiveSyncResult<Source, Payload, Persisted>,
	Error
> {
	return Effect.gen(function* () {
		const cache = yield* Effect.try({
			try: () =>
				inspectSyncCache<Payload>(
					cacheKey,
					{ ttlMs: cacheTtlMs, defaultTtlMs: defaultCacheTtlMs },
					db,
				),
			catch: toError,
		});
		const cached = cache.entry;
		if (!refresh && cached && cache.fresh) {
			const persisted = persistCached
				? yield* databaseWriteEffect((writeDb) =>
						persistCached(writeDb, cached.value),
					)
				: undefined;
			return {
				source: "cache",
				payload: cached.value,
				persisted,
			};
		}

		const fetched = yield* fetchWithTransportFallbackEffect(transports);
		const persisted = yield* databaseWriteEffect((writeDb) => {
			const value = persistLive(writeDb, fetched.payload, fetched.source);
			writeSyncCache(cacheKey, fetched.payload, writeDb);
			return value;
		});
		return {
			source: fetched.source,
			payload: fetched.payload,
			persisted,
		};
	});
}
