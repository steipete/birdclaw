import { parseJsonObject } from "./json-codec";
import type { ProfileRecord } from "./types";

export type ProfileDbRow = Record<string, unknown>;

const PROFILE_COLUMNS = {
	id: "id",
	handle: "handle",
	displayName: "display_name",
	bio: "bio",
	followersCount: "followers_count",
	followingCount: "following_count",
	avatarHue: "avatar_hue",
	avatarUrl: "avatar_url",
	location: "location",
	url: "url",
	verifiedType: "verified_type",
	entities: "entities_json",
	createdAt: "created_at",
} as const;

export type ProfileSqlRow<Prefix extends string> = {
	[
		Key in keyof typeof PROFILE_COLUMNS as `${Prefix}${(typeof PROFILE_COLUMNS)[Key]}`
	]: Key extends "followersCount" | "followingCount" | "avatarHue"
		? number | null
		: string | null;
};

export function profileSelect(table: string, prefix: string, details = true) {
	return Object.values(PROFILE_COLUMNS)
		.filter(
			(column) =>
				details ||
				!["location", "url", "verified_type", "entities_json"].includes(column),
		)
		.map((column) => `${table}.${column} as ${prefix}${column}`)
		.join(", ");
}

function valueAt(
	row: ProfileDbRow,
	prefix: string,
	column: (typeof PROFILE_COLUMNS)[keyof typeof PROFILE_COLUMNS],
) {
	return row[`${prefix}${column}`];
}

function numberOrZero(value: unknown) {
	const number = Number(value ?? 0);
	return Number.isFinite(number) ? number : 0;
}

function nonEmptyString(value: unknown) {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function profileFromDbRow(
	row: ProfileDbRow,
	prefix = "",
): ProfileRecord {
	const followingCount = Number(
		valueAt(row, prefix, PROFILE_COLUMNS.followingCount) ?? 0,
	);
	const avatarUrl = nonEmptyString(
		valueAt(row, prefix, PROFILE_COLUMNS.avatarUrl),
	);
	const location = nonEmptyString(
		valueAt(row, prefix, PROFILE_COLUMNS.location),
	);
	const url = nonEmptyString(valueAt(row, prefix, PROFILE_COLUMNS.url));
	const verifiedType = nonEmptyString(
		valueAt(row, prefix, PROFILE_COLUMNS.verifiedType),
	);
	const entities = parseJsonObject(
		valueAt(row, prefix, PROFILE_COLUMNS.entities),
	);

	return {
		id: String(valueAt(row, prefix, PROFILE_COLUMNS.id) ?? ""),
		handle: String(valueAt(row, prefix, PROFILE_COLUMNS.handle) ?? ""),
		displayName: String(
			valueAt(row, prefix, PROFILE_COLUMNS.displayName) ?? "",
		),
		bio: String(valueAt(row, prefix, PROFILE_COLUMNS.bio) ?? ""),
		followersCount: numberOrZero(
			valueAt(row, prefix, PROFILE_COLUMNS.followersCount),
		),
		...(Number.isFinite(followingCount) ? { followingCount } : {}),
		avatarHue: numberOrZero(valueAt(row, prefix, PROFILE_COLUMNS.avatarHue)),
		...(avatarUrl ? { avatarUrl } : {}),
		...(location ? { location } : {}),
		...(url ? { url } : {}),
		...(verifiedType ? { verifiedType } : {}),
		...(entities ? { entities } : {}),
		createdAt: String(valueAt(row, prefix, PROFILE_COLUMNS.createdAt) ?? ""),
	};
}

export function nullableProfileFromDbRow(
	row: ProfileDbRow,
	prefix = "",
): ProfileRecord | null {
	const id = valueAt(row, prefix, PROFILE_COLUMNS.id);
	return id === null || id === undefined || id === ""
		? null
		: profileFromDbRow(row, prefix);
}

export function normalizeProfileHandle(value: string | null | undefined) {
	return value?.trim().replace(/^@/, "") ?? "";
}

export function profileHandleKey(value: string | null | undefined) {
	return normalizeProfileHandle(value).toLowerCase();
}

export function profileEntityUrls(
	profile: ProfileRecord,
	key: "url" | "description" = "description",
) {
	const block = profile.entities?.[key];
	if (!block || typeof block !== "object") return [];
	const entries = (block as { urls?: unknown }).urls;
	if (!Array.isArray(entries)) return [];
	return entries
		.map(getUrlEntityExpandedUrl)
		.filter((url): url is string => Boolean(url));
}

export function getUrlEntityExpandedUrl(entity: unknown) {
	if (!entity || typeof entity !== "object") return undefined;
	const record = entity as Record<string, unknown>;
	const expanded = record.expandedUrl ?? record.expanded_url ?? record.url;
	return typeof expanded === "string" && expanded.length > 0
		? expanded
		: undefined;
}
