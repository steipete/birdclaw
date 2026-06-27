import { exec } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import type { ArchiveCandidate } from "./types";

const execAsync = promisify(exec);
const ARCHIVE_DISCOVERY_CACHE_MS = 5 * 60_000;
const ARCHIVE_NAME_PATTERNS = [
	/^twitter-.*\.zip$/i,
	/^x-.*\.zip$/i,
	/archive.*\.zip$/i,
];
let archiveDiscoveryCache:
	| { value: ArchiveCandidate[]; updatedAt: number }
	| undefined;
let archiveDiscoveryInFlight: Promise<ArchiveCandidate[]> | undefined;

function formatFileSize(bytes: number): string {
	const units = ["B", "KB", "MB", "GB"];
	let value = bytes;
	let index = 0;

	while (value >= 1024 && index < units.length - 1) {
		value /= 1024;
		index += 1;
	}

	return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

function formatRelativeDate(date: Date): string {
	const days = Math.floor(
		(Date.now() - date.getTime()) / (1000 * 60 * 60 * 24),
	);
	if (days <= 0) return "Today";
	if (days === 1) return "Yesterday";
	if (days < 7) return `${days} days ago`;
	if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
	if (days < 365) return `${Math.floor(days / 30)} months ago`;
	return `${Math.floor(days / 365)} years ago`;
}

function normalizeArchivePath(filePath: string) {
	return filePath.replaceAll(path.sep, path.posix.sep);
}

function getCandidateEffect(filePath: string) {
	return Effect.gen(function* () {
		const stats = yield* tryPromise(() => fs.stat(filePath));
		if (!stats.isFile() || stats.size < 1024 * 1024) {
			return null;
		}

		const normalizedPath = normalizeArchivePath(filePath);
		return {
			path: normalizedPath,
			name: path.posix.basename(normalizedPath),
			size: stats.size,
			sizeFormatted: formatFileSize(stats.size),
			modifiedTime: stats.mtime.toISOString(),
			dateFormatted: formatRelativeDate(stats.mtime),
		};
	}).pipe(Effect.catchAll(() => Effect.succeed(null)));
}

function searchDirectoryEffect(directoryPath: string) {
	if (!existsSync(directoryPath)) {
		return Effect.succeed([]);
	}

	return Effect.gen(function* () {
		const entries = yield* tryPromise(() => fs.readdir(directoryPath));
		const matches = entries.filter((entry) =>
			ARCHIVE_NAME_PATTERNS.some((pattern) => pattern.test(entry)),
		);

		const candidates = yield* Effect.forEach(
			matches,
			(entry) => getCandidateEffect(path.join(directoryPath, entry)),
			{ concurrency: "unbounded" },
		);

		return candidates.filter((item) => item !== null);
	}).pipe(Effect.catchAll(() => Effect.succeed([])));
}

function searchSpotlightEffect(query: string) {
	return Effect.gen(function* () {
		const { stdout } = yield* tryPromise(() =>
			execAsync(`mdfind -onlyin ~ '${query}'`, {
				timeout: 5000,
			}),
		);
		const paths = stdout
			.split("\n")
			.map((item) => item.trim())
			.filter((item) => item.length > 0 && item.endsWith(".zip"));

		return yield* Effect.forEach(paths, getCandidateEffect, {
			concurrency: "unbounded",
		});
	}).pipe(Effect.catchAll(() => Effect.succeed([])));
}

export function findArchivesEffect(): Effect.Effect<
	ArchiveCandidate[],
	unknown
> {
	if (process.platform !== "darwin") {
		return Effect.succeed([]);
	}

	return Effect.gen(function* () {
		const found = new Map<string, ArchiveCandidate>();
		const downloads = yield* searchDirectoryEffect(
			path.join(homedir(), "Downloads"),
		);

		for (const candidate of downloads) {
			found.set(candidate.path, candidate);
		}

		const queries = [
			'kMDItemDisplayName == "twitter-*.zip"',
			'kMDItemDisplayName == "x-*.zip"',
			'kMDItemDisplayName == "*archive*.zip" && kMDItemKind == "Zip archive"',
		];

		const spotlightCandidates = yield* Effect.forEach(
			queries,
			searchSpotlightEffect,
			{ concurrency: "unbounded" },
		);

		for (const candidates of spotlightCandidates) {
			for (const candidate of candidates) {
				if (candidate) {
					found.set(candidate.path, candidate);
				}
			}
		}

		return [...found.values()].sort(
			(left, right) =>
				new Date(right.modifiedTime).getTime() -
				new Date(left.modifiedTime).getTime(),
		);
	});
}

export function findArchivesCachedEffect(): Effect.Effect<
	ArchiveCandidate[],
	unknown
> {
	return Effect.suspend(() => {
		const cached = archiveDiscoveryCache;
		if (cached && Date.now() - cached.updatedAt < ARCHIVE_DISCOVERY_CACHE_MS) {
			return Effect.succeed(cached.value);
		}
		if (archiveDiscoveryInFlight) {
			return Effect.promise(() => archiveDiscoveryInFlight!);
		}

		const request = runEffectPromise(findArchivesEffect())
			.then((value) => {
				archiveDiscoveryCache = { value, updatedAt: Date.now() };
				return value;
			})
			.finally(() => {
				if (archiveDiscoveryInFlight === request) {
					archiveDiscoveryInFlight = undefined;
				}
			});
		archiveDiscoveryInFlight = request;
		return Effect.promise(() => request);
	});
}

export function findArchives(): Promise<ArchiveCandidate[]> {
	return runEffectPromise(findArchivesEffect());
}

export function clearArchiveFinderCacheForTests() {
	archiveDiscoveryCache = undefined;
	archiveDiscoveryInFlight = undefined;
}
