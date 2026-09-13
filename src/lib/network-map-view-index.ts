import type { NetworkMapViewResponse } from "./api-contracts";
import {
	buildClusterIndex,
	compareClusterFeatures,
	createBoundsFilter,
	featureSearchText,
	getClusterDisplayAnchor,
	isCluster,
	CLUSTER_LEAF_SAMPLE_SIZE,
	type ClusterResult,
	type MapFeature,
	type MapViewport,
} from "./network-map-geometry";

const PAGE_SIZE = 160;
const MAX_MARKERS = 200;
const CLUSTER_PREVIEW_SIZE = 6;
const MAX_CACHED_VIEWS = 4;
const MAX_CACHED_CLUSTERS = 2_000;
type Marker = NetworkMapViewResponse["markers"][number];

type View = {
	markers: NetworkMapViewResponse["markers"];
	indices: number[];
	search: string;
	matches: number[];
};

export class NetworkMapViewIndex {
	private readonly index: ReturnType<typeof buildClusterIndex>;
	private readonly views = new Map<string, View>();
	private readonly markers = new Map<number, Marker>();
	private readonly searchTexts: Array<string | undefined> = [];

	constructor(private readonly features: MapFeature[]) {
		features.sort(compareClusterFeatures);
		this.index = buildClusterIndex(features);
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
		const contains = createBoundsFilter(viewport.bounds);
		const indices: number[] = [];
		for (let i = 0; i < this.features.length; i++)
			if (contains(this.features[i])) indices.push(i);
		const view = { markers, indices, search: "", matches: indices };
		this.views.set(key, view);
		if (this.views.size > MAX_CACHED_VIEWS)
			this.views.delete(this.views.keys().next().value!);
		return view;
	}

	private marker(item: ClusterResult): Marker {
		if (!isCluster(item))
			return {
				kind: "profile",
				feature: this.features[item.properties.featureIndex],
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
			.map((leaf) => this.features[leaf.properties.featureIndex])
			.sort(compareClusterFeatures);
		const marker: Marker = {
			kind: "cluster",
			id,
			coordinates: getClusterDisplayAnchor(
				leaves,
				item.geometry.coordinates as [number, number],
			),
			count: item.properties.point_count,
			expansionZoom: this.index.getClusterExpansionZoom(id),
			stats: {
				followers: item.properties.followers,
				following: item.properties.following,
				mutual: item.properties.mutual,
			},
			features: leaves.slice(0, CLUSTER_PREVIEW_SIZE),
		};
		this.markers.set(id, marker);
		if (this.markers.size > MAX_CACHED_CLUSTERS)
			this.markers.delete(this.markers.keys().next().value!);
		return marker;
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
		return {
			markers: view.markers,
			features: view.matches
				.slice(offset, offset + PAGE_SIZE)
				.map((i) => this.features[i]),
			visibleProfiles: view.indices.length,
			matchingProfiles: view.matches.length,
			offset,
			pageSize: PAGE_SIZE,
		};
	}
}
