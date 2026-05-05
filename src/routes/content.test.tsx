import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Route } from "./content";

const ContentRoute = Route.options.component as ComponentType;

function createOverLimitReplyFetchMock() {
	return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/api/analytics")) {
			return new Response(
				JSON.stringify({
					accounts: [
						{
							accountId: "acct_project",
							handle: "@vantaprivacy",
							name: "Vanta",
							role: "project",
							mentions: 1,
							unrepliedMentions: 1,
							dms: 0,
							needsReplyDms: 0,
							uniqueMentionAuthors: 1,
						},
					],
					sharedAudience: [],
					topicSignals: [],
					projectOpportunities: [],
					recommendations: [],
				}),
			);
		}
		if (url.endsWith("/api/content-workflow")) {
			return new Response(
				JSON.stringify({
					manualPostingOnly: true,
					bridgeTheme: "Over-limit reply fixture.",
					pillars: [],
					postDrafts: [],
					personalPostDrafts: [],
					replyPrompts: [
						{
							sourceOpportunityId: "long_reply",
							tweetId: "long_reply",
							targetHandle: "merchant",
							authorHandle: "merchant",
							prompt: "Long reply fixture.",
							suggestedReply: "x".repeat(281),
							priority: "high",
							score: 25,
							nextAction: "Review reply manually",
							whyItMatters: "Fixture.",
							sourceEvidence: ["Fixture evidence."],
						},
					],
					safetyNote: "Manual review required before any public post or reply.",
					safetyNotes: [
						"Manual review required before any public post or reply.",
					],
				}),
			);
		}
		throw new Error(`Unexpected fetch ${url}`);
	});
}

function createTrainingFixture() {
	return {
		source:
			"X public recommendation architecture mapped onto local Birdclaw signal.",
		algorithmPrinciples: [
			"candidate source fit",
			"engagement probabilities",
			"negative feedback filters",
		],
		limits: ["Local Birdclaw sample is directional and manual-review-first."],
		accounts: [
			{
				handle: "@williamclay",
				accountRole: "personal_scout",
				title: "@williamclay training",
				northStar: "Scout mechanisms before project translation.",
				goodTweetDefinition:
					"A good personal tweet makes a normal reader see the mechanism before Vanta appears.",
				algorithmPasses: [
					{
						id: "personal-candidate",
						label: "Candidate source fit",
						score: 84,
						status: "strong",
						algorithmMechanic:
							"In-network and topic-similar candidates need a legible hook.",
						accountRule:
							"@williamclay should name the mechanism under the timeline object.",
						evidence: "Personal scout draft with agent-wallet blast radius.",
						drill:
							"Rewrite one vague AI take as a concrete permission boundary.",
					},
					{
						id: "personal-negative",
						label: "Negative-signal filter",
						score: 79,
						status: "watch",
						algorithmMechanic:
							"Mutes, blocks, reports, and not-interested feedback push posts down.",
						accountRule:
							"Remove shock bait, quote-pile-ons, and forced Vanta jumps.",
						evidence: "No shock-bait checklist.",
						drill: "Cut one moralizing sentence.",
					},
				],
				goodTweetRules: [
					"Make the normal reader understand the mechanism.",
					"Leave one replyable edge.",
				],
				antiPatterns: ["Forced Vanta translation in a personal post."],
				drills: ["Rewrite a broad AI take into a permission-boundary take."],
				scorecard: [
					{
						label: "Normal-human hook",
						score: 86,
						target: "Readable before niche context.",
						evidence: "Blast radius draft.",
					},
				],
				exampleTransformations: [
					{
						before: "agent wallets are risky",
						after:
							"the agent wallet problem is not intelligence. it is blast radius.",
						why: "Specific mechanism, shorter hook, replyable edge.",
					},
				],
				topDraftIds: ["personal_1"],
				sourceBoundaries: ["Manual posting only."],
			},
			{
				handle: "@vantaprivacy",
				accountRole: "project_publisher",
				title: "@vantaprivacy training",
				northStar: "Publish proof-backed receipt and boundary language.",
				goodTweetDefinition:
					"A good project tweet is useful to a counterparty: what happened, what can be checked, what stays private.",
				algorithmPasses: [
					{
						id: "project-engagement",
						label: "Engagement-probability fit",
						score: 88,
						status: "strong",
						algorithmMechanic:
							"Predicted favorite, reply, repost, click, share, and dwell shape rank.",
						accountRule:
							"Make the receipt, artifact, or proof boundary save-worthy.",
						evidence: "Receipt thesis and merchant target.",
						drill: "Add the exact receipt field before copy.",
					},
					{
						id: "project-artifact",
						label: "Artifact and dwell fit",
						score: 81,
						status: "needs_artifact",
						algorithmMechanic:
							"Inspectability can earn clicks, dwell, bookmarks, and shares.",
						accountRule: "Pair claims with an artifact before copying.",
						evidence: "receipt screenshot gate.",
						drill: "Turn the claim into a marked-up receipt.",
					},
				],
				goodTweetRules: ["Say what happened.", "Say what stays private."],
				antiPatterns: ["anonymous or fully private claims."],
				drills: ["Rewrite a privacy claim as a receipt field map."],
				scorecard: [
					{
						label: "Proof boundary",
						score: 90,
						target: "Can prove / stays local / beta limit.",
						evidence: "Proof Boundary Matrix.",
					},
				],
				exampleTransformations: [
					{
						before: "private payments for merchants",
						after: "private settlement needs one public surface: the receipt.",
						why: "Counterparty usefulness replaces abstract privacy.",
					},
				],
				topDraftIds: ["draft_1"],
				sourceBoundaries: ["No unsafe privacy claims."],
			},
		],
	};
}

