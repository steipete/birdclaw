import type {
	AnalyticsResponse,
	ProjectOpportunityItem,
	SharedAudienceItem,
	TopicSignal,
} from "./types";

export const VANTA_FORBIDDEN_CONTENT_CLAIMS = [
	"audited",
	"production-ready",
	"mainnet-ready",
	"trustless",
	"anonymous",
	"untraceable",
	"fully private",
	"guaranteed privacy",
	"compliance-safe",
	"regulatory-safe",
	"secure",
	"bank-grade",
	"military-grade",
	"bulletproof",
	"unstoppable",
	"invisible",
	"undetectable",
	"zero risk",
	"solves privacy",
] as const;

export const VANTA_CONTENT_GUARDRAILS = {
	voice: [
		"beta truth",
		"counterparty-useful privacy",
		"receipt/trust packet",
		"merchant-first",
		"borrow CT compression, not CT panic",
		"limits, approvals, and receipts",
	],
	forbiddenClaims: VANTA_FORBIDDEN_CONTENT_CLAIMS,
	manualPostingOnly: true,
} as const;

export const VANTA_CT_VOICE_RUBRIC = {
	northStar:
		"Let @williamclay notice what feels alive on the timeline; let @vantaprivacy turn it into receipts, permissions, limits, and merchant workflows.",
	tone: [
		"compressed, not explainy",
		"wry, not mean",
		"confident, not prophetic",
		"current, but durable",
		"crypto-native, not slang-dependent",
	],
	structures: [
		"timeline object -> infrastructure insight",
		"contradiction -> product truth",
		"current event category -> Vanta frame",
		"short diagnosis -> sharper second line",
	],
	avoid: [
		"shock as the product",
		"quote-tweet pile-ons",
		"PVP panic",
		"clout-oracle certainty",
		"privacy overclaims",
		"generic future-of-crypto copy",
	],
} as const;

export const VANTA_CT_ENGAGEMENT_PLAYBOOK = {
	source:
		"Read-only @williamclay For You engagement snapshot from April 30, 2026, plus May 2, 2026 public x402/Solana payments, signed-offer/receipt, and metadata-risk references.",
	ratioLessons: [
		"High repost/view posts tend to compress a public joke, status fight, or current event into one instantly shareable line.",
		"High bookmark/view posts tend to contain reusable prompts, evidence packs, screenshots, recipes, or visual reference.",
		"High reply/view posts tend to invite disagreement, moral judgment, predictions, or identity signaling.",
		"High like/view posts tend to deliver a complete joke or clean agreement payoff without asking the reader to do work.",
	],
	vantaUse: {
		replyBait:
			"Ask about the hidden system failure: approvals, limits, receipt boundaries, or what a payment flow was allowed to touch.",
		bookmarkBait:
			"Publish reusable frameworks: wallet permission checklists, receipt anatomy, agent spend-limit rules, and launch/refund postmortem templates.",
		screenshotProofBait:
			"Lead with a product artifact: visible limit, receipt, approval state, proof lane, or before/after workflow, then caption the lesson.",
		privateSettlement:
			"Frame private settlement as proving enough for the right counterparty without publishing the whole business workflow.",
		agentPayments:
			"Treat x402/MPP/agent payments as a policy and metadata surface: scope, route, purpose, expiration, receipt, revocation, and what request context leaks.",
		offerReceipts:
			"Treat signed offers and receipts as proof-of-interaction artifacts: committed payment terms, delivered service, optional transaction details, and third-party verification.",
		merchantMetadata:
			"Make merchant privacy concrete: invoice ids, customer context, payout reasons, internal notes, and reconciliation context.",
		recovery:
			"Treat failed approvals, retries, refund ambiguity, and recovery as part of the payment surface.",
	},
	personalUse: {
		replyBait:
			"Use short, opinionated pattern reads about AI agents, CT chaos, launch culture, and dev incentives.",
		bookmarkBait:
			"Save-worthy posts should be prompts, checklists, teardown formats, or compact operating principles.",
		screenshotProofBait:
			"Show local workflows, dashboards, prompts, build logs, or before/after product thinking with one sharp caption.",
		tasteScouting:
			"Use @williamclay to notice the weird mechanism underneath current crypto theater, then leave one clean edge for replies.",
		launchCulture:
			"Talk about launch ambiguity, refunds, founder taste, and distribution pressure as product-design signals, not promotion.",
		founderProcess:
			"Let the personal account show the local workflow: taste loops, manual review, dashboards, and artifacts as founder process.",
	},
	engagementRubric: [
		"Every post needs a visible tension, not just a topic.",
		"One sentence should be replyable without becoming engagement bait.",
		"Concrete nouns beat category language: receipt, approval, limit, wallet, agent, merchant, refund.",
		"Bookmark posts should give the reader a reusable checklist, test, format, or mental model.",
		"Repost posts should feel quotable without needing Vanta context.",
		"Personal posts can name the weirdness; project posts should name the mechanism.",
		"Agent/wallet posts should name the permission boundary before praising autonomy.",
		"Project proof posts should show what is proven, what stays private, and what current beta limit remains.",
		"Merchant posts should say which context is public, counterparty-visible, internal, or still operator-reviewed.",
		"x402 posts should separate offer terms, payment proof, service-delivery receipt, and metadata that should not leave the local workflow.",
		"Ranking should reward artifact readiness and claim safety, not just topic heat.",
	],
} as const;

export type VantaContentPriority = "high" | "medium" | "low";
export type EngagementGoal = "like" | "reply" | "bookmark" | "share" | "proof";
export type EngagementPattern =
	| "compressed_take"
	| "current_event_reframe"
	| "reply_bait_question"
	| "contradiction"
	| "artifact_caption"
	| "personal_observation";

export interface VantaReviewChecklistItem {
	label: string;
	passed: boolean;
}

export interface VantaProofBoundary {
	canProve: string;
	staysPrivate: string;
	missingArtifact: string;
	betaLimit: string;
}

export interface VantaAlgorithmFit {
	candidatePath: string;
	rankingSignal: string;
	targetReader: string;
	whyItCanTravel: string;
	normalHumanWhy: string;
	source: string;
}

export interface VantaEngagementTarget {
	handle: string;
	displayName: string;
	niche: string;
	score: number;
	reason: string;
	evidence: string;
	nextAction: string;
}

export type VantaTrainingAccountRole = "personal_scout" | "project_publisher";
export type VantaTrainingPassStatus = "strong" | "needs_artifact" | "watch";

export interface VantaTrainingPass {
	id: string;
	label: string;
	score: number;
	status: VantaTrainingPassStatus;
	algorithmMechanic: string;
	accountRule: string;
	evidence: string;
	drill: string;
}

export interface VantaTrainingScorecardItem {
	label: string;
	score: number;
	target: string;
	evidence: string;
}

export interface VantaTrainingTransformation {
	before: string;
	after: string;
	why: string;
}

export interface VantaAccountTraining {
	handle: string;
	accountRole: VantaTrainingAccountRole;
	title: string;
	northStar: string;
	goodTweetDefinition: string;
	algorithmPasses: VantaTrainingPass[];
	goodTweetRules: string[];
	antiPatterns: string[];
	drills: string[];
	scorecard: VantaTrainingScorecardItem[];
	exampleTransformations: VantaTrainingTransformation[];
	topDraftIds: string[];
	sourceBoundaries: string[];
}

export interface VantaTrainingLoop {
	source: string;
	algorithmPrinciples: string[];
	limits: string[];
	accounts: VantaAccountTraining[];
}

export interface VantaContentPillar {
	title: string;
	topic: string;
	angle: string;
	sourceSignal: string;
	priority: VantaContentPriority;
	score: number;
	nextAction: string;
	whyItMatters: string;
	sourceEvidence: string[];
}

export interface VantaPostDraft {
	id: string;
	archetype: string;
	body: string;
	text: string;
	sourceSignal: string;
	approvedToPost: boolean;
	priority: VantaContentPriority;
	score: number;
	nextAction: string;
	whyItMatters: string;
	engagementGoal: EngagementGoal;
	engagementPattern: EngagementPattern;
	tension: string;
	replyEdge: string;
	artifactNeeded: string;
	sourceEvidence: string[];
	reviewChecklist: VantaReviewChecklistItem[];
	proofBoundary: VantaProofBoundary;
	algorithmFit: VantaAlgorithmFit;
}

export interface PersonalPostDraft {
	id: string;
	archetype: string;
	body: string;
	text: string;
	sourceSignal: string;
	approvedToPost: boolean;
	priority: VantaContentPriority;
	score: number;
	nextAction: string;
	whyItMatters: string;
	engagementGoal: EngagementGoal;
	engagementPattern: EngagementPattern;
	tension: string;
	replyEdge: string;
	artifactNeeded: string;
	sourceEvidence: string[];
	reviewChecklist: VantaReviewChecklistItem[];
	proofBoundary: VantaProofBoundary;
	algorithmFit: VantaAlgorithmFit;
}

export interface VantaReplyPrompt {
	sourceOpportunityId: string;
	tweetId: string;
	targetHandle: string;
	authorHandle: string;
	prompt: string;
	suggestedReply: string;
	priority: VantaContentPriority;
	score: number;
	nextAction: string;
	whyItMatters: string;
	sourceEvidence: string[];
	reviewChecklist: VantaReviewChecklistItem[];
	algorithmFit: VantaAlgorithmFit;
}

