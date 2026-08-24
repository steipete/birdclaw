import { getNativeDb } from "./db";
import { resolveOperationAccount } from "./account-selection";
import type { NetworkMapResponse } from "./api-contracts";
import {
	geocodeLocation,
	GeocodeRateLimitError,
	getOpenCageApiKey,
	readCachedGeocodes,
	readSuppressedGeocodeKeys,
	type GeocodeResult,
} from "./geocoding";
import { isMeaningfulLocation, normalizeLocationKey } from "./location";
import type { Database } from "./sqlite";

export type NetworkMapKind = "all" | "followers" | "following" | "mutual";

export interface NetworkMapProfileProperties {
	profileId: string;
	handle: string;
	name: string;
	avatarUrl: string | null;
	location: string;
	resolvedLocation: string | null;
	followersCount: number;
	followingCount: number;
	verified: boolean | null;
	relationship: "followers" | "following" | "mutual";
	approxRadiusM: number | null;
}

export interface NetworkMapFeature {
	type: "Feature";
	geometry: { type: "Point"; coordinates: [number, number] };
	properties: NetworkMapProfileProperties;
}

interface ProfileLocationRow {
	id: string;
	handle: string;
	display_name: string;
	followers_count: number;
	following_count: number;
	avatar_url: string | null;
	location: string | null;
	verified_type: string | null;
	in_followers: number;
	in_following: number;
}

interface NetworkMapOptions {
	account?: string;
	type?: NetworkMapKind;
	limit?: number;
	geocodeLimit?: number;
	refresh?: boolean;
	signal?: AbortSignal;
}

const DEFAULT_LIMIT = 10_000;
const MAX_LIMIT = 50_000;
const DEFAULT_GEOCODE_LIMIT = 80;
const MAX_GEOCODE_LIMIT = 500;
const OPENCAGE_REQUEST_DELAY_MS = 1100;

function abortableDelay(ms: number, signal?: AbortSignal) {
	if (signal?.aborted) return Promise.reject(new Error("geocode aborted"));
	return new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timeout);
			reject(new Error("geocode aborted"));
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function getPublicMapboxToken() {
	const token =
		process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN?.trim() ||
		process.env.BIRDCLAW_MAPBOX_ACCESS_TOKEN?.trim() ||
		null;
	return token?.startsWith("pk.") ? token : null;
}

function parseLimit(
	value: number | undefined,
	fallback: number,
	max: number,
	min = 1,
) {
	if (!Number.isFinite(value) || value === undefined || value < min)
		return fallback;
	return Math.min(max, Math.floor(value));
}

function relationshipForRow(
	row: Pick<ProfileLocationRow, "in_followers" | "in_following">,
) {
	if (row.in_followers && row.in_following) return "mutual";
	if (row.in_followers) return "followers";
	return "following";
}

function fetchNetworkRows({
	db,
	accountId,
	type,
	limit,
}: {
	db: Database;
	accountId: string;
	type: NetworkMapKind;
	limit: number;
}) {
	const having =
		type === "mutual"
			? "having max(case when fe.direction = 'followers' then 1 else 0 end) = 1 and max(case when fe.direction = 'following' then 1 else 0 end) = 1"
			: type === "followers"
				? "having max(case when fe.direction = 'followers' then 1 else 0 end) = 1"
				: type === "following"
					? "having max(case when fe.direction = 'following' then 1 else 0 end) = 1"
					: "";
	const rows = db
		.prepare(
			`
      select
        p.id,
        p.handle,
        p.display_name,
        p.followers_count,
        p.following_count,
        p.avatar_url,
        p.location,
        p.verified_type,
        max(case when fe.direction = 'followers' then 1 else 0 end) as in_followers,
        max(case when fe.direction = 'following' then 1 else 0 end) as in_following
      from follow_edges fe
      join profiles p on p.id = fe.profile_id
      where fe.account_id = ?
        and fe.current = 1
      group by p.id
      ${having}
      order by p.followers_count desc, p.handle asc
      limit ?
      `,
		)
		.all(accountId, limit) as ProfileLocationRow[];
	return rows;
}

function collectKeys(rows: ProfileLocationRow[]) {
	const originalByKey = new Map<string, string>();
	const keyByProfile = new Map<string, string>();
	const seen = new Set<string>();
	const keys: string[] = [];
	for (const row of rows) {
		const location = row.location;
		if (!location || !isMeaningfulLocation(location)) continue;
		const key = normalizeLocationKey(location);
		if (!key) continue;
		keyByProfile.set(row.id, key);
		if (!originalByKey.has(key)) originalByKey.set(key, location);
		if (!seen.has(key)) {
			seen.add(key);
			keys.push(key);
		}
	}
	return { keys, keyByProfile, originalByKey };
}

