import {
	installDigestLaunchAgent,
	runDigestJob,
} from "#/lib/digest-job";
import type { CliCommandContext } from "./command-context";

export function registerDigestJobCommands({ print }: CliCommandContext) {
	return {
		register(jobsCommand: ReturnType<CliCommandContext["program"]["command"]>) {
			jobsCommand
				.command("run-digest")
				.description(
					"Generate an AI digest for a rolling time window and optionally notify Discord",
				)
				.option("--account <accountId>", "Account id")
				.option("--window-hours <hours>", "Hours to look back", "6")
				.option(
					"--period <period>",
					"Period preset: today, 24h, yesterday, week (overrides --window-hours)",
				)
				.option("--include-dms", "Include private DM context")
				.option("--model <model>", "OpenAI model id")
				.option(
					"--language <tag>",
					"Report language as a Unicode locale id",
				)
				.option("--max-tweets <n>", "Maximum tweet context")
				.option("--max-links <n>", "Maximum linked articles")
				.option("--log <path>", "Audit JSONL path")
				.action(async (options) => {
					const result = await runDigestJob({
						account: options.account,
						windowHours: Number(options.windowHours),
						period: options.period,
						includeDms: Boolean(options.includeDms),
						model: options.model,
						language: options.language,
						maxTweets: options.maxTweets !== undefined ? Number(options.maxTweets) : undefined,
						maxLinks: options.maxLinks !== undefined ? Number(options.maxLinks) : undefined,
						logPath: options.log,
					});
					print(result, true);
					if (!result.ok) process.exitCode = 1;
				});

			jobsCommand
				.command("install-digest-launchd")
				.description("Install a LaunchAgent that runs digest every hour")
				.option("--label <label>", "LaunchAgent label")
				.option("--interval-seconds <seconds>", "Launch interval", "3600")
				.option("--program <path>", "birdclaw executable or command", "birdclaw")
				.option("--account <accountId>", "Account id")
				.option("--window-hours <hours>", "Hours to look back", "6")
				.option("--period <period>", "Period preset")
				.option("--include-dms", "Include private DM context")
				.option("--model <model>", "OpenAI model id")
				.option(
					"--language <tag>",
					"Report language as a Unicode locale id",
				)
				.option("--max-tweets <n>", "Maximum tweet context")
				.option("--max-links <n>", "Maximum linked articles")
				.option("--log <path>", "Audit JSONL path")
				.option("--env-path <path>", "Shell env file to source before running")
				.option("--env-file <path>", "Deprecated alias for --env-path")
				.option("--stdout <path>", "launchd stdout path")
				.option("--stderr <path>", "launchd stderr path")
				.option("--launch-agents-dir <path>", "LaunchAgents directory")
				.option("--no-load", "Write plist without loading it")
				.action(async (options) => {
					const result = await installDigestLaunchAgent({
						label: options.label,
						intervalSeconds: Number(options.intervalSeconds),
						program: options.program,
						account: options.account,
						windowHours: Number(options.windowHours),
						period: options.period,
						includeDms: Boolean(options.includeDms),
						model: options.model,
						language: options.language,
						maxTweets: options.maxTweets !== undefined ? Number(options.maxTweets) : undefined,
						maxLinks: options.maxLinks !== undefined ? Number(options.maxLinks) : undefined,
						logPath: options.log,
						envFile: options.envPath ?? options.envFile,
						stdoutPath: options.stdout,
						stderrPath: options.stderr,
						launchAgentsDir: options.launchAgentsDir,
						load: options.load,
					});
					print(result, true);
				});
		},
	};
}
