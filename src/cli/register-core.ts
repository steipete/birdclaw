import { findArchives } from "#/lib/archive-finder";
import {
	ARCHIVE_IMPORT_SLICES,
	type ArchiveImportSlice,
	type ImportProgressEvent,
	type ImportProgressSlice,
	type ImportWritePhase,
	importArchive,
} from "#/lib/archive-import";
import { ensureBirdclawDirs, setActionsTransport } from "#/lib/config";
import { getNativeDb } from "#/lib/db";
import {
	FxTwitterError,
	importConversationViaFxTwitter,
	importProfileViaFxTwitter,
	importThreadViaFxTwitter,
	importTweetsViaFxTwitter,
} from "#/lib/fxtwitter";
import { hydrateProfilesFromX } from "#/lib/profile-hydration";
import { getQueryEnvelope } from "#/lib/query-status";
import { seedDemoData } from "#/lib/seed";
import { printError, type CliCommandContext } from "./command-context";

const IMPORT_SLICE_LABELS: Record<ImportProgressSlice, string> = {
	tweets: "tweets",
	deletedTweets: "deleted tweets",
	noteTweets: "note tweets",
	directMessages: "direct messages",
	likes: "likes",
	bookmarks: "bookmarks",
	media: "media files",
	followers: "followers",
	following: "following",
};

const IMPORT_WRITE_LABELS: Record<ImportWritePhase, string> = {
	profiles: "profiles",
	tweets: "tweets",
	collections: "likes+bookmarks",
	dmMessages: "DM messages",
};

function logImportProgress(event: ImportProgressEvent) {
	switch (event.kind) {
		case "scanned":
			process.stderr.write(
				`Scanning archive… ${String(event.entryCount)} entries\n`,
			);
			return;
		case "slice-start":
			if (event.slice === "media") {
				process.stderr.write("Indexing media files…\n");
				return;
			}
			process.stderr.write(
				`Parsing ${IMPORT_SLICE_LABELS[event.slice]}… (${String(event.files)} file${event.files === 1 ? "" : "s"})\n`,
			);
			return;
		case "slice-file":
			if (event.files > 1) {
				process.stderr.write(
					`  ${IMPORT_SLICE_LABELS[event.slice]} ${String(event.processed)}/${String(event.files)}\n`,
				);
			}
			return;
		case "slice-done":
			process.stderr.write(
				`  ${IMPORT_SLICE_LABELS[event.slice]}: ${event.count.toLocaleString()}\n`,
			);
			return;
		case "writing":
			process.stderr.write("Writing to database…\n");
			return;
		case "write-start":
			process.stderr.write(
				`Writing ${IMPORT_WRITE_LABELS[event.phase]}… (${event.total.toLocaleString()})\n`,
			);
			return;
		case "write-progress":
			process.stderr.write(
				`  ${IMPORT_WRITE_LABELS[event.phase]} ${event.processed.toLocaleString()}/${event.total.toLocaleString()}\n`,
			);
			return;
		case "done":
			process.stderr.write("Import complete.\n");
	}
}

function parseActionsTransport(value: string | undefined) {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "auto" || normalized === "bird" || normalized === "xurl") {
		return normalized;
	}
	printError("transport must be auto, bird, or xurl");
	process.exitCode = 1;
	return undefined;
}

function parseArchiveImportSelect(value: string | undefined) {
	if (value === undefined) return undefined;
	const aliases: Record<string, ArchiveImportSlice> = Object.assign(
		Object.create(null) as Record<string, ArchiveImportSlice>,
		{
			tweets: "tweets",
			likes: "likes",
			bookmarks: "bookmarks",
			directmessages: "directMessages",
			"direct-messages": "directMessages",
			dms: "directMessages",
			profiles: "profiles",
			followers: "followers",
			following: "following",
		},
	);
	const selected: ArchiveImportSlice[] = [];
	const seen = new Set<ArchiveImportSlice>();
	for (const rawItem of value.split(",")) {
		const item = rawItem.trim();
		if (!item) continue;
		const slice = aliases[item] ?? aliases[item.toLowerCase()];
		if (!slice) {
			printError(
				`--select must be a comma-separated subset of ${ARCHIVE_IMPORT_SLICES.join(", ")}`,
			);
			process.exitCode = 1;
			return undefined;
		}
		if (!seen.has(slice)) {
			seen.add(slice);
			selected.push(slice);
		}
	}
	if (selected.length === 0) {
		printError(
			`--select must include at least one of ${ARCHIVE_IMPORT_SLICES.join(", ")}`,
		);
		process.exitCode = 1;
		return undefined;
	}
	return selected;
}

