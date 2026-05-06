import { describe, expect, it } from "vitest";
import { buildProjectContentWorkflow } from "./content-workflow";
import type { AnalyticsResponse } from "./types";

function makeAnalytics(): AnalyticsResponse {
	return {
		accounts: [
			{
				accountId: "acct_vantaprivacy",
				handle: "@vantaprivacy",
				name: "Vanta",
				role: "project",
				mentions: 39,
				unrepliedMentions: 12,
				dms: 0,
				needsReplyDms: 0,
				uniqueMentionAuthors: 30,
			},
			{
				accountId: "acct_williamclay",
				handle: "@williamclay",
				name: "Clay",
				role: "personal",
				mentions: 23,
				unrepliedMentions: 8,
				dms: 0,
				needsReplyDms: 0,
				uniqueMentionAuthors: 20,
			},
		],
		sharedAudience: [
			{
				profile: {
					id: "profile_founder",
					handle: "merchantfounder",
					displayName: "Merchant Founder",
					bio: "Solana merchant tooling",
					followersCount: 4800,
					avatarHue: 20,
					createdAt: "2026-04-30T00:00:00.000Z",
				},
				projectMentions: 2,
				personalMentions: 3,
				latestMentionAt: "2026-04-30T00:00:00.000Z",
			},
		],
		topicSignals: [
			{
				topic: "Solana",
				projectMentions: 1,
				personalMentions: 9,
				sampleText: "@BagsApp Solana's privacy layer",
			},
			{
				topic: "Privacy",
				projectMentions: 39,
				personalMentions: 1,
				sampleText: "Privacy. Speed. Sovereignty.",
			},
			{
				topic: "Collaboration",
				projectMentions: 10,
				personalMentions: 0,
				sampleText: "DM me for promo",
			},
		],
		projectOpportunities: [
			{
				id: "tweet_good",
				accountId: "acct_vantaprivacy",
				accountHandle: "@vantaprivacy",
				text: "@vantaprivacy how does a merchant verify the receipt?",
				createdAt: "2026-04-30T00:00:00.000Z",
				likeCount: 4,
				author: {
					id: "profile_buyer",
					handle: "buyerops",
					displayName: "Buyer Ops",
					bio: "Merchant ops",
					followersCount: 1200,
					avatarHue: 40,
					createdAt: "2026-04-30T00:00:00.000Z",
				},
				reason: "Question or confusion worth answering publicly",
			},
			{
				id: "tweet_spam",
				accountId: "acct_vantaprivacy",
				accountHandle: "@vantaprivacy",
				text: "@vantaprivacy DM me for project growth rockets",
				createdAt: "2026-04-30T00:00:00.000Z",
				likeCount: 0,
				author: {
					id: "profile_spam",
					handle: "promobot",
					displayName: "Promo Bot",
					bio: "",
					followersCount: 0,
					avatarHue: 60,
					createdAt: "2026-04-30T00:00:00.000Z",
				},
				reason: "Inbound collaboration or DM request to triage",
			},
		],
		recommendations: [],
	};
}

