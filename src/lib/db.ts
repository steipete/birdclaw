import { DATABASE_MIGRATIONS } from "./database-schema";
import { existsSync } from "node:fs";
import NativeSqliteDatabase, {
	type Database,
	SQLITE_BUSY_TIMEOUT_MS,
} from "./sqlite";
import {
	ensureBirdclawDirs,
	getBirdclawPaths,
	isReadOnlyDeployment,
} from "./config";
import {
	getDatabaseSchemaVersion,
	runDatabaseMigrations,
} from "./database-migrations";
import { seedDemoData } from "./seed";
import {
	type DatabaseConnectionRole,
	recordDatabaseStatement,
	recordDatabaseBatch,
} from "./database-metrics";

let nativeDb: Database | undefined;
let readDbs: Database[] = [];
let readDbIndex = 0;
let demoSeedAttempted = false;

export interface InitDatabaseOptions {
	seedDemoData?: boolean;
}

function ensureDemoData(db: Database) {
	if (demoSeedAttempted) {
		return;
	}

	seedDemoData(db);
	demoSeedAttempted = true;
}

function shouldSeedDemoData(options: InitDatabaseOptions) {
	return (
		options.seedDemoData === true ||
		(options.seedDemoData === undefined &&
			process.env.BIRDCLAW_TEST_SEED_DEMO_DATA === "1")
	);
}

function initDatabase(options: InitDatabaseOptions = {}) {
	ensureBirdclawDirs();
	const seedDemo = shouldSeedDemoData(options);

	if (!nativeDb) {
		const { dbPath } = getBirdclawPaths();
		nativeDb = createDatabaseConnection(dbPath, "writer");
		nativeDb.exec(`
		  pragma journal_mode = wal;
		  pragma busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};
		  pragma foreign_keys = on;
		`);
		runDatabaseMigrations(nativeDb, DATABASE_MIGRATIONS);
		if (seedDemo) {
			ensureDemoData(nativeDb);
		}
	} else if (seedDemo) {
		ensureDemoData(nativeDb);
	}
}

function createDatabaseConnection(
	dbPath: string,
	role: DatabaseConnectionRole,
	options: { readonly?: boolean } = {},
) {
	return new NativeSqliteDatabase(dbPath, {
		...options,
		onBatch: recordDatabaseBatch,
		onStatement: (sql, durationMs) =>
			recordDatabaseStatement(role, sql, durationMs),
	});
}

function closeDatabaseIgnoringErrors(db: Database) {
	try {
		db.close();
	} catch {
		// Preserve the error that triggered cleanup.
	}
}

function createReadDatabaseConnection(dbPath: string) {
	// Bun WAL readers may need to create shared-memory sidecars after a clean exit.
	// Preserve Node's read-only open and enforce query_only for both runtimes below.
	const db = createDatabaseConnection(dbPath, "reader", {
		readonly: !process.versions.bun,
	});
	try {
		db.exec(`
		  pragma busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};
		  pragma foreign_keys = on;
		  pragma query_only = on;
		`);
		return db;
	} catch (error) {
		closeDatabaseIgnoringErrors(db);
		throw error;
	}
}

function createReadDatabasePool(
	dbPath: string,
	validateFirst?: (db: Database) => void,
) {
	const pool: Database[] = [];
	try {
		const first = createReadDatabaseConnection(dbPath);
		pool.push(first);
		validateFirst?.(first);
		pool.push(createReadDatabaseConnection(dbPath));
		return pool;
	} catch (error) {
		for (const db of pool) closeDatabaseIgnoringErrors(db);
		throw error;
	}
}

function assertCurrentDatabaseSchema(db: Database) {
	const expectedVersion = DATABASE_MIGRATIONS.at(-1)?.version ?? 0;
	const actualVersion = getDatabaseSchemaVersion(db);
	// Version 10 adds only indexes. Existing v9 snapshots remain safe to serve
	// until their next writable sync upgrades them; future schemas still fail closed.
	const compatibleSnapshot = expectedVersion === 10 && actualVersion === 9;
	if (actualVersion !== expectedVersion && !compatibleSnapshot) {
		throw new Error(
			`Birdclaw database schema ${String(actualVersion)} is not ready for version ${String(expectedVersion)}`,
		);
	}
}

function nextReadDb() {
	const db = readDbs[readDbIndex % readDbs.length] as Database;
	readDbIndex = (readDbIndex + 1) % readDbs.length;
	return db;
}

export function getNativeDb(options: InitDatabaseOptions = {}) {
	if (isReadOnlyDeployment()) return getStrictReadDb();
	initDatabase(options);
	return nativeDb as Database;
}

export function getReadDb(options: InitDatabaseOptions = {}) {
	if (isReadOnlyDeployment()) return getStrictReadDb();
	initDatabase(options);
	if (readDbs.length === 0) {
		const { dbPath } = getBirdclawPaths();
		readDbs = createReadDatabasePool(dbPath);
	}
	return nextReadDb();
}

export function refreshReadDatabasePoolAfterBulkWrite(db: Database) {
	if (db !== nativeDb) return false;

	const readers = readDbs;
	readDbs = [];
	readDbIndex = 0;
	for (const reader of readers) closeDatabaseIgnoringErrors(reader);

	try {
		db.exec("pragma wal_checkpoint(passive)");
	} catch {
		// The import is already committed; a busy external reader may delay cleanup.
	}
	return true;
}

export function getStrictReadDb() {
	if (readDbs.length > 0) {
		assertCurrentDatabaseSchema(readDbs[0] as Database);
		return nextReadDb();
	}
	const { dbPath } = getBirdclawPaths();
	if (!existsSync(dbPath)) {
		throw new Error("Birdclaw database is not initialized");
	}

	readDbs = createReadDatabasePool(dbPath, assertCurrentDatabaseSchema);
	return nextReadDb();
}

export function closeDatabase() {
	const native = nativeDb;
	const readers = readDbs;
	nativeDb = undefined;
	readDbs = [];
	readDbIndex = 0;
	demoSeedAttempted = false;

	for (const reader of readers) reader.close();
	native?.close();
}

export function resetDatabaseForTests() {
	closeDatabase();
}
