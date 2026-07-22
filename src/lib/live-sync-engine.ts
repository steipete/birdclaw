import { Effect } from "effect";
import { findOperationAccount } from "./account-selection";
import { databaseWriteEffect } from "./database-writer";
import { toError } from "./effect-runtime";
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

export function redactSensitiveLogText(
	value: string,
	sensitiveValues: readonly string[] = [],
) {
	let redacted = value;
	for (const secret of sensitiveValues) {
		if (secret) redacted = redacted.replaceAll(secret, "[REDACTED]");
	}
	return redacted
		.replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
		.replace(
			/((?:authorization|cookie|auth[_-]?token|ct0)\s*[:=]\s*)\S+/gi,
			"$1[REDACTED]",
		);
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
		Effect.catchAll((error) => {
			const reason = toError(error);
			if (rest.length === 0) return Effect.fail(reason);
			console.error(
				`[${new Date().toISOString()}] live-sync transport-fallback source=${first.source} reason=${redactSensitiveLogText(reason.message)}`,
			);
			return fetchWithTransportFallbackEffect(rest);
		}),
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
