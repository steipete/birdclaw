import { Effect } from "effect";
import { resolveOperationAccount } from "./account-selection";
import type {
	NetworkMapResponse,
	NetworkMapViewResponse,
} from "./api-contracts";
import { getNativeDb } from "./db";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import {
	getNetworkMap,
	getPublicMapboxToken,
	type NetworkMapKind,
} from "./network-map";
import { WORLD_VIEWPORT, type MapViewport } from "./network-map-geometry";
import { NetworkMapViewIndex } from "./network-map-view-index";
import type { Database } from "./sqlite";

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
