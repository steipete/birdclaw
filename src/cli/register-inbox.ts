import { listInboxItems, scoreInbox } from "#/lib/inbox";
import type { CliCommandContext } from "./command-context";
import { CliInputError } from "./numeric-options";

export function registerInboxCommand({
	program,
	print,
	asJson,
	autoSyncAfterWrite,
	autoUpdateBeforeRead,
	parseFiniteNumberOption,
	parseLimitOption,
}: CliCommandContext) {
	program
		.command("inbox")
		.option("--account <username>", "Account username or id")
		.option("--kind <kind>", "mixed, mentions, or dms", "mixed")
		.option("--min-score <n>", "Minimum rank", "0")
		.option("--hide-low-signal", "Hide low-signal items")
		.option("--score", "Score top items with OpenAI before listing")
		.option("--limit <n>", "Limit results", "20")
		.action(async (options) => {
			const minScore = parseFiniteNumberOption(options.minScore, "--min-score");

			const limit = parseLimitOption(options.limit, "--limit");

			const kind = options.kind;
			if (kind !== "mixed" && kind !== "mentions" && kind !== "dms") {
				throw new CliInputError("--kind must be mixed, mentions, or dms");
			}
			await autoUpdateBeforeRead();
			if (options.score) {
				await scoreInbox({
					kind,
					account: options.account,
					limit,
				});
				await autoSyncAfterWrite();
			}
			print(
				listInboxItems({
					kind,
					account: options.account,
					minScore,
					hideLowSignal: Boolean(options.hideLowSignal),
					limit,
				}),
				asJson(),
			);
		});
}
