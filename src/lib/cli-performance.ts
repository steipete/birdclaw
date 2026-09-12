import { writeSync } from "node:fs";
import { getDatabasePerformanceTotals } from "./database-metrics";

export function captureCliPerformance() {
	const start = performance.now();
	const cpu = process.cpuUsage();
	const sql = getDatabasePerformanceTotals();
	return () => {
		const usage = process.cpuUsage(cpu);
		const after = getDatabasePerformanceTotals();
		return {
			version: 1,
			elapsedMs: Math.max(0, performance.now() - start),
			cpuUserMs: usage.user / 1000,
			cpuSystemMs: usage.system / 1000,
			sqlMs: Math.max(0, after.milliseconds - sql.milliseconds),
			sqlCalls: Math.max(0, after.calls - sql.calls),
		};
	};
}

export function writeCliPerformance(
	summary: ReturnType<ReturnType<typeof captureCliPerformance>>,
	write: typeof writeSync = writeSync,
) {
	try {
		write(2, `BIRDCLAW_CLI_METRICS ${JSON.stringify(summary)}\n`);
	} catch {
		/* Diagnostics cannot change a command's outcome when stderr is closed. */
	}
}