async function fillMissingGeocodes({
	db,
	keys,
	originalByKey,
	refresh,
	geocodeLimit,
	signal,
}: {
	db: Database;
	keys: string[];
	originalByKey: Map<string, string>;
	refresh: boolean;
	geocodeLimit: number;
	signal?: AbortSignal;
}) {
	const cache = readCachedGeocodes(keys, db);
	const suppressed = readSuppressedGeocodeKeys(keys, db);
	const coordinateKeys = keys.filter(
		(key) => key.startsWith("coords:") && (refresh || !cache.has(key)),
	);
	const uncachedKeys = keys.filter(
		(key) =>
			!key.startsWith("coords:") &&
			!cache.has(key) &&
			(refresh || !suppressed.has(key)),
	);
	const refreshKeys = refresh
		? keys.filter((key) => !key.startsWith("coords:") && cache.has(key))
		: [];
	const openCageKeys = getOpenCageApiKey()
		? [...uncachedKeys, ...refreshKeys].slice(0, geocodeLimit)
		: [];
	let geocoded = 0;
	for (const key of coordinateKeys) {
		if (signal?.aborted) break;
		const original = originalByKey.get(key);
		if (!original) continue;
		const result = await geocodeLocation(original, db, signal).catch(
			() => null,
		);
		if (result) geocoded += 1;
	}
	for (let index = 0; index < openCageKeys.length; index += 1) {
		if (signal?.aborted) break;
		const key = openCageKeys[index];
		if (!key) continue;
		if (index > 0) {
			await abortableDelay(OPENCAGE_REQUEST_DELAY_MS, signal).catch(() => null);
			if (signal?.aborted) break;
		}
		const original = originalByKey.get(key);
		if (!original) continue;
		try {
			const result = await geocodeLocation(original, db, signal);
			if (result) geocoded += 1;
		} catch (error) {
			if (signal?.aborted) break;
			if (error instanceof GeocodeRateLimitError) break;
		}
	}
	const updatedCache = readCachedGeocodes(keys, db);
	const updatedSuppressed = readSuppressedGeocodeKeys(keys, db);
	return {
		cache: updatedCache,
		missingCount: keys.filter(
			(key) => !updatedCache.has(key) && !updatedSuppressed.has(key),
		).length,
		suppressedCount: updatedSuppressed.size,
		geocoded,
	};
}

function buildFeatures({
	rows,
	keyByProfile,
	cache,
}: {
	rows: ProfileLocationRow[];
	keyByProfile: Map<string, string>;
	cache: Map<string, GeocodeResult>;
}) {
	const byKey = new Map<string, ProfileLocationRow[]>();
	for (const row of rows) {
		const key = keyByProfile.get(row.id);
		if (!key || !cache.has(key)) continue;
		const group = byKey.get(key);
		if (group) group.push(row);
		else byKey.set(key, [row]);
	}

	const features: NetworkMapFeature[] = [];
	for (const [key, members] of byKey) {
		const geo = cache.get(key);
		if (!geo) continue;
		for (let index = 0; index < members.length; index += 1) {
			const row = members[index];
			if (!row?.location) continue;
			features.push({
				type: "Feature",
				geometry: { type: "Point", coordinates: [geo.lng, geo.lat] },
				properties: {
					profileId: row.id,
					handle: row.handle,
					name: row.display_name,
					avatarUrl: row.avatar_url,
					location: row.location,
					resolvedLocation: geo.formatted ?? null,
					followersCount: Number(row.followers_count ?? 0),
					followingCount: Number(row.following_count ?? 0),
					verified:
						row.verified_type && row.verified_type !== "none" ? true : null,
					relationship: relationshipForRow(row),
					approxRadiusM: geo.approxRadiusM ?? null,
				},
			});
		}
	}
	return features;
}

export async function getNetworkMap(
	options: NetworkMapOptions = {},
	db = getNativeDb(),
): Promise<NetworkMapResponse> {
	const account = resolveOperationAccount(options.account, db);
	const accountId = account.id;
	const type = options.type ?? "all";
	const limit = parseLimit(options.limit, DEFAULT_LIMIT, MAX_LIMIT);
	const geocodeLimit = parseLimit(
		options.geocodeLimit,
		DEFAULT_GEOCODE_LIMIT,
		MAX_GEOCODE_LIMIT,
		0,
	);
	const rows = fetchNetworkRows({ db, accountId, type, limit });
	const rowsWithLocation = rows.filter((row) => row.location);
	const meaningfulRows = rowsWithLocation.filter((row) =>
		row.location ? isMeaningfulLocation(row.location) : false,
	);
	const { keys, keyByProfile, originalByKey } = collectKeys(meaningfulRows);
	const geocodes = await fillMissingGeocodes({
		db,
		keys,
		originalByKey,
		refresh: options.refresh === true,
		geocodeLimit,
		signal: options.signal,
	});
	const features = buildFeatures({
		rows: meaningfulRows,
		keyByProfile,
		cache: geocodes.cache,
	});
	const token = getPublicMapboxToken();
	return {
		type: "FeatureCollection",
		features,
		meta: {
			accountId,
			type,
			totalProfiles: rows.length,
			profilesWithLocation: rowsWithLocation.length,
			meaningfulProfiles: meaningfulRows.length,
			locatedProfiles: features.length,
			missingGeocodes: geocodes.missingCount,
			geocodedThisRun: geocodes.geocoded,
			suppressedGeocodes: geocodes.suppressedCount,
			opencageConfigured: Boolean(getOpenCageApiKey()),
			mapboxTokenConfigured: Boolean(token),
		},
		config: {
			mapboxToken: token,
		},
	};
}
