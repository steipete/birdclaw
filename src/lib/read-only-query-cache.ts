import type { Database } from "./sqlite";

type Entry = { value: string; bytes: number };
type Snapshot = { version: number; entries: Map<string, Entry>; bytes: number };

/** Only deterministic reads on strict read-only database connections belong here. */
export class ReadOnlyQueryCache {
	private readonly snapshots = new WeakMap<Database, Snapshot>();
	constructor(
		private readonly limits = {
			entries: 100,
			bytes: 4 * 1024 * 1024,
			entryBytes: 512 * 1024,
			keyBytes: 4096,
		},
	) {}

	read(db: Database, key: string, produce: () => string): string {
		const keyBytes = Buffer.byteLength(key);
		if (keyBytes > this.limits.keyBytes) return produce();
		const version = Number(db.pragma("data_version", { simple: true }));
		let snapshot = this.snapshots.get(db);
		if (!snapshot || snapshot.version !== version) {
			snapshot = { version, entries: new Map(), bytes: 0 };
			this.snapshots.set(db, snapshot);
		}
		const hit = snapshot.entries.get(key);
		if (hit) {
			snapshot.entries.delete(key);
			snapshot.entries.set(key, hit);
			return hit.value;
		}
		const value = produce();
		const bytes = keyBytes + Buffer.byteLength(value);
		// A writer may commit while the synchronous reader is building its response.
		if (
			Number(db.pragma("data_version", { simple: true })) !== version ||
			bytes > this.limits.entryBytes ||
			bytes > this.limits.bytes
		)
			return value;
		while (
			snapshot.entries.size >= this.limits.entries ||
			snapshot.bytes + bytes > this.limits.bytes
		) {
			const oldest = snapshot.entries.keys().next().value;
			if (oldest === undefined) return value;
			snapshot.bytes -= snapshot.entries.get(oldest)!.bytes;
			snapshot.entries.delete(oldest);
		}
		snapshot.entries.set(key, { value, bytes });
		snapshot.bytes += bytes;
		return value;
	}
}
