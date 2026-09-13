import { resolveOperationAccount } from "#/lib/account-selection";
import { getConversationThread } from "#/lib/dm-read-model";
import { getTweetConversation } from "#/lib/timeline-read-model";
import type { CliCommandContext } from "./command-context";

export function registerShowCommands({
	program,
	print,
	asJson,
	autoUpdateBeforeRead,
	parsePositiveLimitOption,
}: CliCommandContext) {
	const show = program
		.command("show")
		.description("Read stored tweets and conversations");
	show
		.command("tweet <id>")
		.description("Show one cached tweet")
		.option("--account <username>", "Account username or id")
		.action(async (id: string, options) => {
			await autoUpdateBeforeRead();
			const account = resolveOperationAccount(options.account);
			const conversation = getTweetConversation(
				id.trim(),
				1,
				undefined,
				account.id,
			);
			const tweet = conversation?.items.find(
				(item) => item.id === conversation.anchorId,
			);
			if (!tweet) throw new Error(`Tweet not found in selected account: ${id}`);
			print(tweet, asJson());
		});
	show
		.command("thread <id>")
		.description("Show a cached tweet conversation and its truncation status")
		.option("--account <username>", "Account username or id")
		.option("--limit <n>", "Maximum tweets in the conversation", "80")
		.action(async (id: string, options) => {
			const limit = parsePositiveLimitOption(options.limit, "--limit");

			await autoUpdateBeforeRead();
			const account = resolveOperationAccount(options.account);
			const conversation = getTweetConversation(
				id.trim(),
				limit,
				undefined,
				account.id,
			);
			if (!conversation)
				throw new Error(`Tweet not found in selected account: ${id}`);
			print(conversation, asJson());
		});
	show
		.command("dm <conversationId>")
		.description("Show a complete cached DM conversation")
		.option("--account <username>", "Account username or id")
		.action(async (conversationId: string, options) => {
			await autoUpdateBeforeRead();
			const account = resolveOperationAccount(options.account);
			const conversation = getConversationThread(conversationId.trim(), {
				account: account.id,
			});
			if (!conversation)
				throw new Error(
					`DM conversation not found in selected account: ${conversationId}`,
				);
			print(conversation, asJson());
		});
}
