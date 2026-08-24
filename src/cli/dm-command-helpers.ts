import type { DirectMessagesSyncMode } from "#/lib/dms-live";
import { resolveProfilesForIds } from "#/lib/profile-resolver";
import { listDmConversations } from "#/lib/dm-read-model";
import { expandUrlsFromTexts } from "#/lib/url-expansion";
import { printError } from "./command-context";

export function parseDmInboxOption(
	value: string | undefined,
): "all" | "accepted" | "requests" | undefined {
	const normalized = (value ?? "all").trim().toLowerCase();
	if (
		normalized === "all" ||
		normalized === "accepted" ||
		normalized === "requests"
	) {
		return normalized;
	}
	if (normalized === "request") return "requests";
	printError("--inbox must be all, accepted, or requests");
	process.exitCode = 1;
	return undefined;
}

export function parseDmSyncModeOption(
	value: string | undefined,
): DirectMessagesSyncMode | undefined {
	const normalized = (value ?? "bird").trim().toLowerCase();
	if (normalized === "auto" || normalized === "bird" || normalized === "xurl") {
		return normalized;
	}
	printError("--mode must be auto, bird, or xurl");
	process.exitCode = 1;
	return undefined;
}

export async function enrichDmItems(
	query: Parameters<typeof listDmConversations>[0],
	options: {
		resolveProfiles?: boolean;
		expandUrls?: boolean;
		refreshProfileCache?: boolean;
		refreshUrlCache?: boolean;
		xurlFallback?: boolean;
	},
) {
	let items = listDmConversations(query);
	const profileResolution = options.resolveProfiles
		? await resolveProfilesForIds(
				items.map((item) => item.participant.id),
				{
					refresh: options.refreshProfileCache,
					xurlFallback: options.xurlFallback ?? true,
				},
			)
		: undefined;
	if (profileResolution) items = listDmConversations(query);
	const urlExpansions = options.expandUrls
		? await expandUrlsFromTexts(
				items.flatMap((item) => [
					item.lastMessagePreview,
					item.searchSnippet ?? "",
					...(item.matches ?? []).flatMap((match) => [
						...match.before.map((message) => message.text),
						match.message.text,
						...match.after.map((message) => message.text),
					]),
				]),
				{ refresh: options.refreshUrlCache },
			)
		: undefined;
	if (!profileResolution && !urlExpansions) return items;
	return {
		items,
		...(profileResolution ? { profileResolution } : {}),
		...(urlExpansions ? { urlExpansions } : {}),
	};
}
