import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { tryPromise } from "./effect-runtime";

export interface ScheduledJobRunMetadata {
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	host: string;
	pid: number;
}

export interface ScheduledJobRun {
	readonly startedAt: string;
	finish(): ScheduledJobRunMetadata;
}

export type ScheduledJobLockRelease = () => Promise<void>;

interface ScheduledJobLockMetadata {
	token: string;
	pid: number;
	host: string;
	startedAt: string;
	renewedAt: string;
	createdAt?: string;
}

let beforeRenewalRenameForTests: (() => void | Promise<void>) | undefined;
let afterGuardReclaimMarkerForTests:
	| ((guardPath: string) => void | Promise<void>)
	| undefined;

async function syncLockDirectory(directory: string) {
	const handle = await fs.open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function isFileExistsError(error: unknown) {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "EEXIST"
	);
}

export function startScheduledJobRun(started = Date.now()): ScheduledJobRun {
	const startedAt = new Date(started).toISOString();
	return {
		startedAt,
		finish() {
			const finished = Date.now();
			return {
				startedAt,
				finishedAt: new Date(finished).toISOString(),
				durationMs: finished - started,
				host: os.hostname(),
				pid: process.pid,
			};
		},
	};
}

export async function appendScheduledJobAudit(logPath: string, entry: unknown) {
	await fs.mkdir(path.dirname(logPath), { recursive: true });
	await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}

export function appendScheduledJobAuditEffect(logPath: string, entry: unknown) {
	return tryPromise(() => appendScheduledJobAudit(logPath, entry));
}

