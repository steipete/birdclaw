// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureCliPerformance, writeCliPerformance } from "./cli-performance";
import {
	recordDatabaseBatch,
	recordDatabaseStatement,
	resetDatabaseRuntimeMetricsForTests,
} from "./database-metrics";
import { NativeSqliteDatabase } from "./sqlite";

beforeEach(() => resetDatabaseRuntimeMetricsForTests());
describe("numeric CLI performance summaries", () => {
	it("reports per-command deltas without SQL or bound data", () => {
		recordDatabaseStatement("writer", "previous command", 200);
		const capture = captureCliPerformance();
		recordDatabaseStatement("reader", "select 'synthetic-private-content'", 70);
		recordDatabaseStatement("writer", "update profiles set bio = ?", 12);
		recordDatabaseBatch(8);
		const summary = capture();
		expect(summary.sqlMs).toBe(90);
		expect(summary.sqlCalls).toBe(3);
		expect(summary.version).toBe(1);
		for (const value of Object.values(summary))
			expect(Number.isFinite(value) && value >= 0).toBe(true);
		const write = vi.fn(() => 0);
		writeCliPerformance(summary, write);
		const [fd, text] = write.mock.calls[0]! as unknown as [number, string];
		expect(fd).toBe(2);
		expect(text).toMatch(/^BIRDCLAW_CLI_METRICS \{/);
		expect(text).not.toContain("synthetic-private-content");
		expect(text).not.toContain("profiles");
		expect(
			Object.keys(
				JSON.parse(text.slice("BIRDCLAW_CLI_METRICS ".length)),
			).sort(),
		).toEqual([
			"cpuSystemMs",
			"cpuUserMs",
			"elapsedMs",
			"sqlCalls",
			"sqlMs",
			"version",
		]);
	});
	it("does not fail a command when diagnostic output is closed", () => {
		expect(() =>
			writeCliPerformance(captureCliPerformance()(), () => {
				throw new Error("closed");
			}),
		).not.toThrow();
	});
	it("times successful and failed exec batches without changing statement metrics", () => {
		const batches: number[] = [];
		const statements: string[] = [];
		const db = new NativeSqliteDatabase(":memory:", {
			onBatch: (ms) => batches.push(ms),
			onStatement: (sql) => statements.push(sql),
		});
		try {
			db.exec("create table sample(value); insert into sample values (1)");
			expect(db.prepare("select value from sample").get()).toEqual({
				value: 1,
			});
			expect(() => db.exec("invalid SQL")).toThrow(/syntax/i);
			expect(batches).toHaveLength(2);
			expect(batches.every((ms) => Number.isFinite(ms) && ms >= 0)).toBe(true);
			expect(statements).toEqual(["select value from sample"]);
		} finally {
			db.close();
		}
	});
});
