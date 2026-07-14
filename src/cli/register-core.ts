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
import { hydrateProfilesFromX } from "#/lib/profile-hydration";
import { getQueryEnvelope } from "#/lib/queries";
import { printError, type CliCommandContext } from "./command-context";

const IMPORT_SLICE_LABELS: Record<ImportProgressSlice, string> = {
	tweets: "tweets",
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
}: CliCommandContext) {
	program
		.command("init")
		.description("Create local birdclaw root and seed the database")
		.option(
			"--account <username>",
			"Select an authenticated xurl account instead of its default",
		)
		.action(async (options: { account?: string }) => {
			const selectedAccount = options.account?.trim().replace(/^@/, "");
			if (options.account !== undefined && !selectedAccount) {
				throw new Error("--account requires a non-empty username");
			}
			const paths = ensureBirdclawDirs();
			await getQueryEnvelope();
			const account =
				selectedAccount === undefined
					? undefined
					: await hydrateProfilesFromX({
							account: selectedAccount,
							accountOnly: true,
							seededAccountOnly: true,
						});
			if (selectedAccount !== undefined && !account?.account) {
				throw new Error(
					account?.reason ??
						`Could not select authenticated xurl account @${selectedAccount}`,
				);
			}
			print(
				{
					ok: true,
					...(account?.account ? { account: account.account } : {}),
					rootDir: paths.rootDir,
					configPath: paths.configPath,
					dbPath: paths.dbPath,
					mediaOriginalsDir: paths.mediaOriginalsDir,
					mediaThumbsDir: paths.mediaThumbsDir,
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

	program
		.command("archive find")
		.description("Find likely Twitter archives on disk")
		.action(async () => print(await findArchives(), asJson()));

	const importCommand = program
		.command("import")
		.description("Import local archive data");
	importCommand
		.command("archive [archivePath]")
		.description("Import a Twitter archive into the local SQLite store")
		.option(
			"--select <kinds>",
			`Import only selected archive slices: ${ARCHIVE_IMPORT_SLICES.join(", ")}`,
		)
		.action(async (archivePath, options: { select?: string }) => {
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
				onProgress: json ? undefined : logImportProgress,
			});
			await autoSyncAfterWrite();
			print(result, json);
		});
	importCommand
		.command("hydrate-profiles")
		.description(
			"Backfill archive-imported profiles from live Twitter metadata",
		)
		.action(async () => {
			const result = await hydrateProfilesFromX();
			await autoSyncAfterWrite();
			print(result, asJson());
		});
}
