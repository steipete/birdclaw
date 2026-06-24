import { clearAccountBirdProfile, setAccountBirdProfile } from "#/lib/accounts";
import type { CliCommandContext } from "./command-context";

export function registerAccountCommands({ program, print }: CliCommandContext) {
	const accountsCommand = program
		.command("accounts")
		.description("Manage local Birdclaw account settings");

	accountsCommand
		.command("set-bird-profile")
		.description("Attach a bird relay profile name to a local account")
		.requiredOption("--account <accountId>", "Account id")
		.requiredOption("--profile-name <name>", "bird relay profile name")
		.action(async (options) => {
			const result = await setAccountBirdProfile(
				options.account,
				options.profileName,
			);
			print(result, true);
		});

	accountsCommand
		.command("clear-bird-profile")
		.description("Remove the bird relay profile name from a local account")
		.requiredOption("--account <accountId>", "Account id")
		.action(async (options) => {
			const result = await clearAccountBirdProfile(options.account);
			print(result, true);
		});
}
