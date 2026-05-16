import { Effect } from "effect";
import { getNativeDb } from "./db";
import { runEffectPromise } from "./effect-runtime";
import {
	ensureIdentitySearchIndexForDmProfiles,
	syncIdentitySearchIndexForProfileIds,
} from "./identity-search-index";
import { fetchProfileBioEntities } from "./profile-bio-entities";
import { fetchProfileSnapshots } from "./profile-history";
import { resolveProfilesForIdsEffect } from "./profile-resolver";
import type { ProfileResolveResult } from "./profile-resolver";
import { listDmConversations, listTimelineItems } from "./queries";
import { expandUrlsFromTextsEffect } from "./url-expansion";
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
	affiliation?: string;
	currentAffiliation?: string;
	excludeDomainOnly?: boolean;
}

export interface WhoisCandidate {
	conversation: DmConversationItem;
	confidence: number;
	category: WhoisCandidateCategory;
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

export type WhoisCandidateCategory =
	| "likely_affiliated"
	| "ecosystem"
	| "profile_or_link"
	| "dm_context"
	| "other";

export interface WhoisResult {
	query: string;
	candidates: WhoisCandidate[];
	relatedTweets: TimelineItem[];
	urlExpansions: UrlExpansionItem[];
	profileResolution?: ProfileResolveResult[];
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

function trySync<T>(try_: () => T) {
	return Effect.try({
		try: try_,
		catch: (cause) => cause,
	});
}

interface WhoisQueryIntent {
	raw: string;
	normalized: string;
	terms: string[];
	handles: string[];
	domains: string[];
	wantsPerson: boolean;
	wantsAffiliation: boolean;
	wantsDomain: boolean;
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

function getQueryDomains(query: string) {
	return Array.from(
		new Set(
			query
				.toLowerCase()
				.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/g)
				?.map((domain) => domain.replace(/^www\./, "")) ?? [],
		),
	);
}

function getQueryHandles(query: string) {
	return Array.from(
		new Set(
			query
				.match(/@[A-Za-z0-9_]{1,15}\b/g)
				?.map((handle) => handle.toLowerCase()) ?? [],
		),
	);
}

function getQueryIntent(query: string): WhoisQueryIntent {
	const normalized = normalizeQuery(query);
	const domains = getQueryDomains(query);
	const handles = getQueryHandles(query);
	const terms = getSignificantQueryTerms(query);
	const wantsPerson =
		/\b(guy|person|people|who|someone|staff|employee|devrel|founder|founders)\b/i.test(
			query,
		);
	const wantsDomain =
		domains.length > 0 ||
		(/\b(link|url|domain|repo|repository|github\.com)\b/i.test(query) &&
			!wantsPerson);
	const wantsAffiliation =
		handles.length > 0 ||
		wantsPerson ||
		/\b(at|from|works?|employee|staff|affiliation|company|org|devrel)\b/i.test(
			query,
		);
	return {
		raw: query,
		normalized,
		terms,
		handles,
		domains,
		wantsPerson,
		wantsAffiliation,
		wantsDomain,
	};
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

const DOMAIN_ONLY_EVIDENCE = new Set<WhoisEvidenceSignal["kind"]>([
	"profile_url",
	"profile_bio_url",
	"bio_domain",
	"expanded_url",
]);

function getEvidenceWeight(
	signal: WhoisEvidenceSignal,
	intent: WhoisQueryIntent,
	profile: ProfileRecord,
) {
	const bio = profile.bio.toLowerCase();
	const ecosystemPenalty =
		signal.kind === "bio_handle" || signal.kind === "bio_company"
			? isEcosystemMention(bio, intent)
			: false;
	switch (signal.kind) {
		case "affiliation":
			return 72;
		case "bio_handle":
			return ecosystemPenalty ? 20 : 56;
		case "bio_company":
			return ecosystemPenalty ? 16 : 46;
		case "profile_history":
			return 36;
		case "profile_handle":
			return intent.handles.length > 0 ? 44 : 24;
		case "profile_name":
		case "profile_bio":
			return 24;
		case "dm_context":
			return intent.wantsAffiliation ? 12 : 22;
		case "expanded_url":
			return intent.wantsDomain ? 26 : 8;
		case "profile_url":
		case "profile_bio_url":
		case "bio_domain":
			return intent.wantsDomain ? 30 : 8;
		case "profile_location":
		case "profile_verified_type":
			return 8;
	}
}

function isEcosystemMention(bio: string, intent: WhoisQueryIntent) {
	const terms = new Set([
		...intent.terms,
		...intent.handles.map((handle) => handle.replace(/^@/, "")),
	]);
	for (const term of terms) {
		const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (
			new RegExp(
				`\\b${escaped}\\s+(star|stars|sponsor|sponsors|campus expert|expert|partner|alumni)\\b`,
				"i",
			).test(bio)
		) {
			return true;
		}
	}
	return false;
}

function hasCurrentAffiliationMatch(
	profile: ProfileRecord,
	affiliationQuery: string | undefined,
) {
	if (!affiliationQuery?.trim()) {
		return true;
	}
	const normalized = normalizeQuery(affiliationQuery);
	return (profile.affiliations ?? []).some((affiliation) =>
		getAffiliationTexts(affiliation).some((text) =>
			matchesQueryText(normalized, text),
		),
	);
}

function hasAffiliationEvidenceMatch(
	profile: ProfileRecord,
	profileEvidence: WhoisEvidenceSignal[],
	affiliationQuery: string | undefined,
) {
	if (!affiliationQuery?.trim()) {
		return true;
	}
	const normalized = normalizeQuery(affiliationQuery);
	if (hasCurrentAffiliationMatch(profile, affiliationQuery)) {
		return true;
	}
	return profileEvidence.some(
		(signal) =>
			(signal.kind === "affiliation" ||
				signal.kind === "bio_handle" ||
				signal.kind === "bio_company" ||
				signal.kind === "profile_history") &&
			matchesQueryText(normalized, signal.value),
	);
}

function hasNonDomainEvidence(profileEvidence: WhoisEvidenceSignal[]) {
	return profileEvidence.some(
		(signal) => !DOMAIN_ONLY_EVIDENCE.has(signal.kind),
	);
}

function getCandidateCategory(
	profile: ProfileRecord,
	profileEvidence: WhoisEvidenceSignal[],
	intent: WhoisQueryIntent,
	messageMatched: boolean,
): WhoisCandidateCategory {
	if (profileEvidence.some((signal) => signal.kind === "affiliation")) {
		return "likely_affiliated";
	}
	if (
		profileEvidence.some(
			(signal) =>
				signal.kind === "bio_handle" ||
				signal.kind === "bio_company" ||
				signal.kind === "profile_history",
		)
	) {
		return isEcosystemMention(profile.bio.toLowerCase(), intent)
			? "ecosystem"
			: "likely_affiliated";
	}
	if (profileEvidence.some((signal) => DOMAIN_ONLY_EVIDENCE.has(signal.kind))) {
		return "profile_or_link";
	}
	return messageMatched ? "dm_context" : "other";
}

function scoreCandidate(
	query: string,
	conversation: DmConversationItem,
	expansions: UrlExpansionItem[],
	bioEntities: ProfileBioEntity[] = [],
	snapshots: ProfileSnapshot[] = [],
) {
	const normalized = normalizeQuery(query);
	const intent = getQueryIntent(query);
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
	let confidence = 0;

	if (!/^id\d+$/.test(conversation.participant.handle)) {
		confidence += 18;
		reasons.push("resolved profile");
	}
	if (
		matchesQueryText(normalized, profile.handle) ||
		matchesQueryText(normalized, profile.displayName) ||
		matchesQueryText(normalized, profile.bio)
	) {
		confidence += 18;
		reasons.push("profile matches query");
	}
	if (
		matchesQueryText(normalized, profile.url) ||
		profileBioUrls.some((url) => matchesQueryText(normalized, url))
	) {
		confidence += intent.wantsDomain ? 28 : 8;
		reasons.push("profile URL matches query");
	}
	if (profileEvidence.some((signal) => signal.kind === "affiliation")) {
		confidence += 40;
		reasons.push("affiliation matches query");
	}
	if (profileEvidence.some((signal) => signal.source === "bio_entity")) {
		confidence += 24;
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
	const messageMatched = messageTexts.some((text) =>
		matchesQueryText(normalized, text),
	);
	if (messageMatched) {
		confidence += intent.wantsAffiliation ? 10 : 18;
		reasons.push("message text matches query");
		profileEvidence.push({
			kind: "dm_context",
			value: query,
			source: "dm",
		});
	}
	if (expansions.some((item) => matchesQueryText(normalized, item.finalUrl))) {
		confidence += intent.wantsDomain ? 20 : 8;
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

	for (const signal of profileEvidence) {
		confidence += getEvidenceWeight(signal, intent, profile);
	}
	const category = getCandidateCategory(
		profile,
		profileEvidence,
		intent,
		messageMatched,
	);
	if (category === "ecosystem") {
		confidence -= 24;
		reasons.push("ecosystem mention, not direct affiliation");
	}
	if (category === "profile_or_link" && intent.wantsAffiliation) {
		confidence -= 18;
	}

	return {
		confidence: Math.max(0, Math.min(100, confidence)),
		category,
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
	const db = getNativeDb();
	ensureIdentitySearchIndexForDmProfiles(db, account);
	const clauses: string[] = [];
	const params: Array<string | number> = [];
	for (const term of terms) {
		const pattern = `%${term}%`;
		clauses.push("isi.normalized_value like ?");
		params.push(pattern);
	}

	let accountClause = "";
	if (account && account !== "all") {
		accountClause = "and c.account_id = ?";
		params.push(account);
	}
	params.push(limit);

	const rows = db
		.prepare(
			`
      select c.id, max(isi.weight) as max_weight
      from dm_conversations c
      join identity_search_index isi on isi.profile_id = c.participant_profile_id
      where (${clauses.map((clause) => `(${clause})`).join(" or ")})
        ${accountClause}
      group by c.id
      order by max_weight desc, c.last_message_at desc
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

export function runWhoisEffect(
	query: string,
	options: WhoisOptions = {},
): Effect.Effect<WhoisResult, unknown> {
	return Effect.gen(function* () {
		const includeDms = options.dms ?? true;
		const includeTweets = options.tweets ?? false;
		const limit = options.limit ?? 10;
		const context = options.context ?? 4;
		let conversations = yield* trySync(() =>
			loadWhoisConversations(query, options, includeDms, context, limit),
		);
		let profileResolution: WhoisResult["profileResolution"];

		if (options.resolveProfiles ?? true) {
			profileResolution = yield* resolveProfilesForIdsEffect(
				conversations.map((item) => item.participant.id),
				{
					refresh: options.refreshProfileCache,
					xurlFallback: options.xurlFallback ?? true,
				},
			);
			conversations = yield* trySync(() =>
				loadWhoisConversations(query, options, includeDms, context, limit),
			);
		}
		yield* trySync(() =>
			syncIdentitySearchIndexForProfileIds(
				getNativeDb(),
				conversations.map((item) => item.participant.id),
			),
		);

		const relatedTweets = includeTweets
			? yield* trySync(() => [
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
				])
			: [];

		const texts = yield* trySync(() => [
			...conversations.flatMap(getMessageTexts),
			...conversations.flatMap((conversation) =>
				[
					conversation.participant.bio,
					conversation.participant.url ?? "",
					...getProfileBioUrls(conversation.participant),
				].filter((text) => text.includes("https://t.co/")),
			),
			...relatedTweets.map((tweet) => tweet.text),
		]);
		const urlExpansions =
			(options.expandUrls ?? true)
				? yield* expandUrlsFromTextsEffect(texts, {
						refresh: options.refreshUrlCache,
					})
				: [];
		yield* trySync(() => {
			for (const conversation of conversations) {
				attachExpansionsToMatches(conversation, urlExpansions);
			}
		});

		const candidates = yield* trySync(() => {
			const profileIds = conversations.map(
				(conversation) => conversation.participant.id,
			);
			const db = getNativeDb();
			const bioEntitiesByProfile = fetchProfileBioEntities(db, profileIds);
			const snapshotsByProfile = fetchProfileSnapshots(db, profileIds);
			return conversations
				.map((conversation): WhoisCandidate | null => {
					const conversationExpansions = urlExpansions.filter((item) =>
						getMessageTexts(conversation).some((text) =>
							text.includes(item.url),
						),
					);
					const profileId = conversation.participant.id;
					const score = scoreCandidate(
						query,
						conversation,
						conversationExpansions,
						bioEntitiesByProfile.get(profileId) ?? [],
						snapshotsByProfile.get(profileId) ?? [],
					);
					if (
						!hasCurrentAffiliationMatch(
							conversation.participant,
							options.currentAffiliation,
						)
					) {
						return null;
					}
					if (
						!hasAffiliationEvidenceMatch(
							conversation.participant,
							score.profileEvidence,
							options.affiliation,
						)
					) {
						return null;
					}
					if (
						options.excludeDomainOnly &&
						!hasNonDomainEvidence(score.profileEvidence)
					) {
						return null;
					}
					return {
						conversation,
						confidence: score.confidence,
						category: score.category,
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
				.filter((candidate): candidate is WhoisCandidate => candidate !== null)
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
		});

		return {
			query,
			candidates,
			relatedTweets,
			urlExpansions,
			...(profileResolution ? { profileResolution } : {}),
		};
	});
}

export function runWhois(
	query: string,
	options: WhoisOptions = {},
): Promise<WhoisResult> {
	return runEffectPromise(runWhoisEffect(query, options));
}

const CATEGORY_LABELS: Record<WhoisCandidateCategory, string> = {
	likely_affiliated: "Likely affiliated",
	ecosystem: "Ecosystem / role mentions",
	profile_or_link: "Profile or link matches",
	dm_context: "DM context matches",
	other: "Other local matches",
};

function summarizeSignal(signal: WhoisEvidenceSignal) {
	switch (signal.kind) {
		case "affiliation":
			return `current affiliation ${signal.value}`;
		case "bio_handle":
			return `bio handle ${signal.value}`;
		case "bio_company":
			return `bio company ${signal.value}`;
		case "profile_history":
			return `profile history ${signal.value}`;
		case "profile_url":
		case "profile_bio_url":
		case "bio_domain":
			return `domain/link ${signal.value}`;
		case "dm_context":
			return `DM context`;
		case "expanded_url":
			return `expanded URL ${signal.value}`;
		default:
			return `${signal.kind.replace(/^profile_/, "profile ")} ${signal.value}`;
	}
}

function signalSummaryRank(signal: WhoisEvidenceSignal) {
	switch (signal.kind) {
		case "affiliation":
			return 0;
		case "bio_handle":
			return 1;
		case "bio_company":
			return 2;
		case "profile_history":
			return 3;
		case "dm_context":
			return 4;
		case "expanded_url":
			return 5;
		case "profile_url":
		case "profile_bio_url":
		case "bio_domain":
			return 6;
		default:
			return 7;
	}
}

function explainCandidate(candidate: WhoisCandidate) {
	const evidence = candidate.profileEvidence
		.slice()
		.sort((left, right) => signalSummaryRank(left) - signalSummaryRank(right))
		.slice(0, 4)
		.map(summarizeSignal);
	return evidence.length > 0
		? evidence.join(" + ")
		: candidate.reasons.join(", ");
}

export function formatWhois(result: WhoisResult) {
	const lines = [`Whois: ${result.query}`];
	if (result.candidates.length === 0) {
		lines.push("No matching DM candidates.");
	} else {
		let activeCategory: WhoisCandidateCategory | undefined;
		for (const candidate of result.candidates) {
			const profile = candidate.conversation.participant;
			if (activeCategory !== candidate.category) {
				activeCategory = candidate.category;
				lines.push("");
				lines.push(CATEGORY_LABELS[candidate.category]);
			}
			lines.push("");
			lines.push(
				`${candidate.confidence}% @${profile.handle} (${profile.displayName})`,
			);
			lines.push(`Why: ${explainCandidate(candidate)}`);
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

export const __test__ = {
	getSignificantQueryTerms,
	getQueryDomains,
	getQueryHandles,
	getQueryIntent,
	matchesQueryText,
	getDmSearchQueries,
	getUrlEntityExpandedUrl,
	getProfileBioUrls,
	getAffiliationTexts,
	getSnapshotAffiliationTexts,
	getHistoricalSnapshotTexts,
	collectProfileEvidence,
	hasCurrentAffiliationMatch,
	hasAffiliationEvidenceMatch,
	hasNonDomainEvidence,
	scoreCandidate,
	explainCandidate,
	attachExpansionsToMatches,
	mergeConversations,
};
