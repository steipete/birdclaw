import { describe, expect, it } from "vitest";
import {
	VANTA_FORBIDDEN_CONTENT_CLAIMS,
	buildVantaContentPlan,
} from "./vanta-content-workflow";
import type { AnalyticsResponse } from "./types";

const analytics: AnalyticsResponse = {
	accounts: [
		{
			accountId: "acct_project",
			handle: "@vantaprivacy",
			name: "Vanta",
			role: "project",
			mentions: 12,
			unrepliedMentions: 3,
			dms: 2,
			needsReplyDms: 1,
			uniqueMentionAuthors: 7,
			latestMentionAt: "2026-04-30T12:00:00.000Z",
		},
		{
			accountId: "acct_personal",
			handle: "@williamclay",
			name: "Clay",
			role: "personal",
			mentions: 18,
			unrepliedMentions: 2,
			dms: 4,
			needsReplyDms: 1,
			uniqueMentionAuthors: 11,
			latestMentionAt: "2026-04-30T12:15:00.000Z",
		},
	],
	sharedAudience: [
		{
			profile: {
				id: "profile_merchant",
				handle: "merchantdesk",
				displayName: "Merchant Desk",
				bio: "Stablecoin merchant ops",
				followersCount: 4200,
				avatarHue: 180,
				createdAt: "2025-01-01T00:00:00.000Z",
			},
			projectMentions: 3,
			personalMentions: 2,
			latestMentionAt: "2026-04-30T11:00:00.000Z",
		},
	],
	topicSignals: [
		{
			topic: "Privacy",
			projectMentions: 5,
			personalMentions: 4,
			sampleText: "How does Vanta keep privacy useful for merchant settlement?",
		},
		{
			topic: "Solana",
			projectMentions: 2,
			personalMentions: 3,
			sampleText: "What is the Solana stablecoin angle?",
		},
	],
	projectOpportunities: [
		{
			id: "tweet_1",
			accountId: "acct_project",
			accountHandle: "@vantaprivacy",
			text: "Can merchants verify a payment without exposing everything?",
			createdAt: "2026-04-30T10:00:00.000Z",
			likeCount: 9,
			author: {
				id: "profile_merchant",
				handle: "merchantdesk",
				displayName: "Merchant Desk",
				bio: "Stablecoin merchant ops",
				followersCount: 4200,
				avatarHue: 180,
				createdAt: "2025-01-01T00:00:00.000Z",
			},
			reason: "Question or confusion worth answering publicly",
		},
	],
	recommendations: [
		"Reply from @vantaprivacy to the highest-signal project mentions before broad posting.",
	],
};

