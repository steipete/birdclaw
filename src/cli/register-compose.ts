import { resolveOperationAccount } from "#/lib/account-selection";
import {
	createDmReply,
	createPost,
	createTweetReply,
} from "#/lib/query-actions";
import type { CliCommandContext } from "./command-context";

export function registerComposeCommands({
	program,
	print,
	asJson,
	autoSyncAfterWrite,
}: CliCommandContext) {
	const composeCommand = program
		.command("compose")
		.description("Create local/xurl actions");

	composeCommand
		.command("post <text>")
		.option("--account <username>", "Account username or id")
		.action(async (text, options) => {
			const result = await createPost(
				resolveOperationAccount(options.account).id,
				text,
			);
			await autoSyncAfterWrite();
			print(result, asJson());
		});

	composeCommand
		.command("reply <tweetId> <text>")
		.option("--account <username>", "Account username or id")
		.action(async (tweetId, text, options) => {
			const result = await createTweetReply(
				resolveOperationAccount(options.account).id,
				tweetId,
				text,
			);
			await autoSyncAfterWrite();
			print(result, asJson());
		});

	composeCommand
		.command("dm <conversationId> <text>")
		.description("Reply inside an existing DM conversation")
		.option("--account <username>", "Account username or id")
		.action(async (conversationId, text, options) => {
			const result = await createDmReply(conversationId, text, options.account);
			await autoSyncAfterWrite();
			print(result, asJson());
		});
}
