// @vitest-environment node
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	__test__,
	acquireScheduledJobLock,
	appendScheduledJobAudit,
	startScheduledJobRun,
} from "./scheduled-job";

const tempDirs: string[] = [];

function makeTempDir() {
	const directory = mkdtempSync(
		path.join(os.tmpdir(), "birdclaw-job-runtime-"),
	);
	tempDirs.push(directory);
	return directory;
}

async function spawnLockOwner(
	lockPath: string,
	staleMs: number,
	renew: boolean,
) {
	const directory = makeTempDir();
	const scriptPath = path.join(directory, "lock-owner.mjs");
	const moduleUrl = new URL("./scheduled-job.ts", import.meta.url).href;
	writeFileSync(
		scriptPath,
		`import { acquireScheduledJobLock } from ${JSON.stringify(moduleUrl)};
		 const lockPath = process.argv[2];
		 const release = await acquireScheduledJobLock(lockPath, Number(process.argv[3]), { renew: process.argv[4] === "true" });
		 if (!release) throw new Error("lock not acquired");
		 process.stdout.write("ready\\n");
		 process.stdin.setEncoding("utf8");
		 process.stdin.on("data", async (value) => {
		   if (!value.includes("release")) return;
		   await release(); process.stdout.write("released\\n"); process.exit(0);
		 });`,
		"utf8",
	);
	const child = spawn(
		path.resolve("scripts/bun-canary.sh"),
		[scriptPath, lockPath, String(staleMs), String(renew)],
		{ cwd: path.resolve("."), stdio: ["pipe", "pipe", "pipe"] },
	);
	let output = "";
	const waitFor = (needle: string) =>
		new Promise<void>((resolve, reject) => {
			const onData = (chunk: Buffer | string) => {
				output += String(chunk);
				if (!output.includes(needle)) return;
				child.stdout.off("data", onData);
				resolve();
			};
			child.stdout.on("data", onData);
			child.once("error", reject);
			child.once("exit", (code) => {
				if (!output.includes(needle))
					reject(new Error(`lock owner exited ${code}: ${output}`));
			});
		});
	await waitFor("ready");
	return { child, waitFor };
}