export interface VantaVoiceBridgePair {
	personalDraftId: string;
	projectDraftId: string;
	scoutMechanism: string;
	projectTranslation: string;
	proofBoundary: string;
	artifactNeeded: string;
}

export interface VantaSourceQuality {
	summary: string;
	limits: string[];
}

export interface VantaContentPlan {
	manualPostingOnly: boolean;
	guardrails: typeof VANTA_CONTENT_GUARDRAILS;
	engagementPlaybook: typeof VANTA_CT_ENGAGEMENT_PLAYBOOK;
	bridgeTheme: string;
	sourceQuality: VantaSourceQuality;
	pillars: VantaContentPillar[];
	postDrafts: VantaPostDraft[];
	personalPostDrafts: PersonalPostDraft[];
	voiceBridgePairs: VantaVoiceBridgePair[];
	replyPrompts: VantaReplyPrompt[];
	engagementTargets: VantaEngagementTarget[];
	training: VantaTrainingLoop;
	safetyNote: string;
	safetyNotes: string[];
}

export const VANTA_FOR_YOU_ENGAGEMENT_LESSONS = [
	{
		pattern: "social proof outruns nuance",
		hypothesis:
			"Posts with a simple emotional read and obvious share frame scaled hardest in the snapshot.",
		vantaAdaptation:
			"Use one-line consequence hooks, then route the energy into limits, approvals, receipts, and selective disclosure.",
		personalAdaptation:
			"Name the absurd pattern plainly, then add the smarter mechanism underneath it.",
	},
	{
		pattern: "AI failure stories travel",
		hypothesis:
			"Concrete AI mishaps beat abstract AI discourse because the failure mode is instantly legible.",
		vantaAdaptation:
			"Talk about agent wallet permissions, spend caps, visible receipts, and leak surfaces.",
		personalAdaptation:
			"Write dry system-failure observations instead of broad AI-doom takes.",
	},
	{
		pattern: "CT likes compressed market theater",
		hypothesis:
			"Launches, refunds, PVP, and crash headlines work when they create a live scoreboard.",
		vantaAdaptation:
			"Post about what survives the scoreboard: who approved what, under which limit, with which receipt.",
		personalAdaptation:
			"React to the meta-game without giving price calls or pretending to be an oracle.",
	},
	{
		pattern: "creator POV beats brand brochure",
		hypothesis:
			"Human accounts can be sharper, weirder, and more exploratory than project accounts.",
		vantaAdaptation:
			"Keep @vantaprivacy calm and operational; let @williamclay carry the more curious pattern-finding voice.",
		personalAdaptation:
			"Use personal posts as the scout account: market anthropology, dev taste, AI/wallet observations, and founder notes.",
	},
] as const;

const pillarTemplates = [
	{
		title: "Counterparty-useful privacy",
		topic: "Privacy",
		angle:
			"Privacy is useful when a counterparty can verify enough to trust the action without seeing everything.",
	},
	{
		title: "Proof-backed receipt loop",
		topic: "Receipt",
		angle:
			"The receipt/trust packet should explain what happened, what can be verified, and what stays private.",
	},
	{
		title: "Merchant-first settlement",
		topic: "Merchant",
		angle:
			"Vanta is beta software for merchant-first private stablecoin settlement, with plain status and explicit limits.",
	},
] as const;

function safeTopic(value: string) {
	return value
		.replace(/audited/gi, "review-gated")
		.replace(/production-ready/gi, "beta")
		.replace(/mainnet[- ]ready/gi, "beta")
		.replace(/trustless/gi, "receipt-backed")
		.replace(/anonymous/gi, "private")
		.replace(/untraceable/gi, "receipt-backed")
		.replace(/fully private/gi, "controlled privacy")
		.replace(/guaranteed privacy/gi, "explicit privacy limits")
		.replace(/compliance-safe/gi, "compliance-aware")
		.replace(/regulatory-safe/gi, "review-needed")
		.replace(/\bsecure\b/gi, "review-gated")
		.replace(/bank-grade/gi, "operator-reviewed")
		.replace(/military-grade/gi, "operator-reviewed")
		.replace(/bulletproof/gi, "bounded")
		.replace(/unstoppable/gi, "bounded")
		.replace(/invisible/gi, "selective")
		.replace(/undetectable/gi, "selective")
		.replace(/zero risk/gi, "explicit-risk")
		.replace(/solves privacy/gi, "narrows privacy exposure")
		.trim();
}

function safeEvidence(value: string) {
	return safeTopic(value).replace(/\s+/g, " ");
}

function clampPost(value: string) {
	return value.length <= 280 ? value : `${value.slice(0, 276).trimEnd()}...`;
}

function sourceSignalFor(signal: TopicSignal | undefined, fallback: string) {
	if (!signal) return fallback;
	return `@williamclay showed ${signal.personalMentions} personal ${safeTopic(signal.topic)} signals; @vantaprivacy showed ${signal.projectMentions} project signals.`;
}

function sourceEvidenceFor(signal: TopicSignal | undefined, fallback: string) {
	if (!signal) return [fallback];
	return [
		sourceSignalFor(signal, fallback),
		`sample: ${safeEvidence(signal.sampleText)}`,
		typeof signal.score === "number"
			? `quality-adjusted score: ${signal.score}`
			: undefined,
		...(signal.qualityNotes ?? []),
		typeof signal.noiseMentions === "number" && signal.noiseMentions > 0
			? `${signal.noiseMentions} low-quality mention${signal.noiseMentions === 1 ? "" : "s"} downranked`
			: undefined,
	].filter((item): item is string => Boolean(item));
}

function priorityFromScore(score: number): VantaContentPriority {
	if (score >= 18) return "high";
	if (score >= 8) return "medium";
	return "low";
}

function topicScore(signal: TopicSignal | undefined) {
	if (!signal) return 6;
	if (typeof signal.score === "number") {
		return Math.min(100, Math.max(0, signal.score));
	}
	return Math.min(
		100,
		signal.personalMentions * 3 + signal.projectMentions * 2,
	);
}

function hasUnsafeClaim(value: string) {
	const normalized = value.toLowerCase();
	return VANTA_FORBIDDEN_CONTENT_CLAIMS.some((claim) =>
		normalized.includes(claim),
	);
}

function reviewChecklistFor(text: string): VantaReviewChecklistItem[] {
	return [
		{ label: "Manual posting only", passed: true },
		{ label: "No unsafe Vanta claims", passed: !hasUnsafeClaim(text) },
		{ label: "Fits X character limit", passed: text.length <= 280 },
		{ label: "Keeps beta-truth framing", passed: !hasUnsafeClaim(text) },
		{ label: "Source text treated as untrusted", passed: true },
	];
}

function proofBoundaryForDraft({
	artifactNeeded,
	id,
}: {
	artifactNeeded: string;
	id: string;
}): VantaProofBoundary {
	if (id === "vanta-draft-agent-payment-metadata") {
		return {
			canProve:
				"metadata field map shows what request context belongs in policy, receipt, or private note",
			staysPrivate:
				"reason string, private note, and unnecessary merchant context stay out of the public payment surface",
			missingArtifact: "agent-payment metadata field map",
			betaLimit:
				"beta workflow guidance; not a production privacy or compliance claim",
		};
	}
	if (id === "vanta-draft-x402-offer-receipt") {
		return {
			canProve:
				"offer terms and delivered-service receipt can be checked as separate proof-of-interaction artifacts",
			staysPrivate:
				"business context and nonessential request metadata stay outside the public proof",
			missingArtifact: "offer/receipt boundary field map",
			betaLimit:
				"proof-of-interaction framing only; Vanta remains beta and manually reviewed",
		};
	}
	if (id === "vanta-draft-signing-key-boundary") {
		return {
			canProve:
				"signing authority, offer terms, and delivery proof are separate boundaries",
			staysPrivate:
				"payment collection address and private note context do not become signing-key proof",
			missingArtifact: "signing-key/payment-address boundary checklist",
			betaLimit:
				"signing key boundary guidance; not a custody or security guarantee",
		};
	}
	if (artifactNeeded && artifactNeeded !== "none") {
		return {
			canProve: `${artifactNeeded} can back the public claim`,
			staysPrivate:
				"nonessential business context and source text stay out of the post",
			missingArtifact: artifactNeeded,
			betaLimit: "Vanta remains beta; review limits before posting",
		};
	}
	return {
		canProve: "manual review can confirm the claim stays narrow",
		staysPrivate: "source text and unnecessary context stay local",
		missingArtifact: "none",
		betaLimit: "Vanta remains beta; avoid readiness or privacy overclaims",
	};
}

