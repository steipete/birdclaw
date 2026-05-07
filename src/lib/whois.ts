import { getNativeDb } from "./db";
import { fetchProfileBioEntities } from "./profile-bio-entities";
import { fetchProfileSnapshots } from "./profile-history";
import { expandUrlsFromTexts } from "./url-expansion";
import { resolveProfilesForIds } from "./profile-resolver";
import { listDmConversations, listTimelineItems } from "./queries";
import type {
	DmConversationItem,
	ProfileAffiliation,
	ProfileBioEntity,
	ProfileRecord,
	ProfileSnapshot,
	TimelineItem,
	UrlExpansionItem,
} from "./types";

export interface WhoisOptions {
	account?: string;
	dms?: boolean;
	tweets?: boolean;
	resolveProfiles?: boolean;
	expandUrls?: boolean;
	refreshProfileCache?: boolean;
	refreshUrlCache?: boolean;
	xurlFallback?: boolean;
	context?: number;
	limit?: number;
}

export interface WhoisCandidate {
	conversation: DmConversationItem;
	confidence: number;
	reasons: string[];
	profileEvidence: WhoisEvidenceSignal[];
	evidence: Array<{
		messageId: string;
		createdAt: string;
		direction: string;
		text: string;
		urlExpansions?: UrlExpansionItem[];
	}>;
}

export interface WhoisResult {
	query: string;
	candidates: WhoisCandidate[];
	relatedTweets: TimelineItem[];
	urlExpansions: UrlExpansionItem[];
	profileResolution?: Awaited<ReturnType<typeof resolveProfilesForIds>>;
}

export interface WhoisEvidenceSignal {
	kind:
		| "profile_handle"
		| "profile_name"
		| "profile_bio"
		| "profile_location"
		| "profile_url"
		| "profile_bio_url"
		| "profile_verified_type"
		| "affiliation"
		| "bio_handle"
		| "bio_domain"
		| "bio_company"
		| "profile_history"
		| "dm_context"
		| "expanded_url";
	value: string;
	source: "profile" | "affiliation" | "bio_entity" | "history" | "dm" | "url";
}

function normalizeQuery(query: string) {
	return query.trim().toLowerCase();
}

function getSignificantQueryTerms(query: string) {
	const stopwords = new Set([
		"a",
		"an",
		"and",
		"at",
		"for",
		"from",
		"guy",
		"is",
		"of",
		"person",
		"the",
		"who",
		"with",
	]);
	return Array.from(
		new Set(
			normalizeQuery(query)
				.split(/[^a-z0-9_@.-]+/)
				.map((term) => term.replace(/^@/, ""))
				.filter((term) => term.length >= 3 && !stopwords.has(term)),
		),
	);
}

function matchesQueryText(query: string, value: string | undefined | null) {
	if (!value) {
		return false;
	}
	const normalizedValue = value.toLowerCase();
	if (normalizedValue.includes(query)) {
		return true;
	}
	return getSignificantQueryTerms(query).some((term) =>
		normalizedValue.includes(term),
	);
}

function getDmSearchQueries(query: string) {
	const trimmed = query.trim();
	const values = [trimmed, ...getSignificantQueryTerms(trimmed)];
	return Array.from(new Set(values.filter((value) => value.length > 0)));
}

function getMessageTexts(conversation: DmConversationItem) {
	return (conversation.matches ?? []).flatMap((match) => [
		...match.before.map((message) => message.text),
		match.message.text,
		...match.after.map((message) => message.text),
	]);
}

function getUrlEntityExpandedUrl(entity: unknown) {
	if (!entity || typeof entity !== "object") {
		return undefined;
	}
	const record = entity as Record<string, unknown>;
	const expanded = record.expandedUrl ?? record.expanded_url ?? record.url;
	return typeof expanded === "string" && expanded.length > 0
		? expanded
		: undefined;
}

function getProfileBioUrls(profile: ProfileRecord) {
	const description = profile.entities?.description;
	if (!description || typeof description !== "object") {
		return [];
	}
	const urls = (description as { urls?: unknown }).urls;
	if (!Array.isArray(urls)) {
		return [];
	}
	return urls
		.map(getUrlEntityExpandedUrl)
		.filter((url): url is string => Boolean(url));
}