afterEach(() => {
	__test__.setBeforeRenewalRename(undefined);
	__test__.setAfterGuardReclaimMarker(undefined);
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("scheduled job runtime", () => {
	it("appends JSONL audit entries with run metadata", async () => {
		const logPath = path.join(makeTempDir(), "audit", "job.jsonl");
		const run = startScheduledJobRun(Date.now() - 10);
		const entry = { job: "test", ok: true, ...run.finish() };

		await appendScheduledJobAudit(logPath, entry);

		expect(JSON.parse(readFileSync(logPath, "utf8"))).toMatchObject({
			job: "test",
			ok: true,
			host: os.hostname(),
			pid: process.pid,
		});
		expect(entry.durationMs).toBeGreaterThanOrEqual(10);
	});

	it("rejects active locks and replaces stale locks", async () => {
		const lockPath = path.join(makeTempDir(), "locks", "job.lock");
		const release = await acquireScheduledJobLock(lockPath, 1_000);

		expect(release).toBeTypeOf("function");
		await expect(
			acquireScheduledJobLock(lockPath, 1_000),
		).resolves.toBeUndefined();
		await release?.();
		expect(existsSync(lockPath)).toBe(false);

		writeFileSync(lockPath, "stale\n", "utf8");
		const old = new Date(Date.now() - 2_000);
		utimesSync(lockPath, old, old);
		const staleRelease = await acquireScheduledJobLock(lockPath, 1_000);

		expect(staleRelease).toBeTypeOf("function");
		expect(readFileSync(lockPath, "utf8")).toContain(`"pid":${process.pid}`);
		await staleRelease?.();
	});

	it("renews a live independent-process lease", async () => {
		const lockPath = path.join(makeTempDir(), "locks", "renewed.lock");
		const owner = await spawnLockOwner(lockPath, 120, true);
		await new Promise((resolve) => setTimeout(resolve, 350));

		await expect(
			acquireScheduledJobLock(lockPath, 120),
		).resolves.toBeUndefined();
		owner.child.stdin.write("release\n");
		await owner.waitFor("released");
		expect(existsSync(lockPath)).toBe(false);
	});

	it("keeps valid token metadata when an atomic renewal is interrupted", async () => {
		const lockPath = path.join(makeTempDir(), "locks", "atomic-renew.lock");
		const release = await acquireScheduledJobLock(lockPath, 600);
		expect(release).toBeTypeOf("function");
		const initial = JSON.parse(readFileSync(lockPath, "utf8")) as {
			token: string;
			renewedAt: string;
		};
		let interrupted = 0;
		__test__.setBeforeRenewalRename(() => {
			interrupted += 1;
			throw new Error("synthetic renewal interruption");
		});
		for (let attempt = 0; attempt < 30 && interrupted === 0; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(interrupted).toBeGreaterThan(0);
		const afterFailure = JSON.parse(readFileSync(lockPath, "utf8")) as {
			token: string;
			renewedAt: string;
		};
		expect(afterFailure).toEqual(initial);

		__test__.setBeforeRenewalRename(undefined);
		let renewed = initial;
		for (
			let attempt = 0;
			attempt < 100 && renewed.renewedAt === initial.renewedAt;
			attempt += 1
		) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			renewed = JSON.parse(readFileSync(lockPath, "utf8")) as {
				token: string;
				renewedAt: string;
			};
		}
		expect(renewed.token).toBe(initial.token);
		expect(renewed.renewedAt).not.toBe(initial.renewedAt);
		await expect(
			acquireScheduledJobLock(lockPath, 600),
		).resolves.toBeUndefined();
		await release!();
		expect(existsSync(lockPath)).toBe(false);
	});

	it("retries token-owned release while the guard remains busy", async () => {
		const lockPath = path.join(makeTempDir(), "locks", "busy-release.lock");
		const staleMs = 10_000;
		const release = await acquireScheduledJobLock(lockPath, staleMs, {
			renew: false,
		});
		expect(release).toBeTypeOf("function");
		const guardPath = `${lockPath}.guard`;
		mkdirSync(guardPath);
		writeFileSync(
			path.join(guardPath, "owner.json"),
			JSON.stringify({
				token: "synthetic-live-guard",
				pid: process.pid,
				host: os.hostname(),
				createdAt: new Date().toISOString(),
			}),
			"utf8",
		);
		let settled = false;
		const startedAt = Date.now();
		const releasing = release!().finally(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 650));
		expect(settled).toBe(false);
		expect(existsSync(lockPath)).toBe(true);

		rmSync(guardPath, { recursive: true });
		await Promise.race([
			releasing,
			new Promise((_, reject) =>
				setTimeout(
					() => reject(new Error("lock release did not retry")),
					2_000,
				),
			),
		]);
		expect(Date.now() - startedAt).toBeLessThan(staleMs);
		expect(existsSync(lockPath)).toBe(false);
	});

	it("does not reclaim a fresh guard that replaces a marked stale guard", async () => {
		const lockPath = path.join(makeTempDir(), "locks", "guard-aba.lock");
		mkdirSync(path.dirname(lockPath), { recursive: true });
		const guardPath = `${lockPath}.guard`;
		mkdirSync(guardPath);
		const ownerPath = path.join(guardPath, "owner.json");
		writeFileSync(
			ownerPath,
			JSON.stringify({
				token: "stale-guard",
				pid: 999_999,
				host: os.hostname(),
				createdAt: "2000-01-01T00:00:00.000Z",
			}),
		);
		const old = new Date(Date.now() - 60_000);
		utimesSync(ownerPath, old, old);
		utimesSync(guardPath, old, old);
		let resume!: () => void;
		const resumed = new Promise<void>((resolve) => {
			resume = resolve;
		});
		let markerObserved!: () => void;
		const observed = new Promise<void>((resolve) => {
			markerObserved = resolve;
		});
		let activeMarkerHolders = 0;
		let maxConcurrentMarkerHolders = 0;
		__test__.setAfterGuardReclaimMarker(async () => {
			activeMarkerHolders += 1;
			maxConcurrentMarkerHolders = Math.max(
				maxConcurrentMarkerHolders,
				activeMarkerHolders,
			);
			try {
				markerObserved();
				await resumed;
			} finally {
				activeMarkerHolders -= 1;
			}
		});

		const contenders = [
			acquireScheduledJobLock(lockPath, 1_000, { renew: false }),
			acquireScheduledJobLock(lockPath, 1_000, { renew: false }),
		];
		await observed;
		rmSync(guardPath, { recursive: true });
		mkdirSync(guardPath);
		writeFileSync(
			ownerPath,
			JSON.stringify({
				token: "fresh-guard",
				pid: process.pid,
				host: os.hostname(),
				createdAt: new Date().toISOString(),
			}),
		);
		resume();

		await expect(Promise.all(contenders)).resolves.toEqual([
			undefined,
			undefined,
		]);
		expect(maxConcurrentMarkerHolders).toBe(1);
		expect(
			(JSON.parse(readFileSync(ownerPath, "utf8")) as { token: string }).token,
		).toBe("fresh-guard");
		expect(existsSync(guardPath)).toBe(true);
		rmSync(guardPath, { recursive: true });
	}, 10000);

	it("keeps an expired live lease locked and reclaims it only after owner death", async () => {
		const lockPath = path.join(makeTempDir(), "locks", "takeover.lock");
		const owner = await spawnLockOwner(lockPath, 120, false);
		const old = JSON.parse(readFileSync(lockPath, "utf8")) as Record<
			string,
			unknown
		>;
		writeFileSync(
			lockPath,
			`${JSON.stringify({
				...old,
				renewedAt: "2000-01-01T00:00:00.000Z",
			})}\n`,
			"utf8",
		);
		await expect(
			acquireScheduledJobLock(lockPath, 120),
		).resolves.toBeUndefined();
		const exited = new Promise<void>((resolve) =>
			owner.child.once("exit", () => resolve()),
		);
		owner.child.kill("SIGTERM");
		await exited;
		const replacement = await acquireScheduledJobLock(lockPath, 120);
		expect(replacement).toBeTypeOf("function");
		await replacement?.();
		expect(existsSync(lockPath)).toBe(false);
	});

	it("never automatically reclaims an expired valid cross-host lease", async () => {
		const lockPath = path.join(makeTempDir(), "locks", "cross-host.lock");
		mkdirSync(path.dirname(lockPath), { recursive: true });
		writeFileSync(
			lockPath,
			JSON.stringify({
				token: "cross-host-owner",
				pid: 42,
				host: "another-host.example",
				startedAt: "2000-01-01T00:00:00.000Z",
				renewedAt: "2000-01-01T00:00:00.000Z",
			}),
		);
		const old = new Date(Date.now() - 60_000);
		utimesSync(lockPath, old, old);

		await expect(
			acquireScheduledJobLock(lockPath, 120),
		).resolves.toBeUndefined();
		expect(
			(JSON.parse(readFileSync(lockPath, "utf8")) as { token: string }).token,
		).toBe("cross-host-owner");
	});

	it("immediately reclaims a valid same-host lock with a confirmed dead pid", async () => {
		const lockPath = path.join(makeTempDir(), "locks", "dead-owner.lock");
		mkdirSync(path.dirname(lockPath), { recursive: true });
		writeFileSync(
			lockPath,
			JSON.stringify({
				token: "dead-owner",
				pid: 999_999,
				host: os.hostname(),
				startedAt: new Date().toISOString(),
				renewedAt: new Date().toISOString(),
			}),
		);

		const release = await acquireScheduledJobLock(lockPath, 60_000);
		expect(release).toBeTypeOf("function");
		await release?.();
		expect(existsSync(lockPath)).toBe(false);
	});
});
