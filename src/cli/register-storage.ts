import {
	exportBackup,
	importBackup,
	syncBackup,
	validateBackup,
} from "#/lib/backup";
import { getBirdclawPaths } from "#/lib/config";
import { getDatabaseRuntimeMetrics } from "#/lib/database-metrics";
import { getQueryEnvelope } from "#/lib/queries";
import type { CliCommandContext } from "./command-context";

export function registerStorageCommands({
	program,
	print,
	asJson,
	autoUpdateBeforeRead,
}: CliCommandContext) {
	program
		.command("db stats")
		.description("Show local storage and dataset stats")
		.action(async () => {
			await autoUpdateBeforeRead();
			const meta = await getQueryEnvelope({ includeArchives: false });
			const paths = getBirdclawPaths();
			print(
				{
					paths,
					database: getDatabaseRuntimeMetrics(),
					stats: meta.stats,
					transport: meta.transport,
				},
				asJson(),
			);
		});

	const backupCommand = program
		.command("backup")
		.description("Export, import, and validate Git-friendly text backups");

	backupCommand
		.command("export")
		.description("Export canonical JSONL backup shards")
		.requiredOption("--repo <path>", "Backup repository/path")
		.option("--commit", "Create a git commit in the backup repo")
		.option("--push", "Push the backup repo after committing")
		.option(
			"--message <message>",
			"Git commit message",
			"archive: update birdclaw backup",
		)
		.option("--no-validate", "Skip post-export validation")
		.action(async (options) => {
			const result = await exportBackup({
				repoPath: options.repo,
				commit: Boolean(options.commit) || Boolean(options.push),
				push: Boolean(options.push),
				message: options.message,
				validate: options.validate,
			});
			print(result, true);
		});

	backupCommand
		.command("import <repo>")
		.description("Merge a canonical JSONL backup into the local SQLite store")
		.option("--no-validate", "Skip backup validation before import")
		.option("--restore", "Exactly replace local portable tables")
		.option("--replace", "Deprecated alias for --restore")
		.action(async (repo, options) => {
			const result = await importBackup({
				repoPath: repo,
				validate: options.validate,
				mode: options.restore || options.replace ? "replace" : "merge",
			});
			print(result, true);
		});

	backupCommand
		.command("sync")
		.description("Pull, merge-import, export, commit, and push a backup repo")
		.requiredOption("--repo <path>", "Backup repository/path")
		.option("--remote <url>", "Git remote to clone/configure")
		.option(
			"--message <message>",
			"Git commit message",
			"archive: sync birdclaw backup",
		)
		.action(async (options) => {
			const result = await syncBackup({
				repoPath: options.repo,
				remote: options.remote,
				message: options.message,
			});
			print(result, true);
		});

	backupCommand
		.command("validate <repo>")
		.description("Validate backup manifest, shard hashes, and JSONL rows")
		.action(async (repo) => {
			const result = await validateBackup(repo);
			print(result, true);
			if (!result.ok) {
				process.exitCode = 1;
			}
		});
}
