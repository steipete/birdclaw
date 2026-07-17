import { listStoredXListMembers, listStoredXLists } from "#/lib/x-lists";
import type { CliCommandContext } from "./command-context";

export function registerListCommands({
	program,
	print,
	asJson,
	autoUpdateBeforeRead,
}: CliCommandContext) {
	const listsCommand = program
		.command("lists")
		.description("Inspect cached X Lists and membership");

	listsCommand
		.command("list")
		.description("List cached owned X Lists")
		.option("--account <username>", "Account username or id")
		.action(async (options) => {
			await autoUpdateBeforeRead();
			const items = listStoredXLists({ account: options.account });
			if (asJson()) {
				print(items, true);
				return;
			}
			console.log(
				items
					.map(
						(item) =>
							`${item.name}\t${item.listId}\t${item.membershipStatus}\t${String(item.memberResultCount)}/${item.memberCount === undefined ? "?" : String(item.memberCount)}`,
					)
					.join("\n"),
			);
		});

	listsCommand
		.command("members [name]")
		.description("List cached members for one X List")
		.option("--list-id <id>", "Select by List id")
		.option("--account <username>", "Account username or id")
		.option("--include-ended", "Include members absent from a complete sync")
		.option("--limit <n>", "Limit results", "100")
		.action(async (name, options) => {
			await autoUpdateBeforeRead();
			const result = listStoredXListMembers({
				account: options.account,
				name,
				listId: options.listId,
				includeEnded: Boolean(options.includeEnded),
				limit: Number(options.limit),
			});
			if (asJson()) {
				print(result, true);
				return;
			}
			console.log(
				result.items
					.map(
						(item) =>
							`@${item.profile.handle}\t${item.externalUserId}\t${item.current ? "current" : "ended"}`,
					)
					.join("\n"),
			);
		});
}
