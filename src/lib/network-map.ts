import { getNativeDb } from "./db";
import { isReadOnlyDeployment } from "./config";
import { resolveOperationAccount } from "./account-selection";
import type { NetworkMapResponse } from "./api-contracts";
import {
	geocodeLocation,
	GeocodeRateLimitError,
	getOpenCageApiKey,
	readCachedGeocodes,
	readSuppressedGeocodeKeys,
	readSuppressedGeocodes,
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

interface MapProfileRow {
	id: string;
	handle: string;
	display_name: string;
	followers_count: number;
	location: string | null;
	in_followers: number;
	in_following: number;
}

interface ProfileLocationRow extends MapProfileRow {
	following_count: number;
	avatar_url: string | null;
	verified_type: string | null;
}

export type MapIndexFeature = Omit<NetworkMapFeature, "properties"> & {
	properties: Omit<
		NetworkMapProfileProperties,
		"avatarUrl" | "followingCount" | "verified"
	>;
};

interface NetworkMapOptions {
	account?: string;
	type?: NetworkMapKind;
	limit?: number | null;
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

function networkRowsSql(type: NetworkMapKind, fullDetails: boolean) {
	// Following is usually much smaller than Followers; start with that direction's index.
	const membership =
		type === "following" || type === "mutual"
			? `
        select fe.profile_id, (other.profile_id is not null) as in_followers, 1 as in_following
        from follow_edges fe indexed by idx_follow_edges_current
        ${type === "mutual" ? "join" : "left join"} follow_edges other
          on other.account_id = fe.account_id and other.profile_id = fe.profile_id
          and other.direction = 'followers' and other.current = 1
        where fe.account_id = ? and fe.direction = 'following' and fe.current = 1
      `
			: `
        select profile_id,
          max(case when direction = 'followers' then 1 else 0 end) as in_followers,
          max(case when direction = 'following' then 1 else 0 end) as in_following
        from follow_edges fe
        where account_id = ? and current = 1
        group by profile_id
        ${type === "followers" ? "having max(case when fe.direction = 'followers' then 1 else 0 end) = 1" : ""}
      `;
	return `
      with membership as (${membership})
      select
        p.id,
        p.handle,
        p.display_name,
        p.followers_count,
        p.location,
        ${fullDetails ? "p.following_count, p.avatar_url, p.verified_type," : ""}
        fe.in_followers,
        fe.in_following
      from membership fe
      join profiles p on p.id = fe.profile_id
      ${fullDetails ? "order by p.followers_count desc, p.handle asc" : ""}
      limit ?
      `;
}

function collectLocations<Row extends MapProfileRow>(rows: Row[]) {
	const originalByKey = new Map<string, string>();
	const groups = new Map<string, Row[]>();
	const keys: string[] = [];
	const normalizedLocations = new Map<string, string>();
	let profilesWithLocation = 0;
	let meaningfulProfiles = 0;
	for (const row of rows) {
		const location = row.location;
		if (!location) continue;
		profilesWithLocation++;
		let key = normalizedLocations.get(location);
		if (key === undefined) {
			key = isMeaningfulLocation(location)
				? normalizeLocationKey(location)
				: "";
			normalizedLocations.set(location, key);
		}
		if (!key) continue;
		meaningfulProfiles++;
		const group = groups.get(key);
		if (group) group.push(row);
		else {
			groups.set(key, [row]);
			originalByKey.set(key, location);
			keys.push(key);
		}
	}
	return {
		keys,
		groups,
		originalByKey,
		profilesWithLocation,
		meaningfulProfiles,
	};
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
	if (isReadOnlyDeployment()) {
		return {
			cache,
			missingCount: keys.filter(
				(key) => !cache.has(key) && !suppressed.has(key),
			).length,
			suppressedCount: suppressed.size,
			geocoded: 0,
		};
	}
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
	const updatedCache =
		coordinateKeys.length || openCageKeys.length
			? readCachedGeocodes(keys, db)
			: cache;
	const updatedSuppressed =
		coordinateKeys.length || openCageKeys.length
			? readSuppressedGeocodeKeys(keys, db)
			: suppressed;
	return {
		cache: updatedCache,
		missingCount: keys.filter(
			(key) => !updatedCache.has(key) && !updatedSuppressed.has(key),
		).length,
		suppressedCount: updatedSuppressed.size,
		geocoded,
	};
}

function buildFeatures<Row extends MapProfileRow, Extra extends object>({
	groups,
	cache,
	details,
}: {
	groups: Map<string, Row[]>;
	cache: Map<string, GeocodeResult>;
	details: (row: Row) => Extra;
}) {
	const features: Array<MapIndexFeature & { properties: Extra }> = [];
	for (const [key, members] of groups) {
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
					location: row.location,
					resolvedLocation: geo.formatted ?? null,
					followersCount: Number(row.followers_count ?? 0),
					relationship: relationshipForRow(row),
					approxRadiusM: geo.approxRadiusM ?? null,
					...details(row),
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
	const limit =
		options.limit === null
			? -1
			: parseLimit(options.limit, DEFAULT_LIMIT, MAX_LIMIT);
	const geocodeLimit = parseLimit(
		options.geocodeLimit,
		DEFAULT_GEOCODE_LIMIT,
		MAX_GEOCODE_LIMIT,
		0,
	);
	const rows = db
		.prepare(networkRowsSql(type, true))
		.all(accountId, limit) as ProfileLocationRow[];
	const locations = collectLocations(rows);
	const geocodes = await fillMissingGeocodes({
		db,
		keys: locations.keys,
		originalByKey: locations.originalByKey,
		refresh: options.refresh === true,
		geocodeLimit,
		signal: options.signal,
	});
	const features = buildFeatures({
		groups: locations.groups,
		cache: geocodes.cache,
		details: profileDisplayProperties,
	});
	const token = getPublicMapboxToken();
	return {
		type: "FeatureCollection",
		features,
		meta: {
			accountId,
			type,
			totalProfiles: rows.length,
			profilesWithLocation: locations.profilesWithLocation,
			meaningfulProfiles: locations.meaningfulProfiles,
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

function profileDisplayProperties(
	row: Pick<
		ProfileLocationRow,
		"avatar_url" | "following_count" | "verified_type"
	>,
) {
	return {
		avatarUrl: row.avatar_url,
		followingCount: Number(row.following_count ?? 0),
		verified: row.verified_type && row.verified_type !== "none" ? true : null,
	};
}

// Called inside the read-only view's snapshot; geocoding remains on the full-map path.
export function readMapIndexData(
	accountId: string,
	type: NetworkMapKind,
	db: Database,
) {
	const rows = db
		.prepare(networkRowsSql(type, false))
		.all(accountId, -1) as MapProfileRow[];
	const locations = collectLocations(rows);
	const cache = readCachedGeocodes(locations.keys, db);
	const suppression = readSuppressedGeocodes(locations.keys, db);
	const suppressed = suppression.keys;
	// Recover the full-map order using only located groups, avoiding a SQLite sort
	// of every network member. BINARY text order also preserves Unicode/tied handles.
	const compareRows = (a: MapProfileRow, b: MapProfileRow) =>
		b.followers_count - a.followers_count ||
		compareSqliteText(a.handle, b.handle);
	const groups = [...locations.groups].filter(([key]) => cache.has(key));
	for (const [, members] of groups) members.sort(compareRows);
	groups.sort((a, b) => compareRows(a[1][0], b[1][0]));
	const features = buildFeatures({
		groups: new Map(groups),
		cache,
		details: () => ({}),
	});
	return {
		features,
		expiresAt: suppression.expiresAt,
		asOf: suppression.asOf,
		meta: {
			accountId,
			type,
			totalProfiles: rows.length,
			profilesWithLocation: locations.profilesWithLocation,
			meaningfulProfiles: locations.meaningfulProfiles,
			locatedProfiles: features.length,
			missingGeocodes: locations.keys.filter(
				(key) => !cache.has(key) && !suppressed.has(key),
			).length,
			geocodedThisRun: 0,
			suppressedGeocodes: suppressed.size,
			opencageConfigured: Boolean(getOpenCageApiKey()),
			mapboxTokenConfigured: Boolean(getPublicMapboxToken()),
		},
	};
}

function compareSqliteText(a: string, b: string) {
	// UTF-8 BINARY order follows code points, unlike JS's UTF-16 string comparison.
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		if (a.charCodeAt(i) !== b.charCodeAt(i))
			return a.codePointAt(i)! - b.codePointAt(i)!;
	}
	return a.length - b.length;
}

export function hydrateMapFeatures(
	features: MapIndexFeature[],
	db: Database,
): NetworkMapFeature[] {
	if (!features.length) return [];
	const rows = db
		.prepare(`
		select id, avatar_url, following_count, verified_type from profiles
		where id in (select value from json_each(?))
	`)
		.all(
			JSON.stringify(features.map((feature) => feature.properties.profileId)),
		) as Array<
		Pick<
			ProfileLocationRow,
			"id" | "avatar_url" | "following_count" | "verified_type"
		>
	>;
	const byId = new Map(rows.map((row) => [row.id, row]));
	return features.map((feature) => {
		const row = byId.get(feature.properties.profileId);
		if (!row) throw new Error("Map profile missing from its database snapshot");
		return {
			...feature,
			properties: { ...feature.properties, ...profileDisplayProperties(row) },
		};
	});
}
