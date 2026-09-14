import type * as GeoJSON from "geojson";
import Supercluster from "supercluster";
import type { NetworkMapResponse } from "./api-contracts";
import type { MapIndexFeature, NetworkMapKind } from "./network-map";

export type MapFeature = NetworkMapResponse["features"][number];
export type MapBounds = [number, number, number, number];

export interface ClusterPointProperties {
	featureIndex: number;
	relationship: MapFeature["properties"]["relationship"];
}

export interface ClusterAggregateProperties {
	followers: number;
	following: number;
	mutual: number;
}

export interface ClusterFeatureProperties extends ClusterAggregateProperties {
	cluster: true;
	cluster_id: number;
	point_count: number;
	point_count_abbreviated: string | number;
}

export type ClusterPointFeature = GeoJSON.Feature<
	GeoJSON.Point,
	ClusterPointProperties
>;
export type ClusterFeature = GeoJSON.Feature<
	GeoJSON.Point,
	ClusterFeatureProperties
>;
export type ClusterResult = ClusterPointFeature | ClusterFeature;
export type MapViewport = { bounds: MapBounds; zoom: number };
export type MapTarget = {
	getBounds: () => {
		getWest: () => number;
		getSouth: () => number;
		getEast: () => number;
		getNorth: () => number;
	};
	getZoom: () => number;
};

export type SelectedOverlay =
	| { kind: "profile"; feature: MapFeature }
	| {
			kind: "cluster";
			coordinates: [number, number];
			count: number;
			features: MapFeature[];
			stats: ClusterAggregateProperties;
	  };

export const CLUSTER_LEAF_SAMPLE_SIZE = 48;

export const MAP_TYPES: Array<{ value: NetworkMapKind; label: string }> = [
	{ value: "all", label: "All" },
	{ value: "followers", label: "Followers" },
	{ value: "following", label: "Following" },
	{ value: "mutual", label: "Mutual" },
];

export const WORLD_BOUNDS: MapBounds = [-180, -85, 180, 85];
export const WORLD_VIEWPORT: MapViewport = { bounds: WORLD_BOUNDS, zoom: 1.15 };

export function formatRelationship(
	value: MapFeature["properties"]["relationship"],
) {
	if (value === "mutual") return "mutual";
	if (value === "following") return "following";
	return "follower";
}

export function relationshipColor(
	relationship: MapFeature["properties"]["relationship"],
) {
	if (relationship === "mutual") return "#22c55e";
	if (relationship === "following") return "#f59e0b";
	return "#1d9bf0";
}

export function clusterGradient(stats: ClusterAggregateProperties) {
	const total = Math.max(1, stats.followers + stats.following + stats.mutual);
	const mutual = (stats.mutual / total) * 100;
	const following = mutual + (stats.following / total) * 100;
	return `conic-gradient(#22c55e 0 ${mutual}%, #f59e0b ${mutual}% ${following}%, #1d9bf0 ${following}% 100%)`;
}

export function buildClusterIndex(features: MapIndexFeature[]) {
	const points: ClusterPointFeature[] = features.map(
		(feature, featureIndex) => ({
			type: "Feature",
			geometry: feature.geometry,
			properties: {
				featureIndex,
				relationship: feature.properties.relationship,
			},
		}),
	);
	return new Supercluster<ClusterPointProperties, ClusterAggregateProperties>({
		maxZoom: 18,
		minPoints: 2,
		radius: 64,
		map: (props) => ({
			followers: props.relationship === "followers" ? 1 : 0,
			following: props.relationship === "following" ? 1 : 0,
			mutual: props.relationship === "mutual" ? 1 : 0,
		}),
		reduce: (accumulated, props) => {
			accumulated.followers += props.followers;
			accumulated.following += props.following;
			accumulated.mutual += props.mutual;
		},
	}).load(points);
}

export function isCluster(item: ClusterResult): item is ClusterFeature {
	return "cluster" in item.properties && item.properties.cluster === true;
}

export function compareClusterFeatures(a: MapIndexFeature, b: MapIndexFeature) {
	return (
		b.properties.followersCount - a.properties.followersCount ||
		a.properties.handle.localeCompare(b.properties.handle)
	);
}

export function getClusterDisplayAnchor(
	features: MapIndexFeature[],
	fallback: [number, number],
): [number, number] {
	const buckets = new Map<
		string,
		{ coordinates: [number, number]; count: number; followers: number }
	>();
	for (const feature of features) {
		const [lng, lat] = feature.geometry.coordinates;
		const key = `${lng.toFixed(4)},${lat.toFixed(4)}`;
		const existing = buckets.get(key);
		if (existing) {
			existing.count += 1;
			existing.followers += feature.properties.followersCount;
		} else {
			buckets.set(key, {
				coordinates: [lng, lat],
				count: 1,
				followers: feature.properties.followersCount,
			});
		}
	}
	const best = [...buckets.values()].sort(
		(a, b) => b.count - a.count || b.followers - a.followers,
	)[0];
	return best?.coordinates ?? fallback;
}

export function readViewport(target: unknown): MapViewport | null {
	if (!target || typeof target !== "object") return null;
	const map = target as Partial<MapTarget>;
	if (
		typeof map.getBounds !== "function" ||
		typeof map.getZoom !== "function"
	) {
		return null;
	}
	const bounds = map.getBounds();
	return {
		bounds: [
			bounds.getWest(),
			bounds.getSouth(),
			bounds.getEast(),
			bounds.getNorth(),
		],
		zoom: map.getZoom(),
	};
}

export function normalizeMapBounds(bounds: MapBounds) {
	const [west, south, east, north] = bounds;
	const normalizedWest = (((west % 360) + 540) % 360) - 180;
	const normalizedEast = (((east % 360) + 540) % 360) - 180;
	const minLatitude = Math.max(-85, south);
	const maxLatitude = Math.min(85, north);
	const allLongitudes = east - west >= 360;
	const crossesAntimeridian = normalizedWest > normalizedEast;
	return {
		normalizedWest,
		normalizedEast,
		minLatitude,
		maxLatitude,
		allLongitudes,
		crossesAntimeridian,
	};
}

export function createBoundsFilter(bounds: MapBounds) {
	const {
		normalizedWest,
		normalizedEast,
		minLatitude,
		maxLatitude,
		allLongitudes,
		crossesAntimeridian,
	} = normalizeMapBounds(bounds);
	return (feature: MapIndexFeature) => {
		const [lng, lat] = feature.geometry.coordinates;
		return (
			lat >= minLatitude &&
			lat <= maxLatitude &&
			(allLongitudes ||
				(crossesAntimeridian
					? lng >= normalizedWest || lng <= normalizedEast
					: lng >= normalizedWest && lng <= normalizedEast))
		);
	};
}

export function featureSearchText(feature: MapIndexFeature) {
	return [
		feature.properties.name,
		feature.properties.handle,
		feature.properties.location,
		feature.properties.resolvedLocation ?? "",
		formatRelationship(feature.properties.relationship),
	]
		.join(" ")
		.toLowerCase();
}
