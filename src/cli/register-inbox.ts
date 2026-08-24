import { listInboxItems, scoreInbox } from "#/lib/inbox";
import type { CliCommandContext } from "./command-context";

export function registerInboxCommand({
	program,
	print,
	asJson,
	autoSyncAfterWrite,
	autoUpdateBeforeRead,
	parseNonNegativeIntegerOption,
}: CliCommandContext) {
	program
		.command("inbox")
		.option("--kind <kind>", "mixed, mentions, or dms", "mixed")
		.option("--min-score <n>", "Minimum rank", "0")
		.option("--hide-low-signal", "Hide low-signal items")
		.option("--score", "Score top items with OpenAI before listing")
		.option("--limit <n>", "Limit results", "20")
		.action(async (options) => {
			const minScore = parseNonNegativeIntegerOption(
				options.minScore,
				"--min-score",
			);
			if (minScore === undefined) return;
			const limit = parseNonNegativeIntegerOption(options.limit, "--limit");
			if (limit === undefined) return;
			await autoUpdateBeforeRead();
			const kind =
				options.kind === "mentions" || options.kind === "dms"
					? options.kind
					: "mixed";
			if (options.score) {
				await scoreInbox({
					kind,
					limit,
				});
				await autoSyncAfterWrite();
			}
			print(
				listInboxItems({
					kind,
					minScore,
					hideLowSignal: Boolean(options.hideLowSignal),
					limit,
				}),
				asJson(),
			);
		});
}
