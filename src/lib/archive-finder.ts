import { exec } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ArchiveCandidate } from "./types";

const execAsync = promisify(exec);
const ARCHIVE_NAME_PATTERNS = [
	/^twitter-.*\.zip$/i,
	/^x-.*\.zip$/i,
	/archive.*\.zip$/i,
];

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

async function getCandidate(
	filePath: string,
): Promise<ArchiveCandidate | null> {
	try {
		const stats = await fs.stat(filePath);
		if (!stats.isFile() || stats.size < 1024 * 1024) {
			return null;
		}

		return {
			path: filePath,
			name: path.basename(filePath),
			size: stats.size,
			sizeFormatted: formatFileSize(stats.size),
			modifiedTime: stats.mtime.toISOString(),
			dateFormatted: formatRelativeDate(stats.mtime),
		};
	} catch {
		return null;
	}
}

async function searchDirectory(
	directoryPath: string,
): Promise<ArchiveCandidate[]> {
	if (!existsSync(directoryPath)) {
		return [];
	}

	const entries = await fs.readdir(directoryPath);
	const matches = entries.filter((entry) =>
		ARCHIVE_NAME_PATTERNS.some((pattern) => pattern.test(entry)),
	);

	const candidates = await Promise.all(
		matches.map((entry) => getCandidate(path.join(directoryPath, entry))),
	);

	return candidates.filter((item) => item !== null);
}

export async function findArchives(): Promise<ArchiveCandidate[]> {
	if (process.platform !== "darwin") {
		return [];
	}

	const found = new Map<string, ArchiveCandidate>();
	const downloads = await searchDirectory(path.join(homedir(), "Downloads"));

	for (const candidate of downloads) {
		found.set(candidate.path, candidate);
	}

	const queries = [
		'kMDItemDisplayName == "twitter-*.zip"',
		'kMDItemDisplayName == "x-*.zip"',
		'kMDItemDisplayName == "*archive*.zip" && kMDItemKind == "Zip archive"',
	];

	const spotlightCandidates = await Promise.all(
		queries.map(async (query) => {
			try {
				const { stdout } = await execAsync(`mdfind -onlyin ~ '${query}'`, {
					timeout: 5000,
				});

				const paths = stdout
					.split("\n")
					.map((item) => item.trim())
					.filter((item) => item.length > 0 && item.endsWith(".zip"));

				return Promise.all(paths.map((filePath) => getCandidate(filePath)));
			} catch {
				// Best-effort only.
				return [];
			}
		}),
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
}
