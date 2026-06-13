import { DatabaseSync, type StatementSync } from "node:sqlite";

export type Database = NativeSqliteDatabase;

type DatabaseOptions = {
	readonly?: boolean;
};

type PragmaOptions = {
	simple?: boolean;
};

type RunResult = {
	changes: number;
	lastInsertRowid: number;
};

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
	return Object.fromEntries(
		Object.entries(row as Record<string, unknown>).map(([key, value]) => [
			key,
			normalizeValue(value),
		]),
	);
}

class NativeSqliteStatement {
	readonly reader: boolean;

	constructor(private readonly statement: StatementSync) {
		this.reader = statement.columns().length > 0;
	}

	all(...parameters: unknown[]): unknown[] {
		return this.statement.all(...bindArgs(parameters)).map(normalizeRow);
	}

	get(...parameters: unknown[]): unknown {
		return normalizeRow(this.statement.get(...bindArgs(parameters)));
	}

	run(...parameters: unknown[]): RunResult {
		const result = this.statement.run(...bindArgs(parameters));
		return {
			changes: Number(result.changes),
			lastInsertRowid: Number(result.lastInsertRowid),
		};
	}

	iterate(...parameters: unknown[]): IterableIterator<unknown> {
		const rows = this.statement.iterate(...bindArgs(parameters));
		return (function* () {
			for (const row of rows) {
				yield normalizeRow(row);
			}
		})();
	}
}

export class NativeSqliteDatabase {
	private transactionDepth = 0;
	private readonly db: DatabaseSync;

	constructor(path: string, options: DatabaseOptions = {}) {
		this.db = new DatabaseSync(path, {
			readOnly: options.readonly,
			timeout: 5000,
		});
	}

	close(): void {
		if (!this.db.isOpen) {
			return;
		}
		this.db.close();
	}

	exec(sql: string): void {
		this.db.exec(sql);
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
		return new NativeSqliteStatement(this.db.prepare(sql));
	}

	transaction<TArgs extends unknown[], TResult>(
		fn: (...args: TArgs) => TResult,
	): (...args: TArgs) => TResult {
		return (...args: TArgs) => {
			const nested = this.db.isTransaction;
			const savepoint = `__birdclaw_tx_${++this.transactionDepth}`;
			this.exec(nested ? `savepoint ${savepoint}` : "begin");
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
}

export default NativeSqliteDatabase;