describe("Vanta content workflow", () => {
	it("builds a deterministic local-only plan from analytics data", () => {
		const first = buildVantaContentPlan(analytics);
		const second = buildVantaContentPlan(analytics);

		expect(second).toEqual(first);
		expect(first.manualPostingOnly).toBe(true);
		expect(first.engagementPlaybook.vantaUse.replyBait).toContain("limits");
		expect(first.pillars).toEqual([
			expect.objectContaining({ title: "Counterparty-useful privacy" }),
			expect.objectContaining({ title: "Proof-backed receipt loop" }),
			expect.objectContaining({ title: "Merchant-first settlement" }),
		]);
		expect(first.postDrafts.length).toBeGreaterThanOrEqual(3);
		expect(first.personalPostDrafts.length).toBeGreaterThanOrEqual(3);
		expect(first.voiceBridgePairs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					personalDraftId: expect.stringContaining("personal-draft"),
					projectDraftId: expect.stringContaining("vanta-draft"),
					scoutMechanism: expect.any(String),
					projectTranslation: expect.any(String),
					proofBoundary: expect.stringContaining("receipt"),
					artifactNeeded: expect.any(String),
				}),
			]),
		);
		expect(first.replyPrompts).toEqual([
			expect.objectContaining({
				targetHandle: "merchantdesk",
				sourceOpportunityId: "tweet_1",
			}),
		]);
		expect(first.engagementTargets).toEqual([
			expect.objectContaining({
				handle: "merchantdesk",
				niche: expect.stringContaining("merchant"),
				reason: expect.any(String),
			}),
		]);
	});

	it("adds UI-actionable priority, evidence, and review metadata", () => {
		const plan = buildVantaContentPlan(analytics);
		const metadataDraft = plan.postDrafts.find(
			(draft) => draft.id === "vanta-draft-agent-payment-metadata",
		);
		const offerReceiptDraft = plan.postDrafts.find(
			(draft) => draft.id === "vanta-draft-x402-offer-receipt",
		);
		const signingKeyDraft = plan.postDrafts.find(
			(draft) => draft.id === "vanta-draft-signing-key-boundary",
		);

		expect(plan.pillars[0]).toEqual(
			expect.objectContaining({
				priority: "high",
				score: expect.any(Number),
				nextAction: "Draft a receipt-focused post",
				whyItMatters: expect.stringContaining("counterparty"),
				sourceEvidence: expect.arrayContaining([
					expect.stringContaining("@williamclay"),
					expect.stringContaining("sample:"),
				]),
			}),
		);
		expect(plan.postDrafts[0]).toEqual(
			expect.objectContaining({
				priority: "high",
				score: expect.any(Number),
				nextAction: "Review and queue manually",
				whyItMatters: expect.stringContaining("receipt"),
				engagementGoal: "share",
				engagementPattern: "contradiction",
				tension: expect.stringContaining("public verification"),
				replyEdge: expect.stringContaining("receipt"),
				artifactNeeded: expect.stringContaining("receipt"),
				sourceEvidence: expect.arrayContaining([
					expect.stringContaining("@williamclay"),
				]),
				reviewChecklist: [
					expect.objectContaining({
						label: "Manual posting only",
						passed: true,
					}),
					expect.objectContaining({
						label: "No unsafe Vanta claims",
						passed: true,
					}),
					expect.objectContaining({
						label: "Fits X character limit",
						passed: true,
					}),
					expect.objectContaining({
						label: "Keeps beta-truth framing",
						passed: true,
					}),
					expect.objectContaining({
						label: "Source text treated as untrusted",
						passed: true,
					}),
				],
				algorithmFit: expect.objectContaining({
					candidatePath: expect.stringContaining("Project lane"),
					rankingSignal: expect.stringContaining("repost"),
					targetReader: expect.stringContaining("@merchantdesk"),
					normalHumanWhy: expect.stringContaining("normal reader"),
				}),
			}),
		);
		expect(metadataDraft).toEqual(
			expect.objectContaining({
				engagementGoal: "bookmark",
				engagementPattern: "compressed_take",
				artifactNeeded: expect.stringContaining("metadata"),
				proofBoundary: expect.objectContaining({
					canProve: expect.stringContaining("metadata field map"),
					staysPrivate: expect.stringContaining("reason string"),
					missingArtifact: expect.stringContaining("metadata"),
					betaLimit: expect.stringContaining("beta"),
				}),
				replyEdge: expect.stringContaining("metadata"),
				sourceEvidence: expect.arrayContaining([
					expect.stringContaining("x402"),
					expect.stringContaining("metadata"),
				]),
				reviewChecklist: expect.arrayContaining([
					expect.objectContaining({
						label: "No unsafe Vanta claims",
						passed: true,
					}),
				]),
			}),
		);
		expect(offerReceiptDraft).toEqual(
			expect.objectContaining({
				engagementGoal: "bookmark",
				engagementPattern: "compressed_take",
				artifactNeeded: expect.stringContaining("offer/receipt"),
				proofBoundary: expect.objectContaining({
					canProve: expect.stringContaining("offer terms"),
					staysPrivate: expect.stringContaining("business context"),
					missingArtifact: expect.stringContaining("offer/receipt"),
					betaLimit: expect.stringContaining("proof-of-interaction"),
				}),
				replyEdge: expect.stringContaining("offer"),
				sourceEvidence: expect.arrayContaining([
					expect.stringContaining("signed-offer/receipt"),
					expect.stringContaining("metadata"),
				]),
			}),
		);
		expect(signingKeyDraft).toEqual(
			expect.objectContaining({
				engagementGoal: "bookmark",
				engagementPattern: "compressed_take",
				artifactNeeded: expect.stringContaining("signing-key"),
				proofBoundary: expect.objectContaining({
					canProve: expect.stringContaining("signing authority"),
					staysPrivate: expect.stringContaining("payment collection"),
					missingArtifact: expect.stringContaining("signing-key"),
					betaLimit: expect.stringContaining("signing key"),
				}),
				replyEdge: expect.stringContaining("signing key"),
				sourceEvidence: expect.arrayContaining([
					expect.stringContaining("Signing Key"),
					expect.stringContaining("payment address"),
				]),
			}),
		);
		expect(plan.replyPrompts[0]).toEqual(
			expect.objectContaining({
				priority: "high",
				score: expect.any(Number),
				nextAction: "Review reply and respond manually",
				whyItMatters: expect.stringContaining("Merchant Desk"),
				sourceEvidence: expect.arrayContaining([
					expect.stringContaining("Question or confusion"),
				]),
				reviewChecklist: expect.arrayContaining([
					expect.objectContaining({
						label: "Manual posting only",
						passed: true,
					}),
					expect.objectContaining({
						label: "Source text treated as untrusted",
						passed: true,
					}),
				]),
				algorithmFit: expect.objectContaining({
					candidatePath: expect.stringContaining("Conversation lane"),
					rankingSignal: expect.stringContaining("reply probability"),
				}),
			}),
		);
		expect(plan.postDrafts.every((draft) => draft.approvedToPost)).toBe(false);
		expect(plan.personalPostDrafts[0]).toEqual(
			expect.objectContaining({
				priority: "high",
				nextAction: "Review for @williamclay",
				approvedToPost: false,
				engagementGoal: "reply",
				engagementPattern: "personal_observation",
				tension: expect.stringContaining("agent autonomy"),
				replyEdge: expect.stringContaining("responsibility"),
				reviewChecklist: expect.arrayContaining([
					expect.objectContaining({
						label: "No financial advice",
						passed: true,
					}),
					expect.objectContaining({
						label: "No shock bait",
						passed: true,
					}),
					expect.objectContaining({
						label: "Source text treated as untrusted",
						passed: true,
					}),
				]),
				algorithmFit: expect.objectContaining({
					candidatePath: expect.stringContaining("Personal scout lane"),
					targetReader: expect.stringContaining("@merchantdesk"),
				}),
			}),
		);
		expect(plan.personalPostDrafts.every((draft) => draft.approvedToPost)).toBe(
			false,
		);
	});

	it("trains both accounts through algorithm-aware good-tweet passes", () => {
		const plan = buildVantaContentPlan(analytics);

		expect(plan.training).toEqual(
			expect.objectContaining({
				source: expect.stringContaining("X public recommendation"),
				algorithmPrinciples: expect.arrayContaining([
					expect.stringContaining("candidate"),
					expect.stringContaining("engagement probabilities"),
					expect.stringContaining("negative"),
				]),
				limits: expect.arrayContaining([
					expect.stringContaining("Local Birdclaw sample"),
				]),
			}),
		);
		expect(plan.training.accounts).toHaveLength(2);

		const personalTraining = plan.training.accounts.find(
			(account) => account.handle === "@williamclay",
		);
		const projectTraining = plan.training.accounts.find(
			(account) => account.handle === "@vantaprivacy",
		);

		expect(personalTraining).toEqual(
			expect.objectContaining({
				accountRole: "personal_scout",
				goodTweetDefinition: expect.stringContaining("mechanism"),
				northStar: expect.stringContaining("scout"),
				goodTweetRules: expect.arrayContaining([
					expect.stringContaining("normal reader"),
					expect.stringContaining("replyable"),
				]),
				antiPatterns: expect.arrayContaining([
					expect.stringContaining("forced Vanta"),
				]),
				drills: expect.arrayContaining([expect.stringContaining("rewrite")]),
				algorithmPasses: expect.arrayContaining([
					expect.objectContaining({
						label: "Candidate source fit",
						algorithmMechanic: expect.stringContaining("in-network"),
						accountRule: expect.stringContaining("@williamclay"),
					}),
					expect.objectContaining({
						label: "Negative-signal filter",
						accountRule: expect.stringContaining("shock bait"),
					}),
				]),
				scorecard: expect.arrayContaining([
					expect.objectContaining({
						label: "Normal-human hook",
						score: expect.any(Number),
					}),
				]),
				exampleTransformations: expect.arrayContaining([
					expect.objectContaining({
						before: expect.stringContaining("agent wallets"),
						after: expect.stringContaining("blast radius"),
					}),
				]),
			}),
		);
		expect(projectTraining).toEqual(
			expect.objectContaining({
				accountRole: "project_publisher",
				goodTweetDefinition: expect.stringContaining("counterparty"),
				northStar: expect.stringContaining("receipt"),
				goodTweetRules: expect.arrayContaining([
					expect.stringContaining("what happened"),
					expect.stringContaining("what stays private"),
				]),
				antiPatterns: expect.arrayContaining([
					expect.stringContaining("anonymous"),
				]),
				drills: expect.arrayContaining([expect.stringContaining("receipt")]),
				algorithmPasses: expect.arrayContaining([
					expect.objectContaining({
						label: "Engagement-probability fit",
						algorithmMechanic: expect.stringContaining("favorite"),
						accountRule: expect.stringContaining("receipt"),
					}),
					expect.objectContaining({
						label: "Artifact and dwell fit",
						accountRule: expect.stringContaining("artifact"),
					}),
				]),
				scorecard: expect.arrayContaining([
					expect.objectContaining({
						label: "Proof boundary",
						score: expect.any(Number),
					}),
				]),
				exampleTransformations: expect.arrayContaining([
					expect.objectContaining({
						before: expect.stringContaining("private payments"),
						after: expect.stringContaining("receipt"),
					}),
				]),
			}),
		);
	});

	it("keeps every draft inside Vanta voice guardrails", () => {
		const plan = buildVantaContentPlan(analytics);
		const text = [
			...plan.pillars.map((pillar) =>
				[
					pillar.title,
					pillar.topic,
					pillar.angle,
					pillar.sourceSignal,
					pillar.nextAction,
					pillar.whyItMatters,
					...pillar.sourceEvidence,
				].join(" "),
			),
			...plan.postDrafts.map((draft) =>
				[
					draft.body,
					draft.sourceSignal,
					draft.nextAction,
					draft.whyItMatters,
					...draft.sourceEvidence,
				].join(" "),
			),
			...plan.personalPostDrafts.map((draft) =>
				[
					draft.body,
					draft.sourceSignal,
					draft.nextAction,
					draft.whyItMatters,
					...draft.sourceEvidence,
				].join(" "),
			),
			...plan.replyPrompts.map((prompt) =>
				[
					prompt.prompt,
					prompt.suggestedReply,
					prompt.nextAction,
					prompt.whyItMatters,
					...prompt.sourceEvidence,
				].join(" "),
			),
			plan.safetyNote,
		].join("\n");

		expect(text).toContain("beta");
		expect(text).toContain("counterparty-useful privacy");
		expect(text).toContain("receipt/trust packet");
		expect(text).toContain("merchant-first");
		for (const forbidden of VANTA_FORBIDDEN_CONTENT_CLAIMS) {
			expect(text.toLowerCase()).not.toContain(forbidden);
		}
	});

	it("sanitizes unsafe source topics and evidence before exposing UI fields", () => {
		const unsafe = {
			...analytics,
			topicSignals: [
				{
					topic: "Production-ready trustless audited anonymous payments",
					projectMentions: 4,
					personalMentions: 9,
					sampleText:
						"mainnet-ready anonymous secure payments with guaranteed privacy and zero risk",
				},
			],
		};

		const plan = buildVantaContentPlan(unsafe);
		const exposedText = [
			plan.bridgeTheme,
			...plan.pillars.flatMap((pillar) => [
				pillar.topic,
				pillar.sourceSignal,
				...pillar.sourceEvidence,
			]),
			...plan.postDrafts.flatMap((draft) => [
				draft.text,
				draft.sourceSignal,
				...draft.sourceEvidence,
			]),
			...plan.personalPostDrafts.flatMap((draft) => [
				draft.text,
				draft.sourceSignal,
				...draft.sourceEvidence,
			]),
		].join("\n");

		for (const forbidden of VANTA_FORBIDDEN_CONTENT_CLAIMS) {
			expect(exposedText.toLowerCase()).not.toContain(forbidden);
		}
	});
});
