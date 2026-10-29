import { spawn } from "node:child_process";
import { Effect } from "effect";
import {
	ingestSourcesInBatchesEffect,
	streamAssignedJsonArray,
} from "../streaming-ingestion";
import { runSubprocessEffect } from "../subprocess";
import type { ArchiveRecord } from "./types";

const ARCHIVE_JSON_PAYLOAD = /=\s*(\[[\s\S]*\]|\{[\s\S]*\})/s;

export function normalizeArchivePath(value: string) {
	return value.replaceAll("\\", "/");
}

export function extractArchiveJson(content: string): unknown {
	const match = ARCHIVE_JSON_PAYLOAD.exec(content);
	return match ? JSON.parse(match[1]) : [];
}

export function parseArchiveArray(content: string): ArchiveRecord[] {
	const parsed = extractArchiveJson(content);
	return Array.isArray(parsed)
		? parsed.filter((item): item is ArchiveRecord => Boolean(item))
		: [];
}

function runUnzipEffect(args: string[], maxBuffer = 1024 * 1024 * 256) {
	return runSubprocessEffect({
		command: "unzip",
		args,
		maxBufferBytes: maxBuffer,
	}).pipe(Effect.map(({ stdout }) => stdout));
}

export function listArchiveEntriesEffect(
	archivePath: string,
): Effect.Effect<string[], unknown> {
	return Effect.gen(function* () {
		const stdout = yield* runUnzipEffect(
			["-Z1", archivePath],
			1024 * 1024 * 64,
		);
		return stdout
			.split("\n")
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
	});
}

export function listArchiveEntryDetailsEffect(
	archivePath: string,
): Effect.Effect<Array<{ path: string; size: number }>, unknown> {
	return Effect.gen(function* () {
		const stdout = yield* runUnzipEffect(
			["-Z", "-l", archivePath],
			1024 * 1024 * 64,
		);
		// zipinfo prints `?` as the file-type char when an entry has no Unix
		// file-type bits, which is how X's archive exporter writes every entry.
		return stdout
			.split("\n")
			.map((line) => line.trim().split(/\s+/))
			.filter((parts) => parts.length >= 10 && /^[-d?]/.test(parts[0] ?? ""))
			.map((parts) => ({
				path: parts.slice(9).join(" "),
				size: Number(parts[3] ?? 0),
			}))
			.filter((entry) => entry.path.length > 0 && Number.isFinite(entry.size));
	});
}

export function readArchiveEntryEffect(
	archivePath: string,
	entryPath: string,
): Effect.Effect<string, unknown> {
	return runUnzipEffect(["-p", archivePath, entryPath]);
}

async function* streamArchiveArrayRecords(
	archivePath: string,
	entryPath: string,
) {
	const child = spawn("unzip", ["-p", archivePath, entryPath], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	const exit = new Promise<number | null>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", resolve);
	});

	try {
		yield* streamAssignedJsonArray(child.stdout);
		const exitCode = await exit;
		if (exitCode !== 0) {
			throw new Error(
				`Failed to extract ${entryPath}: ${stderr.trim() || `exit ${String(exitCode)}`}`,
			);
		}
	} finally {
		if (!child.killed) child.kill();
	}
}

export function processArchiveEntryRecordsEffect(
	archivePath: string,
	entryPath: string,
	processRecord: (record: ArchiveRecord) => void,
) {
	return ingestSourcesInBatchesEffect({
		sources: [
			{
				id: entryPath,
				stream: () => streamArchiveArrayRecords(archivePath, entryPath),
			},
		],
		processBatch: (batch) => {
			for (const record of batch) processRecord(record);
		},
	});
}

export function getFirstEntry(entries: string[], pattern: RegExp) {
	return entries.find((entry) => pattern.test(normalizeArchivePath(entry)));
}

export function getMatchingEntries(entries: string[], pattern: RegExp) {
	return entries.filter((entry) => pattern.test(normalizeArchivePath(entry)));
}
