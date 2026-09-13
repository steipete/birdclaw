function stringValue(value: unknown, fallback = "") {
	return typeof value === "string" ? value : fallback;
}

function enumValue<const T extends string>(
	value: unknown,
	values: readonly T[],
	fallback: T,
) {
	return typeof value === "string" && values.includes(value as T)
		? (value as T)
		: fallback;
}

function booleanValue(value: unknown, fallback = false) {
	if (value === true || value === "true" || value === "1") return true;
	if (value === false || value === "false" || value === "0") return false;
	return fallback;
}

export interface RouteSearchUpdateOptions {
	replace?: boolean;
}

export type RouteSearchChange<T> = (
	next: T,
	options?: RouteSearchUpdateOptions,
) => void;

export type DmsRouteSearch = ReturnType<typeof validateDmsSearch>;

export function validateDmsSearch(search: Record<string, unknown>) {
	return {
		inbox: enumValue(search.inbox, ["all", "accepted", "requests"], "all"),
		reply: enumValue(
			search.reply,
			["all", "unreplied", "replied"],
			"unreplied",
		),
		minFollowers: stringValue(search.minFollowers),
		minInfluence: stringValue(search.minInfluence),
		sort: enumValue(search.sort, ["recent", "followers"], "recent"),
		q: stringValue(search.q),
		conversation: stringValue(search.conversation),
	};
}

export type InboxRouteSearch = ReturnType<typeof validateInboxSearch>;

export function validateInboxSearch(search: Record<string, unknown>) {
	return {
		kind: enumValue(search.kind, ["mixed", "mentions", "dms"], "mixed"),
		minScore: stringValue(search.minScore, "40"),
		hideLowSignal: booleanValue(search.hideLowSignal, true),
	};
}

export type LinksRouteSearch = ReturnType<typeof validateLinksSearch>;

export function validateLinksSearch(search: Record<string, unknown>) {
	return {
		kind: enumValue(search.kind, ["links", "videos"], "links"),
		range: enumValue(
			search.range,
			["today", "week", "month", "year", "all"],
			"week",
		),
		source: enumValue(search.source, ["all", "tweet", "dm"], "all"),
		sort: enumValue(search.sort, ["rank", "recent", "comments"], "rank"),
		q: stringValue(search.q),
	};
}

export type DiscussRouteSearch = ReturnType<typeof validateDiscussSearch>;

export function validateDiscussSearch(search: Record<string, unknown>) {
	return {
		q: stringValue(search.q),
		question: stringValue(search.question),
		source: enumValue(
			search.source,
			["search", "all", "home", "mentions", "authored", "likes", "bookmarks"],
			"search",
		),
		mode: enumValue(search.mode, ["auto", "bird", "xurl", "local"], "xurl"),
		includeDms: booleanValue(search.includeDms),
	};
}

export type PeriodRouteSearch = "today" | "24h" | "yesterday" | "week";

export type TodayRouteSearch = ReturnType<typeof validateTodaySearch>;

export function validateTodaySearch(search: Record<string, unknown>) {
	return {
		period: enumValue(
			search.period,
			["today", "24h", "yesterday", "week"],
			"today",
		),
		includeDms: booleanValue(search.includeDms),
	};
}

export type NetworkMapRouteSearch = ReturnType<typeof validateNetworkMapSearch>;

export function validateNetworkMapSearch(search: Record<string, unknown>) {
	return {
		type: enumValue(
			search.type,
			["all", "followers", "following", "mutual"],
			"all",
		),
		q: stringValue(search.q),
	};
}

export type BlocksRouteSearch = ReturnType<typeof validateBlocksSearch>;

export function validateBlocksSearch(search: Record<string, unknown>) {
	return {
		account: stringValue(search.account, "acct_primary"),
		q: stringValue(search.q),
	};
}