export function registerCoreCommands({
	program,
	print,
	asJson,
	autoSyncAfterWrite,
	parsePositiveIntegerOption,
}: CliCommandContext) {
	async function runFxTwitterCommand<T>(run: () => Promise<T>) {
		try {
			return await run();
		} catch (error) {
			if (!(error instanceof FxTwitterError)) throw error;
			console.error(
				JSON.stringify({
					error: {
						kind: error.kind,
						message: error.message,
						status: error.status,
						retryAfterMs: error.retryAfterMs,
					},
				}),
			);
			process.exitCode = 1;
			return undefined;
		}
	}

	function requireFxTwitterOptIn(enabled: boolean | undefined) {
		if (enabled) return true;
		printError(
			"FxTwitter public reads are off by default. Pass --fxtwitter to disclose the requested tweet IDs, handles, or queries plus network metadata and timing to api.fxtwitter.com.",
		);
		process.exitCode = 1;
		return false;
	}

	program
		.command("init")
		.description("Create an empty local birdclaw workspace")
		.option("--demo", "Seed sample tweets and DMs for offline exploration")
		.action((options: { demo?: boolean }) => {
			const paths = ensureBirdclawDirs();
			const db = getNativeDb({ seedDemoData: false });
			const demo = options.demo
				? { requested: true, ...seedDemoData(db) }
				: { requested: false };
			print(
				{
					ok: true,
					demo,
					rootDir: paths.rootDir,
					configPath: paths.configPath,
					dbPath: paths.dbPath,
					mediaOriginalsDir: paths.mediaOriginalsDir,
					mediaThumbsDir: paths.mediaThumbsDir,
					nextSteps: options.demo
						? [
								"birdclaw search tweets --limit 5",
								"birdclaw dms list --limit 5",
								"birdclaw serve",
							]
						: ["birdclaw import archive <path>", "birdclaw init --demo"],
				},
				asJson(),
			);
		});

	const authCommand = program
		.command("auth")
		.description("Manage live transport");
	authCommand
		.command("status")
		.description("Show transport status")
		.action(async () => {
			const meta = await getQueryEnvelope();
			print(meta.transport, asJson());
		});
	authCommand
		.command("use <transport>")
		.description("Set preferred moderation action transport")
		.action((transport: string) => {
			const parsed = parseActionsTransport(transport);
			if (parsed) print(setActionsTransport(parsed), asJson());
		});

	const archiveCommand = program
		.command("archive")
		.description("Find and inspect Twitter archives");
	archiveCommand
		.command("find")
		.description("Find likely Twitter archives on disk")
		.action(async () => print(await findArchives(), asJson()));

	const importCommand = program
		.command("import")
		.description("Import local or explicitly selected public data");
	importCommand
		.command("archive [archivePath]")
		.description("Import a Twitter archive into the local SQLite store")
		.option(
			"--select <kinds>",
			`Import only selected archive slices: ${ARCHIVE_IMPORT_SLICES.join(", ")}`,
		)
		.option(
			"--restore",
			"Exactly replace imported archive slices instead of safely merging",
		)
		.action(
			async (archivePath, options: { select?: string; restore?: boolean }) => {
				const select = parseArchiveImportSelect(options.select);
				if (options.select !== undefined && !select) return;
				let resolvedArchivePath = archivePath;
				if (!resolvedArchivePath) {
					const [latestArchive] = await findArchives();
					resolvedArchivePath = latestArchive?.path;
				}
				if (!resolvedArchivePath) {
					throw new Error(
						"No archive found. Pass a path or place one in Downloads.",
					);
				}
				const json = Boolean(asJson());
				const result = await importArchive(resolvedArchivePath, {
					select,
					...(options.restore ? { restore: true } : {}),
					...(!json ? { onProgress: logImportProgress } : {}),
				});
				await autoSyncAfterWrite();
				print(result, json);
			},
		);
	importCommand
		.command("tweet <tweets...>")
		.description(
			"Import public tweets through an explicitly selected read-only transport",
		)
		.option(
			"--fxtwitter",
			"Send tweet IDs to the fixed third-party api.fxtwitter.com endpoint",
		)
		.action(async (tweets: string[], options: { fxtwitter?: boolean }) => {
			if (!requireFxTwitterOptIn(options.fxtwitter)) return;
			const result = await runFxTwitterCommand(() =>
				importTweetsViaFxTwitter(tweets),
			);
			if (!result) return;
			await autoSyncAfterWrite();
			print(result, asJson());
		});
	for (const endpointFamily of ["thread", "conversation"] as const) {
		importCommand
			.command(`${endpointFamily} <tweet>`)
			.description(
				`Import an explicitly requested public ${endpointFamily} through FxTwitter`,
			)
			.option(
				"--fxtwitter",
				"Send the tweet ID to the fixed third-party api.fxtwitter.com endpoint",
			)
			.option("--limit <n>", "Maximum observed tweets to import", "500")
			.action(
				async (
					tweet: string,
					options: { fxtwitter?: boolean; limit?: string },
				) => {
					if (!requireFxTwitterOptIn(options.fxtwitter)) return;
					const limit = parsePositiveIntegerOption(options.limit, "--limit");
					if (limit === undefined) return;
					const result = await runFxTwitterCommand(() =>
						endpointFamily === "thread"
							? importThreadViaFxTwitter(tweet, { limit })
							: importConversationViaFxTwitter(tweet, { limit }),
					);
					if (!result) return;
					await autoSyncAfterWrite();
					print(result, asJson());
				},
			);
	}
	importCommand
		.command("profile <handle>")
		.description(
			"Import an explicitly requested public profile through FxTwitter",
		)
		.option(
			"--fxtwitter",
			"Send the handle to the fixed third-party api.fxtwitter.com endpoint",
		)
		.action(async (handle: string, options: { fxtwitter?: boolean }) => {
			if (!requireFxTwitterOptIn(options.fxtwitter)) return;
			const result = await runFxTwitterCommand(() =>
				importProfileViaFxTwitter(handle),
			);
			if (!result) return;
			await autoSyncAfterWrite();
			print(result, asJson());
		});
	importCommand
		.command("hydrate-profiles")
		.description(
			"Backfill archive-imported profiles from live Twitter metadata",
		)
		.option("--account <username>", "Account username or id")
		.action(async (options) => {
			const result = await hydrateProfilesFromX({ account: options.account });
			await autoSyncAfterWrite();
			print(result, asJson());
		});
}
