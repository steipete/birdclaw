import { z } from "zod";
import { getNativeDb } from "./db";
import { parseJsonObject } from "./json-codec";
import { coordinatesFromLocationKey, normalizeLocationKey } from "./location";
import type { Database } from "./sqlite";

const OpenCageGeometrySchema = z.object({ lat: z.number(), lng: z.number() });
const OpenCageResultSchema = z.object({
	geometry: OpenCageGeometrySchema,
	confidence: z.number().int().min(0).max(10).optional(),
	formatted: z.string().optional(),
	components: z
		.object({ country_code: z.string().optional() })
		.loose()
		.optional(),
	bounds: z
		.object({
			northeast: OpenCageGeometrySchema.optional(),
			southwest: OpenCageGeometrySchema.optional(),
		})
		.optional(),
});
const OpenCageResponseSchema = z.object({
	results: z.array(OpenCageResultSchema),
	status: z.object({ code: z.number(), message: z.string() }).loose(),
});

export interface GeocodeResult {
	normalizedKey: string;
	original: string;
	lat: number;
	lng: number;
	formatted?: string;
	countryCode?: string;
	confidence?: number;
	provider: "opencage" | "coords";
	approxRadiusM?: number;
	bounds?: Record<string, unknown>;
	components?: Record<string, unknown>;
}

export class GeocodeRateLimitError extends Error {
	constructor() {
		super("opencage:429");
		this.name = "GeocodeRateLimitError";
	}
}

const SQLITE_IN_CHUNK_SIZE = 400;

export function getOpenCageApiKey() {
	return process.env.OPENCAGE_API_KEY?.trim() || null;
}

function approximateRadiusM(bounds: GeocodeResult["bounds"]) {
	const northeast = bounds?.northeast as
		| { lat?: unknown; lng?: unknown }
		| undefined;
	const southwest = bounds?.southwest as
		| { lat?: unknown; lng?: unknown }
		| undefined;
	if (
		typeof northeast?.lat !== "number" ||
		typeof northeast.lng !== "number" ||
		typeof southwest?.lat !== "number" ||
		typeof southwest.lng !== "number"
	) {
		return undefined;
	}
	const latMeters = Math.abs(northeast.lat - southwest.lat) * 111_320;
	const lngMeters =
		Math.abs(northeast.lng - southwest.lng) *
		Math.cos((((northeast.lat + southwest.lat) / 2) * Math.PI) / 180) *
		111_320;
	return Math.max(500, Math.min(120_000, Math.hypot(latMeters, lngMeters) / 2));
}

export function readCachedGeocodes(
	keys: readonly string[],
	db = getNativeDb(),
) {
	if (keys.length === 0) return new Map<string, GeocodeResult>();
	const rows: Array<Record<string, unknown>> = [];
	for (let index = 0; index < keys.length; index += SQLITE_IN_CHUNK_SIZE) {
		const chunk = keys.slice(index, index + SQLITE_IN_CHUNK_SIZE);
		const placeholders = chunk.map(() => "?").join(",");
		rows.push(
			...(db
				.prepare(
					`
          select normalized_key, original, lat, lng, formatted, country_code,
            confidence, provider, approx_radius_m, bounds_json, components_json
          from geocoded_locations
          where normalized_key in (${placeholders})
          `,
				)
				.all(...chunk) as Array<Record<string, unknown>>),
		);
	}
	const map = new Map<string, GeocodeResult>();
	for (const row of rows) {
		const key = String(row.normalized_key);
		map.set(key, {
			normalizedKey: key,
			original: String(row.original),
			lat: Number(row.lat),
			lng: Number(row.lng),
			formatted: typeof row.formatted === "string" ? row.formatted : undefined,
			countryCode:
				typeof row.country_code === "string" ? row.country_code : undefined,
			confidence:
				typeof row.confidence === "number" ? row.confidence : undefined,
			provider: row.provider === "coords" ? "coords" : "opencage",
			approxRadiusM:
				typeof row.approx_radius_m === "number"
					? row.approx_radius_m
					: undefined,
			bounds: parseJsonObject(row.bounds_json),
			components: parseJsonObject(row.components_json),
		});
	}
	return map;
}

export function readSuppressedGeocodeKeys(
	keys: readonly string[],
	db = getNativeDb(),
) {
	return readSuppressedGeocodes(keys, db).keys;
}