export function buildVantaVoiceBridgePairs({
	personalPostDrafts,
	postDrafts,
}: {
	personalPostDrafts: Array<{
		id: string;
		archetype: string;
		artifactNeeded: string;
		tension: string;
	}>;
	postDrafts: Array<{
		id: string;
		archetype: string;
		artifactNeeded: string;
		tension: string;
	}>;
}): VantaVoiceBridgePair[] {
	const projectById = new Map(postDrafts.map((draft) => [draft.id, draft]));
	const personalById = new Map(
		personalPostDrafts.map((draft) => [draft.id, draft]),
	);
	const pairs: VantaVoiceBridgePair[] = [];
	const addPair = ({
		artifactNeeded,
		personalDraftId,
		projectDraftId,
		projectTranslation,
		proofBoundary,
		scoutMechanism,
	}: VantaVoiceBridgePair) => {
		if (
			!personalById.has(personalDraftId) ||
			!projectById.has(projectDraftId)
		) {
			return;
		}
		pairs.push({
			artifactNeeded,
			personalDraftId,
			projectDraftId,
			projectTranslation,
			proofBoundary,
			scoutMechanism,
		});
	};

	addPair({
		personalDraftId: "personal-draft-agent-payment-metadata",
		projectDraftId: "vanta-draft-agent-payment-metadata",
		scoutMechanism: "request context is often more sensitive than the payment",
		projectTranslation:
			"turn request context into metadata minimization, policy, and receipt boundaries",
		proofBoundary:
			"receipt proves enough; reason string/private note stays local; beta limit visible",
		artifactNeeded: "agent-payment metadata field map",
	});
	addPair({
		personalDraftId: "personal-draft-offer-receipt-boundary",
		projectDraftId: "vanta-draft-x402-offer-receipt",
		scoutMechanism:
			"paid APIs need proof of both the server promise and delivered service",
		projectTranslation:
			"turn offer and receipt fields into counterparty-verifiable proof without exposing extra request context",
		proofBoundary:
			"offer proves committed terms; receipt proves delivery; private notes and nonessential metadata stay local",
		artifactNeeded: "offer/receipt boundary field map",
	});
	addPair({
		personalDraftId: "personal-draft-signing-key-boundary",
		projectDraftId: "vanta-draft-signing-key-boundary",
		scoutMechanism:
			"agent-payment trust depends on which key is allowed to prove service delivery",
		projectTranslation:
			"separate signing authority, payment collection, offer terms, receipt, and private note surfaces",
		proofBoundary:
			"signing key proves the receipt boundary; payment address collects funds; custody and security claims stay out",
		artifactNeeded: "signing-key/payment-address boundary checklist",
	});
	addPair({
		personalDraftId: "personal-draft-wallet-group-chat",
		projectDraftId: "vanta-draft-recovery-surface",
		scoutMechanism:
			"wallet explanations have to survive screenshots and confused follow-up",
		projectTranslation:
			"turn payment success into recovery, retry, and receipt-state copy",
		proofBoundary:
			"show what failed or settled; keep private context local; avoid readiness claims",
		artifactNeeded: "failed-approval or recovery-state screenshot",
	});
	addPair({
		personalDraftId: "personal-draft-ct-product-spec",
		projectDraftId: "vanta-draft-receipt-anatomy",
		scoutMechanism: "CT panic reveals missing controls under public spectacle",
		projectTranslation:
			"turn the control gap into receipt anatomy and counterparty-useful proof",
		proofBoundary:
			"receipt says what happened, what can be checked, and what stays private",
		artifactNeeded: "marked-up receipt/trust packet",
	});

	if (!pairs.length && personalPostDrafts[0] && postDrafts[0]) {
		pairs.push({
			personalDraftId: personalPostDrafts[0].id,
			projectDraftId: postDrafts[0].id,
			scoutMechanism: personalPostDrafts[0].tension,
			projectTranslation: postDrafts[0].tension,
			proofBoundary:
				"receipt or review artifact proves enough while source text stays local",
			artifactNeeded: postDrafts[0].artifactNeeded,
		});
	}

	return pairs;
}

function topSignals(analytics: AnalyticsResponse) {
	return analytics.topicSignals
		.slice()
		.sort((left, right) => {
			const hasScoredSignal =
				typeof left.score === "number" || typeof right.score === "number";
			return (
				(hasScoredSignal ? topicScore(right) - topicScore(left) : 0) ||
				right.personalMentions - left.personalMentions ||
				right.projectMentions - left.projectMentions
			);
		})
		.slice(0, 3);
}

function buildBridgeTheme(analytics: AnalyticsResponse) {
	const project =
		analytics.accounts.find((account) => account.role === "project")?.handle ??
		"@vantaprivacy";
	const personal =
		analytics.accounts.find((account) => account.role === "personal")?.handle ??
		"@williamclay";
	const personalSignal =
		analytics.topicSignals
			.slice()
			.sort((left, right) => right.personalMentions - left.personalMentions)[0]
			?.topic ?? "audience";

	return `Route ${personal} ${safeTopic(personalSignal)} interest into ${project} privacy settlement posts.`;
}

function isSpammyOpportunity(item: ProjectOpportunityItem) {
	const text = item.text.toLowerCase();
	return (
		/follow back|dm me|send me dm|shoot dm|project growth|pump your project|let'?s collab/.test(
			text,
		) && item.likeCount === 0
	);
}

