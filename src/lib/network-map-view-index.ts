import type { NetworkMapViewResponse } from "./api-contracts";
import type { MapIndexFeature } from "./network-map";
import {
	buildClusterIndex,
	compareClusterFeatures,
	featureSearchText,
	getClusterDisplayAnchor,
	isCluster,
	CLUSTER_LEAF_SAMPLE_SIZE,
	type ClusterResult,
	type MapFeature,
	type MapViewport,
} from "./network-map-geometry";
import { NetworkMapBoundsIndex } from "./network-map-bounds-index";

const PAGE_SIZE = 160;
const MAX_MARKERS = 200;
const CLUSTER_PREVIEW_SIZE = 6;
const MAX_CACHED_VIEWS = 4;
const MAX_CACHED_CLUSTERS = 2_000;
const MAX_CACHED_PROFILES = 4_096;
type Marker = NetworkMapViewResponse["markers"][number];
type IndexedMarker =
	| { kind: "profile"; index: number }
	| (Omit<Extract<Marker, { kind: "cluster" }>, "features"> & {
			indices: number[];
	  });
type HydrateFeatures = (features: MapIndexFeature[]) => MapFeature[];

type View = {
	markers: IndexedMarker[];
	indices: number[];
	search: string;
	matches: number[];
};

export class NetworkMapViewIndex {
	private readonly index: ReturnType<typeof buildClusterIndex>;
	private readonly boundsIndex: NetworkMapBoundsIndex;
	private readonly views = new Map<string, View>();
	private readonly markers = new Map<number, IndexedMarker>();
	private readonly searchTexts: Array<string | undefined> = [];
	private readonly profiles = new Map<number, MapFeature>();
	private readonly features: MapIndexFeature[];
	private readonly hydrate?: HydrateFeatures;

	constructor(features: MapFeature[]);
	constructor(features: MapIndexFeature[], hydrate: HydrateFeatures);
	constructor(
		features: MapFeature[] | MapIndexFeature[],
		hydrate?: HydrateFeatures,
	) {
		this.features = features;
		this.hydrate = hydrate;
		features.sort(compareClusterFeatures);
		this.index = buildClusterIndex(features);
		this.boundsIndex = new NetworkMapBoundsIndex(features);
	}

	private view(viewport: MapViewport): View {
		let zoom = Math.max(0, Math.min(18, Math.floor(viewport.zoom)));
		const key = `${viewport.bounds.join(",")}:${zoom}`;
		const cached = this.views.get(key);
		if (cached) {
			this.views.delete(key);
			this.views.set(key, cached);
			return cached;
		}
		let clusters = this.index.getClusters(viewport.bounds, zoom);
		// Keep wide, high-zoom requests bounded without dropping profiles.
		while (clusters.length > MAX_MARKERS && zoom > 0)
			clusters = this.index.getClusters(viewport.bounds, --zoom);
		const markers = clusters.map((item) => this.marker(item));
		const indices = this.boundsIndex.read(viewport.bounds);
		const view = { markers, indices, search: "", matches: indices };
		this.views.set(key, view);
		if (this.views.size > MAX_CACHED_VIEWS)
			this.views.delete(this.views.keys().next().value!);
		return view;
	}

	private marker(item: ClusterResult): IndexedMarker {
		if (!isCluster(item))
			return {
				kind: "profile",
				index: item.properties.featureIndex,
			};
		const id = item.properties.cluster_id;
		const cached = this.markers.get(id);
		if (cached) {
			this.markers.delete(id);
			this.markers.set(id, cached);
			return cached;
		}
		const leaves = this.index
			.getLeaves(id, CLUSTER_LEAF_SAMPLE_SIZE)
			.map((leaf) => leaf.properties.featureIndex)
			.sort((a, b) =>
				compareClusterFeatures(this.features[a], this.features[b]),
			);
		const marker: IndexedMarker = {
			kind: "cluster",
			id,
			coordinates: getClusterDisplayAnchor(
				leaves.map((i) => this.features[i]),
				item.geometry.coordinates as [number, number],
			),
			count: item.properties.point_count,
			expansionZoom: this.index.getClusterExpansionZoom(id),
			stats: {
				followers: item.properties.followers,
				following: item.properties.following,
				mutual: item.properties.mutual,
			},
			indices: leaves.slice(0, CLUSTER_PREVIEW_SIZE),
		};
		this.markers.set(id, marker);
		if (this.markers.size > MAX_CACHED_CLUSTERS)
			this.markers.delete(this.markers.keys().next().value!);
		return marker;
	}

	private readProfiles(indices: Set<number>) {
		if (!this.hydrate)
			return { get: (i: number) => this.features[i] as MapFeature };
		const result = new Map<number, MapFeature>();
		const missing: number[] = [];
		for (const i of indices) {
			const cached = this.profiles.get(i);
			if (cached) {
				this.profiles.delete(i);
				this.profiles.set(i, cached);
				result.set(i, cached);
			} else missing.push(i);
		}
		const hydrated = missing.length
			? this.hydrate(missing.map((i) => this.features[i]))
			: [];
		for (let j = 0; j < missing.length; j++) {
			const i = missing[j];
			const feature = hydrated[j];
			result.set(i, feature);
			this.profiles.set(i, feature);
		}
		while (this.profiles.size > MAX_CACHED_PROFILES)
			this.profiles.delete(this.profiles.keys().next().value!);
		return result;
	}

	clearProfileCache() {
		this.profiles.clear();
	}

	read(viewport: MapViewport, search: string, requestedOffset: number) {
		const view = this.view(viewport);
		const needle = search.trim().toLowerCase();
		if (needle !== view.search) {
			// Extending a substring search can only remove matches from the previous result.
			const candidates = needle.includes(view.search)
				? view.matches
				: view.indices;
			view.matches = needle
				? candidates.filter((i) => {
						const text = (this.searchTexts[i] ??= featureSearchText(
							this.features[i],
						));
						return text.includes(needle);
					})
				: view.indices;
			view.search = needle;
		}
		const lastPageOffset = Math.max(
			0,
			Math.floor((view.matches.length - 1) / PAGE_SIZE) * PAGE_SIZE,
		);
		const offset = Math.min(
			Math.max(0, Math.floor(requestedOffset)),
			lastPageOffset,
		);
		const page = view.matches.slice(offset, offset + PAGE_SIZE);
		const needed = new Set(page);
		for (const marker of view.markers) {
			if (marker.kind === "profile") needed.add(marker.index);
			else for (const i of marker.indices) needed.add(i);
		}
		const profiles = this.readProfiles(needed);
		return {
			markers: view.markers.map((marker): Marker => {
				if (marker.kind === "profile")
					return { kind: "profile", feature: profiles.get(marker.index)! };
				const { indices, ...cluster } = marker;
				return { ...cluster, features: indices.map((i) => profiles.get(i)!) };
			}),
			features: page.map((i) => profiles.get(i)!),
			visibleProfiles: view.indices.length,
			matchingProfiles: view.matches.length,
			offset,
			pageSize: PAGE_SIZE,
		};
	}
}
