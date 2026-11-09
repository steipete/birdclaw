import {
	getFollowGraphSummary,
	listFollowEvents,
	listMutuals,
	listNonMutualFollowing,
	listTopFollowers,
	listUnfollowedSince,
} from "#/lib/follow-graph";
import type { CliCommandContext } from "./command-context";

export function registerGraphCommands({
	program,
	print,
	autoUpdateBeforeRead,
}: CliCommandContext) {
	const graphCommand = program
		.command("graph")
		.description("Query the local cache-only follow graph");

	graphCommand
		.command("summary")
		.description(
			"Summarize cached followers, following, mutuals, and snapshots",
		)
		.option("--account <username>", "Account username or id")
		.action(async (options) => {
			await autoUpdateBeforeRead();
			print(getFollowGraphSummary({ account: options.account }), true);
		});

	graphCommand
		.command("top-followers")
		.description("List current followers sorted by their follower count")
		.option("--account <username>", "Account username or id")
		.option("--limit <n>", "Limit results", "20")
		.action(async (options) => {
			await autoUpdateBeforeRead();
			print(
				listTopFollowers({
					account: options.account,
					limit: Number(options.limit),
				}),
				true,
			);
		});

	graphCommand
		.command("unfollowed")
		.description("List cached ended follow edges since a date")
		.requiredOption("--date <date>", "YYYY-MM-DD or ISO timestamp")
		.option("--account <username>", "Account username or id")
		.option("--direction <direction>", "followers or following", "followers")
		.option("--limit <n>", "Limit results", "100")
		.action(async (options) => {
			await autoUpdateBeforeRead();
			print(
				listUnfollowedSince({
					account: options.account,
					date: options.date,
					direction:
						options.direction === "following" ? "following" : "followers",
					limit: Number(options.limit),
				}),
				true,
			);
		});

	graphCommand
		.command("events")
		.description("List cached append-only follow graph events")
		.option("--account <username>", "Account username or id")
		.option("--direction <direction>", "followers or following")
		.option("--kind <kind>", "started or ended")
		.option("--since <date>", "YYYY-MM-DD or ISO timestamp")
		.option("--until <date>", "YYYY-MM-DD or ISO timestamp")
		.option("--limit <n>", "Limit results", "100")
		.action(async (options) => {
			await autoUpdateBeforeRead();
			print(
				listFollowEvents({
					account: options.account,
					direction:
						options.direction === "followers" ||
						options.direction === "following"
							? options.direction
							: undefined,
					kind:
						options.kind === "started" || options.kind === "ended"
							? options.kind
							: undefined,
					since: options.since,
					until: options.until,
					limit: Number(options.limit),
				}),
				true,
			);
		});

	graphCommand
		.command("non-mutual-following")
		.description("List current following who are not current followers")
		.option("--account <username>", "Account username or id")
		.option("--sort <mode>", "followers or handle", "followers")
		.option("--limit <n>", "Limit results", "100")
		.action(async (options) => {
			await autoUpdateBeforeRead();
			print(
				listNonMutualFollowing({
					account: options.account,
					sort: options.sort === "handle" ? "handle" : "followers",
					limit: Number(options.limit),
				}),
				true,
			);
		});

	graphCommand
		.command("mutuals")
		.description("List profiles that are both followers and following")
		.option("--account <username>", "Account username or id")
		.option("--limit <n>", "Limit results", "100")
		.action(async (options) => {
			await autoUpdateBeforeRead();
			print(
				listMutuals({
					account: options.account,
					limit: Number(options.limit),
				}),
				true,
			);
		});
}