function formatFollowers(value: number) {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${Math.round(value / 100) / 10}k`;
	return String(value);
}

function nicheForText(value: string) {
	if (/agent|x402|api|wallet|permission/i.test(value))
		return "agent wallets and paid APIs";
	if (/merchant|settlement|invoice|receipt|payment/i.test(value))
		return "merchant settlement and receipts";
	if (/privacy|private|proof|disclos/i.test(value))
		return "privacy and proof boundaries";
	if (/solana|stablecoin/i.test(value)) return "Solana stablecoin ops";
	return "crypto operators and product builders";
}

function targetFromOpportunity(
	item: ProjectOpportunityItem,
): VantaEngagementTarget {
	const text = `${item.text} ${item.reason} ${item.author.bio}`;
	const score = Math.min(
		100,
		12 + item.likeCount * 3 + Math.floor(item.author.followersCount / 1200),
	);
	return {
		handle: item.author.handle,
		displayName: item.author.displayName,
		niche: nicheForText(text),
		score,
		reason: item.reason,
		evidence: `${item.likeCount} likes; ${formatFollowers(item.author.followersCount)} followers; "${safeEvidence(item.text)}"`,
		nextAction: `Reply to @${item.author.handle} only after source review; use their question as the proof-boundary prompt.`,
	};
}

function targetFromSharedAudience(
	item: SharedAudienceItem,
): VantaEngagementTarget {
	const totalMentions = item.projectMentions + item.personalMentions;
	const score = Math.min(
		100,
		totalMentions * 9 + Math.floor(item.profile.followersCount / 1800),
	);
	return {
		handle: item.profile.handle,
		displayName: item.profile.displayName,
		niche: nicheForText(`${item.profile.bio} ${item.profile.displayName}`),
		score,
		reason: "Warm overlap across personal and project account signal",
		evidence: `${item.projectMentions} project mentions; ${item.personalMentions} personal mentions; ${formatFollowers(item.profile.followersCount)} followers`,
		nextAction: `Use @${item.profile.handle} as a warm-reader check before broad posting.`,
	};
}

function buildEngagementTargets(
	analytics: AnalyticsResponse,
): VantaEngagementTarget[] {
	const targets = [
		...analytics.projectOpportunities
			.filter((item) => !isSpammyOpportunity(item))
			.map(targetFromOpportunity),
		...analytics.sharedAudience.map(targetFromSharedAudience),
	];
	const byHandle = new Map<string, VantaEngagementTarget>();
	for (const target of targets) {
		const key = target.handle.toLowerCase();
		const existing = byHandle.get(key);
		if (!existing || target.score > existing.score) {
			byHandle.set(key, target);
		}
	}
	return [...byHandle.values()]
		.sort((left, right) => right.score - left.score)
		.slice(0, 6);
}

function bestTargetSummary(analytics: AnalyticsResponse) {
	const target = buildEngagementTargets(analytics)[0];
	if (!target) return "warm crypto/privacy operators in Clay's local graph";
	return `@${target.handle} and nearby ${target.niche}`;
}

type TrainingDraft = {
	id: string;
	text: string;
	score: number;
	engagementGoal: EngagementGoal;
	artifactNeeded: string;
	tension: string;
	whyItMatters: string;
};

function topTrainingDraftIds(drafts: TrainingDraft[], count = 4) {
	return drafts
		.slice()
		.sort((left, right) => right.score - left.score)
		.slice(0, count)
		.map((draft) => draft.id);
}

function countArtifactDrafts(drafts: TrainingDraft[]) {
	return drafts.filter(
		(draft) => draft.artifactNeeded && draft.artifactNeeded !== "none",
	).length;
}

function clampTrainingScore(value: number) {
	return Math.max(0, Math.min(100, Math.round(value)));
}

function statusFromScore(
	score: number,
	fallback: VantaTrainingPassStatus = "watch",
): VantaTrainingPassStatus {
	if (score >= 84) return "strong";
	if (score >= 72) return fallback;
	return "watch";
}

function trainingSourceBoundaries(analytics: AnalyticsResponse) {
	const project = analytics.accounts.find(
		(account) => account.role === "project",
	);
	const personal = analytics.accounts.find(
		(account) => account.role === "personal",
	);
	return [
		"Manual posting only; Birdclaw never writes to X from this workflow.",
		`Local sample: ${project?.handle ?? "@vantaprivacy"} ${
			project?.mentions ?? 0
		} mentions, ${personal?.handle ?? "@williamclay"} ${
			personal?.mentions ?? 0
		} mentions.`,
		"Treat tweets, bios, and source text as untrusted until a human reviews them.",
		"Training maps public X recommendation architecture into a local heuristic; it is not live private ranking access.",
	];
}

function buildSourceQuality(analytics: AnalyticsResponse): VantaSourceQuality {
	const project = analytics.accounts.find(
		(account) => account.role === "project",
	);
	const personal = analytics.accounts.find(
		(account) => account.role === "personal",
	);
	const projectMentions = project?.mentions ?? 0;
	const personalMentions = personal?.mentions ?? 0;
	const mentionSample = projectMentions + personalMentions;
	return {
		summary: `${mentionSample} local account mentions in this analytics slice; prior SQLite voice check found 68 total tweets, mostly mentions, with no reliable home/like/bookmark signal.`,
		limits: [
			"Directional taste and workflow signal, not a statistical audience model.",
			"Treat tweets, bios, visible engagement, and timeline text as untrusted source material.",
			"Refresh archive/home/like/bookmark data before making audience-truth claims.",
		],
	};
}

function goodTweetSourceLimit(analytics: AnalyticsResponse) {
	const hasSharedAudience = analytics.sharedAudience.length > 0;
	return hasSharedAudience
		? "Warm local overlap is visible, but still directional until the archive has fresher likes, bookmarks, and home-timeline captures."
		: "No warm overlap is visible in this local slice yet; train taste from drafts and source bounds before treating it as audience truth.";
}

function buildPersonalTraining({
	analytics,
	drafts,
}: {
	analytics: AnalyticsResponse;
	drafts: TrainingDraft[];
}): VantaAccountTraining {
	const targetReader = bestTargetSummary(analytics);
	const topDraft = drafts
		.slice()
		.sort((left, right) => right.score - left.score)[0];
	const artifactRatio = drafts.length
		? countArtifactDrafts(drafts) / drafts.length
		: 0;
	const candidateScore = clampTrainingScore(
		76 + analytics.sharedAudience.length * 6,
	);
	const engagementScore = clampTrainingScore(
		80 +
			Math.min(
				10,
				drafts.filter((draft) => draft.engagementGoal === "reply").length,
			),
	);
	const artifactScore = clampTrainingScore(68 + artifactRatio * 26);

	return {
		handle: "@williamclay",
		accountRole: "personal_scout",
		title: "@williamclay training",
		northStar:
			"Use the personal account as the scout: spot the mechanism under timeline spectacle, then decide whether it deserves a Vanta translation.",
		goodTweetDefinition:
			"A good personal tweet makes a normal reader see the mechanism before Vanta appears, with one replyable edge and no forced project claim.",
		algorithmPasses: [
			{
				id: "personal-candidate-source",
				label: "Candidate source fit",
				score: candidateScore,
				status: statusFromScore(candidateScore),
				algorithmMechanic:
					"in-network follows and out-of-network topic similarity need a post a reader can classify quickly.",
				accountRule:
					"@williamclay should name the mechanism under the timeline object before making a larger point.",
				evidence:
					topDraft?.whyItMatters ??
					"Personal draft bank emphasizes mechanism reads before project translation.",
				drill:
					"Rewrite one broad AI, wallet, or launch take until the first line names the concrete mechanism.",
			},
			{
				id: "personal-engagement-probability",
				label: "Engagement-probability fit",
				score: engagementScore,
				status: statusFromScore(engagementScore),
				algorithmMechanic:
					"Predicted reply, favorite, repost, click, share, and dwell reward compact posts with a clear interaction job.",
				accountRule:
					"Make the post replyable without turning it into bait: one claim, one edge, one concrete noun.",
				evidence: `Target reader: ${targetReader}.`,
				drill:
					"Turn the second sentence into a question a builder could answer from experience.",
			},
			{
				id: "personal-social-proof",
				label: "Social proof fit",
				score: clampTrainingScore(72 + analytics.sharedAudience.length * 5),
				status: analytics.sharedAudience.length ? "strong" : "watch",
				algorithmMechanic:
					"Out-of-network quality often improves when nearby people have engaged with the author or topic.",
				accountRule:
					"Use Clay's local graph as taste direction, not proof; write for nearby crypto/product builders first.",
				evidence: goodTweetSourceLimit(analytics),
				drill:
					"Name the one person type who would reply before polishing the line.",
			},
			{
				id: "personal-negative-filter",
				label: "Negative-signal filter",
				score: 88,
				status: "strong",
				algorithmMechanic:
					"not-interested, mute, block, report, and low-quality feedback should be treated as ranking drag.",
				accountRule:
					"Remove shock bait, quote-tweet pile-ons, moralizing, and forced Vanta jumps.",
				evidence:
					"Personal review checklist rejects shock bait and source text is treated as untrusted.",
				drill:
					"Cut any sentence that sounds like a dunk; replace it with the missing control surface.",
			},
			{
				id: "personal-voice-fit",
				label: "Voice correctness",
				score: 86,
				status: "strong",
				algorithmMechanic:
					"Author identity and audience expectation affect whether people engage or bounce.",
				accountRule:
					"Stay wry, concrete, and founder-taste-driven; do not sound like a project press release.",
				evidence:
					"Voice bridge keeps @williamclay sharper while @vantaprivacy stays artifact-backed.",
				drill:
					"Read the draft aloud; if it sounds like brand copy, move it to the project account or delete it.",
			},
			{
				id: "personal-artifact-dwell",
				label: "Artifact and dwell fit",
				score: artifactScore,
				status: statusFromScore(artifactScore, "needs_artifact"),
				algorithmMechanic:
					"Images, screenshots, workflows, and reusable formats can increase clicks, dwell, bookmarks, and shares.",
				accountRule:
					"Add a screenshot or checklist only when it makes the product mechanism inspectable.",
				evidence: `${countArtifactDrafts(drafts)} of ${drafts.length} personal drafts have an artifact path.`,
				drill:
					"Attach one local workflow screenshot and rewrite the caption to explain only what it proves.",
			},
		],
		goodTweetRules: [
			"Make the normal reader understand the mechanism before naming a niche.",
			"Keep one replyable edge: permission, blame, receipt, recovery, or context.",
			"Use concrete nouns: wallet, agent, chart, receipt, screenshot, approval.",
			"Let the personal account test taste; do not force Vanta into the punchline.",
			"Write the line so it still works if the current event disappears tomorrow.",
		],
		antiPatterns: [
			"forced Vanta translation in a personal post.",
			"Quote-tweet pile-ons that borrow attention without adding a mechanism.",
			"Broad AI doom, founder theater, or future-of-crypto prophecy.",
			"Inside jokes that a normal reader cannot parse from the first line.",
		],
		drills: [
			"rewrite one vague AI take as a permission-boundary take.",
			"Turn one launch-culture reaction into a receipt or recovery question.",
			"Take the best draft and remove every abstract noun that can become a concrete object.",
			"Write a second version that a non-crypto friend can understand without losing the edge.",
		],
		scorecard: [
			{
				label: "Normal-human hook",
				score: 86,
				target: "Readable before niche context.",
				evidence:
					topDraft?.text ??
					"Personal draft bank starts from concrete mechanism reads.",
			},
			{
				label: "Reply edge",
				score: 84,
				target: "One clean disagreement or clarification path.",
				evidence:
					topDraft?.tension ??
					"Training emphasizes visible tension before category language.",
			},
			{
				label: "Voice separation",
				score: 90,
				target: "Personal scout voice stays distinct from project voice.",
				evidence:
					"Voice bridge pairs translate scout reads into project-safe copy.",
			},
			{
				label: "Artifact potential",
				score: artifactScore,
				target:
					"Screenshot or checklist appears only when it improves inspectability.",
				evidence: `${countArtifactDrafts(drafts)} artifact-ready personal lanes.`,
			},
		],
		exampleTransformations: [
			{
				before: "agent wallets are risky",
				after:
					"the agent wallet problem is not intelligence. it is blast radius.",
				why: "It replaces a category warning with a concrete mechanism people can argue about.",
			},
			{
				before: "crypto launches are chaotic",
				after:
					"launch culture is mostly a stress test for whether the explanation can survive the chart.",
				why: "It keeps the current-event energy but makes the product lesson durable.",
			},
		],
		topDraftIds: topTrainingDraftIds(drafts),
		sourceBoundaries: trainingSourceBoundaries(analytics),
	};
}

function buildProjectTraining({
	analytics,
	drafts,
	engagementTargets,
}: {
	analytics: AnalyticsResponse;
	drafts: TrainingDraft[];
	engagementTargets: VantaEngagementTarget[];
}): VantaAccountTraining {
	const artifactCount = countArtifactDrafts(drafts);
	const targetReader = engagementTargets[0]
		? `@${engagementTargets[0].handle} and nearby ${engagementTargets[0].niche}`
		: bestTargetSummary(analytics);
	const proofScore = clampTrainingScore(82 + Math.min(10, artifactCount));
	const artifactScore = clampTrainingScore(
		70 + (drafts.length ? (artifactCount / drafts.length) * 30 : 0),
	);

	return {
		handle: "@vantaprivacy",
		accountRole: "project_publisher",
		title: "@vantaprivacy training",
		northStar:
			"Publish calm project copy that turns attention into receipts, proof boundaries, merchant context, and beta-truth.",
		goodTweetDefinition:
			"A good project tweet is useful to a counterparty: what happened, what can be checked, what stays private, and what remains beta.",
		algorithmPasses: [
			{
				id: "project-candidate-source",
				label: "Candidate source fit",
				score: 82,
				status: "watch",
				algorithmMechanic:
					"in-network and out-of-network candidate paths need topic relevance plus a reason to survive first-glance filtering.",
				accountRule:
					"@vantaprivacy should lead with receipts, merchants, payment context, or proof boundaries instead of abstract privacy.",
				evidence: `Target reader: ${targetReader}.`,
				drill:
					"Rewrite the first line so a merchant operator can tell why it matters without knowing Vanta.",
			},
			{
				id: "project-engagement-probability",
				label: "Engagement-probability fit",
				score: 88,
				status: "strong",
				algorithmMechanic:
					"Predicted favorite, reply, repost, click, share, and dwell are stronger when the post has a concrete save or debate job.",
				accountRule:
					"Make the receipt, artifact, field map, or proof boundary save-worthy before asking for attention.",
				evidence: `${artifactCount} of ${drafts.length} project drafts point to an artifact.`,
				drill:
					"Add the exact receipt or policy field that would make the post worth bookmarking.",
			},
			{
				id: "project-social-proof",
				label: "Social proof fit",
				score: clampTrainingScore(
					76 + Math.min(12, engagementTargets.length * 3),
				),
				status: engagementTargets.length ? "strong" : "watch",
				algorithmMechanic:
					"Social proof and nearby graph engagement help an out-of-network project post look safer to rank.",
				accountRule:
					"Write for actual engaged people first; make their operational problem obvious.",
				evidence:
					engagementTargets[0]?.evidence ??
					"No warm engaged target in this local slice yet.",
				drill:
					"Before copy, name the exact merchant, API builder, wallet team, or operator who would save it.",
			},
			{
				id: "project-negative-filter",
				label: "Negative-signal filter",
				score: 92,
				status: "strong",
				algorithmMechanic:
					"Hard filters, muted keywords, reports, blocks, and not-interested feedback should shape copy discipline.",
				accountRule:
					"Remove anonymous, untraceable, fully private, readiness, audit, and compliance-safety claims.",
				evidence:
					"Vanta forbidden-claims guardrail and review checklist stay attached to every draft.",
				drill:
					"Replace any privacy adjective with a field boundary: public, counterparty-visible, private, or beta.",
			},
			{
				id: "project-voice-fit",
				label: "Voice correctness",
				score: 87,
				status: "strong",
				algorithmMechanic:
					"Project accounts earn trust when repeated posts match a recognizable job and expectation.",
				accountRule:
					"Stay calm, artifact-backed, merchant-first, and explicit about current beta limits.",
				evidence:
					"Project drafts emphasize receipts, metadata, policy, recovery, and proof boundaries.",
				drill:
					"Delete any hype line; replace it with what can be verified and what stays private.",
			},
			{
				id: "project-artifact-dwell",
				label: "Artifact and dwell fit",
				score: artifactScore,
				status: statusFromScore(artifactScore, "needs_artifact"),
				algorithmMechanic:
					"Inspectability can earn clicks, dwell, bookmarks, repost context, and useful replies.",
				accountRule:
					"Pair claims with an artifact before copying: receipt, field map, policy screen, or proof-boundary checklist.",
				evidence: `${artifactCount} artifact lanes visible in the project draft bank.`,
				drill:
					"Turn one sentence into a marked-up receipt or field map, then rewrite the caption around that artifact.",
			},
		],
		goodTweetRules: [
			"Say what happened before saying why it matters.",
			"Say what can be checked by the counterparty.",
			"Say what stays private, local, or out of the broadcast.",
			"Keep the beta limit visible when proof or privacy is mentioned.",
			"Use merchant/operator nouns before abstract privacy language.",
		],
		antiPatterns: [
			"anonymous, untraceable, fully private, audited, or production-ready claims.",
			"Generic future-of-crypto privacy positioning.",
			"We are excited launch copy with no artifact or counterparty use.",
			"Proof language that does not say who verifies what.",
		],
		drills: [
			"Rewrite a privacy claim as a receipt field map.",
			"Turn a launch take into what happened / what can be checked / what stays private.",
			"Add the missing beta limit to the strongest project draft.",
			"Write the same point for a merchant operator, not a crypto fan.",
		],
		scorecard: [
			{
				label: "Counterparty usefulness",
				score: 88,
				target:
					"A merchant, wallet team, API builder, or operator knows the next action.",
				evidence: targetReader,
			},
			{
				label: "Proof boundary",
				score: proofScore,
				target: "Can prove / stays private / missing artifact / beta limit.",
				evidence: "Drafts carry proofBoundary metadata into the UI.",
			},
			{
				label: "Artifact readiness",
				score: artifactScore,
				target:
					"Strong claims have screenshots, receipts, field maps, or checklists.",
				evidence: `${artifactCount} artifact-backed project drafts.`,
			},
			{
				label: "Claim safety",
				score: 92,
				target:
					"No forbidden readiness, audit, anonymity, or guaranteed-privacy language.",
				evidence:
					"Forbidden-claim guardrails and copy gates block unsafe text.",
			},
		],
		exampleTransformations: [
			{
				before: "private payments for merchants",
				after:
					"private settlement needs one public surface: the receipt. enough to verify, not enough to leak the workflow.",
				why: "It turns abstract privacy into counterparty-useful proof and a clear boundary.",
			},
			{
				before: "agent payments need privacy",
				after:
					"when every API becomes a checkout, the missing UI is policy: amount, route, purpose, expiry, revocation, receipt.",
				why: "It replaces a broad claim with concrete fields people can save or debate.",
			},
		],
		topDraftIds: topTrainingDraftIds(drafts),
		sourceBoundaries: trainingSourceBoundaries(analytics),
	};
}

export function buildVantaAccountTraining({
	analytics,
	engagementTargets,
	personalPostDrafts,
	postDrafts,
}: {
	analytics: AnalyticsResponse;
	engagementTargets: VantaEngagementTarget[];
	personalPostDrafts: TrainingDraft[];
	postDrafts: TrainingDraft[];
}): VantaTrainingLoop {
	return {
		source:
			"X public recommendation architecture mapped onto local Birdclaw signal: candidate sourcing, Grok/ML engagement predictions, social proof, filtering, negative feedback, and author diversity.",
		algorithmPrinciples: [
			"candidate source fit: in-network and out-of-network posts need a clear relevance path.",
			"ranking fit: engagement probabilities reward favorite, reply, repost, quote, click, share, dwell, and follow-author likelihood.",
			"social proof fit: nearby graph engagement can make out-of-network posts safer to surface.",
			"negative-signal filter: blocks, mutes, reports, not-interested, spam, duplicate, and fatigue signals should shape copy discipline.",
			"artifact and dwell fit: screenshots, receipts, field maps, and reusable checklists can create inspectability.",
			"author diversity fit: split personal scout voice from project publisher voice so one account does not crowd out the other.",
		],
		limits: [
			"Local Birdclaw sample is directional, small, and read-only.",
			"Public X algorithm sources do not expose every live production weight or personalization detail.",
			"Training improves draft judgment; it does not post, like, reply, or mutate X.",
			"Vanta copy remains beta-truthful and manual-review-first.",
		],
		accounts: [
			buildPersonalTraining({ analytics, drafts: personalPostDrafts }),
			buildProjectTraining({
				analytics,
				drafts: postDrafts,
				engagementTargets,
			}),
		],
	};
}

function rankingSignalForGoal(goal: EngagementGoal) {
	const signals = {
		bookmark:
			"save-worthy utility: checklists, field maps, and reusable receipt language",
		like: "clean agreement payoff without requiring Vanta context",
		proof:
			"artifact dwell: screenshot, receipt, or proof lane gives people something inspectable",
		reply: "reply probability: one clear edge people can argue or clarify",
		share:
			"repost/quote probability: a compressed contradiction that travels without a thread",
	} as const;
	return signals[goal];
}

function algorithmFitForDraft({
	accountLane,
	analytics,
	artifactNeeded,
	engagementGoal,
	tension,
}: {
	accountLane: "project" | "personal" | "reply";
	analytics: AnalyticsResponse;
	artifactNeeded?: string;
	engagementGoal: EngagementGoal;
	tension: string;
}): VantaAlgorithmFit {
	const targetReader = bestTargetSummary(analytics);
	const candidatePath =
		accountLane === "personal"
			? "Personal scout lane: Clay's in-network taste plus topic-similar crypto/product builders."
			: accountLane === "reply"
				? "Conversation lane: answer an existing mention so the reply can earn its own home-timeline merit."
				: "Project lane: warm overlap, social proof, and topic similarity around receipts, wallets, privacy, and agent payments.";
	const artifactClause =
		artifactNeeded && artifactNeeded !== "none"
			? ` The missing artifact (${artifactNeeded}) should create the save/dwell reason.`
			: "";
	const normalHumanWhy =
		accountLane === "personal"
			? "A normal reader should recognize the product failure before they need to know Vanta exists."
			: "A normal reader should understand what happened, what can be checked, and what stays private.";
	return {
		candidatePath,
		rankingSignal: rankingSignalForGoal(engagementGoal),
		targetReader,
		whyItCanTravel: `It has a visible tension (${tension}) and a concrete noun surface instead of abstract crypto positioning.${artifactClause}`,
		normalHumanWhy,
		source:
			"Birdclaw heuristic based on X's public recommendation architecture: candidate sourcing, engagement-probability ranking, social proof, filtering, and author diversity.",
	};
}

function buildPillars(analytics: AnalyticsResponse): VantaContentPillar[] {
	const signals = topSignals(analytics);
	const pillars = signals.map((signal, index) => {
		const template = pillarTemplates[index] ?? pillarTemplates[0];
		const score = topicScore(signal);
		return {
			title: template.title,
			topic: safeTopic(signal.topic),
			angle: template.angle,
			sourceSignal: sourceSignalFor(signal, template.topic),
			priority: priorityFromScore(score),
			score,
			nextAction:
				index === 0
					? "Draft a receipt-focused post"
					: "Turn into a manual content lane",
			whyItMatters:
				index === 0
					? "Highest current signal for turning Vanta privacy into a counterparty-useful receipt story."
					: "Keeps the project account grounded in actual audience interest instead of abstract privacy claims.",
			sourceEvidence: sourceEvidenceFor(signal, template.topic),
		};
	});

	while (pillars.length < pillarTemplates.length) {
		const template = pillarTemplates[pillars.length] ?? pillarTemplates[0];
		pillars.push({
			title: template.title,
			topic: template.topic,
			angle: template.angle,
			sourceSignal: "Vanta voice contract and distribution ethos.",
			priority: "low",
			score: 6,
			nextAction: "Hold as fallback lane",
			whyItMatters:
				"Provides a safe default lane when live local signals are sparse.",
			sourceEvidence: ["Vanta voice contract and distribution ethos."],
		});
	}

	return pillars;
}

function buildPostDrafts(analytics: AnalyticsResponse): VantaPostDraft[] {
	const signals = topSignals(analytics);
	const sourceSignal = sourceSignalFor(
		signals[0],
		"Personal interests are being routed into project-account positioning.",
	);
	const sourceEvidence = sourceEvidenceFor(
		signals[0],
		"Personal interests are being routed into project-account positioning.",
	);
	const primaryScore = topicScore(signals[0]);
	const drafts = [
		{
			id: "vanta-draft-counterparty-privacy",
			archetype: "control-surface thesis",
			body: "private settlement needs one public surface: the receipt. enough to verify, not enough to leak the workflow.",
			sourceSignal,
			score: Math.max(primaryScore, 20),
			nextAction: "Review and queue manually",
			whyItMatters:
				"Uses CT compression to center the receipt loop and selective disclosure without implying unsafe privacy guarantees.",
			engagementGoal: "share" as const,
			engagementPattern: "contradiction" as const,
			tension: "public verification vs business privacy",
			replyEdge:
				"What should a receipt prove, and what should stay out of view?",
			artifactNeeded: "receipt screenshot or proof-lane screenshot",
			sourceEvidence,
		},
		{
			id: "vanta-draft-solana-merchant",
			archetype: "personal-interest bridge",
			body: "the part after the refund drama is the product: who approved it, what changed, what can be proven, what stays out of view.",
			sourceSignal,
			score: primaryScore,
			nextAction: "Review and queue manually",
			whyItMatters:
				"Turns personal-account topic heat into merchant-first project language that can survive the timeline moving on.",
			engagementGoal: "reply" as const,
			engagementPattern: "current_event_reframe" as const,
			tension: "launch drama vs recoverable payment context",
			replyEdge: "Builders can argue what belongs in the receipt.",
			artifactNeeded: "refund or receipt anatomy screenshot",
			sourceEvidence,
		},
		{
			id: "vanta-draft-launch-recovery",
			archetype: "launch recovery path",
			body: "launches need more than attention. they need receipts, status, and recovery paths that still make sense after the thread is gone.",
			sourceSignal:
				"Forty-loop CT taste pass: launch/refund attention only becomes useful when it turns into durable status and recovery evidence.",
			score: Math.max(primaryScore - 1, 24),
			nextAction: "Pair with launch/refund status map",
			whyItMatters:
				"Turns launch culture into a normal-human recovery story instead of promotion or pile-on commentary.",
			engagementGoal: "bookmark" as const,
			engagementPattern: "current_event_reframe" as const,
			tension: "attention spike vs recoverable status",
			replyEdge:
				"Founders and operators can argue what a launch needs after the thread stops moving.",
			artifactNeeded: "launch/refund status map",
			sourceEvidence: [
				"Current CT loop: refund and launch ambiguity travel, but the durable Vanta lane is status, proof, and recovery.",
				"Product adaptation: show who approved what, what changed, what can be verified, and what remains private.",
			],
		},
		{
			id: "vanta-draft-agent-permissions",
			archetype: "agent-permission critique",
			body: "the question is no longer whether agents can touch wallets. it is what they were allowed to touch.",
			sourceSignal: "Vanta voice contract: agent-safe control surfaces.",
			score: 26,
			nextAction: "Review and queue manually",
			whyItMatters:
				"Connects agentic commerce to safer approval surfaces without claiming production readiness.",
			engagementGoal: "bookmark" as const,
			engagementPattern: "compressed_take" as const,
			tension: "autonomy vs permission",
			replyEdge:
				"Agent builders can push on what the minimum permission set should be.",
			artifactNeeded: "permission screen or limit config screenshot",
			sourceEvidence: ["Vanta voice contract: agent-safe control surfaces."],
		},
		{
			id: "vanta-draft-agent-payment-policy",
			archetype: "x402 policy surface",
			body: "when every API becomes a checkout, the missing UI is policy: amount, route, purpose, expiry, revocation, receipt.",
			sourceSignal:
				"Forty-loop CT taste pass: x402, MPP, and agent payments are current, but the missing layer is policy and receipt clarity.",
			score: 24,
			nextAction: "Pair with an agent spend-limit screenshot",
			whyItMatters:
				"Turns current x402/agent-payment attention into a Vanta-native permission and receipt lane.",
			engagementGoal: "bookmark" as const,
			engagementPattern: "compressed_take" as const,
			tension: "payment rail vs permission policy",
			replyEdge:
				"Agent builders can debate what policy fields belong in the default flow.",
			artifactNeeded: "agent spending policy or limit config screenshot",
			sourceEvidence: [
				"Search-visible CT and docs around x402/MPP show agent payments moving from demo to control-plane problem.",
				"Reusable bookmark format: scope, route, purpose, expiration, receipt, revocation.",
			],
		},
		{
			id: "vanta-draft-receipt-anatomy",
			archetype: "receipt anatomy",
			body: "a useful private payment receipt answers three questions: what happened, what can be verified, and what stays private.",
			sourceSignal:
				"Forty-loop CT taste pass: proof artifacts and receipt anatomy are the most durable Vanta project-account lane.",
			score: 25,
			nextAction: "Build a marked-up receipt/trust-packet screenshot",
			whyItMatters:
				"Makes Vanta's privacy story concrete and save-worthy without making broad privacy claims.",
			engagementGoal: "proof" as const,
			engagementPattern: "artifact_caption" as const,
			tension: "counterparty confidence vs transaction graph exposure",
			replyEdge:
				"Operators can ask which fields belong in the public, counterparty, and private parts of a receipt.",
			artifactNeeded: "marked-up receipt/trust packet",
			sourceEvidence: [
				"Project-account loop: receipts should prove the thing happened, not publish everything around it.",
				"Premium voice rule: artifact-backed, beta-truthful, counterparty-useful privacy.",
			],
		},
		{
			id: "vanta-draft-merchant-metadata",
			archetype: "merchant metadata privacy",
			body: "merchant privacy is usually metadata privacy. the payment can be visible while the invoice id, customer context, payout reason, and internal note stay out of the broadcast.",
			sourceSignal:
				"Project loops: merchant metadata privacy is the strongest new lane because it makes privacy operational instead of abstract.",
			score: 27,
			nextAction: "Pair with a redacted receipt field map",
			whyItMatters:
				"Turns privacy into a merchant workflow problem with concrete fields and clear counterparty usefulness.",
			engagementGoal: "bookmark" as const,
			engagementPattern: "contradiction" as const,
			tension: "public movement vs private business context",
			replyEdge:
				"Operators can argue which fields belong in public, counterparty-visible, and internal lanes.",
			artifactNeeded: "redacted receipt field map",
			sourceEvidence: [
				"Project loops: say invoice, customer context, payout reason, and internal note before saying privacy.",
				"Dashboard rule: reward counterparty usefulness and claim safety.",
			],
		},
		{
			id: "vanta-draft-agent-spend-policy",
			archetype: "agent spend policy",
			body: "an agent spend limit should read like a policy, not a vibe: max amount, allowed route, purpose, expiry, revocation, receipt.",
			sourceSignal:
				"Project loops: agent payments are moving from autonomy demos to readable policy, limit, and receipt surfaces.",
			score: 26,
			nextAction: "Pair with a spend-policy config screenshot",
			whyItMatters:
				"Creates a bookmarkable policy primitive for agent wallets without praising unlimited autonomy.",
			engagementGoal: "bookmark" as const,
			engagementPattern: "compressed_take" as const,
			tension: "agent convenience vs explicit blast radius",
			replyEdge:
				"Agent builders can debate the default fields for a safe spend policy.",
			artifactNeeded: "agent spend-policy config screenshot",
			sourceEvidence: [
				"Project loops: scope, spend limits, expiry, revocation, and receipts are the current agent-payment control plane.",
			],
		},
		{
			id: "vanta-draft-agent-payment-metadata",
			archetype: "agent payment metadata",
			body: "agent payments do not just move money. they also describe what the agent wanted, where it went, and why the request existed.",
			sourceSignal:
				"May 2 current-reference pass: x402 turns paid API calls into a live agent-payment rail, but request metadata becomes part of the trust and leak surface.",
			score: 28,
			nextAction: "Pair with an agent-payment metadata field map",
			whyItMatters:
				"Moves the current x402 conversation from payment novelty to Vanta's stronger lane: policy, metadata minimization, and receipt boundaries.",
			engagementGoal: "bookmark" as const,
			engagementPattern: "compressed_take" as const,
			tension: "autonomous payment vs request-context exposure",
			replyEdge:
				"Agent and API builders can argue which metadata belongs in the payment request, receipt, or private note.",
			artifactNeeded: "agent-payment metadata field map",
			sourceEvidence: [
				"Solana x402 guide: payment verification, receipt generation, error handling, and Solana examples are now active implementation concerns.",
				"April 2026 x402 metadata research: resource URLs, descriptions, and reason strings can travel before settlement unless filtered by policy.",
			],
		},
		{
			id: "vanta-draft-x402-offer-receipt",
			archetype: "x402 offer receipt boundary",
			body: "paid API calls need two receipts: the offer the server committed to, and the service the client actually received.",
			sourceSignal:
				"May 2 current-reference pass: x402 signed offers and receipts make proof-of-interaction concrete for agent payments.",
			score: 27,
			nextAction: "Pair with an offer/receipt boundary field map",
			whyItMatters:
				"Connects live x402 implementation work to Vanta's strongest lane: proof artifacts that help counterparties verify without exposing excess context.",
			engagementGoal: "bookmark" as const,
			engagementPattern: "compressed_take" as const,
			tension: "server promise vs delivered service",
			replyEdge:
				"Agent, API, and wallet builders can debate which fields belong in the offer, receipt, payment proof, or private note.",
			artifactNeeded: "offer/receipt boundary field map",
			sourceEvidence: [
				"x402 signed-offer/receipt docs frame offers and receipts as portable proof-of-interaction artifacts.",
				"Solana x402 guide: payment-required flows involve payment terms, verification, settlement, response, receipt generation, and error handling.",
				"x402 metadata-risk research: resource URLs, descriptions, and reason strings can travel before settlement.",
			],
		},
		{
			id: "vanta-draft-signing-key-boundary",
			archetype: "signing-key boundary",
			body: "the key that signs a receipt should be a boundary, not a shortcut. keep payment collection, offer terms, and delivery proof separate.",
			sourceSignal:
				"May 2 current-reference pass: x402 signed offers and receipts make the signing key a visible trust boundary, separate from payment collection.",
			score: 26,
			nextAction: "Pair with a signing-key/payment-address boundary checklist",
			whyItMatters:
				"Turns current x402 implementation detail into a Vanta-native proof-boundary lane without broad safety claims.",
			engagementGoal: "bookmark" as const,
			engagementPattern: "compressed_take" as const,
			tension: "receipt signing authority vs payment collection address",
			replyEdge:
				"Agent-payment builders can argue where the signing key, payment address, offer terms, receipt, and private note should live.",
			artifactNeeded: "signing-key/payment-address boundary checklist",
			sourceEvidence: [
				"x402 signed-offer/receipt docs: Signing Key is not the payment address; the signing key should be dedicated.",
				"Current x402/Solana payment flow: offer terms, settlement, response, and receipt generation are separate review surfaces.",
			],
		},
		{
			id: "vanta-draft-recovery-surface",
			archetype: "recovery surface",
			body: "recovery is part of the payment surface. if a wallet can approve, spend, or settle, it should also explain what failed and what can be retried.",
			sourceSignal:
				"Project loops: recovery is an underused Vanta lane for failed approvals, refund ambiguity, retries, and trust after errors.",
			score: 23,
			nextAction: "Pair with a failed-approval or recovery-state screenshot",
			whyItMatters:
				"Moves Vanta copy from ideal flow claims into operational trust after something goes wrong.",
			engagementGoal: "proof" as const,
			engagementPattern: "artifact_caption" as const,
			tension: "successful settlement vs recoverable failure",
			replyEdge:
				"Wallet and merchant teams can name the failure states users need explained.",
			artifactNeeded: "failed-approval or recovery-state screenshot",
			sourceEvidence: [
				"Project loops: what happens after failed approval, refund ambiguity, or retry should be part of the surface.",
			],
		},
		{
			id: "vanta-draft-beta-proof-boundary",
			archetype: "beta proof boundary",
			body: "proof is stronger when it has a boundary. this happened, this can be checked, this stays private, this is still beta.",
			sourceSignal:
				"Project loops: beta truth should be product discipline, not apology; every proof claim needs a visible boundary.",
			score: 21,
			nextAction: "Pair with a proof-boundary checklist",
			whyItMatters:
				"Sharpens Vanta's public voice around proof artifacts while avoiding readiness or privacy overclaims.",
			engagementGoal: "share" as const,
			engagementPattern: "compressed_take" as const,
			tension: "proof confidence vs beta limits",
			replyEdge:
				"Builders can debate what belongs in the proof, private, and review-needed columns.",
			artifactNeeded: "proof-boundary checklist",
			sourceEvidence: [
				"Project loops: prefer what can be verified, what stays private, and what still needs review over broad claims.",
			],
		},
	];

	return drafts.map((draft) => {
		const text = clampPost(draft.body);
		return {
			...draft,
			body: text,
			text,
			approvedToPost: false,
			priority: priorityFromScore(draft.score),
			proofBoundary: proofBoundaryForDraft({
				artifactNeeded: draft.artifactNeeded,
				id: draft.id,
			}),
			reviewChecklist: reviewChecklistFor(text),
			algorithmFit: algorithmFitForDraft({
				accountLane: "project",
				analytics,
				artifactNeeded: draft.artifactNeeded,
				engagementGoal: draft.engagementGoal,
				tension: draft.tension,
			}),
		};
	});
}

function buildPersonalPostDrafts(
	analytics: AnalyticsResponse,
): PersonalPostDraft[] {
	const signals = topSignals(analytics);
	const sourceSignal = sourceSignalFor(
		signals[0],
		"Personal account should scout the timeline and turn live interest into useful market anthropology.",
	);
	const sourceEvidence = [
		"Fresh @williamclay For You snapshot: comedy and controversy scaled when the hook was instantly legible.",
		"AI failure, CT PVP, market headlines, Solana, launch/refund drama, and dev-culture posts recurred as live interest lanes.",
		"Engagement lesson: keep the hook compressed, then add a mechanism instead of chasing shock.",
	];
	const score = Math.max(topicScore(signals[0]), 22);
	const drafts = [
		{
			id: "personal-draft-agent-failure",
			archetype: "personal market anthropology",
			body: "the agent wallet problem is not intelligence. it is blast radius.",
			sourceSignal,
			score,
			nextAction: "Review for @williamclay",
			whyItMatters:
				"Uses the high-engagement AI-failure lane while staying mechanism-first and useful.",
			engagementGoal: "reply" as const,
			engagementPattern: "personal_observation" as const,
			tension: "agent autonomy vs accountability",
			replyEdge:
				"People can argue where responsibility should sit when agents touch production.",
			artifactNeeded: "none",
			sourceEvidence,
		},
		{
			id: "personal-draft-ct-scoreboard",
			archetype: "CT pattern note",
			body: "CT notices the scoreboard instantly. the operating system underneath it usually gets discussed three disasters later.",
			sourceSignal,
			score: Math.max(score - 2, 18),
			nextAction: "Review for @williamclay",
			whyItMatters:
				"Lets the personal account talk like a sharp observer while quietly steering attention toward infrastructure.",
			engagementGoal: "share" as const,
			engagementPattern: "compressed_take" as const,
			tension: "public spectacle vs boring ops failure",
			replyEdge:
				"CT people can name examples without requiring Vanta to chase a scandal.",
			artifactNeeded: "none",
			sourceEvidence,
		},
		{
			id: "personal-draft-project-builder",
			archetype: "founder taste note",
			body: "best founder taste right now is probably knowing which parts of the flow should stay manual.",
			sourceSignal,
			score: Math.max(score - 4, 16),
			nextAction: "Review for @williamclay",
			whyItMatters:
				"Builds the bridge between personal interests and Vanta's wallet/privacy thesis without sounding like a brand account.",
			engagementGoal: "bookmark" as const,
			engagementPattern: "personal_observation" as const,
			tension: "capability vs permission boundary",
			replyEdge:
				"Agent and wallet people can debate the useful permission boundary.",
			artifactNeeded: "workflow screenshot",
			sourceEvidence,
		},
		{
			id: "personal-draft-launch-receipt",
			archetype: "launch culture read",
			body: "launch culture is mostly a stress test for whether the explanation can survive the chart.",
			sourceSignal:
				"Forty-loop personal taste pass: Bags-style launch culture is alive, but the durable angle is ambiguity, reputation, and receipts.",
			score: Math.max(score - 1, 20),
			nextAction: "Review for @williamclay",
			whyItMatters:
				"Uses live launch-culture interest while keeping the point on product evidence instead of promotion.",
			engagementGoal: "reply" as const,
			engagementPattern: "personal_observation" as const,
			tension: "distribution speed vs trust explanation",
			replyEdge:
				"Founders and CT people can argue what evidence a launch needs to survive ambiguity.",
			artifactNeeded: "none",
			sourceEvidence: [
				"Current personal loops: launch ambiguity and refund/rug discourse create reply energy.",
				"Safe adaptation: turn launch drama into a receipt and explanation problem.",
			],
		},
		{
			id: "personal-draft-proof-test",
			archetype: "save-worthy product test",
			body: "useful product test: if the screenshot goes viral, can a normal person tell what happened, who had permission, and what changed?",
			sourceSignal:
				"Forty-loop personal taste pass: bookmarkable posts are prompts, checklists, teardown formats, and compact operating principles.",
			score: Math.max(score - 3, 19),
			nextAction: "Review for @williamclay",
			whyItMatters:
				"Creates a reusable product heuristic that can earn saves and replies without becoming brand copy.",
			engagementGoal: "bookmark" as const,
			engagementPattern: "reply_bait_question" as const,
			tension: "viral screenshot vs inspectable context",
			replyEdge:
				"Product builders can apply the test to their own flows or argue which fields matter.",
			artifactNeeded: "workflow or screenshot teardown",
			sourceEvidence: [
				"Personal loops: save-worthy posts should be prompts, checklists, teardown formats, or compact operating principles.",
			],
		},
		{
			id: "personal-draft-ct-product-spec",
			archetype: "CT product spec",
			body: "the weird thing about CT is that every panic is also an accidental product requirements doc.",
			sourceSignal:
				"Personal loops: start with the weird mechanism, not the moral; every blowup points to a missing control surface.",
			score: Math.max(score - 2, 21),
			nextAction: "Review for @williamclay",
			whyItMatters:
				"Turns timeline chaos into founder/product taste without quote-tweet pile-ons.",
			engagementGoal: "share" as const,
			engagementPattern: "compressed_take" as const,
			tension: "public panic vs product requirement",
			replyEdge:
				"Builders can name the controls every panic accidentally specifies.",
			artifactNeeded: "none",
			sourceEvidence: [
				"Personal loops: CT panic as product spec; ask what should have been logged, limited, approved, or recoverable.",
			],
		},
		{
			id: "personal-draft-agent-demo-permission",
			archetype: "agent demo skepticism",
			body: "i trust agent demos more when they show the permission screen before the magic.",
			sourceSignal:
				"Personal loops: agent-wallet discourse needs less awe and more permission, log, and blame mapping.",
			score: Math.max(score - 1, 22),
			nextAction: "Review for @williamclay",
			whyItMatters:
				"Provides a short, replyable personal take that trains the audience toward permission-first product taste.",
			engagementGoal: "reply" as const,
			engagementPattern: "personal_observation" as const,
			tension: "agent magic vs permission screen",
			replyEdge:
				"Agent builders can argue what should be shown before autonomy.",
			artifactNeeded: "permission screen screenshot",
			sourceEvidence: [
				"Personal loops: agent demos get stronger when they show permission surfaces before action.",
			],
		},
		{
			id: "personal-draft-wallet-group-chat",
			archetype: "wallet UX read",
			body: "a wallet flow is not done when the payment succeeds. it is done when the explanation survives a confused group chat.",
			sourceSignal:
				"Personal loops: wallet UX is now screenshot, confusion, receipt, and permission-history UX.",
			score: Math.max(score - 2, 21),
			nextAction: "Review for @williamclay",
			whyItMatters:
				"Connects personal product taste to wallet receipts and context without sounding like project marketing.",
			engagementGoal: "bookmark" as const,
			engagementPattern: "personal_observation" as const,
			tension: "payment success vs social explanation",
			replyEdge:
				"Wallet users can name the context that should survive the screenshot.",
			artifactNeeded: "wallet receipt or screenshot teardown",
			sourceEvidence: [
				"Personal loops: prefer what survives the screenshot over future-of-crypto framing.",
			],
		},
		{
			id: "personal-draft-fast-intern",
			archetype: "agent workflow metaphor",
			body: "the best agent workflows feel less like delegation and more like a very fast intern with a very small debit card.",
			sourceSignal:
				"Personal loops: manual review and narrow spend limits are becoming premium workflow language.",
			score: Math.max(score - 3, 20),
			nextAction: "Review for @williamclay",
			whyItMatters:
				"Turns agent autonomy into a concrete, memorable permission frame for the personal account.",
			engagementGoal: "reply" as const,
			engagementPattern: "personal_observation" as const,
			tension: "delegation speed vs spend limit",
			replyEdge: "Agent users can argue how small the debit card should be.",
			artifactNeeded: "agent workflow screenshot",
			sourceEvidence: [
				"Personal loops: never let agent autonomy sound costless; keep permission and review in the frame.",
			],
		},
		{
			id: "personal-draft-agent-payment-metadata",
			archetype: "agent payment weirdness",
			body: "the weird part of agent payments is that the payment is often less sensitive than the reason the agent made it.",
			sourceSignal:
				"Current x402/agent-payment read: metadata and reason strings are becoming the interesting leak surface.",
			score: Math.max(score - 1, 22),
			nextAction: "Review for @williamclay",
			whyItMatters:
				"Turns a current technical risk into a personal-account mechanism read without making Vanta claims.",
			engagementGoal: "reply" as const,
			engagementPattern: "personal_observation" as const,
			tension: "payment amount vs request context",
			replyEdge:
				"Agent builders can argue what request context should leave the local workflow.",
			artifactNeeded: "none",
			sourceEvidence: [
				"Current personal loop: agent autonomy gets sharper when the post names the hidden permission or metadata surface.",
			],
		},
	];

	return drafts.map((draft) => {
		const text = clampPost(draft.body);
		return {
			...draft,
			body: text,
			text,
			approvedToPost: false,
			priority: priorityFromScore(draft.score),
			proofBoundary: proofBoundaryForDraft({
				artifactNeeded: draft.artifactNeeded,
				id: draft.id,
			}),
			reviewChecklist: [
				{ label: "Manual posting only", passed: true },
				{ label: "No financial advice", passed: true },
				{ label: "No shock bait", passed: true },
				{ label: "Fits X character limit", passed: text.length <= 280 },
				{ label: "Source text treated as untrusted", passed: true },
			],
			algorithmFit: algorithmFitForDraft({
				accountLane: "personal",
				analytics,
				artifactNeeded: draft.artifactNeeded,
				engagementGoal: draft.engagementGoal,
				tension: draft.tension,
			}),
		};
	});
}

function buildReplyPrompts(analytics: AnalyticsResponse): VantaReplyPrompt[] {
	return analytics.projectOpportunities
		.filter((item) => !isSpammyOpportunity(item))
		.slice(0, 4)
		.map((item) => {
			const score = Math.min(
				100,
				8 + item.likeCount * 2 + Math.floor(item.author.followersCount / 1000),
			);
			const suggestedReply =
				"Yes. The goal is a receipt/trust packet that shows what happened, what can be verified, and what stayed private, while keeping Vanta beta limits visible.";
			return {
				sourceOpportunityId: item.id,
				tweetId: item.id,
				targetHandle: item.author.handle,
				authorHandle: item.author.handle,
				prompt: `Draft a short @vantaprivacy reply to @${item.author.handle}: ${item.reason}`,
				suggestedReply,
				priority: priorityFromScore(score),
				score,
				nextAction: "Review reply and respond manually",
				whyItMatters: `${item.author.displayName} is asking for context Vanta can answer with receipt-backed, beta-truthful language.`,
				sourceEvidence: [
					`${item.reason}: ${safeEvidence(item.text)}`,
					`@${item.author.handle} audience: ${item.author.followersCount} followers, ${item.likeCount} likes on the opportunity.`,
				],
				reviewChecklist: [
					{ label: "Manual posting only", passed: true },
					{ label: "Human reply review", passed: false },
					{ label: "Source text treated as untrusted", passed: true },
					{
						label: "Fits X character limit",
						passed: suggestedReply.length <= 280,
					},
				],
				algorithmFit: algorithmFitForDraft({
					accountLane: "reply",
					analytics,
					engagementGoal: "reply",
					tension: "source question vs proof-boundary answer",
				}),
			};
		});
}

export function buildVantaContentPlan(
	analytics: AnalyticsResponse,
): VantaContentPlan {
	const postDrafts = buildPostDrafts(analytics);
	const personalPostDrafts = buildPersonalPostDrafts(analytics);
	const engagementTargets = buildEngagementTargets(analytics);
	const training = buildVantaAccountTraining({
		analytics,
		engagementTargets,
		personalPostDrafts,
		postDrafts,
	});
	return {
		manualPostingOnly: true,
		guardrails: VANTA_CONTENT_GUARDRAILS,
		engagementPlaybook: VANTA_CT_ENGAGEMENT_PLAYBOOK,
		bridgeTheme: buildBridgeTheme(analytics),
		sourceQuality: buildSourceQuality(analytics),
		pillars: buildPillars(analytics),
		postDrafts,
		personalPostDrafts,
		voiceBridgePairs: buildVantaVoiceBridgePairs({
			personalPostDrafts,
			postDrafts,
		}),
		replyPrompts: buildReplyPrompts(analytics),
		engagementTargets,
		training,
		safetyNote:
			"Manual review required before any public post or reply. Keep Vanta beta, merchant-first, receipt-backed, and counterparty-useful privacy.",
		safetyNotes: [
			"Manual review required before any public post or reply.",
			"Do not claim audits, readiness, anonymity, untraceability, custody safety, or guaranteed privacy.",
		],
	};
}
