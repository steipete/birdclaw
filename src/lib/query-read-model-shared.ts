import type { ProfileRecord } from "./types";

export function toProfile(row: Record<string, unknown>): ProfileRecord {
	const followingCount = Number(row.following_count ?? 0);
	const entities = parseJsonField<Record<string, unknown> | undefined>(
		row.entities_json,
		undefined,
	);
	return {
		id: String(row.id),
		handle: String(row.handle),
		displayName: String(row.display_name),
		bio: String(row.bio),
		followersCount: Number(row.followers_count),
		...(Number.isFinite(followingCount) ? { followingCount } : {}),
		avatarHue: Number(row.avatar_hue),
		avatarUrl:
			typeof row.avatar_url === "string" ? String(row.avatar_url) : undefined,
		...(typeof row.location === "string" && row.location.length > 0
			? { location: row.location }
			: {}),
		...(typeof row.url === "string" && row.url.length > 0
			? { url: row.url }
			: {}),
		...(typeof row.verified_type === "string" && row.verified_type.length > 0
			? { verifiedType: row.verified_type }
			: {}),
		...(entities ? { entities } : {}),
		createdAt: String(row.created_at),
	};
}

export function parseJsonField<T>(value: unknown, fallback: T): T {
	if (typeof value !== "string" || value.length === 0) {
		return fallback;
	}

	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

export function toFtsSearchQuery(value: string) {
	const terms = value.match(/[\p{L}\p{N}_]+/gu) ?? [];
	return terms
		.map((term) => term.trim())
		.filter((term) => term.length > 0)
		.map((term) => `"${term.replaceAll('"', '""')}"`)
		.join(" ");
}
