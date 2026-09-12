export type DatabaseConnectionRole = "reader" | "writer";

export interface SlowDatabaseStatement {
	durationMs: number;
	role: DatabaseConnectionRole;
	sql: string;
}

const SLOW_STATEMENT_MS = 50;
const MAX_SLOW_STATEMENTS = 10;

let readStatements = 0;
let writeStatements = 0;
let statementDurationMs = 0;
let batchCalls = 0;
let batchDurationMs = 0;
let slowStatements: SlowDatabaseStatement[] = [];
let queuedWrites = 0;
let activeWrites = 0;
let completedWrites = 0;
let failedWrites = 0;
let maxQueuedWrites = 0;
let maxWriteWaitMs = 0;

function compactSql(sql: string) {
	return sql.replace(/\s+/g, " ").trim().slice(0, 240);
}

export function recordDatabaseStatement(
	role: DatabaseConnectionRole,
	sql: string,
	durationMs: number,
) {
	statementDurationMs += durationMs;
	if (role === "reader") {
		readStatements += 1;
	} else {
		writeStatements += 1;
	}
	if (durationMs < SLOW_STATEMENT_MS) return;
	slowStatements = [
		...slowStatements,
		{ durationMs, role, sql: compactSql(sql) },
	].slice(-MAX_SLOW_STATEMENTS);
}

export function recordDatabaseBatch(durationMs: number) {
	batchCalls += 1;
	batchDurationMs += durationMs;
}

export function getDatabasePerformanceTotals() {
	return {
		calls: readStatements + writeStatements + batchCalls,
		milliseconds: statementDurationMs + batchDurationMs,
	};
}

export function recordDatabaseWriteQueued() {
	queuedWrites += 1;
	maxQueuedWrites = Math.max(maxQueuedWrites, queuedWrites);
}

export function recordDatabaseWriteStarted(waitMs: number) {
	queuedWrites = Math.max(0, queuedWrites - 1);
	activeWrites += 1;
	maxWriteWaitMs = Math.max(maxWriteWaitMs, waitMs);
}

export function recordDatabaseWriteCompleted(failed: boolean) {
	activeWrites = Math.max(0, activeWrites - 1);
	completedWrites += 1;
	if (failed) failedWrites += 1;
}

export function getDatabaseRuntimeMetrics() {
	return {
		connections: {
			readStatements,
			writeStatements,
			slowStatements: [...slowStatements],
		},
		writer: {
			active: activeWrites,
			completed: completedWrites,
			failed: failedWrites,
			maxQueued: maxQueuedWrites,
			maxWaitMs: maxWriteWaitMs,
			queued: queuedWrites,
		},
	};
}

export function resetDatabaseRuntimeMetricsForTests() {
	readStatements = 0;
	writeStatements = 0;
	statementDurationMs = 0;
	batchCalls = 0;
	batchDurationMs = 0;
	slowStatements = [];
	queuedWrites = 0;
	activeWrites = 0;
	completedWrites = 0;
	failedWrites = 0;
	maxQueuedWrites = 0;
	maxWriteWaitMs = 0;
}