describe("buildProjectContentWorkflow", () => {
	it("turns personal interests into safe manual-only project drafts", () => {
		const workflow = buildProjectContentWorkflow(makeAnalytics());

		expect(workflow.manualPostingOnly).toBe(true);
		expect(workflow.sourceQuality).toEqual(
			expect.objectContaining({
				summary: expect.stringContaining("62 local account mentions"),
				limits: expect.arrayContaining([
					expect.stringContaining("not a statistical audience model"),
				]),
			}),
		);
		expect(workflow.bridgeTheme).toBe(
			"Route @williamclay Solana interest into @vantaprivacy privacy settlement posts.",
		);
		expect(workflow.pillars.map((pillar) => pillar.topic)).toEqual([
			"Solana",
			"Privacy",
			"Collaboration",
		]);
		expect(workflow.postDrafts.length).toBeGreaterThanOrEqual(10);
		expect(new Set(workflow.postDrafts.map((draft) => draft.id)).size).toBe(
			workflow.postDrafts.length,
		);
		expect(workflow.personalPostDrafts).toHaveLength(13);
		expect(workflow.personalPostDrafts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					accountHandle: "@williamclay",
					approvedToPost: false,
					engagementGoal: "reply",
					engagementPattern: "personal_observation",
					tension: expect.stringContaining("permission"),
					replyEdge: expect.stringContaining("permission"),
				}),
				expect.objectContaining({
					engagementGoal: "share",
				}),
				expect.objectContaining({
					engagementGoal: "bookmark",
				}),
				expect.objectContaining({
					engagementGoal: "proof",
				}),
				expect.objectContaining({
					archetype: "launch culture read",
					engagementGoal: "reply",
				}),
				expect.objectContaining({
					archetype: "founder taste note",
					engagementGoal: "bookmark",
				}),
				expect.objectContaining({
					archetype: "CT product spec",
					engagementGoal: "share",
				}),
				expect.objectContaining({
					archetype: "agent demo skepticism",
					engagementGoal: "reply",
				}),
				expect.objectContaining({
					archetype: "wallet UX read",
					engagementGoal: "bookmark",
				}),
				expect.objectContaining({
					archetype: "agent workflow metaphor",
					engagementGoal: "reply",
				}),
				expect.objectContaining({
					archetype: "agent payment weirdness",
					engagementGoal: "reply",
					tension: expect.stringContaining("request context"),
				}),
				expect.objectContaining({
					archetype: "offer receipt scout note",
					engagementGoal: "bookmark",
					tension: expect.stringContaining("server promise"),
					artifactNeeded: expect.stringContaining("offer/receipt"),
				}),
				expect.objectContaining({
					archetype: "signing-key scout note",
					engagementGoal: "reply",
					tension: expect.stringContaining("signing authority"),
					replyEdge: expect.stringContaining("signing authority"),
				}),
			]),
		);
		expect(workflow.voiceBridgePairs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					personalDraftId: "personal-draft-agent-payment-metadata",
					projectDraftId: "vanta-draft-agent-payment-metadata",
					scoutMechanism: expect.stringContaining("request context"),
					projectTranslation: expect.stringContaining("metadata minimization"),
					proofBoundary: expect.stringContaining("reason string"),
					artifactNeeded: expect.stringContaining("metadata"),
				}),
				expect.objectContaining({
					personalDraftId: "personal-draft-offer-receipt-boundary",
					projectDraftId: "vanta-draft-x402-offer-receipt",
					scoutMechanism: expect.stringContaining("server promise"),
					projectTranslation: expect.stringContaining("offer and receipt"),
					proofBoundary: expect.stringContaining("receipt proves delivery"),
					artifactNeeded: expect.stringContaining("offer/receipt"),
				}),
				expect.objectContaining({
					personalDraftId: "personal-draft-signing-key-boundary",
					projectDraftId: "vanta-draft-signing-key-boundary",
					scoutMechanism: expect.stringContaining("key"),
					projectTranslation: expect.stringContaining("signing authority"),
					proofBoundary: expect.stringContaining("payment address"),
					artifactNeeded: expect.stringContaining("signing-key"),
				}),
			]),
		);
		expect(workflow.engagementPlaybook.vantaUse.bookmarkBait).toContain(
			"checklists",
		);
		expect(workflow.engagementPlaybook.vantaUse.agentPayments).toContain(
			"policy",
		);
		expect(workflow.engagementPlaybook.engagementRubric).toContain(
			"Every post needs a visible tension, not just a topic.",
		);
		expect(workflow.training.accounts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					handle: "@williamclay",
					accountRole: "personal_scout",
					topDraftIds: expect.arrayContaining([
						"personal-draft-agent-permissions",
					]),
					goodTweetDefinition: expect.stringContaining("mechanism"),
				}),
				expect.objectContaining({
					handle: "@vantaprivacy",
					accountRole: "project_publisher",
					topDraftIds: expect.arrayContaining([
						"vanta-draft-agent-payment-metadata",
					]),
					goodTweetDefinition: expect.stringContaining("counterparty"),
				}),
			]),
		);
		expect(
			workflow.training.accounts[0].algorithmPasses.length,
		).toBeGreaterThan(4);
		expect(
			workflow.training.accounts[1].algorithmPasses.length,
		).toBeGreaterThan(4);
		expect(workflow.postDrafts[0]?.text).toContain("private settlement");
		expect(workflow.postDrafts[0]?.sourceSignal).toContain("@williamclay");
		expect(workflow.postDrafts.every((draft) => draft.approvedToPost)).toBe(
			false,
		);
		expect(workflow.postDrafts.every((draft) => draft.priority)).toBe(true);
		expect(
			workflow.postDrafts.every((draft) => draft.reviewChecklist.length >= 4),
		).toBe(true);
		expect(workflow.postDrafts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					archetype: "x402 policy surface",
					engagementGoal: "bookmark",
					artifactNeeded: expect.stringContaining("spending policy"),
				}),
				expect.objectContaining({
					archetype: "receipt anatomy",
					engagementGoal: "proof",
					artifactNeeded: expect.stringContaining("receipt"),
				}),
				expect.objectContaining({
					archetype: "merchant metadata privacy",
					engagementGoal: "bookmark",
					artifactNeeded: expect.stringContaining("receipt field map"),
				}),
				expect.objectContaining({
					archetype: "agent payment metadata",
					engagementGoal: "bookmark",
					artifactNeeded: expect.stringContaining("metadata"),
				}),
				expect.objectContaining({
					archetype: "signing-key boundary",
					engagementGoal: "bookmark",
					artifactNeeded: expect.stringContaining("signing-key"),
				}),
				expect.objectContaining({
					archetype: "recovery surface",
					engagementGoal: "proof",
					artifactNeeded: expect.stringContaining("recovery-state"),
				}),
			]),
		);
		expect(
			workflow.postDrafts.find(
				(draft) => draft.archetype === "truth-first build note",
			),
		).toEqual(
			expect.objectContaining({
				priority: "medium",
				nextAction: "Review beta-truth note manually",
				whyItMatters: expect.stringContaining("overclaiming"),
				sourceEvidence: expect.arrayContaining([
					"Vanta beta-truth and no-overclaiming guardrail.",
				]),
			}),
		);
		expect(workflow.postDrafts.every((draft) => draft.text.length <= 280)).toBe(
			true,
		);
	});

	it("filters spammy project opportunities out of reply prompts", () => {
		const workflow = buildProjectContentWorkflow(makeAnalytics());

		expect(workflow.replyPrompts).toEqual([
			expect.objectContaining({
				tweetId: "tweet_good",
				authorHandle: "buyerops",
			}),
		]);
		expect(workflow.replyPrompts[0]?.suggestedReply).toContain("receipt");
		expect(workflow.replyPrompts[0]?.suggestedReply).not.toMatch(
			/anonymous|untraceable|audited|mainnet-ready|production-ready/i,
		);
	});

	it("blocks unsafe Vanta claims in generated copy", () => {
		const unsafe = makeAnalytics();
		unsafe.topicSignals = [
			{
				topic: "Mainnet-ready anonymous payments",
				projectMentions: 2,
				personalMentions: 4,
				sampleText: "mainnet ready anonymous payments",
			},
		];

		const workflow = buildProjectContentWorkflow(unsafe);
		const allCopy = [
			...workflow.postDrafts.map((draft) => draft.text),
			...workflow.replyPrompts.map((prompt) => prompt.suggestedReply),
		].join("\n");

		expect(allCopy).not.toMatch(
			/audited|production-ready|mainnet-ready|anonymous|untraceable|fully private|secure|zero risk/i,
		);
		expect(workflow.safetyNotes).toContain(
			"Manual review required before any public post or reply.",
		);
	});
});
