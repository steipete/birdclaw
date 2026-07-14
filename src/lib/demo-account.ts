import { createHash } from "node:crypto";
import type { Database } from "./sqlite";

export const DEMO_PRIMARY_ACCOUNT = {
	id: "acct_primary",
	name: "Peter",
	handle: "@steipete",
	externalUserId: "25401953",
	transport: "xurl",
	isDefault: 1,
	createdAt: "2026-03-08T12:00:00.000Z",
} as const;

export const DEMO_PRIMARY_ACCOUNT_MARKER_KEY =
	"identity:demo-seed:acct_primary:v1";

export type StoredPrimaryAccount = {
	name: string;
	handle: string;
	external_user_id: string | null;
	transport: string;
	is_default: number;
	created_at: string;
};

type DemoAccountMarker = {
	version: 1;
	tableCounts: Record<string, number>;
	fingerprint: string;
};

function quoteIdentifier(value: string) {
	return `"${value.replaceAll('"', '""')}"`;
}

function getTrackedTableNames(db: Database) {
	return (
		db
			.prepare(
				`select name
				 from sqlite_master
				 where type = 'table'
				   and name not like 'sqlite_%'
				   and name not like 'tweets_fts%'
				   and name not like 'dm_fts%'
				   and name <> 'sync_cache'
				   and upper(coalesce(sql, '')) not like 'CREATE VIRTUAL TABLE%'
				 order by name`,
			)
			.all() as Array<{ name: string }>
	).map((row) => row.name);
}

function getTableCount(db: Database, table: string) {
	return (
		db
			.prepare(`select count(*) as count from ${quoteIdentifier(table)}`)
			.get() as { count: number }
	).count;
}

function getTableRows(db: Database, table: string) {
	const columns = db
		.prepare(`pragma table_info(${quoteIdentifier(table)})`)
		.all() as Array<{ name: string; pk: number }>;
	const primaryKey = columns
		.filter((column) => column.pk > 0)
		.sort((left, right) => left.pk - right.pk);
	const orderColumns = primaryKey.length > 0 ? primaryKey : columns;
	const orderBy = orderColumns
		.map((column) => quoteIdentifier(column.name))
		.join(", ");
	return db
		.prepare(
			`select * from ${quoteIdentifier(table)}${orderBy ? ` order by ${orderBy}` : ""}`,
		)
		.all();
}

function computeFingerprint(db: Database, tableNames: string[]) {
	const hash = createHash("sha256");
	for (const table of tableNames) {
		hash.update(table);
		hash.update("\0");
		hash.update(JSON.stringify(getTableRows(db, table)));
		hash.update("\0");
	}
	return hash.digest("hex");
}

export function createDemoPrimaryAccountMarkerValue(db: Database) {
	const tableNames = getTrackedTableNames(db);
	const tableCounts = Object.fromEntries(
		tableNames.map((table) => [table, getTableCount(db, table)]),
	);
	return JSON.stringify({
		version: 1,
		tableCounts,
		fingerprint: computeFingerprint(db, tableNames),
	} satisfies DemoAccountMarker);
}

export function hasUntouchedDemoPrimaryAccountState(
	db: Database,
	account: StoredPrimaryAccount | undefined,
) {
	if (!isUntouchedDemoPrimaryAccount(account)) return false;
	const row = db
		.prepare("select value_json from sync_cache where cache_key = ?")
		.get(DEMO_PRIMARY_ACCOUNT_MARKER_KEY) as { value_json: string } | undefined;
	if (!row) return false;

	let marker: DemoAccountMarker;
	try {
		marker = JSON.parse(row.value_json) as DemoAccountMarker;
	} catch {
		return false;
	}
	if (
		marker.version !== 1 ||
		!marker.tableCounts ||
		typeof marker.tableCounts !== "object" ||
		typeof marker.fingerprint !== "string"
	) {
		return false;
	}

	const tableNames = getTrackedTableNames(db);
	const markedTableNames = Object.keys(marker.tableCounts).sort();
	if (
		tableNames.length !== markedTableNames.length ||
		tableNames.some((table, index) => table !== markedTableNames[index])
	) {
		return false;
	}
	for (const table of tableNames) {
		if (getTableCount(db, table) !== marker.tableCounts[table]) return false;
	}
	return computeFingerprint(db, tableNames) === marker.fingerprint;
}

export function isUntouchedDemoPrimaryAccount(
	account: StoredPrimaryAccount | undefined,
) {
	return (
		account?.name === DEMO_PRIMARY_ACCOUNT.name &&
		account.handle === DEMO_PRIMARY_ACCOUNT.handle &&
		account.external_user_id === DEMO_PRIMARY_ACCOUNT.externalUserId &&
		account.transport === DEMO_PRIMARY_ACCOUNT.transport &&
		account.is_default === DEMO_PRIMARY_ACCOUNT.isDefault
	);
}
