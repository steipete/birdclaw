import type { MapIndexFeature } from "./network-map";
import {
	createBoundsFilter,
	normalizeMapBounds,
	type MapBounds,
} from "./network-map-geometry";

const CELL_DEGREES = 10;
const COLUMNS = 360 / CELL_DEGREES;
const column = (lng: number) =>
	Math.min(COLUMNS - 1, Math.floor((lng + 180) / CELL_DEGREES));
const row = (lat: number) => Math.floor((lat + 90) / CELL_DEGREES);

export class NetworkMapBoundsIndex {
	private readonly cells = new Map<number, number[]>();
	private readonly outliers: number[] = [];

	constructor(private readonly features: MapIndexFeature[]) {
		for (let i = 0; i < features.length; i++) {
			const [lng, lat] = features[i].geometry.coordinates;
			if (!(lat >= -85 && lat <= 85)) continue;
			if (!(lng >= -180 && lng <= 180)) {
				this.outliers.push(i);
				continue;
			}
			const key = row(lat) * COLUMNS + column(lng);
			const cell = this.cells.get(key);
			if (cell) cell.push(i);
			else this.cells.set(key, [i]);
		}
	}

	read(bounds: MapBounds) {
		const contains = createBoundsFilter(bounds);
		const {
			normalizedWest,
			normalizedEast,
			minLatitude,
			maxLatitude,
			allLongitudes,
			crossesAntimeridian,
		} = normalizeMapBounds(bounds);
		if (minLatitude > maxLatitude) return [];
		const ranges = allLongitudes
			? [[-180, 180]]
			: crossesAntimeridian
				? [
						[normalizedWest, 180],
						[-180, normalizedEast],
					]
				: [[normalizedWest, normalizedEast]];
		const selected = new Set<number>();
		const buckets = [this.outliers];
		let candidates = this.outliers.length;
		for (const [west, east] of ranges)
			for (let y = row(minLatitude); y <= row(maxLatitude); y++)
				for (let x = column(west); x <= column(east); x++) {
					const key = y * COLUMNS + x;
					if (selected.has(key)) continue;
					selected.add(key);
					const bucket = this.cells.get(key);
					if (bucket) {
						buckets.push(bucket);
						candidates += bucket.length;
					}
				}
		const indices: number[] = [];
		// Broad views are cheaper in existing rank order than gathering and re-sorting.
		if (candidates >= this.features.length / 2) {
			for (let i = 0; i < this.features.length; i++)
				if (contains(this.features[i])) indices.push(i);
		} else {
			for (const bucket of buckets)
				for (const i of bucket) if (contains(this.features[i])) indices.push(i);
			indices.sort((a, b) => a - b);
		}
		return indices;
	}
}
