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
import {
	buildClusterIndex,
	boundsContainFeature,
	compareClusterFeatures,
	featureMatchesSearch,
	getClusterDisplayAnchor,
	isCluster,
	CLUSTER_LEAF_SAMPLE_SIZE,
	WORLD_VIEWPORT,
	type MapViewport,
} from "./network-map-geometry";
import type { Database } from "./sqlite";

export const NETWORK_MAP_PAGE_SIZE = 160;
const MAX_MARKERS = 200;
const CLUSTER_PREVIEW_SIZE = 6;

type IndexedMap = {
	data: NetworkMapResponse;
	index: ReturnType<typeof buildClusterIndex>;
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
			data.features.sort(compareClusterFeatures);
			const index = buildClusterIndex(data.features);
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
		const viewport = options.viewport ?? WORLD_VIEWPORT;
		let zoom = Math.max(0, Math.min(18, Math.floor(viewport.zoom)));
		let clusters = index.getClusters(viewport.bounds, zoom);
		// Keep even wide, high-zoom requests bounded without dropping any profiles.
		while (clusters.length > MAX_MARKERS && zoom > 0)
			clusters = index.getClusters(viewport.bounds, --zoom);
		const markers: NetworkMapViewResponse["markers"] = clusters.map((item) => {
			if (!isCluster(item))
				return {
					kind: "profile",
					feature: data.features[item.properties.featureIndex],
				};
			const leaves = index
				.getLeaves(item.properties.cluster_id, CLUSTER_LEAF_SAMPLE_SIZE)
				.map((leaf) => data.features[leaf.properties.featureIndex])
				.sort(compareClusterFeatures);
			return {
				kind: "cluster",
				id: item.properties.cluster_id,
				coordinates: getClusterDisplayAnchor(
					leaves,
					item.geometry.coordinates as [number, number],
				),
				count: item.properties.point_count,
				expansionZoom: index.getClusterExpansionZoom(
					item.properties.cluster_id,
				),
				stats: {
					followers: item.properties.followers,
					following: item.properties.following,
					mutual: item.properties.mutual,
				},
				features: leaves.slice(0, CLUSTER_PREVIEW_SIZE),
			};
		});
		const matches = [];
		let visibleProfiles = 0;
		for (const feature of data.features) {
			if (!boundsContainFeature(viewport.bounds, feature)) continue;
			visibleProfiles++;
			if (featureMatchesSearch(feature, options.search ?? ""))
				matches.push(feature);
		}
		const requestedOffset = Math.max(0, Math.floor(options.offset ?? 0));
		const lastPageOffset = Math.max(
			0,
			Math.floor((matches.length - 1) / NETWORK_MAP_PAGE_SIZE) *
				NETWORK_MAP_PAGE_SIZE,
		);
		const offset = Math.min(requestedOffset, lastPageOffset);
		return {
			meta: {
				...data.meta,
				geocodedThisRun: options.refresh ? data.meta.geocodedThisRun : 0,
			},
			config: { mapboxToken: getPublicMapboxToken() },
			markers,
			features: matches.slice(offset, offset + NETWORK_MAP_PAGE_SIZE),
			visibleProfiles,
			matchingProfiles: matches.length,
			offset,
			pageSize: NETWORK_MAP_PAGE_SIZE,
		} satisfies NetworkMapViewResponse;
	});
}

export function getNetworkMapView(
	options: NetworkMapViewOptions = {},
	db = getNativeDb(),
) {
	return runEffectPromise(getNetworkMapViewEffect(options, db));
}