function getAffiliationTexts(affiliation: ProfileAffiliation) {
	return [
		affiliation.organizationName,
		affiliation.organizationHandle,
		affiliation.label,
		affiliation.url,
		affiliation.organizationProfileId,
	].filter((item): item is string => Boolean(item));
}

function pushMatchEvidence(
	signals: WhoisEvidenceSignal[],
	query: string,
	kind: WhoisEvidenceSignal["kind"],
	value: string | undefined | null,
	source: WhoisEvidenceSignal["source"],
) {
	if (!matchesQueryText(query, value)) {
		return;
	}
	signals.push({ kind, value: String(value), source });
}

function getSnapshotAffiliationTexts(snapshot: ProfileSnapshot) {
	return snapshot.affiliations.flatMap((affiliation) => {
		if (!affiliation || typeof affiliation !== "object") {
			return [];
		}
		const record = affiliation as Record<string, unknown>;
		return [
			record.organizationName,
			record.organizationHandle,
			record.label,
			record.url,
		].filter(
			(item): item is string => typeof item === "string" && item.length > 0,
		);
	});
}

function getHistoricalSnapshotTexts(
	snapshot: ProfileSnapshot,
	profile: ProfileRecord,
) {
	const texts: string[] = [];
	if (snapshot.handle !== profile.handle) {
		texts.push(`previous handle: @${snapshot.handle}`);
	}
	if (snapshot.displayName !== profile.displayName) {
		texts.push(`previous name: ${snapshot.displayName}`);
	}
	if (snapshot.bio !== profile.bio) {
		texts.push(`previous bio: ${snapshot.bio}`);
	}
	if (snapshot.location && snapshot.location !== (profile.location ?? null)) {
		texts.push(`previous location: ${snapshot.location}`);
	}
	if (snapshot.url && snapshot.url !== (profile.url ?? null)) {
		texts.push(`previous url: ${snapshot.url}`);
	}
	if (
		snapshot.verifiedType &&
		snapshot.verifiedType !== (profile.verifiedType ?? null)
	) {
		texts.push(`previous verified: ${snapshot.verifiedType}`);
	}
	const currentAffiliationTexts = new Set(
		(profile.affiliations ?? [])
			.flatMap((affiliation) => [
				affiliation.organizationName,
				affiliation.organizationHandle,
				affiliation.label,
				affiliation.url,
			])
			.filter((item): item is string => Boolean(item))
			.map((item) => item.toLowerCase()),
	);
	const previousAffiliationTexts = getSnapshotAffiliationTexts(snapshot);
	if (
		previousAffiliationTexts.some(
			(text) => !currentAffiliationTexts.has(text.toLowerCase()),
		)
	) {
		texts.push(
			`previous affiliations: ${JSON.stringify(snapshot.affiliations)}`,
		);
	}
	return texts;
}

function collectProfileEvidence(
	query: string,
	profile: ProfileRecord,
	bioEntities: ProfileBioEntity[] = [],
	snapshots: ProfileSnapshot[] = [],
) {
	const signals: WhoisEvidenceSignal[] = [];
	pushMatchEvidence(
		signals,
		query,
		"profile_handle",
		profile.handle,
		"profile",
	);
	pushMatchEvidence(
		signals,
		query,
		"profile_name",
		profile.displayName,
		"profile",
	);
	pushMatchEvidence(signals, query, "profile_bio", profile.bio, "profile");
	pushMatchEvidence(
		signals,
		query,
		"profile_location",
		profile.location,
		"profile",
	);
	pushMatchEvidence(signals, query, "profile_url", profile.url, "profile");
	pushMatchEvidence(
		signals,
		query,
		"profile_verified_type",
		profile.verifiedType,
		"profile",
	);
	for (const url of getProfileBioUrls(profile)) {
		pushMatchEvidence(signals, query, "profile_bio_url", url, "profile");
	}
	for (const affiliation of profile.affiliations ?? []) {
		for (const text of getAffiliationTexts(affiliation)) {
			pushMatchEvidence(signals, query, "affiliation", text, "affiliation");
		}
	}
	for (const entity of bioEntities) {
		const kind =
			entity.kind === "handle"
				? "bio_handle"
				: entity.kind === "domain"
					? "bio_domain"
					: "bio_company";
		pushMatchEvidence(signals, query, kind, entity.value, "bio_entity");
	}
	for (const snapshot of snapshots) {
		for (const text of getHistoricalSnapshotTexts(snapshot, profile)) {
			pushMatchEvidence(
				signals,
				query,
				"profile_history",
				`${snapshot.lastSeenAt}: ${text}`,
				"history",
			);
		}
	}
	return signals;
}