export function readSuppressedGeocodes(
	keys: readonly string[],
	db = getNativeDb(),
) {
	const now = new Date().toISOString();
	const rows: Array<{ normalized_key: string; ttl_until: string | null }> = [];
	for (let index = 0; index < keys.length; index += SQLITE_IN_CHUNK_SIZE) {
		const chunk = keys.slice(index, index + SQLITE_IN_CHUNK_SIZE);
		const placeholders = chunk.map(() => "?").join(",");
		rows.push(
			...(db
				.prepare(
					`
          select normalized_key, ttl_until
          from geocoded_locations_unresolved
          where normalized_key in (${placeholders})
            and (ttl_until is null or ttl_until > ?)
          `,
				)
				.all(...chunk, now) as typeof rows),
		);
	}
	let expiresAt: string | null = null;
	for (const row of rows)
		if (
			row.ttl_until !== null &&
			(expiresAt === null || row.ttl_until < expiresAt)
		)
			expiresAt = row.ttl_until;
	return {
		keys: new Set(rows.map((row) => row.normalized_key)),
		expiresAt,
		asOf: now,
	};
}

export function storeGeocode(result: GeocodeResult, db = getNativeDb()) {
	const now = new Date().toISOString();
	db.prepare(
		`
    insert into geocoded_locations (
      normalized_key, original, lat, lng, formatted, country_code, confidence,
      provider, approx_radius_m, bounds_json, components_json, hits, created_at,
      last_used_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    on conflict(normalized_key) do update set
      original = excluded.original,
      lat = excluded.lat,
      lng = excluded.lng,
      formatted = coalesce(excluded.formatted, geocoded_locations.formatted),
      country_code = coalesce(excluded.country_code, geocoded_locations.country_code),
      confidence = coalesce(excluded.confidence, geocoded_locations.confidence),
      provider = excluded.provider,
      approx_radius_m = coalesce(excluded.approx_radius_m, geocoded_locations.approx_radius_m),
      bounds_json = excluded.bounds_json,
      components_json = excluded.components_json,
      hits = geocoded_locations.hits + 1,
      last_used_at = excluded.last_used_at
    `,
	).run(
		result.normalizedKey,
		result.original,
		result.lat,
		result.lng,
		result.formatted ?? null,
		result.countryCode?.toUpperCase() ?? null,
		result.confidence ?? null,
		result.provider,
		result.approxRadiusM ?? null,
		JSON.stringify(result.bounds ?? {}),
		JSON.stringify(result.components ?? {}),
		now,
		now,
	);
	db.prepare(
		"delete from geocoded_locations_unresolved where normalized_key = ?",
	).run(result.normalizedKey);
}

export function storeUnresolvedGeocode(
	normalizedKey: string,
	original: string,
	reason: string,
	db: Database = getNativeDb(),
) {
	const now = new Date().toISOString();
	const ttl = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
	db.prepare(
		`
    insert into geocoded_locations_unresolved (
      normalized_key, original, reason, last_attempted_at, ttl_until
    ) values (?, ?, ?, ?, ?)
    on conflict(normalized_key) do update set
      original = excluded.original,
      reason = excluded.reason,
      last_attempted_at = excluded.last_attempted_at,
      ttl_until = excluded.ttl_until
    `,
	).run(normalizedKey, original, reason, now, ttl);
}

export async function geocodeLocation(
	original: string,
	db: Database = getNativeDb(),
	signal?: AbortSignal,
): Promise<GeocodeResult | null> {
	if (signal?.aborted) throw new Error("geocode aborted");
	const normalizedKey = normalizeLocationKey(original);
	if (!normalizedKey) return null;

	const coord = coordinatesFromLocationKey(normalizedKey);
	if (coord) {
		const result: GeocodeResult = {
			normalizedKey,
			original,
			lat: coord.lat,
			lng: coord.lng,
			formatted: original,
			provider: "coords",
			approxRadiusM: 500,
		};
		storeGeocode(result, db);
		return result;
	}

	const key = getOpenCageApiKey();
	if (!key) return null;

	const url = new URL("https://api.opencagedata.com/geocode/v1/json");
	url.searchParams.set("q", original);
	url.searchParams.set("key", key);
	url.searchParams.set("limit", "1");
	url.searchParams.set("no_annotations", "1");

	const response = await fetch(url, { signal });
	if (!response.ok) {
		if (response.status === 429) {
			throw new GeocodeRateLimitError();
		}
		storeUnresolvedGeocode(
			normalizedKey,
			original,
			`opencage:${String(response.status)}`,
			db,
		);
		return null;
	}
	const payload = OpenCageResponseSchema.parse(await response.json());
	const first = payload.results[0];
	if (!first) {
		storeUnresolvedGeocode(normalizedKey, original, "no-result", db);
		return null;
	}

	const bounds = first.bounds as Record<string, unknown> | undefined;
	const result: GeocodeResult = {
		normalizedKey,
		original,
		lat: first.geometry.lat,
		lng: first.geometry.lng,
		formatted: first.formatted,
		countryCode: first.components?.country_code?.toUpperCase(),
		confidence: first.confidence,
		provider: "opencage",
		approxRadiusM: approximateRadiusM(bounds),
		bounds,
		components: first.components as Record<string, unknown> | undefined,
	};
	storeGeocode(result, db);
	return result;
}
