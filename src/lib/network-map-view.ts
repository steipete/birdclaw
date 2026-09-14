import { Effect } from "effect";
import { resolveOperationAccount } from "./account-selection";
import type {
	NetworkMapResponse,
	NetworkMapViewResponse,
} from "./api-contracts";
import { getNativeDb } from "./db";
import { isReadOnlyDeployment } from "./config";
import { runEffectPromise, tryPromise, trySync } from "./effect-runtime";
import {
	getNetworkMap,
	getPublicMapboxToken,
	hydrateMapFeatures,
	readMapIndexData,
	type NetworkMapKind,
} from "./network-map";
import { WORLD_VIEWPORT, type MapViewport } from "./network-map-geometry";
import { NetworkMapViewIndex } from "./network-map-view-index";
import type { Database } from "./sqlite";
import { readNetworkMapRevision } from "./network-map-revision";

type IndexedMap = {
	data: NetworkMapResponse;
	index: NetworkMapViewIndex;
};
type CachedMap = {
	db: Database;
	revision: string;
	key: string;
	pending: Promise<IndexedMap>;
};
const maps = new Map<Database["writeIdentity"], CachedMap>();
const MAX_CACHED_DATABASES = 2;
type ReadOnlyMap = {
	db: Database;
	revision: ReturnType<typeof readNetworkMapRevision>;
	expiresAt: string | null;
	asOf: string;
	key: string;
	meta: NetworkMapResponse["meta"];
	index: NetworkMapViewIndex;
};
const readOnlyMaps = new Map<Database["writeIdentity"], ReadOnlyMap>();

function revision(db: Database) {
	return `${db.pragma("data_version", { simple: true })}:${(db.prepare("select total_changes() as n").get() as { n: number }).n}`;
}

export interface NetworkMapViewOptions {
	account?: string;
	type?: NetworkMapKind;
	viewport?: MapViewport;
	search?: string;
	offset?: number;
	refresh?: boolean;
	geocodeLimit?: number;
	signal?: AbortSignal;
}

function readOnlyView(
	options: NetworkMapViewOptions,
	db: Database,
): NetworkMapViewResponse {
	const identity = db.writeIdentity;
	const cached = options.refresh ? undefined : readOnlyMaps.get(identity);
	// Closed pool owners cannot validate or hydrate their index.
	let owner = cached?.db ?? db;
	try {
		owner.pragma("data_version", { simple: true });
	} catch {
		readOnlyMaps.delete(identity);
		owner = db;
	}
	return owner.readTransaction(() => {
		// A real table read pins validation, index construction and hydration to one snapshot.
		const account = resolveOperationAccount(options.account, owner);
		const key = `${account.id}:${options.type ?? "all"}`;
		const currentRevision = readNetworkMapRevision(owner);
		const now = new Date().toISOString();
		let entry =
			cached?.db === owner &&
			cached.key === key &&
			cached.revision.geometry === currentRevision.geometry &&
			cached.revision.localChanges === currentRevision.localChanges &&
			cached.asOf <= now &&
			(cached.expiresAt === null || cached.expiresAt > now)
				? cached
				: undefined;
		if (!entry) {
			const data = readMapIndexData(account.id, options.type ?? "all", owner);
			entry = {
				db: owner,
				key,
				revision: currentRevision,
				meta: data.meta,
				expiresAt: data.expiresAt,
				asOf: data.asOf,
				index: new NetworkMapViewIndex(data.features, (features) =>
					hydrateMapFeatures(features, owner),
				),
			};
		} else if (entry.revision.details !== currentRevision.details) {
			entry.index.clearProfileCache();
			entry.revision = currentRevision;
		}
		const view = entry.index.read(
			options.viewport ?? WORLD_VIEWPORT,
			options.search ?? "",
			options.offset ?? 0,
		);
		if (!options.refresh) {
			readOnlyMaps.delete(identity);
			readOnlyMaps.set(identity, entry);
			while (readOnlyMaps.size > MAX_CACHED_DATABASES)
				readOnlyMaps.delete(readOnlyMaps.keys().next().value!);
		}
		return {
			meta: entry.meta,
			config: { mapboxToken: getPublicMapboxToken() },
			...view,
		};
	})();
}

function readIndexedMap(options: NetworkMapViewOptions, db: Database) {
	const account = resolveOperationAccount(options.account, db);
	const key = `${account.id}:${options.type ?? "all"}`;
	const identity = db.writeIdentity;
	const cached = maps.get(identity);
	if (!options.refresh && cached?.key === key) {
		try {
			// data_version is connection-local: validate through the index's owner.
			if (cached.revision === revision(cached.db)) return cached.pending;
		} catch {
			// A replaced read pool may have closed the connection that built this index.
			maps.delete(identity);
		}
	}
	const entry: CachedMap = {
		db,
		key,
		revision: revision(db),
		pending: getNetworkMap(
			{
				account: account.id,
				type: options.type,
				limit: null,
				geocodeLimit: options.refresh ? (options.geocodeLimit ?? 80) : 0,
				refresh: options.refresh,
				// Ordinary shared reads have no external work to cancel.
				signal: options.refresh ? options.signal : undefined,
			},
			db,
		).then((data) => {
			const index = new NetworkMapViewIndex(data.features);
			return { data, index };
		}),
	};
	// A slow explicit geocode refresh must never hold up ordinary map reads.
	if (!options.refresh) {
		maps.delete(identity);
		maps.set(identity, entry);
		while (maps.size > MAX_CACHED_DATABASES)
			maps.delete(maps.keys().next().value!);
	}
	void entry.pending.catch(() => {
		if (maps.get(identity) === entry) maps.delete(identity);
	});
	return entry.pending;
}

export function getNetworkMapViewEffect(
	options: NetworkMapViewOptions = {},
	db = getNativeDb(),
) {
	return Effect.gen(function* () {
		if (isReadOnlyDeployment())
			return yield* trySync(() => readOnlyView(options, db));
		const { data, index } = yield* tryPromise(() =>
			readIndexedMap(options, db),
		);
		return {
			meta: {
				...data.meta,
				geocodedThisRun: options.refresh ? data.meta.geocodedThisRun : 0,
			},
			config: { mapboxToken: getPublicMapboxToken() },
			...index.read(
				options.viewport ?? WORLD_VIEWPORT,
				options.search ?? "",
				options.offset ?? 0,
			),
		} satisfies NetworkMapViewResponse;
	});
}

export function getNetworkMapView(
	options: NetworkMapViewOptions = {},
	db = getNativeDb(),
) {
	return runEffectPromise(getNetworkMapViewEffect(options, db));
}