function scoreCandidate(
	query: string,
	conversation: DmConversationItem,
	expansions: UrlExpansionItem[],
	bioEntities: ProfileBioEntity[] = [],
	snapshots: ProfileSnapshot[] = [],
) {
	const normalized = normalizeQuery(query);
	const profile = conversation.participant;
	const profileEvidence = collectProfileEvidence(
		normalized,
		profile,
		bioEntities,
		snapshots,
	);
	const affiliationTexts = (profile.affiliations ?? []).flatMap(
		getAffiliationTexts,
	);
	const profileBioUrls = getProfileBioUrls(profile);
	const bioEntityTexts = bioEntities.map((entity) => entity.value);
	const profileHistoryTexts = snapshots.flatMap((snapshot) =>
		getHistoricalSnapshotTexts(snapshot, profile),
	);
	const messageTexts = getMessageTexts(conversation);
	const haystack = [
		conversation.title,
		profile.handle,
		profile.displayName,
		profile.bio,
		profile.location,
		profile.url,
		profile.verifiedType,
		...profileBioUrls,
		...affiliationTexts,
		...bioEntityTexts,
		...profileHistoryTexts,
		...messageTexts,
	]
		.filter(Boolean)
		.join("\n")
		.toLowerCase();
	const reasons: string[] = [];
	let confidence = 20;

	if (!/^id\d+$/.test(conversation.participant.handle)) {
		confidence += 25;
		reasons.push("resolved profile");
	}
	if (
		matchesQueryText(normalized, profile.handle) ||
		matchesQueryText(normalized, profile.displayName) ||
		matchesQueryText(normalized, profile.bio)
	) {
		confidence += 20;
		reasons.push("profile matches query");
	}
	if (
		matchesQueryText(normalized, profile.url) ||
		profileBioUrls.some((url) => matchesQueryText(normalized, url))
	) {
		confidence += 20;
		reasons.push("profile URL matches query");
	}
	if (profileEvidence.some((signal) => signal.kind === "affiliation")) {
		confidence += 30;
		reasons.push("affiliation matches query");
	}
	if (profileEvidence.some((signal) => signal.source === "bio_entity")) {
		confidence += 25;
		reasons.push("bio entity matches query");
	}
	if (profileEvidence.some((signal) => signal.source === "history")) {
		confidence += 20;
		reasons.push("profile history matches query");
	}
	if (haystack.includes("co-founder") || haystack.includes("cofounder")) {
		confidence += 25;
		reasons.push("cofounder language");
	}
	if (messageTexts.some((text) => matchesQueryText(normalized, text))) {
		confidence += 15;
		reasons.push("message text matches query");
		profileEvidence.push({
			kind: "dm_context",
			value: query,
			source: "dm",
		});
	}
	if (expansions.some((item) => matchesQueryText(normalized, item.finalUrl))) {
		confidence += 15;
		reasons.push("expanded URL matches query");
		for (const item of expansions) {
			pushMatchEvidence(
				profileEvidence,
				normalized,
				"expanded_url",
				item.finalUrl,
				"url",
			);
		}
	}

	return {
		confidence: Math.min(100, confidence),
		reasons: reasons.length > 0 ? reasons : ["local DM match"],
		profileEvidence,
	};
}

function attachExpansionsToMatches(
	conversation: DmConversationItem,
	expansions: UrlExpansionItem[],
) {
	for (const match of conversation.matches ?? []) {
		const matchUrls = new Set(
			[...match.before, match.message, ...match.after].flatMap((message) =>
				expansions
					.filter((item) => message.text.includes(item.url))
					.map((item) => item.url),
			),
		);
		if (matchUrls.size > 0) {
			match.urlExpansions = expansions.filter((item) =>
				matchUrls.has(item.url),
			);
		}
	}
}

