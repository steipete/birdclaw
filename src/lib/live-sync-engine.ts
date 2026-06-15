import { Effect } from "effect";
import { databaseWriteEffect } from "./database-writer";
import type { Database } from "./sqlite";
import { readSyncCache, writeSyncCache } from "./sync-cache";

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

interface CachedLiveSyncOptions<Source extends string, Payload, Persisted> {
	db: Database;
	cacheKey: string;
	refresh: boolean;
	cacheTtlMs: number;
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

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

export function resolveLiveSyncAccount(
	db: Database,
	accountId?: string,
): LiveSyncAccount {
	const row = accountId
		? (db
				.prepare(
					"select id, handle, external_user_id, is_default from accounts where id = ?",
				)
				.get(accountId) as
				| {
						id: string;
						handle: string;
						external_user_id: string | null;
						is_default: number;
				  }
				| undefined)
		: (db
				.prepare(
					`
          select id, handle, external_user_id, is_default
          from accounts
          order by is_default desc, created_at asc
          limit 1
          `,
				)
				.get() as
				| {
						id: string;
						handle: string;
						external_user_id: string | null;
						is_default: number;
				  }
				| undefined);

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
	account: LiveSyncAccount;
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

export function normalizeCacheTtlMs(
	value: number | undefined,
	defaultValue: number,
) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return defaultValue;
	}
	return Math.floor(value);
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
	transports,
	persistLive,
	persistCached,
}: CachedLiveSyncOptions<Source, Payload, Persisted>): Effect.Effect<
	CachedLiveSyncResult<Source, Payload, Persisted>,
	Error
> {
	return Effect.gen(function* () {
		const cached = yield* Effect.try({
			try: () => readSyncCache<Payload>(cacheKey, db),
			catch: toError,
		});
		const cacheAgeMs = cached
			? Date.now() - new Date(cached.updatedAt).getTime()
			: Number.POSITIVE_INFINITY;
		if (!refresh && cached && cacheAgeMs <= cacheTtlMs) {
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
