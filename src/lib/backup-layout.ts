import { createHash } from "node:crypto";
import type { BackupJsonRecord, BackupJsonValue } from "./backup-table-codecs";

type Layout = {
	table: string;
	keys: string[];
	observations?: string[];
	partition: "tweet" | "profile";
	kinds?: string[];
};

// Physical layout only. Reassembled rows still use the existing database merge codecs.
const layouts: Record<string, Layout> = {
	profiles: { table: "profiles", keys: ["id"], partition: "profile" },
	profile_snapshots: {
		table: "profile_snapshots",
		keys: ["profile_id", "snapshot_hash"],
		observations: ["last_seen_at"],
		partition: "profile",
	},
	tweets: {
		table: "tweets",
		keys: ["id"],
		observations: ["like_count"],
		partition: "tweet",
	},
	tweet_revisions: {
		table: "tweet_revisions",
		keys: ["revision_id"],
		observations: ["observed_at"],
		partition: "tweet",
	},
	collections: {
		table: "tweet_collections",
		keys: ["account_id", "tweet_id", "kind"],
		observations: ["updated_at"],
		partition: "tweet",
		kinds: ["likes", "bookmarks", "unknown"],
	},
	timeline_edges: {
		table: "tweet_account_edges",
		keys: ["account_id", "tweet_id", "kind"],
		observations: ["last_seen_at", "updated_at", "seen_count"],
		partition: "tweet",
		kinds: ["home", "mention", "authored", "search", "unknown"],
	},
	dms: { table: "dm_messages", keys: ["id"], partition: "tweet" },
};
const byTable = new Map(
	Object.entries(layouts).map(([alias, layout]) => [
		layout.table,
		{ alias, ...layout },
	]),
);
const prefix = "data/v9/";

function bucket(value: BackupJsonValue | undefined) {
	return createHash("sha256")
		.update(String(value ?? ""))
		.digest("hex")
		.slice(0, 2);
}
function day(value: BackupJsonValue | undefined) {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value))
		return undefined;
	const time = Date.parse(value);
	return Number.isFinite(time)
		? new Date(time).toISOString().slice(0, 10)
		: undefined;
}
function key(row: BackupJsonRecord, layout: Layout) {
	return JSON.stringify(
		layout.keys.map((field) => {
			const value = row[field];
			if (typeof value !== "string" || !value)
				throw new Error(`Missing backup row key: ${layout.table}.${field}`);
			return value;
		}),
	);
}

export function partitionedBackupTable(table: string) {
	return byTable.has(table);
}

export function parseBackupLayoutPath(path: string) {
	if (!path.startsWith(prefix)) return undefined;
	const [alias, ...parts] = path.slice(prefix.length).split("/");
	const layout = layouts[alias ?? ""];
	const kind = layout?.kinds ? parts.shift() : undefined;
	const filename = parts[0] ?? "";
	const observation = filename.endsWith(".observations.jsonl");
	const partition = filename.replace(/(?:\.observations)?\.jsonl$/u, "");
	const validPartition = observation
		? /^(?:\d{4}-\d{2}-\d{2}|unknown)$/u.test(partition)
		: layout?.partition === "profile"
			? /^[a-f0-9]{2}$/u.test(partition)
			: /^(?:\d{4}-\d{2}-\d{2}|unknown-[a-f0-9]{2})$/u.test(partition);
	if (
		!layout ||
		parts.length !== 1 ||
		!filename.endsWith(".jsonl") ||
		!validPartition ||
		(layout.kinds && !layout.kinds.includes(kind ?? "")) ||
		(observation && !layout.observations)
	) {
		throw new Error(`Invalid schema-9 backup path: ${path}`);
	}
	return { ...layout, observation, kind };
}

export function buildPartitionedBackupShards(
	rowSets: ReadonlyArray<{ logicalName: string; rows: BackupJsonRecord[] }>,
) {
	const shards = new Map<string, BackupJsonRecord[]>();
	const tweets =
		rowSets.find((set) => set.logicalName === "tweets")?.rows ?? [];
	const revisions =
		rowSets.find((set) => set.logicalName === "tweet_revisions")?.rows ?? [];
	const dates = new Map(tweets.map((row) => [row.id, row.created_at]));
	const observed = new Map(
		revisions.map((row) => [row.revision_id, row.observed_at]),
	);
	const append = (path: string, row: BackupJsonRecord) => {
		const rows = shards.get(path) ?? [];
		rows.push(row);
		shards.set(path, rows);
	};
	for (const set of rowSets) {
		const layout = byTable.get(set.logicalName);
		if (!layout) continue;
		for (const row of set.rows) {
			key(row, layout);
			const id = row.tweet_id ?? row.revision_id ?? row.id;
			const partition =
				layout.partition === "profile"
					? bucket(row.profile_id ?? row.id)
					: (day(dates.get(id) ?? row.created_at) ?? `unknown-${bucket(id)}`);
			const kind = layout.kinds
				? `${layout.kinds.includes(String(row.kind)) ? row.kind : "unknown"}/`
				: "";
			const base = `${prefix}${layout.alias}/${kind}`;
			if (!layout.observations) {
				append(`${base}${partition}.jsonl`, row);
				continue;
			}
			const body: BackupJsonRecord = {},
				observation: BackupJsonRecord = {};
			for (const field of layout.keys) observation[field] = row[field];
			for (const [field, value] of Object.entries(row)) {
				(layout.observations.includes(field) ? observation : body)[field] =
					value;
			}
			const clock =
				row.last_seen_at ??
				row.updated_at ??
				row.observed_at ??
				observed.get(row.id) ??
				row.created_at;
			append(`${base}${partition}.jsonl`, body);
			append(
				`${base}${day(clock) ?? "unknown"}.observations.jsonl`,
				observation,
			);
		}
	}
	for (const [path, rows] of shards) {
		const layout = parseBackupLayoutPath(path)!;
		rows.sort((a, b) => {
			const left = key(a, layout),
				right = key(b, layout);
			return left < right ? -1 : left > right ? 1 : 0;
		});
	}
	return shards;
}

export function reassembleBackupRows(
	table: string,
	bodies: BackupJsonRecord[],
	observations: BackupJsonRecord[],
) {
	const layout = byTable.get(table);
	if (!layout) return bodies;
	const byKey = new Map<string, BackupJsonRecord>();
	for (const row of bodies) {
		const identity = key(row, layout);
		if (byKey.has(identity)) throw new Error(`Duplicate backup body: ${table}`);
		if (layout.observations?.some((field) => field in row))
			throw new Error(`Observation field in backup body: ${table}`);
		byKey.set(identity, { ...row });
	}
	if (!layout.observations) {
		if (observations.length)
			throw new Error(`Unexpected backup observations: ${table}`);
		return [...byKey.values()];
	}
	const seen = new Set<string>();
	for (const row of observations) {
		const identity = key(row, layout),
			body = byKey.get(identity);
		if (!body || seen.has(identity))
			throw new Error(`Orphan or duplicate backup observation: ${table}`);
		if (
			Object.keys(row).some(
				(field) =>
					!layout.keys.includes(field) && !layout.observations!.includes(field),
			) ||
			layout.observations.some((field) => !(field in row))
		)
			throw new Error(`Invalid backup observation fields: ${table}`);
		seen.add(identity);
		Object.assign(body, row);
	}
	if (seen.size !== byKey.size)
		throw new Error(`Missing backup observations: ${table}`);
	return [...byKey.values()];
}