function mergeConversations(
	target: Map<string, DmConversationItem>,
	conversations: DmConversationItem[],
) {
	for (const conversation of conversations) {
		if (!target.has(conversation.id)) {
			target.set(conversation.id, conversation);
		}
	}
}

function findProfileEvidenceConversationIds(
	query: string,
	account: string | undefined,
	limit: number,
) {
	const terms = [normalizeQuery(query), ...getSignificantQueryTerms(query)]
		.filter((term) => term.length > 0)
		.filter((term, index, array) => array.indexOf(term) === index);
	if (terms.length === 0) {
		return [];
	}
	const clauses: string[] = [];
	const params: Array<string | number> = [];
	for (const term of terms) {
		const pattern = `%${term}%`;
		clauses.push(`
      lower(p.handle) like ?
      or lower(p.display_name) like ?
      or lower(p.bio) like ?
      or lower(coalesce(p.location, '')) like ?
      or lower(coalesce(p.url, '')) like ?
      or lower(coalesce(p.verified_type, '')) like ?
      or lower(coalesce(pa.organization_name, '')) like ?
      or lower(coalesce(pa.organization_handle, '')) like ?
      or lower(coalesce(pa.label, '')) like ?
      or lower(coalesce(pa.url, '')) like ?
      or lower(coalesce(pbe.value, '')) like ?
      or lower(coalesce(ps.handle, '')) like ?
      or lower(coalesce(ps.display_name, '')) like ?
      or lower(coalesce(ps.bio, '')) like ?
      or lower(coalesce(ps.location, '')) like ?
      or lower(coalesce(ps.url, '')) like ?
      or lower(coalesce(ps.verified_type, '')) like ?
      or lower(coalesce(ps.affiliations_json, '')) like ?
    `);
		for (let index = 0; index < 18; index += 1) {
			params.push(pattern);
		}
	}

	let accountClause = "";
	if (account && account !== "all") {
		accountClause = "and c.account_id = ?";
		params.push(account);
	}
	params.push(limit);

	const rows = getNativeDb()
		.prepare(
			`
      select c.id
      from dm_conversations c
      join profiles p on p.id = c.participant_profile_id
      left join profile_affiliations pa
        on pa.subject_profile_id = p.id and pa.is_active = 1
      left join profile_bio_entities pbe
        on pbe.profile_id = p.id and pbe.is_active = 1
      left join profile_snapshots ps on ps.profile_id = p.id
      where (${clauses.map((clause) => `(${clause})`).join(" or ")})
        ${accountClause}
      group by c.id
      order by c.last_message_at desc
      limit ?
      `,
		)
		.all(...params) as Array<{ id: string }>;
	return rows.map((row) => row.id);
}

function loadWhoisConversations(
	query: string,
	options: WhoisOptions,
	includeDms: boolean,
	context: number,
	limit: number,
) {
	if (!includeDms) {
		return [];
	}
	const merged = new Map<string, DmConversationItem>();
	const batchLimit = Math.max(limit * 3, 20);
	for (const search of getDmSearchQueries(query)) {
		mergeConversations(
			merged,
			listDmConversations({
				account: options.account,
				search,
				context,
				limit: batchLimit,
			}),
		);
	}

	const profileEvidenceIds = findProfileEvidenceConversationIds(
		query,
		options.account,
		Math.max(limit * 5, 50),
	);
	if (profileEvidenceIds.length > 0) {
		mergeConversations(
			merged,
			listDmConversations({
				account: options.account,
				conversationIds: profileEvidenceIds,
				limit: profileEvidenceIds.length,
			}),
		);
	}

	return [...merged.values()];
}