describe("content route", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	it("renders the premium content workflow and copies drafts without posting", async () => {
		vi.spyOn(Date, "now").mockReturnValue(
			new Date("2026-05-02T12:00:00.000Z").getTime(),
		);
		const writeTextMock = vi.fn().mockResolvedValue(undefined);
		Object.assign(navigator, {
			clipboard: {
				writeText: writeTextMock,
			},
		});
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, _init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/api/analytics")) {
					return new Response(
						JSON.stringify({
							accounts: [
								{
									accountId: "acct_project",
									handle: "@vantaprivacy",
									name: "Vanta",
									role: "project",
									mentions: 3,
									unrepliedMentions: 2,
									dms: 0,
									needsReplyDms: 0,
									uniqueMentionAuthors: 2,
									latestMentionAt: "2026-04-30T10:00:00.000Z",
								},
								{
									accountId: "acct_personal",
									handle: "@williamclay",
									name: "Clay",
									role: "personal",
									mentions: 4,
									unrepliedMentions: 1,
									dms: 0,
									needsReplyDms: 0,
									uniqueMentionAuthors: 3,
									latestMentionAt: "2026-04-24T10:00:00.000Z",
								},
							],
							sharedAudience: [],
							topicSignals: [
								{
									topic: "Solana privacy",
									projectMentions: 1,
									personalMentions: 4,
									sampleText: "privacy settlement receipt",
								},
							],
							projectOpportunities: [],
							recommendations: ["Use the personal signal before drafting."],
						}),
					);
				}
				if (url.endsWith("/api/content-workflow")) {
					return new Response(
						JSON.stringify({
							manualPostingOnly: true,
							bridgeTheme:
								"Route @williamclay privacy interest into @vantaprivacy.",
							pillars: [
								{
									title: "Counterparty-useful privacy",
									topic: "Privacy",
									angle: "Verify enough without seeing everything.",
									sourceSignal:
										"@williamclay showed 4 personal Privacy signals.",
								},
							],
							postDrafts: [
								{
									id: "draft_1",
									archetype: "receipt thesis",
									body: "Private settlement needs receipts people can verify.",
									text: "Private settlement needs receipts people can verify.",
									sourceSignal: "Topic signal: Solana privacy.",
									approvedToPost: false,
									priority: "high",
									score: 30,
									nextAction: "Pair with receipt screenshot",
									whyItMatters:
										"Turns the topic into a proof-backed project-account post.",
									engagementGoal: "share",
									engagementPattern: "contradiction",
									tension: "public verification vs business privacy",
									replyEdge: "What should the receipt prove?",
									artifactNeeded: "receipt screenshot",
									sourceEvidence: ["Topic signal: Solana privacy."],
									reviewChecklist: [
										{ label: "Manual posting only", passed: true },
										{ label: "No unsafe Vanta claims", passed: true },
										{ label: "Fits X character limit", passed: true },
										{ label: "Keeps beta-truth framing", passed: true },
									],
									algorithmFit: {
										candidatePath:
											"Project lane: warm overlap and topic similarity around receipts.",
										rankingSignal:
											"repost/quote probability: compressed proof-boundary language",
										targetReader:
											"@merchant and nearby merchant settlement operators",
										whyItCanTravel:
											"It has a visible tension and a concrete receipt surface.",
										normalHumanWhy:
											"A normal reader understands what happened and what can be checked.",
										source:
											"Birdclaw heuristic based on X's public recommendation architecture.",
									},
								},
							],
							personalPostDrafts: [
								{
									id: "personal_1",
									archetype: "CT pattern note",
									body: "current CT is good at the scoreboard and bad at the operating system underneath it.",
									text: "current CT is good at the scoreboard and bad at the operating system underneath it.",
									sourceSignal: "Fresh For You engagement snapshot.",
									approvedToPost: false,
									engagementGoal: "reply",
									engagementPattern: "personal_observation",
									tension: "scoreboard vs operating system",
									replyEdge: "People can debate which context should survive.",
									artifactNeeded: "none",
									priority: "high",
									score: 22,
									nextAction: "Review for @williamclay",
									whyItMatters:
										"Turns live timeline interest into personal-account pattern recognition.",
									sourceEvidence: ["Fresh For You engagement snapshot."],
									reviewChecklist: [
										{ label: "Manual posting only", passed: true },
										{ label: "No financial advice", passed: true },
									],
									algorithmFit: {
										candidatePath:
											"Personal scout lane: Clay's taste plus topic-similar builders.",
										rankingSignal: "reply probability: one sharp product edge",
										targetReader:
											"@merchant and nearby merchant settlement operators",
										whyItCanTravel:
											"It names the scoreboard tension before the product mechanism.",
										normalHumanWhy:
											"A normal reader recognizes the product failure first.",
										source:
											"Birdclaw heuristic based on X's public recommendation architecture.",
									},
								},
							],
							replyPrompts: [
								{
									sourceOpportunityId: "opp_1",
									tweetId: "tweet_1",
									targetHandle: "merchant",
									authorHandle: "merchant",
									prompt: "Draft a short reply.",
									suggestedReply:
										"Yes, the useful loop is a clear approval plus a receipt.",
									algorithmFit: {
										candidatePath:
											"Conversation lane: answer an existing mention.",
										rankingSignal:
											"reply probability: one clear edge people can clarify",
										targetReader:
											"@merchant and nearby merchant settlement operators",
										whyItCanTravel:
											"It turns the source question into a proof-boundary answer.",
										normalHumanWhy:
											"A normal reader can tell what the approval and receipt are for.",
										source:
											"Birdclaw heuristic based on X's public recommendation architecture.",
									},
								},
							],
							engagementTargets: [
								{
									handle: "merchant",
									displayName: "Merchant Desk",
									niche: "merchant settlement and receipts",
									score: 37,
									reason: "Question or confusion worth answering publicly",
									evidence: "6 likes; 4.2k followers; receipt question",
									nextAction:
										"Reply only after source review; use the question as the proof-boundary prompt.",
								},
							],
							training: createTrainingFixture(),
							safetyNote:
								"Manual review required before any public post or reply.",
							safetyNotes: [
								"Manual review required before any public post or reply.",
								"Do not claim audits or readiness.",
							],
						}),
					);
				}
				throw new Error(`Unexpected fetch ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		render(<ContentRoute />);

		expect(
			await screen.findByText(
				"What to post next, who it is for, and why it can travel",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText("From live signal to reviewed copy"),
		).toBeInTheDocument();
		expect(screen.getByText("Best move today")).toBeInTheDocument();
		expect(
			Boolean(
				screen
					.getByText("Best move today")
					.compareDocumentPosition(screen.getByText("40-loop digest")) &
				Node.DOCUMENT_POSITION_FOLLOWING,
			),
		).toBe(true);
		expect(
			screen.queryByText("Why these topics are worth using"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText("Project-account drafts"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText("Replies worth answering"),
		).not.toBeInTheDocument();
		expect(screen.queryByText("Personal scout drafts")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Review/ })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(screen.getByRole("button", { name: /Queues/ })).toHaveAttribute(
			"aria-pressed",
			"false",
		);
		expect(screen.getByText("Today pick")).toBeInTheDocument();
		expect(screen.getByText("Best move today")).toBeInTheDocument();
		expect(screen.getByText("Check before copy")).toBeInTheDocument();
		expect(screen.getByText("Can prove")).toBeInTheDocument();
		expect(screen.getByText("Stays local")).toBeInTheDocument();
		expect(screen.getByText("Beta limit")).toBeInTheDocument();
		expect(
			Boolean(
				screen
					.getByText("From live signal to reviewed copy")
					.compareDocumentPosition(screen.getByText("Best move today")) &
				Node.DOCUMENT_POSITION_FOLLOWING,
			),
		).toBe(true);
		expect(screen.getByRole("link", { name: "Review/copy" })).toHaveAttribute(
			"href",
			"#best-move",
		);
		expect(
			screen.getByText(
				"current CT is good at the scoreboard and bad at the operating system underneath it.",
			),
		).toBeInTheDocument();
		expect(screen.getByText("Scout signal")).toBeInTheDocument();
		expect(
			screen.getByText(/Step 1: review this (project|reply|personal)/),
		).toBeInTheDocument();
		expect(screen.getByText("Recommended manual action")).toBeInTheDocument();
		expect(screen.getByText("Decision brief")).toBeInTheDocument();
		expect(screen.getByText("Algorithm fit")).toBeInTheDocument();
		expect(screen.getByText("Candidate path")).toBeInTheDocument();
		expect(screen.getByText("Ranking signal")).toBeInTheDocument();
		expect(screen.getByText("Normal-human read")).toBeInTheDocument();
		expect(screen.getByText(/Actual engaged target:/)).toBeInTheDocument();
		expect(screen.getByText("Artifact before copy")).toBeInTheDocument();
		expect(screen.getByText("Proof boundary")).toBeInTheDocument();
		expect(
			screen.getByText("Prove enough; hide excess; keep beta limits visible"),
		).toBeInTheDocument();
		expect(screen.getByText("Artifact Workbench")).toBeInTheDocument();
		expect(screen.getByText("Required artifact")).toBeInTheDocument();
		expect(screen.getByText("Copy gate")).toBeInTheDocument();
		expect(screen.getByText("Distribution handoff")).toBeInTheDocument();
		expect(
			screen.getByText(/Scout read -> proof-safe project artifact/),
		).toBeInTheDocument();
		expect(screen.getByText("Proof Boundary Matrix")).toBeInTheDocument();
		expect(screen.getByText("Public claim")).toBeInTheDocument();
		expect(screen.getByText("Counterparty can verify")).toBeInTheDocument();
		expect(screen.getByText("Stays local")).toBeInTheDocument();
		expect(screen.getByText("Missing artifact")).toBeInTheDocument();
		expect(screen.getByText("Beta limit")).toBeInTheDocument();
		expect(screen.getByText("Local-only action")).toBeInTheDocument();
		expect(screen.getByText("Edit, copy, paste manually")).toBeInTheDocument();
		expect(
			screen.getAllByText("Pair with receipt screenshot").length,
		).toBeGreaterThan(0);
		expect(screen.getByText("Publish readiness")).toBeInTheDocument();
		expect(screen.getByText("Manual-only boundary")).toBeInTheDocument();
		expect(screen.getByText("Copy action only")).toBeInTheDocument();
		expect(screen.getByText("Read-only source bounds")).toBeInTheDocument();
		expect(screen.getByText("Local Birdclaw data")).toBeInTheDocument();
		expect(screen.getByText("Snapshot caveat")).toBeInTheDocument();
		expect(
			screen.getByText("Small local sample; partial X visibility"),
		).toBeInTheDocument();
		expect(screen.getByText("Source freshness")).toBeInTheDocument();
		expect(
			screen.getByText("@vantaprivacy 2026-04-30; @williamclay 2026-04-24"),
		).toBeInTheDocument();
		expect(screen.getByText("Source age")).toBeInTheDocument();
		expect(
			screen.getByText("Project 2d; personal 8d; personal source stale"),
		).toBeInTheDocument();
		expect(screen.getByText("No X write actions")).toBeInTheDocument();
		expect(screen.getByText("Manual clipboard workflow")).toBeInTheDocument();
		expect(screen.getByText("Untrusted social text")).toBeInTheDocument();
		expect(
			screen.getByText("Review claims before posting"),
		).toBeInTheDocument();
		expect(screen.getByText("Artifact check")).toBeInTheDocument();
		expect(screen.getAllByText("receipt screenshot").length).toBeGreaterThan(0);
		expect(screen.getByText("Claim check")).toBeInTheDocument();
		expect(screen.getByText("Human review required")).toBeInTheDocument();
		expect(screen.getByText("Source bounds")).toBeInTheDocument();
		expect(
			screen.getByText("Local signals; X text untrusted"),
		).toBeInTheDocument();
		expect(screen.getAllByText("Top pick").length).toBeGreaterThan(0);
		expect(screen.queryByText(/\/100/)).not.toBeInTheDocument();
		expect(screen.getByText("Why it surfaced")).toBeInTheDocument();
		expect(
			screen.getByText(
				"Artifact and claim readiness ranked ahead of raw score.",
			),
		).toBeInTheDocument();
		expect(screen.getByText("Voice target:")).toBeInTheDocument();
		expect(
			screen.getAllByText(
				/@vantaprivacy stays calm, artifact-backed, and explicit about receipts, limits, and proof boundaries/,
			).length,
		).toBeGreaterThan(0);

		fireEvent.click(screen.getByRole("button", { name: /Queues/ }));
		expect(screen.getByText("Artifact queue")).toBeInTheDocument();
		expect(
			screen.getByText("Proof artifacts needed before copy"),
		).toBeInTheDocument();
		expect(screen.getAllByText("receipt screenshot").length).toBeGreaterThan(0);
		expect(
			screen.getAllByText("Project: receipt thesis").length,
		).toBeGreaterThan(0);
		expect(screen.getByText("Copy gate: Needs artifact")).toBeInTheDocument();
		expect(screen.getByText("Project-account drafts")).toBeInTheDocument();
		expect(screen.getByText("Replies worth answering")).toBeInTheDocument();
		expect(screen.getByText("Personal scout drafts")).toBeInTheDocument();
		expect(
			screen.getAllByText("Manual only: Copy gate").length,
		).toBeGreaterThan(0);
		expect(
			screen.getAllByText("Artifact: receipt screenshot").length,
		).toBeGreaterThan(0);
		expect(screen.getAllByText("Evidence: 1 source").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Claim check: Passed").length).toBeGreaterThan(
			0,
		);
		expect(screen.getAllByText("Risk & evidence").length).toBeGreaterThan(0);
		expect(screen.getAllByText(/Engagement:/).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/Angle:/).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/Tension:/).length).toBeGreaterThan(0);
		expect(screen.getAllByText("Why this should work:").length).toBeGreaterThan(
			0,
		);
		fireEvent.click(screen.getByRole("button", { name: /Voice bridge/ }));
		expect(screen.getAllByText("Voice bridge").length).toBeGreaterThan(0);
		expect(
			screen.getAllByText("Scout translation rationale").length,
		).toBeGreaterThan(0);
		expect(screen.getAllByText(/Scout mechanism:/).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/Project translation:/).length).toBeGreaterThan(
			0,
		);
		fireEvent.click(screen.getByRole("button", { name: /Signals/ }));
		expect(
			screen.getByText("Why these topics are worth using"),
		).toBeInTheDocument();
		expect(screen.getByText("Actual engaged people")).toBeInTheDocument();
		expect(screen.getAllByText("@merchant").length).toBeGreaterThan(0);
		expect(
			screen.getByText("@williamclay showed 4 personal Privacy signals."),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Training/ }));
		expect(screen.getByText("What good tweets are")).toBeInTheDocument();
		expect(screen.getByText("@williamclay training")).toBeInTheDocument();
		expect(screen.getByText("@vantaprivacy training")).toBeInTheDocument();
		expect(screen.getAllByText("Candidate source fit").length).toBeGreaterThan(
			0,
		);
		expect(
			screen.getAllByText("Engagement-probability fit").length,
		).toBeGreaterThan(0);
		expect(
			screen.getAllByText("Negative-signal filter").length,
		).toBeGreaterThan(0);
		expect(screen.getAllByText("Proof boundary").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Training drills").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Anti-patterns").length).toBeGreaterThan(0);
		fireEvent.click(screen.getByRole("button", { name: /Review/ }));
		expect(screen.getByText("40-loop digest")).toBeInTheDocument();
		expect(
			screen.getByText(
				"Add a decision brief before evidence: job, voice split, artifact, manual gate.",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"Agent-payment posts should name the metadata surface, not only the payment rail.",
			),
		).toBeInTheDocument();
		expect(screen.getByLabelText("Goal")).toHaveValue("all");
		expect(screen.getByLabelText("Job")).toHaveValue("all");
		expect(screen.getByLabelText("View")).toHaveValue("scan");
		expect(screen.getByRole("button", { name: "All" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);

		expect(
			screen.getByRole("button", { name: "Needs artifact" }),
		).toBeDisabled();
		expect(
			screen.getByText("Blocked: gather receipt screenshot before copy"),
		).toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("button", { name: "Scout: @williamclay" }),
		);
		fireEvent.change(screen.getByLabelText("Edit locally before copy"), {
			target: { value: "Edited manual draft for review." },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Copy reviewed draft" }),
		);

		await waitFor(() => {
			expect(writeTextMock).toHaveBeenCalledWith(
				"Edited manual draft for review.",
			);
		});
		expect(screen.getByRole("status")).toHaveTextContent(
			"Copied to clipboard. Review in X before posting.",
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(
			fetchMock.mock.calls.some((call) => call[1]?.method === "POST"),
		).toBe(false);
	});

	it("filters account lanes and blocks over-limit primary drafts", async () => {
		Object.assign(navigator, {
			clipboard: {
				writeText: vi.fn().mockResolvedValue(undefined),
			},
		});
		vi.stubGlobal("fetch", createContentFetchMock());

		render(<ContentRoute />);

		await screen.findByText("Best move today");
		const scoutFilter = screen.getByRole("button", {
			name: "Scout: @williamclay",
		});
		fireEvent.click(scoutFilter);
		expect(scoutFilter).toHaveAttribute("aria-pressed", "true");
		expect(
			screen.getAllByText(
				/@williamclay can be sharper: name the mechanism under the timeline spectacle/,
			).length,
		).toBeGreaterThan(0);

		fireEvent.change(screen.getByLabelText("Edit locally before copy"), {
			target: { value: "x".repeat(281) },
		});
		expect(screen.getByText(/281\/280 characters/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Needs trim" })).toBeDisabled();

		fireEvent.click(screen.getByRole("button", { name: /Queues/ }));
		expect(
			screen.getByText("No project drafts match the current filters."),
		).toBeInTheDocument();
		expect(
			screen.queryByText("Needs no artifact required"),
		).not.toBeInTheDocument();
		expect(screen.getAllByText("Not required").length).toBeGreaterThan(0);

		fireEvent.change(screen.getByLabelText("Goal"), {
			target: { value: "bookmark" },
		});
		expect(screen.getByLabelText("Goal")).toHaveValue("bookmark");
		expect(
			screen.getByText(
				"Filters: Scout: @williamclay, Bookmark, All jobs, Scan view, 0/3 actions visible",
			),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Review/ }));
		expect(
			screen.getByText(
				"No recommended moves match the current filters. Adjust account or goal filters to bring drafts back.",
			),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Queues/ }));
		expect(
			screen.queryByText(
				"Yes, the useful loop is a clear approval plus a receipt.",
			),
		).not.toBeInTheDocument();
		expect(
			screen.getByText(
				"No high-signal project replies match the current filters.",
			),
		).toBeInTheDocument();

		fireEvent.click(
			screen.getByRole("button", { name: "Publish: @vantaprivacy" }),
		);
		fireEvent.change(screen.getByLabelText("Goal"), {
			target: { value: "all" },
		});
		fireEvent.change(screen.getByLabelText("Job"), {
			target: { value: "reply-review" },
		});
		expect(screen.getByLabelText("Job")).toHaveValue("reply-review");
		expect(
			screen.getByText(
				"Filters: Publish: @vantaprivacy, All goals, Reply review, Scan view, 1/3 actions visible",
			),
		).toBeInTheDocument();
		expect(
			screen.queryByText(
				"Private settlement needs receipts people can verify.",
			),
		).not.toBeInTheDocument();
		expect(
			screen.getAllByText(
				"Yes, the useful loop is a clear approval plus a receipt.",
			).length,
		).toBeGreaterThan(0);
	});

	it("keeps all-account review project-first before personal scout scores", async () => {
		Object.assign(navigator, {
			clipboard: {
				writeText: vi.fn().mockResolvedValue(undefined),
			},
		});
		vi.stubGlobal("fetch", createContentFetchMock());

		render(<ContentRoute />);

		await screen.findByText("Best move today");
		expect(screen.getByText("Step 1: review this project")).toBeInTheDocument();
		expect(screen.getByText("receipt thesis")).toBeInTheDocument();
	});

	it("blocks edited primary drafts with forbidden Vanta claims", async () => {
		Object.assign(navigator, {
			clipboard: {
				writeText: vi.fn().mockResolvedValue(undefined),
			},
		});
		vi.stubGlobal("fetch", createContentFetchMock());

		render(<ContentRoute />);

		await screen.findByText("Best move today");

		fireEvent.change(screen.getByLabelText("Edit locally before copy"), {
			target: { value: "Vanta is production-ready and anonymous." },
		});

		expect(
			screen.getByText(/remove unsafe claim before copying/),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Needs claim review" }),
		).toBeDisabled();
	});

	it("blocks unsafe generated queue copy across project, reply, and personal cards", async () => {
		const writeTextMock = vi.fn().mockResolvedValue(undefined);
		Object.assign(navigator, {
			clipboard: {
				writeText: writeTextMock,
			},
		});
		vi.stubGlobal("fetch", createUnsafeQueueFetchMock());

		render(<ContentRoute />);

		await screen.findByText("Best move today");
		fireEvent.click(screen.getByRole("button", { name: /Queues/ }));

		const blockedButtons = screen.getAllByRole("button", {
			name: "Needs claim review",
		});
		expect(blockedButtons).toHaveLength(3);
		expect(
			screen.getAllByText("Blocked: remove unsafe claim before copy"),
		).toHaveLength(3);
		for (const button of blockedButtons) {
			expect(button).toBeDisabled();
		}
		expect(writeTextMock).not.toHaveBeenCalled();

		fireEvent.change(screen.getByLabelText("Job"), {
			target: { value: "copy" },
		});
		expect(
			screen.getByText("No project drafts match the current filters."),
		).toBeInTheDocument();
		expect(
			screen.getByText("No Clay scout drafts match the current filters."),
		).toBeInTheDocument();
		expect(
			screen.queryByText("Vanta is production-ready."),
		).not.toBeInTheDocument();
		expect(screen.queryByText("Vanta is anonymous.")).not.toBeInTheDocument();
	});

	it("shows reply character counts and blocks over-limit replies", async () => {
		const writeTextMock = vi.fn().mockResolvedValue(undefined);
		Object.assign(navigator, {
			clipboard: {
				writeText: writeTextMock,
			},
		});
		vi.stubGlobal("fetch", createOverLimitReplyFetchMock());

		render(<ContentRoute />);

		await screen.findByText("Best move today");
		fireEvent.click(screen.getByRole("button", { name: /Queues/ }));

		expect(screen.getByText("281/280")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Needs trim" })).toBeDisabled();
		expect(
			screen.getByText("Blocked: trim to 280 before copy"),
		).toBeInTheDocument();
		expect(writeTextMock).not.toHaveBeenCalled();
	});

	it("keeps the content studio usable when local api reads fail", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ status: 500 }), {
						status: 500,
					}),
			),
		);

		render(<ContentRoute />);

		expect(
			await screen.findByText(
				"What to post next, who it is for, and why it can travel",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"Sync both accounts, then the clearest draft or reply will appear here.",
			),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Queues/ }));
		expect(
			screen.getByText("No project drafts match the current filters."),
		).toBeInTheDocument();
	});
});

function createUnsafeQueueFetchMock() {
	return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/api/analytics")) {
			return new Response(
				JSON.stringify({
					accounts: [
						{
							accountId: "acct_project",
							handle: "@vantaprivacy",
							name: "Vanta",
							role: "project",
							mentions: 1,
							unrepliedMentions: 1,
							dms: 0,
							needsReplyDms: 0,
							uniqueMentionAuthors: 1,
						},
					],
					sharedAudience: [],
					topicSignals: [],
					projectOpportunities: [],
					recommendations: [],
				}),
			);
		}

		if (url.endsWith("/api/content-workflow")) {
			return new Response(
				JSON.stringify({
					manualPostingOnly: true,
					bridgeTheme: "Unsafe queue copy gate fixture.",
					pillars: [],
					postDrafts: [
						{
							id: "unsafe_project",
							archetype: "unsafe project draft",
							body: "Vanta is production-ready.",
							text: "Vanta is production-ready.",
							sourceSignal: "Fixture signal.",
							approvedToPost: false,
							priority: "high",
							score: 30,
							nextAction: "Review manually",
							whyItMatters: "Fixture.",
							engagementGoal: "share",
							engagementPattern: "compressed_take",
							tension: "claim vs review",
							replyEdge: "Fixture edge.",
							artifactNeeded: "none",
							sourceEvidence: ["Fixture evidence."],
							reviewChecklist: [
								{ label: "Manual posting only", passed: true },
								{ label: "No unsafe Vanta claims", passed: false },
							],
						},
					],
					personalPostDrafts: [
						{
							id: "unsafe_personal",
							archetype: "unsafe personal draft",
							body: "Vanta is anonymous.",
							text: "Vanta is anonymous.",
							sourceSignal: "Fixture signal.",
							approvedToPost: false,
							engagementGoal: "reply",
							engagementPattern: "personal_observation",
							tension: "claim vs review",
							replyEdge: "Fixture edge.",
							artifactNeeded: "none",
							priority: "high",
							score: 25,
							nextAction: "Review for @williamclay",
							whyItMatters: "Fixture.",
							sourceEvidence: ["Fixture evidence."],
							reviewChecklist: [
								{ label: "Manual posting only", passed: true },
								{ label: "No unsafe claims", passed: false },
							],
						},
					],
					replyPrompts: [
						{
							sourceOpportunityId: "unsafe_reply",
							tweetId: "unsafe_reply",
							targetHandle: "merchant",
							authorHandle: "merchant",
							prompt: "Unsafe reply fixture.",
							suggestedReply: "Vanta provides guaranteed privacy.",
							priority: "high",
							score: 25,
							nextAction: "Review reply manually",
							whyItMatters: "Fixture.",
							sourceEvidence: ["Fixture evidence."],
						},
					],
					safetyNote: "Manual review required before any public post or reply.",
					safetyNotes: [
						"Manual review required before any public post or reply.",
					],
				}),
			);
		}
		throw new Error(`Unexpected fetch ${url}`);
	});
}

function createContentFetchMock() {
	return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/api/analytics")) {
			return new Response(
				JSON.stringify({
					accounts: [
						{
							accountId: "acct_project",
							handle: "@vantaprivacy",
							name: "Vanta",
							role: "project",
							mentions: 3,
							unrepliedMentions: 2,
							dms: 0,
							needsReplyDms: 0,
							uniqueMentionAuthors: 2,
						},
					],
					sharedAudience: [],
					topicSignals: [],
					projectOpportunities: [],
					recommendations: [],
				}),
			);
		}
		if (url.endsWith("/api/content-workflow")) {
			return new Response(
				JSON.stringify({
					manualPostingOnly: true,
					bridgeTheme:
						"Route @williamclay privacy interest into @vantaprivacy.",
					pillars: [
						{
							title: "Counterparty-useful privacy",
							topic: "Privacy",
							angle: "Verify enough without seeing everything.",
							sourceSignal: "@williamclay showed 4 personal Privacy signals.",
						},
					],
					postDrafts: [
						{
							id: "draft_1",
							archetype: "receipt thesis",
							body: "Private settlement needs receipts people can verify.",
							text: "Private settlement needs receipts people can verify.",
							sourceSignal: "Topic signal: Solana privacy.",
							approvedToPost: false,
							engagementGoal: "share",
							engagementPattern: "contradiction",
							tension: "public verification vs business privacy",
							replyEdge: "What should the receipt prove?",
							artifactNeeded: "receipt screenshot",
							sourceEvidence: ["Topic signal: Solana privacy."],
							reviewChecklist: [
								{ label: "Manual posting only", passed: true },
								{ label: "No unsafe Vanta claims", passed: true },
								{ label: "Fits X character limit", passed: true },
								{ label: "Keeps beta-truth framing", passed: true },
							],
						},
					],
					personalPostDrafts: [
						{
							id: "personal_1",
							archetype: "CT pattern note",
							body: "current CT is good at the scoreboard and bad at the operating system underneath it.",
							text: "current CT is good at the scoreboard and bad at the operating system underneath it.",
							sourceSignal: "Fresh For You engagement snapshot.",
							approvedToPost: false,
							engagementGoal: "reply",
							engagementPattern: "personal_observation",
							tension: "scoreboard vs operating system",
							replyEdge: "People can debate which context should survive.",
							artifactNeeded: "none",
							priority: "high",
							score: 22,
							nextAction: "Review for @williamclay",
							whyItMatters:
								"Turns live timeline interest into personal-account pattern recognition.",
							sourceEvidence: ["Fresh For You engagement snapshot."],
							reviewChecklist: [
								{ label: "Manual posting only", passed: true },
								{ label: "No financial advice", passed: true },
							],
						},
					],
					replyPrompts: [
						{
							sourceOpportunityId: "opp_1",
							tweetId: "tweet_1",
							targetHandle: "merchant",
							authorHandle: "merchant",
							prompt: "Draft a short reply.",
							suggestedReply:
								"Yes, the useful loop is a clear approval plus a receipt.",
						},
					],
					safetyNote: "Manual review required before any public post or reply.",
					safetyNotes: [
						"Manual review required before any public post or reply.",
					],
				}),
			);
		}
		throw new Error(`Unexpected fetch ${url}`);
	});
}
