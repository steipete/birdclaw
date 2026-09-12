import { DatabaseSync, type StatementSync } from "node:sqlite";

export type Database = NativeSqliteDatabase;

type DatabaseOptions = {
	readonly?: boolean;
	fileMustExist?: boolean;
	timeout?: number;
	onStatement?: (sql: string, durationMs: number) => void;
	onBatch?: (durationMs: number) => void;
};

type PragmaOptions = {
	simple?: boolean;
};

type RunResult = {
	changes: number;
	lastInsertRowid: number;
};

export const SQLITE_BUSY_TIMEOUT_MS = 30_000;
const STATEMENT_CACHE_LIMIT = 128;

function bindArgs(parameters: unknown[]) {
	if (parameters.length === 1 && Array.isArray(parameters[0])) {
		return parameters[0];
	}
	return parameters;
}

function normalizeValue(value: unknown): unknown {
	if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
		return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	}
	return value;
}

function normalizeRow(row: unknown): unknown {
	if (
		!row ||
		typeof row !== "object" ||
		Array.isArray(row) ||
		Buffer.isBuffer(row)
	) {
		return normalizeValue(row);
	}
	const record = row as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		const value = record[key];
		if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
			record[key] = normalizeValue(value);
		}
	}
	return Object.setPrototypeOf(record, Object.prototype);
}

class NativeSqliteStatement {
	constructor(
		private readonly statement: StatementSync,
		private readonly sql: string,
		private readonly prepareIterator: () => StatementSync,
		private readonly onStatement?: (sql: string, durationMs: number) => void,
	) {}

	private track<T>(operation: () => T) {
		const startedAt = performance.now();
		try {
			return operation();
		} finally {
			this.onStatement?.(this.sql, performance.now() - startedAt);
		}
	}

	all(...parameters: unknown[]): unknown[] {
		return this.track(() =>
			this.statement.all(...bindArgs(parameters)).map(normalizeRow),
		);
	}

	get(...parameters: unknown[]): unknown {
		return this.track(() =>
			normalizeRow(this.statement.get(...bindArgs(parameters))),
		);
	}

	run(...parameters: unknown[]): RunResult {
		return this.track(() => {
			const result = this.statement.run(...bindArgs(parameters));
			return {
				changes: Number(result.changes),
				lastInsertRowid: Number(result.lastInsertRowid),
			};
		});
	}

	iterate(...parameters: unknown[]): IterableIterator<unknown> {
		// Iterators own their native cursor so nested reads cannot reset it.
		const rows = this.prepareIterator().iterate(...bindArgs(parameters));
		const startedAt = performance.now();
		const onStatement = this.onStatement;
		const sql = this.sql;
		return (function* () {
			try {
				for (const row of rows) {
					yield normalizeRow(row);
				}
			} finally {
				onStatement?.(sql, performance.now() - startedAt);
			}
		})();
	}
}

export class NativeSqliteDatabase {
	readonly writeIdentity: string | object;
	private transactionDepth = 0;
	private readonly db: DatabaseSync;
	private readonly statements = new Map<string, StatementSync>();

	constructor(
		path: string,
		private readonly options: DatabaseOptions = {},
	) {
		this.writeIdentity = path === ":memory:" ? this : path;
		this.db = new DatabaseSync(path, {
			readOnly: options.readonly,
			timeout: options.timeout ?? SQLITE_BUSY_TIMEOUT_MS,
		});
	}

	close(): void {
		if (!this.db.isOpen) {
			return;
		}
		this.statements.clear();
		this.db.close();
	}

	exec(sql: string): void {
		if (!this.options.onBatch) {
			this.db.exec(sql);
			return;
		}
		const startedAt = performance.now();
		try {
			this.db.exec(sql);
		} finally {
			this.options.onBatch(performance.now() - startedAt);
		}
	}

	pragma(sql: string, options: PragmaOptions = {}): unknown {
		const rows = this.prepare(`pragma ${sql}`).all() as Array<
			Record<string, unknown>
		>;
		if (!options.simple) {
			return rows;
		}
		const first = rows[0];
		return first ? Object.values(first)[0] : undefined;
	}

	prepare(sql: string): NativeSqliteStatement {
		let statement = this.statements.get(sql);
		if (statement) {
			this.statements.delete(sql);
		} else {
			statement = this.db.prepare(sql);
			if (this.statements.size >= STATEMENT_CACHE_LIMIT) {
				this.statements.delete(this.statements.keys().next().value!);
			}
		}
		this.statements.set(sql, statement);
		return new NativeSqliteStatement(
			statement,
			sql,
			() => this.db.prepare(sql),
			this.options.onStatement,
		);
	}

	private wrapTransaction<TArgs extends unknown[], TResult>(
		fn: (...args: TArgs) => TResult,
		begin: "begin" | "begin immediate",
	): (...args: TArgs) => TResult {
		return (...args: TArgs) => {
			const nested = this.db.isTransaction;
			const savepoint = `__birdclaw_tx_${++this.transactionDepth}`;
			this.exec(nested ? `savepoint ${savepoint}` : begin);
			try {
				const result = fn(...args);
				this.exec(nested ? `release ${savepoint}` : "commit");
				return result;
			} catch (error) {
				if (nested) {
					this.exec(`rollback to ${savepoint}`);
					this.exec(`release ${savepoint}`);
				} else {
					this.exec("rollback");
				}
				throw error;
			}
		};
	}

	transaction<TArgs extends unknown[], TResult>(
		fn: (...args: TArgs) => TResult,
	): (...args: TArgs) => TResult {
		return this.wrapTransaction(fn, "begin immediate");
	}

	readTransaction<TArgs extends unknown[], TResult>(
		fn: (...args: TArgs) => TResult,
	): (...args: TArgs) => TResult {
		return this.wrapTransaction(fn, "begin");
	}
}

export default NativeSqliteDatabase;
