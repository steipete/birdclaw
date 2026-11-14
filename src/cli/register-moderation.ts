import { registerModerationCommands as registerCommands } from "#/cli-moderation";
import { importBlocklist } from "#/lib/blocklist";
import { CliInputError } from "./numeric-options";
import type { CliCommandContext } from "./command-context";

export function registerModerationCommands(context: CliCommandContext) {
	registerCommands({
		program: context.program,
		print: context.print,
		asJson: context.asJson,
		importBlocklist,
		resolveActionOptions: ({ transport }: { transport?: string }) => {
			if (
				transport !== undefined &&
				transport !== "auto" &&
				transport !== "bird" &&
				transport !== "xurl"
			) {
				throw new CliInputError("--transport must be auto, bird, or xurl");
			}
			return { transport };
		},
	});
}