export async function acquireScheduledJobLock(
	lockPath: string,
	staleMs: number,
	options: { renew?: boolean } = {},
): Promise<ScheduledJobLockRelease | undefined> {
	if (!Number.isFinite(staleMs) || staleMs <= 0) {
		throw new Error("Lock stale interval must be positive");
	}
	await fs.mkdir(path.dirname(lockPath), { recursive: true });
	const guardPath = `${lockPath}.guard`;

	async function readMetadata(filePath: string) {
		try {
			const parsed = JSON.parse(
				await fs.readFile(filePath, "utf8"),
			) as Partial<ScheduledJobLockMetadata>;
			return typeof parsed.token === "string" ? parsed : null;
		} catch {
			return null;
		}
	}

	function processIsAlive(metadata: Partial<ScheduledJobLockMetadata> | null) {
		if (metadata?.host !== os.hostname() || !Number.isInteger(metadata.pid))
			return false;
		try {
			process.kill(Number(metadata.pid), 0);
			return true;
		} catch (error) {
			return Boolean(
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "EPERM",
			);
		}
	}

	function validLockOwner(metadata: Partial<ScheduledJobLockMetadata> | null) {
		return Boolean(
			metadata?.token &&
			typeof metadata.host === "string" &&
			metadata.host.length > 0 &&
			Number.isInteger(metadata.pid) &&
			typeof metadata.startedAt === "string" &&
			typeof metadata.renewedAt === "string",
		);
	}

	function localOwnerState(metadata: Partial<ScheduledJobLockMetadata>) {
		if (metadata.host !== os.hostname() || !Number.isInteger(metadata.pid)) {
			return "unknown" as const;
		}
		try {
			process.kill(Number(metadata.pid), 0);
			return "alive" as const;
		} catch (error) {
			if (
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "ESRCH"
			) {
				return "dead" as const;
			}
			return "unknown" as const;
		}
	}

	async function tryReclaimStaleGuard() {
		const markerPath = path.join(guardPath, ".reclaim");
		const markerToken = randomUUID();
		let markerCreated = false;
		try {
			const marker = await fs.open(markerPath, "wx", 0o600);
			markerCreated = true;
			try {
				await marker.writeFile(JSON.stringify({ token: markerToken }), "utf8");
				await marker.sync();
			} finally {
				await marker.close();
			}
			const markedGuard = await fs.lstat(guardPath);
			await afterGuardReclaimMarkerForTests?.(guardPath);
			const [markerOwner, owner, ownerStat, currentGuard] = await Promise.all([
				readMetadata(markerPath),
				readMetadata(path.join(guardPath, "owner.json")),
				fs.stat(path.join(guardPath, "owner.json")).catch(() => undefined),
				fs.lstat(guardPath).catch(() => undefined),
			]);
			if (
				markerOwner?.token !== markerToken ||
				!currentGuard ||
				currentGuard.dev !== markedGuard.dev ||
				currentGuard.ino !== markedGuard.ino
			) {
				return false;
			}
			const ownerTime = owner?.createdAt
				? new Date(owner.createdAt).getTime()
				: ownerStat?.mtimeMs;
			const stale =
				!processIsAlive(owner) &&
				typeof ownerTime === "number" &&
				Date.now() - ownerTime > 30_000;
			if (!stale) return false;
			const finalGuard = await fs.lstat(guardPath).catch(() => undefined);
			const finalMarker = await readMetadata(markerPath);
			if (
				!finalGuard ||
				finalGuard.dev !== markedGuard.dev ||
				finalGuard.ino !== markedGuard.ino ||
				finalMarker?.token !== markerToken
			) {
				return false;
			}
			const abandoned = `${guardPath}.abandoned-${randomUUID()}`;
			await fs.rename(guardPath, abandoned);
			markerCreated = false;
			await fs.rm(abandoned, { recursive: true, force: true });
			return true;
		} catch (error) {
			if (isFileExistsError(error)) return false;
			if (
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "ENOENT"
			)
				return false;
			throw error;
		} finally {
			if (markerCreated) {
				const markerOwner = await readMetadata(markerPath);
				if (markerOwner?.token === markerToken) {
					await fs.rm(markerPath, { force: true });
				}
			}
		}
	}

	async function guardLooksStale() {
		const ownerPath = path.join(guardPath, "owner.json");
		const [owner, ownerStat, guardStat] = await Promise.all([
			readMetadata(ownerPath),
			fs.stat(ownerPath).catch(() => undefined),
			fs.stat(guardPath).catch(() => undefined),
		]);
		const ownerTime = owner?.createdAt
			? new Date(owner.createdAt).getTime()
			: (ownerStat?.mtimeMs ?? guardStat?.mtimeMs);
		return (
			!processIsAlive(owner) &&
			typeof ownerTime === "number" &&
			Date.now() - ownerTime > 30_000
		);
	}

	async function withGuard<T>(operation: () => Promise<T>) {
		const guardToken = randomUUID();
		for (let attempt = 0; attempt < 50; attempt += 1) {
			try {
				await fs.mkdir(guardPath);
				await fs.writeFile(
					path.join(guardPath, "owner.json"),
					JSON.stringify({
						token: guardToken,
						pid: process.pid,
						host: os.hostname(),
						createdAt: new Date().toISOString(),
					}),
					"utf8",
				);
				try {
					return { acquired: true as const, value: await operation() };
				} finally {
					const owner = await readMetadata(path.join(guardPath, "owner.json"));
					if (owner?.token === guardToken) {
						await fs.rm(guardPath, { recursive: true, force: true });
					}
				}
			} catch (error) {
				if (!isFileExistsError(error)) throw error;
				if ((await guardLooksStale()) && (await tryReclaimStaleGuard())) {
					continue;
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		}
		return { acquired: false as const };
	}

	const token = randomUUID();
	const startedAt = new Date().toISOString();
	const metadata = (): ScheduledJobLockMetadata => ({
		token,
		pid: process.pid,
		host: os.hostname(),
		startedAt,
		renewedAt: new Date().toISOString(),
	});
	const acquired = await withGuard(async () => {
		const current = await readMetadata(lockPath);
		if (current || (await fs.stat(lockPath).catch(() => undefined))) {
			const stats = await fs.stat(lockPath).catch(() => undefined);
			if (validLockOwner(current)) {
				if (current!.host !== os.hostname()) return false;
				if (localOwnerState(current!) !== "dead") return false;
			} else {
				const renewedAt = current?.renewedAt
					? new Date(current.renewedAt).getTime()
					: stats?.mtimeMs;
				if (
					typeof renewedAt !== "number" ||
					Date.now() - renewedAt <= staleMs
				) {
					return false;
				}
			}
			const abandoned = `${lockPath}.abandoned-${randomUUID()}`;
			await fs.rename(lockPath, abandoned);
			await fs.rm(abandoned, { force: true });
		}
		const handle = await fs.open(lockPath, "wx");
		try {
			await handle.writeFile(`${JSON.stringify(metadata())}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		return true;
	});
	if (!acquired.acquired || !acquired.value) return undefined;

	let released = false;
	let renewing = false;
	let releasing = false;
	let releasePromise: Promise<void> | undefined;
	const renew = async () => {
		if (released || releasing || renewing) return;
		renewing = true;
		try {
			await withGuard(async () => {
				const current = await readMetadata(lockPath);
				if (current?.token !== token) return;
				const temporaryPath = `${lockPath}.renew-${randomUUID()}`;
				try {
					const handle = await fs.open(temporaryPath, "wx", 0o600);
					try {
						await handle.writeFile(`${JSON.stringify(metadata())}\n`, "utf8");
						await handle.sync();
					} finally {
						await handle.close();
					}
					await beforeRenewalRenameForTests?.();
					const ownerBeforeReplace = await readMetadata(lockPath);
					if (ownerBeforeReplace?.token !== token) return;
					await fs.rename(temporaryPath, lockPath);
					await syncLockDirectory(path.dirname(lockPath));
				} finally {
					await fs.rm(temporaryPath, { force: true });
					await syncLockDirectory(path.dirname(lockPath));
				}
			});
		} finally {
			renewing = false;
		}
	};
	const renewEveryMs = Math.max(25, Math.min(30_000, Math.floor(staleMs / 3)));
	const timer =
		options.renew === false
			? undefined
			: setInterval(() => void renew().catch(() => undefined), renewEveryMs);
	timer?.unref();

	return () => {
		if (released) return Promise.resolve();
		if (releasePromise) return releasePromise;
		releasing = true;
		if (timer) clearInterval(timer);
		releasePromise = (async () => {
			while (true) {
				const guarded = await withGuard(async () => {
					const current = await readMetadata(lockPath);
					const stats = await fs.stat(lockPath).catch((error) => {
						if (
							error &&
							typeof error === "object" &&
							"code" in error &&
							error.code === "ENOENT"
						)
							return undefined;
						throw error;
					});
					if (!stats) return "gone" as const;
					if (current?.token && current.token !== token) {
						return "other-owner" as const;
					}
					if (current?.token !== token) {
						throw new Error("Unable to verify scheduled job lock ownership");
					}
					await fs.rm(lockPath);
					return "removed" as const;
				});
				if (guarded.acquired) {
					released = true;
					return;
				}

				const current = await readMetadata(lockPath);
				const stats = await fs.stat(lockPath).catch((error) => {
					if (
						error &&
						typeof error === "object" &&
						"code" in error &&
						error.code === "ENOENT"
					)
						return undefined;
					throw error;
				});
				if (!stats || (current?.token && current.token !== token)) {
					released = true;
					return;
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		})().finally(() => {
			if (!released) {
				releasing = false;
				releasePromise = undefined;
			}
		});
		return releasePromise;
	};
}

export function acquireScheduledJobLockEffect(
	lockPath: string,
	staleMs: number,
): Effect.Effect<(() => Effect.Effect<void>) | undefined, unknown> {
	return tryPromise(() => acquireScheduledJobLock(lockPath, staleMs)).pipe(
		Effect.map((release) =>
			release
				? () => tryPromise(release).pipe(Effect.asVoid, Effect.orDie)
				: undefined,
		),
	);
}

export const __test__ = {
	setBeforeRenewalRename(hook: (() => void | Promise<void>) | undefined) {
		beforeRenewalRenameForTests = hook;
	},
	setAfterGuardReclaimMarker(
		hook: ((guardPath: string) => void | Promise<void>) | undefined,
	) {
		afterGuardReclaimMarkerForTests = hook;
	},
};