export async function runWhois(
	query: string,
	options: WhoisOptions = {},
): Promise<WhoisResult> {
	const includeDms = options.dms ?? true;
	const includeTweets = options.tweets ?? false;
	const limit = options.limit ?? 10;
	const context = options.context ?? 4;
	let conversations = loadWhoisConversations(
		query,
		options,
		includeDms,
		context,
		limit,
	);
	let profileResolution: WhoisResult["profileResolution"];

	if (options.resolveProfiles ?? true) {
		profileResolution = await resolveProfilesForIds(
			conversations.map((item) => item.participant.id),
			{
				refresh: options.refreshProfileCache,
				xurlFallback: options.xurlFallback ?? true,
			},
		);
		conversations = loadWhoisConversations(
			query,
			options,
			includeDms,
			context,
			limit,
		);
	}

	const relatedTweets = includeTweets
		? [
				...listTimelineItems({
					resource: "home",
					account: options.account,
					search: query,
					limit,
				}),
				...listTimelineItems({
					resource: "mentions",
					account: options.account,
					search: query,
					limit,
				}),
			]
		: [];

	const texts = [
		...conversations.flatMap(getMessageTexts),
		...conversations.flatMap((conversation) =>
			[
				conversation.participant.bio,
				conversation.participant.url ?? "",
				...getProfileBioUrls(conversation.participant),
			].filter((text) => text.includes("https://t.co/")),
		),
		...relatedTweets.map((tweet) => tweet.text),
	];
	const urlExpansions =
		(options.expandUrls ?? true)
			? await expandUrlsFromTexts(texts, { refresh: options.refreshUrlCache })
			: [];
	for (const conversation of conversations) {
		attachExpansionsToMatches(conversation, urlExpansions);
	}

	const profileIds = conversations.map(
		(conversation) => conversation.participant.id,
	);
	const bioEntitiesByProfile = fetchProfileBioEntities(
		getNativeDb(),
		profileIds,
	);
	const snapshotsByProfile = fetchProfileSnapshots(getNativeDb(), profileIds);
	const candidates = conversations
		.map((conversation): WhoisCandidate => {
			const conversationExpansions = urlExpansions.filter((item) =>
				getMessageTexts(conversation).some((text) => text.includes(item.url)),
			);
			const profileId = conversation.participant.id;
			const score = scoreCandidate(
				query,
				conversation,
				conversationExpansions,
				bioEntitiesByProfile.get(profileId) ?? [],
				snapshotsByProfile.get(profileId) ?? [],
			);
			return {
				conversation,
				confidence: score.confidence,
				reasons: score.reasons,
				profileEvidence: score.profileEvidence,
				evidence: (conversation.matches ?? []).map((match) => ({
					messageId: match.message.id,
					createdAt: match.message.createdAt,
					direction: match.message.direction,
					text: match.message.text,
					...(match.urlExpansions
						? { urlExpansions: match.urlExpansions }
						: {}),
				})),
			};
		})
		.sort((left, right) => {
			if (right.confidence !== left.confidence) {
				return right.confidence - left.confidence;
			}
			return (
				new Date(right.conversation.lastMessageAt).getTime() -
				new Date(left.conversation.lastMessageAt).getTime()
			);
		})
		.slice(0, limit);

	return {
		query,
		candidates,
		relatedTweets,
		urlExpansions,
		...(profileResolution ? { profileResolution } : {}),
	};
}

export function formatWhois(result: WhoisResult) {
	const lines = [`Whois: ${result.query}`];
	if (result.candidates.length === 0) {
		lines.push("No matching DM candidates.");
	} else {
		for (const candidate of result.candidates) {
			const profile = candidate.conversation.participant;
			lines.push("");
			lines.push(
				`${candidate.confidence}% @${profile.handle} (${profile.displayName})`,
			);
			lines.push(`Reasons: ${candidate.reasons.join(", ")}`);
			lines.push(`Conversation: ${candidate.conversation.id}`);
			for (const signal of candidate.profileEvidence.slice(0, 5)) {
				lines.push(`Evidence: ${signal.kind}: ${signal.value}`);
			}
			for (const evidence of candidate.evidence.slice(0, 3)) {
				lines.push(
					`- ${evidence.createdAt} ${evidence.direction}: ${evidence.text}`,
				);
				for (const expansion of evidence.urlExpansions ?? []) {
					lines.push(`  ${expansion.url} -> ${expansion.finalUrl}`);
				}
			}
		}
	}

	if (result.relatedTweets.length > 0) {
		lines.push("");
		lines.push(`Related tweets: ${result.relatedTweets.length}`);
		for (const tweet of result.relatedTweets.slice(0, 5)) {
			lines.push(`- ${tweet.createdAt} @${tweet.author.handle}: ${tweet.text}`);
		}
	}

	return lines.join("\n");
}
