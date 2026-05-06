import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { ProjectContentWorkflow } from "#/lib/content-workflow";
import { VANTA_FORBIDDEN_CONTENT_CLAIMS } from "#/lib/content-workflow";
import type { AnalyticsResponse } from "#/lib/types";
import {
	actionButtonClass,
	cx,
	eyebrowClass,
	heroCopyClass,
	heroShellClass,
	heroTitleClass,
	pageWrapClass,
	surfaceCardClass,
	timestampClass,
} from "#/lib/ui";

export const Route = createFileRoute("/content")({
	component: ContentRoute,
});

type AccountFilter = "all" | "project" | "personal";
type GoalFilter = "all" | "reply" | "bookmark" | "share" | "proof" | "like";
type JobFilter = "all" | "artifact" | "copy" | "reply-review";
type SectionDensity = "scan" | "full";
type ContentFocus = "review" | "queues" | "voice" | "signals" | "training";

const UI_LOOP_DIGEST = [
	"Add a decision brief before evidence: job, voice split, artifact, manual gate.",
	"Lead with the next manual action, then let the user expand context.",
	"Filter by the job to be done, not only by account or engagement goal.",
	"Keep scan mode capped; large loop output needs queues, not scroll walls.",
	"Promote risk and artifact readiness before raw evidence.",
] as const;

const VOICE_LOOP_DIGEST = [
	"x402 offer/receipt work makes proof-of-interaction a current Vanta lane.",
	"@williamclay scouts weird mechanisms under CT spectacle.",
	"@vantaprivacy translates the scout read into receipts, limits, and proof boundaries.",
	"Personal posts can be sharper; project posts should be calmer and artifact-backed.",
	"Every strong claim needs a boundary: what happened, what can be checked, what stays private.",
	"Agent-payment posts should name the metadata surface, not only the payment rail.",
	"Receipt posts should separate signing authority from payment collection.",
] as const;

function accountFilterLabel(value: AccountFilter) {
	if (value === "project") return "Publish: @vantaprivacy";
	if (value === "personal") return "Scout: @williamclay";
	return "All accounts";
}

function goalFilterLabel(value: GoalFilter) {
	if (value === "all") return "All goals";
	return value.charAt(0).toUpperCase() + value.slice(1);
}

function jobFilterLabel(value: JobFilter) {
	if (value === "artifact") return "Needs artifact";
	if (value === "copy") return "Copy-ready";
	if (value === "reply-review") return "Reply review";
	return "All jobs";
}

function sectionDensityLabel(value: SectionDensity) {
	return value === "scan" ? "Scan view" : "Expanded view";
}

function sourceFreshnessSummary(analytics: AnalyticsResponse | null) {
	const accounts = analytics?.accounts ?? [];
	const project = accounts.find((account) => account.role === "project");
	const personal = accounts.find((account) => account.role === "personal");
	const projectDate = project?.latestMentionAt?.slice(0, 10);
	const personalDate = personal?.latestMentionAt?.slice(0, 10);

	if (projectDate || personalDate) {
		return `${project?.handle ?? "@vantaprivacy"} ${projectDate ?? "unknown"}; ${personal?.handle ?? "@williamclay"} ${personalDate ?? "unknown"}`;
	}

	return "No mention dates available; treat as directional";
}

function sourceAgeSummary(analytics: AnalyticsResponse | null) {
	const accounts = analytics?.accounts ?? [];
	const project = accounts.find((account) => account.role === "project");
	const personal = accounts.find((account) => account.role === "personal");
	const projectDate = project?.latestMentionAt?.slice(0, 10);
	const personalDate = personal?.latestMentionAt?.slice(0, 10);
	const dayMs = 24 * 60 * 60 * 1000;
	const ageFor = (date?: string) => {
		if (!date) return null;
		const timestamp = Date.parse(`${date}T00:00:00.000Z`);
		if (Number.isNaN(timestamp)) return null;
		return Math.max(0, Math.floor((Date.now() - timestamp) / dayMs));
	};
	const projectAge = ageFor(projectDate);
	const personalAge = ageFor(personalDate);

	if (projectAge === null && personalAge === null) {
		return "No dated source; treat all lanes as directional";
	}

	const projectLabel =
		projectAge === null ? "project unknown" : `Project ${projectAge}d`;
	const personalLabel =
		personalAge === null ? "personal unknown" : `personal ${personalAge}d`;
	const staleLabels = [
		projectAge !== null && projectAge >= 7 ? "project source stale" : null,
		personalAge !== null && personalAge >= 7 ? "personal source stale" : null,
	].filter(Boolean);

	return `${projectLabel}; ${personalLabel}; ${
		staleLabels.length ? staleLabels.join(", ") : "current directional read"
	}`;
}

function contentFocusLabel(value: ContentFocus) {
	if (value === "queues") return "Queues";
	if (value === "voice") return "Voice bridge";
	if (value === "signals") return "Signals";
	if (value === "training") return "Training";
	return "Review";
}

function hasArtifactRequirement(artifactNeeded?: string) {
	return Boolean(artifactNeeded && artifactNeeded !== "none");
}

function matchesDraftJobFilter(
	draft: {
		artifactNeeded?: string;
		reviewChecklist?: ReviewChecklist;
		text: string;
	},
	jobFilter: JobFilter,
) {
	if (jobFilter === "artifact")
		return hasArtifactRequirement(draft.artifactNeeded);
	if (jobFilter === "copy") {
		return !copyGateForDraft(draft).blocked;
	}
	if (jobFilter === "reply-review") return false;
	return true;
}

function matchesReplyJobFilter(jobFilter: JobFilter) {
	return jobFilter === "all" || jobFilter === "reply-review";
}

function hasForbiddenClaim(value: string) {
	const normalized = value.toLowerCase();
	return VANTA_FORBIDDEN_CONTENT_CLAIMS.some((claim) =>
		normalized.includes(claim),
	);
}

type ReviewChecklist = { label: string; passed: boolean }[];

function concreteArtifactName(artifactNeeded?: string) {
	if (!artifactNeeded || artifactNeeded === "none") return null;
	return artifactNeeded;
}

function hasArtifactReadyCheck(
	artifactNeeded: string,
	reviewChecklist?: ReviewChecklist,
) {
	const normalizedArtifact = artifactNeeded.toLowerCase();
	return Boolean(
		reviewChecklist?.some((item) => {
			if (!item.passed) return false;
			const normalizedLabel = item.label.toLowerCase();
			return (
				/artifact|screenshot|receipt|proof/.test(normalizedLabel) ||
				normalizedArtifact.includes(normalizedLabel) ||
				normalizedLabel.includes(normalizedArtifact)
			);
		}),
	);
}

function copyReadinessForText(
	value: string,
	options: {
		artifactNeeded?: string;
		reviewChecklist?: ReviewChecklist;
	} = {},
) {
	const count = value.length;
	const artifactNeeded = concreteArtifactName(options.artifactNeeded);
	if (count > 280) {
		return {
			blocked: true,
			count,
			label: "Needs trim",
			reason: "trim",
		} as const;
	}
	if (hasForbiddenClaim(value)) {
		return {
			blocked: true,
			count,
			label: "Needs claim review",
			reason: "claim",
		} as const;
	}
	if (
		artifactNeeded &&
		!hasArtifactReadyCheck(artifactNeeded, options.reviewChecklist)
	) {
		return {
			artifactNeeded,
			blocked: true,
			count,
			label: "Needs artifact",
			reason: "artifact",
		} as const;
	}
	return {
		blocked: false,
		count,
		label: "ready",
		reason: "ready",
	} as const;
}

function copyGateForText(
	value: string,
	options: Parameters<typeof copyReadinessForText>[1] = {},
) {
	return copyReadinessForText(value, options);
}

function characterCountLabel(gate: ReturnType<typeof copyGateForText>) {
	return `${gate.count}/280`;
}

function copyGateWarningClass(gate: ReturnType<typeof copyGateForText>) {
	return gate.blocked && "font-medium text-[var(--alert)]";
}

function copyGateForDraft({
	artifactNeeded,
	reviewChecklist,
	text,
}: {
	artifactNeeded?: string;
	reviewChecklist?: ReviewChecklist;
	text: string;
}) {
	return copyGateForText(text, { artifactNeeded, reviewChecklist });
}

function copyGateForReply(text: string) {
	return copyGateForText(text);
}

function copyGateForPrimaryMove(
	move: {
		artifactNeeded?: string;
		reviewChecklist?: ReviewChecklist;
	} | null,
	text: string,
) {
	return copyGateForText(text, {
		artifactNeeded: move?.artifactNeeded,
		reviewChecklist: move?.reviewChecklist,
	});
}

function copyButtonLabel({
	copied,
	defaultLabel,
	gate,
}: {
	copied: boolean;
	defaultLabel: string;
	gate: ReturnType<typeof copyGateForText>;
}) {
	if (gate.blocked) return gate.label;
	return copied ? "Copied" : defaultLabel;
}

function copyGateReasonText(gate: ReturnType<typeof copyGateForText>) {
	if (gate.reason === "trim") return "Blocked: trim to 280 before copy";
	if (gate.reason === "claim")
		return "Blocked: remove unsafe claim before copy";
	if (gate.reason === "artifact")
		return `Blocked: gather ${gate.artifactNeeded} before copy`;
	return null;
}

function voiceTargetForMove(kind: string) {
	if (kind === "Personal") {
		return "@williamclay can be sharper: name the mechanism under the timeline spectacle, keep it useful, and avoid forcing Vanta into the post.";
	}
	if (kind === "Reply") {
		return "@vantaprivacy replies should answer the question calmly, keep beta limits visible, and move the thread toward receipts or permissions.";
	}
	return "@vantaprivacy stays calm, artifact-backed, and explicit about receipts, limits, and proof boundaries.";
}

function artifactActionLabel(artifactNeeded?: string, kind?: string) {
	if (artifactNeeded && artifactNeeded !== "none")
		return `Gather ${artifactNeeded}`;
	if (kind === "Reply") return "Verify source context";
	return "No artifact required";
}

function proofBoundaryLabel(kind: string) {
	if (kind === "Personal") {
		return "Mechanism only; no forced Vanta claim";
	}
	if (kind === "Reply") {
		return "Answer only what the source supports";
	}
	return "Prove enough; hide excess; keep beta limits visible";
}

function defaultProofBoundaryForMove({
	artifactNeeded,
	kind,
}: {
	artifactNeeded?: string;
	kind: string;
}) {
	if (kind === "Personal") {
		return {
			canProve: "Scout post can name a mechanism without making a Vanta claim",
			staysPrivate: "Project claims and source text stay local",
			missingArtifact:
				artifactNeeded && artifactNeeded !== "none" ? artifactNeeded : "none",
			betaLimit: "Personal copy is not project readiness evidence",
		};
	}
	if (kind === "Reply") {
		return {
			canProve: "Reply can answer only the source-supported question",
			staysPrivate: "Untrusted source text and unrelated context stay local",
			missingArtifact: "source context",
			betaLimit: "Keep Vanta beta limits visible before posting",
		};
	}
	return {
		canProve:
			artifactNeeded && artifactNeeded !== "none"
				? `${artifactNeeded} backs the public claim`
				: "Manual review keeps the public claim narrow",
		staysPrivate: "Nonessential business context and source text stay local",
		missingArtifact:
			artifactNeeded && artifactNeeded !== "none" ? artifactNeeded : "none",
		betaLimit: "Vanta remains beta; avoid readiness or privacy overclaims",
	};
}

type ArtifactQueueItem = {
	artifactNeeded: string;
	copyGateLabel: string;
	id: string;
	kind: string;
	proofBoundary: {
		betaLimit: string;
		canProve: string;
		missingArtifact: string;
		staysPrivate: string;
	};
	title: string;
	why: string;
};

function allAccountKindRank(kind: string) {
	if (kind === "Project") return 2;
	if (kind === "Reply") return 1;
	return 0;
}

function ContentRoute() {
	const [analytics, setAnalytics] = useState<AnalyticsResponse | null>(null);
	const [workflow, setWorkflow] = useState<ProjectContentWorkflow | null>(null);
	const [copiedId, setCopiedId] = useState<string | null>(null);
	const [copyStatus, setCopyStatus] = useState("");
	const [accountFilter, setAccountFilter] = useState<AccountFilter>("all");
	const [goalFilter, setGoalFilter] = useState<GoalFilter>("all");
	const [jobFilter, setJobFilter] = useState<JobFilter>("all");
	const [sectionDensity, setSectionDensity] = useState<SectionDensity>("scan");
	const [contentFocus, setContentFocus] = useState<ContentFocus>("review");
	const [editedTextById, setEditedTextById] = useState<Record<string, string>>(
		{},
	);

	useEffect(() => {
		fetch("/api/analytics")
			.then((response) => (response.ok ? response.json() : null))
			.then((data: AnalyticsResponse) => setAnalytics(data));
		fetch("/api/content-workflow")
			.then((response) => (response.ok ? response.json() : null))
			.then((data: ProjectContentWorkflow) => setWorkflow(data));
	}, []);

	const counts = useMemo(() => {
		const project = analytics?.accounts?.find(
			(account) => account.role === "project",
		);
		const personal = analytics?.accounts?.find(
			(account) => account.role === "personal",
		);
		return {
			projectMentions: project?.mentions ?? 0,
			projectUnreplied: project?.unrepliedMentions ?? 0,
			personalMentions: personal?.mentions ?? 0,
			personalPeople: personal?.uniqueMentionAuthors ?? 0,
		};
	}, [analytics]);

	const projectDrafts = workflow?.postDrafts ?? [];
	const personalDrafts = workflow?.personalPostDrafts ?? [];
	const replyPrompts = workflow?.replyPrompts ?? [];

	const filteredProjectDrafts = useMemo(
		() =>
			projectDrafts.filter(
				(draft) =>
					(accountFilter === "all" || accountFilter === "project") &&
					(goalFilter === "all" || draft.engagementGoal === goalFilter) &&
					matchesDraftJobFilter(draft, jobFilter),
			),
		[accountFilter, goalFilter, jobFilter, projectDrafts],
	);
	const filteredPersonalDrafts = useMemo(
		() =>
			personalDrafts.filter(
				(draft) =>
					(accountFilter === "all" || accountFilter === "personal") &&
					(goalFilter === "all" || draft.engagementGoal === goalFilter) &&
					matchesDraftJobFilter(draft, jobFilter),
			),
		[accountFilter, goalFilter, jobFilter, personalDrafts],
	);
	const filteredReplyPrompts = useMemo(
		() =>
			replyPrompts.filter(
				() =>
					(accountFilter === "all" || accountFilter === "project") &&
					(goalFilter === "all" || goalFilter === "reply") &&
					matchesReplyJobFilter(jobFilter),
			),
		[accountFilter, goalFilter, jobFilter, replyPrompts],
	);
	const visibleProjectDrafts =
		sectionDensity === "scan"
			? filteredProjectDrafts.slice(0, 4)
			: filteredProjectDrafts;
	const visiblePersonalDrafts =
		sectionDensity === "scan"
			? filteredPersonalDrafts.slice(0, 4)
			: filteredPersonalDrafts;
	const visibleReplyPrompts =
		sectionDensity === "scan"
			? filteredReplyPrompts.slice(0, 3)
			: filteredReplyPrompts;
	const totalActionCount =
		projectDrafts.length + personalDrafts.length + replyPrompts.length;
	const filteredActionCount =
		filteredProjectDrafts.length +
		filteredPersonalDrafts.length +
		filteredReplyPrompts.length;
	const sourceFreshness = sourceFreshnessSummary(analytics);
	const sourceAge = sourceAgeSummary(analytics);
	const filterSummary = `Filters: ${accountFilterLabel(accountFilter)}, ${goalFilterLabel(goalFilter)}, ${jobFilterLabel(jobFilter)}, ${sectionDensityLabel(sectionDensity)}, ${filteredActionCount}/${totalActionCount} actions visible`;
	const voicePairs = useMemo(() => {
		if (!filteredProjectDrafts.length || !filteredPersonalDrafts.length)
			return [];
		const projectById = new Map(
			filteredProjectDrafts.map((draft) => [draft.id, draft]),
		);
		const personalById = new Map(
			filteredPersonalDrafts.map((draft) => [draft.id, draft]),
		);
		const structuredPairs =
			workflow?.voiceBridgePairs
				?.map((pair) => ({
					pair,
					personal: personalById.get(pair.personalDraftId),
					project: projectById.get(pair.projectDraftId),
				}))
				.filter(
					(
						item,
					): item is {
						pair: NonNullable<
							ProjectContentWorkflow["voiceBridgePairs"]
						>[number];
						personal: ProjectContentWorkflow["personalPostDrafts"][number];
						project: ProjectContentWorkflow["postDrafts"][number];
					} => Boolean(item.personal && item.project),
				) ?? [];

		if (structuredPairs.length) return structuredPairs.slice(0, 3);

		return filteredPersonalDrafts.slice(0, 3).map((personal, index) => {
			const project =
				filteredProjectDrafts[index % filteredProjectDrafts.length];
			return {
				pair: {
					artifactNeeded: project.artifactNeeded ?? "none",
					personalDraftId: personal.id,
					projectDraftId: project.id,
					scoutMechanism: personal.tension ?? personal.archetype,
					projectTranslation: project.tension ?? project.archetype,
					proofBoundary:
						project.artifactNeeded && project.artifactNeeded !== "none"
							? `gather ${project.artifactNeeded}; keep source text local`
							: "manual review keeps project claims narrow",
				},
				personal,
				project,
			};
		});
	}, [
		filteredPersonalDrafts,
		filteredProjectDrafts,
		workflow?.voiceBridgePairs,
	]);
	const workflowStats = useMemo(() => {
		const allDrafts = [...projectDrafts, ...personalDrafts];
		return {
			readyDrafts: allDrafts.length,
			highSignalDrafts: allDrafts.filter((draft) => draft.priority === "high")
				.length,
			artifactDrafts: allDrafts.filter(
				(draft) => draft.artifactNeeded && draft.artifactNeeded !== "none",
			).length,
			manualActions:
				filteredProjectDrafts.length +
				filteredPersonalDrafts.length +
				filteredReplyPrompts.length,
		};
	}, [
		filteredPersonalDrafts.length,
		filteredProjectDrafts.length,
		filteredReplyPrompts.length,
		personalDrafts,
		projectDrafts,
	]);
	const artifactQueue = useMemo<ArtifactQueueItem[]>(() => {
		const projectItems = filteredProjectDrafts.map((draft) => ({
			artifactNeeded: draft.artifactNeeded ?? "none",
			copyGateLabel: copyGateForDraft(draft).label,
			id: draft.id,
			kind: "Project",
			proofBoundary:
				draft.proofBoundary ??
				defaultProofBoundaryForMove({
					artifactNeeded: draft.artifactNeeded,
					kind: "Project",
				}),
			title: draft.archetype,
			why:
				draft.whyItMatters ??
				"Project copy needs an artifact and proof boundary before public use.",
		}));
		const personalItems = filteredPersonalDrafts.map((draft) => ({
			artifactNeeded: draft.artifactNeeded ?? "none",
			copyGateLabel: copyGateForDraft(draft).label,
			id: draft.id,
			kind: "Personal",
			proofBoundary:
				draft.proofBoundary ??
				defaultProofBoundaryForMove({
					artifactNeeded: draft.artifactNeeded,
					kind: "Personal",
				}),
			title: draft.archetype,
			why:
				draft.whyItMatters ??
				"Personal scout copy tests the mechanism before project translation.",
		}));
		const replyItems = filteredReplyPrompts.map((prompt) => ({
			artifactNeeded: "source context",
			copyGateLabel: copyGateForReply(prompt.suggestedReply).label,
			id: prompt.tweetId,
			kind: "Reply",
			proofBoundary: defaultProofBoundaryForMove({ kind: "Reply" }),
			title: `@${prompt.authorHandle}`,
			why:
				prompt.whyItMatters ??
				"Reply copy needs source review before manual use.",
		}));

		return [...projectItems, ...personalItems, ...replyItems]
			.filter((item) => item.artifactNeeded !== "none")
			.sort(
				(left, right) =>
					Number(right.copyGateLabel === "Needs artifact") -
						Number(left.copyGateLabel === "Needs artifact") ||
					allAccountKindRank(right.kind) - allAccountKindRank(left.kind),
			);
	}, [filteredPersonalDrafts, filteredProjectDrafts, filteredReplyPrompts]);

	const nextMoves = useMemo(() => {
		const drafts = filteredProjectDrafts.map((draft) => ({
			id: draft.id,
			kind: "Project",
			title: draft.archetype,
			action: draft.nextAction ?? "Review and queue manually",
			text: draft.text,
			why:
				draft.whyItMatters ??
				"Turns personal-account topic heat into project language.",
			evidence: draft.sourceEvidence ?? [draft.sourceSignal],
			score: draft.score ?? 0,
			priority: draft.priority ?? "medium",
			engagementGoal: draft.engagementGoal,
			engagementPattern: draft.engagementPattern,
			tension: draft.tension,
			replyEdge: draft.replyEdge,
			artifactNeeded: draft.artifactNeeded,
			proofBoundary:
				draft.proofBoundary ??
				defaultProofBoundaryForMove({
					artifactNeeded: draft.artifactNeeded,
					kind: "Project",
				}),
			reviewChecklist: draft.reviewChecklist,
			algorithmFit: draft.algorithmFit,
			topPickEligible: isTopPickEligible({
				artifactNeeded: draft.artifactNeeded,
				kind: "Project",
				reviewChecklist: draft.reviewChecklist,
			}),
		}));
		const replies = filteredReplyPrompts.map((prompt) => ({
			id: prompt.tweetId,
			kind: "Reply",
			title: `@${prompt.authorHandle}`,
			action: prompt.nextAction ?? "Review reply manually",
			text: prompt.suggestedReply,
			why: prompt.whyItMatters ?? "Project mention worth answering manually.",
			evidence: prompt.sourceEvidence ?? [prompt.prompt],
			score: prompt.score ?? 0,
			priority: prompt.priority ?? "medium",
			engagementGoal: undefined,
			engagementPattern: undefined,
			tension: undefined,
			replyEdge: undefined,
			artifactNeeded: undefined,
			proofBoundary: defaultProofBoundaryForMove({ kind: "Reply" }),
			reviewChecklist: undefined,
			algorithmFit: prompt.algorithmFit,
			topPickEligible: true,
		}));
		const personal = filteredPersonalDrafts.map((draft) => ({
			id: draft.id,
			kind: "Personal",
			title: draft.archetype,
			action: draft.nextAction ?? "Review for @williamclay",
			text: draft.text,
			why:
				draft.whyItMatters ??
				"Uses the personal account as the scout account for live interest.",
			evidence: draft.sourceEvidence ?? [draft.sourceSignal],
			score: draft.score ?? 0,
			priority: draft.priority ?? "medium",
			engagementGoal: draft.engagementGoal,
			engagementPattern: draft.engagementPattern,
			tension: draft.tension,
			replyEdge: draft.replyEdge,
			artifactNeeded: draft.artifactNeeded,
			proofBoundary:
				draft.proofBoundary ??
				defaultProofBoundaryForMove({
					artifactNeeded: draft.artifactNeeded,
					kind: "Personal",
				}),
			reviewChecklist: draft.reviewChecklist,
			algorithmFit: draft.algorithmFit,
			topPickEligible: true,
		}));
		return [...drafts, ...personal, ...replies]
			.sort(
				(left, right) =>
					Number(right.topPickEligible) - Number(left.topPickEligible) ||
					(accountFilter === "all"
						? allAccountKindRank(right.kind) - allAccountKindRank(left.kind)
						: 0) ||
					right.score - left.score,
			)
			.slice(0, 4);
	}, [filteredPersonalDrafts, filteredProjectDrafts, filteredReplyPrompts]);
	const focusCounts = useMemo(
		() => ({
			review: nextMoves.length,
			queues: filteredActionCount,
			voice: voicePairs.length,
			signals: workflow?.pillars.length ?? 0,
			training: workflow?.training?.accounts.length ?? 0,
		}),
		[filteredActionCount, nextMoves.length, voicePairs.length, workflow],
	);

	const primaryMove = nextMoves[0] ?? null;
	const primaryMoveText = primaryMove
		? (editedTextById[primaryMove.id] ?? primaryMove.text)
		: "";
	const primaryMoveCopyGate = copyGateForPrimaryMove(
		primaryMove,
		primaryMoveText,
	);
	const primaryMoveOverLimit = primaryMoveCopyGate.reason === "trim";
	const primaryMoveHasForbiddenClaim = primaryMoveCopyGate.reason === "claim";
	const primaryVoicePair = primaryMove
		? voicePairs.find(
				({ personal, project }) =>
					personal.id === primaryMove.id || project.id === primaryMove.id,
			)?.pair
		: undefined;
	const todayPickBoundary = `Source: ${sourceAge}; X text untrusted; clipboard only`;

	async function copyText(id: string, text: string) {
		try {
			if (!navigator.clipboard?.writeText) {
				throw new Error("Clipboard API unavailable");
			}
			await navigator.clipboard.writeText(text);
			setCopiedId(id);
			setCopyStatus("Copied to clipboard. Review in X before posting.");
		} catch {
			setCopiedId(null);
			setCopyStatus(
				"Clipboard unavailable. Select and copy the text manually.",
			);
		}
	}

	return (
		<main className={pageWrapClass}>
			<p className="sr-only" aria-live="polite">
				{copyStatus}
			</p>
			<div className="mx-auto grid w-full max-w-[1180px] gap-5">
				{copyStatus ? (
					<p
						aria-live="polite"
						className="m-0 rounded-[16px] bg-[var(--panel-strong)] p-3 text-sm font-medium text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--line)]"
						role="status"
					>
						{copyStatus}
					</p>
				) : null}
				<section className={cx(heroShellClass, "py-5 pb-4")}>
					<div>
						<p className={eyebrowClass}>today command center</p>
						<h2
							className={cx(
								heroTitleClass,
								"max-w-[15ch] text-[clamp(2.1rem,3.6vw,3.8rem)]",
							)}
						>
							What to post next, who it is for, and why it can travel
						</h2>
						<p className={heroCopyClass}>
							Birdclaw ranks local X signal against voice, proof, and algorithm
							fit, then leaves the final post manual.
						</p>
					</div>
					<div className="grid w-full min-w-0 max-w-[360px] gap-3 rounded-[18px] border border-[var(--line)] bg-[color:color-mix(in_srgb,var(--panel-strong)_78%,transparent)] p-4 max-[760px]:max-w-none">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<p className={cx(eyebrowClass, "mb-0")}>Today pick</p>
							<a
								className="min-h-10 rounded-full bg-[var(--ink)] px-3 py-2 text-sm font-medium text-white no-underline transition-[transform,box-shadow] duration-180 hover:shadow-[0_10px_24px_var(--shadow)] active:scale-[0.96]"
								href="#best-move"
							>
								Review/copy
							</a>
						</div>
						{primaryMove ? (
							<>
								<div className="grid gap-1">
									<p className="m-0 text-sm font-medium text-[var(--ink)]">
										{primaryMove.kind}: {primaryMove.title}
									</p>
									<p className="m-0 text-[0.9rem] leading-relaxed text-[var(--ink-soft)]">
										{primaryMove.action}
									</p>
									{primaryMove.algorithmFit ? (
										<p className="m-0 text-[0.82rem] leading-relaxed text-[var(--ink-soft)]">
											For {primaryMove.algorithmFit.targetReader};{" "}
											{primaryMove.algorithmFit.rankingSignal}
										</p>
									) : null}
								</div>
								<PublishReadinessStrip
									artifactNeeded={primaryMove.artifactNeeded}
									compact
									kind={primaryMove.kind}
								/>
								<p className="m-0 break-words rounded-[12px] bg-[var(--panel)] px-3 py-2 text-[0.82rem] font-medium leading-relaxed text-[var(--ink-soft)] shadow-[inset_0_0_0_1px_var(--line)]">
									{todayPickBoundary}
								</p>
							</>
						) : (
							<p className="m-0 text-[0.92rem] leading-relaxed text-[var(--ink-soft)]">
								{totalActionCount > 0
									? "Current filters hide every local move. Adjust account or goal filters; copy is still the only outbound action."
									: "Birdclaw is loading the strongest local signal. Nothing posts from this page; copy is the only outbound action."}
							</p>
						)}
					</div>
				</section>

				<section className={cx(surfaceCardClass, "grid gap-4 p-4")}>
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div>
							<p className={cx(eyebrowClass, "mb-1")}>publishing workflow</p>
							<h3 className="m-0 font-display text-[1.45rem]">
								From live signal to reviewed copy
							</h3>
							<p className={cx(timestampClass, "m-0 mt-1 max-w-[64ch]")}>
								{workflow?.bridgeTheme ??
									"Loading personal signal and project draft workflow..."}
							</p>
						</div>
						<div className="flex flex-wrap gap-2">
							<FilterButton
								active={accountFilter === "all"}
								label="All"
								onClick={() => setAccountFilter("all")}
							/>
							<FilterButton
								active={accountFilter === "project"}
								label="Publish: @vantaprivacy"
								onClick={() => setAccountFilter("project")}
							/>
							<FilterButton
								active={accountFilter === "personal"}
								label="Scout: @williamclay"
								onClick={() => setAccountFilter("personal")}
							/>
						</div>
					</div>
					<div className="grid gap-2 min-[760px]:grid-cols-4">
						<WorkflowStep index={1} label="Scout signal" />
						<WorkflowStep index={2} label="Shape draft" />
						<WorkflowStep index={3} label="Check risk" />
						<WorkflowStep index={4} label="Copy manually" />
					</div>
					<SourceBoundaryRail
						age={sourceAge}
						freshness={sourceFreshness}
						quality={workflow?.sourceQuality?.summary}
						source={workflow?.engagementPlaybook?.source}
					/>
					<div className="grid gap-3 min-[880px]:grid-cols-[1fr_auto]">
						<div className="grid gap-2 min-[760px]:grid-cols-4">
							<WorkflowStat
								label="Visible actions"
								value={workflowStats.manualActions}
							/>
							<WorkflowStat
								label="Ready drafts"
								value={workflowStats.readyDrafts}
							/>
							<WorkflowStat
								label="High signal"
								value={workflowStats.highSignalDrafts}
							/>
							<WorkflowStat
								label="Needs artifact"
								value={workflowStats.artifactDrafts}
							/>
						</div>
						<div className="grid gap-2 self-start rounded-[18px] border border-[var(--line)] bg-[var(--panel-strong)] p-3 min-[560px]:grid-cols-3">
							<SelectControl
								label="Goal"
								onChange={(value) => setGoalFilter(value as GoalFilter)}
								options={[
									["all", "All goals"],
									["reply", "Reply"],
									["bookmark", "Bookmark"],
									["share", "Share"],
									["proof", "Proof"],
									["like", "Like"],
								]}
								value={goalFilter}
							/>
							<SelectControl
								label="Job"
								onChange={(value) => setJobFilter(value as JobFilter)}
								options={[
									["all", "All jobs"],
									["artifact", "Needs artifact"],
									["copy", "Copy-ready"],
									["reply-review", "Reply review"],
								]}
								value={jobFilter}
							/>
							<SelectControl
								label="View"
								onChange={(value) => setSectionDensity(value as SectionDensity)}
								options={[
									["scan", "Scan view"],
									["full", "Expanded view"],
								]}
								value={sectionDensity}
							/>
						</div>
					</div>
					<p className="m-0 rounded-[14px] bg-[var(--panel-strong)] px-3 py-2 text-sm font-medium text-[var(--ink-soft)] shadow-[inset_0_0_0_1px_var(--line)]">
						{filterSummary}
					</p>
					<div
						aria-label="Content focus"
						className="flex flex-wrap gap-2 border-t border-[var(--line)] pt-3"
						role="group"
					>
						{(
							["review", "queues", "voice", "signals", "training"] as const
						).map((focus) => (
							<FocusButton
								active={contentFocus === focus}
								count={focusCounts[focus]}
								key={focus}
								label={contentFocusLabel(focus)}
								onClick={() => setContentFocus(focus)}
							/>
						))}
					</div>
				</section>

				{contentFocus === "review" ? (
					<section
						className={cx(surfaceCardClass, "grid gap-5 p-5 scroll-mt-4")}
						id="best-move"
					>
						<div className="flex items-start justify-between gap-4 max-[760px]:flex-col">
							<div>
								<h3 className="m-0 font-display text-[1.55rem]">
									Best move today
								</h3>
								<p className={cx(eyebrowClass, "mt-1")}>
									One recommended manual action
								</p>
							</div>
							<p className="m-0 max-w-[42ch] text-sm leading-relaxed text-[var(--ink-soft)]">
								This favors artifact-ready, claim-safe local drafts and replies
								before raw score. Copying only puts text on your clipboard; you
								still decide what posts from X.
							</p>
						</div>

						{primaryMove ? (
							<div className="grid gap-4 min-[980px]:grid-cols-[minmax(0,1.1fr)_minmax(300px,0.9fr)]">
								<article className="grid gap-4 rounded-[18px] bg-[var(--panel-strong)] p-5 shadow-[inset_0_0_0_1px_var(--line)]">
									<div className="flex flex-wrap items-center justify-between gap-3">
										<div>
											<p className={cx(eyebrowClass, "mb-1")}>
												Step 1: review this {primaryMove.kind.toLowerCase()}
											</p>
											<h4 className="m-0 font-display text-[1.45rem] leading-tight">
												{primaryMove.title}
											</h4>
										</div>
										<PriorityBadge
											priority={primaryMove.priority}
											score={primaryMove.score}
											topPickEligible={primaryMove.topPickEligible}
										/>
									</div>

									<section
										aria-label="Recommended manual action"
										className="grid gap-1 rounded-[16px] bg-[color:color-mix(in_srgb,var(--accent-soft)_54%,var(--panel))] p-4 shadow-[inset_0_0_0_1px_var(--line)]"
									>
										<p className={cx(eyebrowClass, "mb-0")}>
											Recommended manual action
										</p>
										<p className="m-0 text-[1.05rem] font-medium leading-relaxed text-[var(--ink)]">
											{primaryMove.action}
										</p>
									</section>
									<MoveDecisionBrief
										artifactNeeded={primaryMove.artifactNeeded}
										kind={primaryMove.kind}
										voiceTarget={voiceTargetForMove(primaryMove.kind)}
									/>
									<AlgorithmFitPanel
										fit={primaryMove.algorithmFit}
										targets={workflow?.engagementTargets ?? []}
									/>
									<ArtifactWorkbench
										gate={primaryMoveCopyGate}
										move={{
											artifactNeeded: primaryMove.artifactNeeded,
											kind: primaryMove.kind,
											title: primaryMove.title,
										}}
										voicePair={primaryVoicePair}
									/>
									<ProofBoundaryMatrix boundary={primaryMove.proofBoundary} />

									<div className="grid gap-2">
										<label
											className={cx(eyebrowClass, "mb-0")}
											htmlFor="primary-move-editor"
										>
											Edit locally before copy
										</label>
										<textarea
											className="min-h-[132px] resize-y rounded-[16px] border border-[var(--line)] bg-[var(--panel)] p-4 text-[1.05rem] leading-relaxed text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--line)] outline-none transition-[border-color,box-shadow] duration-180 focus:border-[var(--line-strong)] focus:shadow-[inset_0_0_0_1px_var(--line-strong)]"
											id="primary-move-editor"
											onChange={(event) =>
												setEditedTextById((current) => ({
													...current,
													[primaryMove.id]: event.target.value,
												}))
											}
											value={primaryMoveText}
										/>
										<p
											className={cx(
												timestampClass,
												"m-0 text-right",
												copyGateWarningClass(primaryMoveCopyGate),
											)}
										>
											{characterCountLabel(primaryMoveCopyGate)} characters
											{primaryMoveOverLimit ? " - trim before copying" : ""}
											{!primaryMoveOverLimit && primaryMoveHasForbiddenClaim
												? " - remove unsafe claim before copying"
												: ""}
										</p>
									</div>

									<div className="grid gap-3 min-[760px]:grid-cols-2">
										<InfoBlock label="Why this one" text={primaryMove.why} />
										<InfoBlock
											label="Voice target"
											text={voiceTargetForMove(primaryMove.kind)}
										/>
									</div>
									<PublishReadinessStrip
										artifactNeeded={primaryMove.artifactNeeded}
										kind={primaryMove.kind}
									/>
									{primaryMove.tension ||
									primaryMove.replyEdge ||
									primaryMove.artifactNeeded ? (
										<DetailsPanel
											defaultOpen={sectionDensity === "full"}
											summary="Engagement details"
										>
											<DraftMeta
												artifactNeeded={primaryMove.artifactNeeded}
												engagementGoal={primaryMove.engagementGoal}
												engagementPattern={primaryMove.engagementPattern}
												tension={primaryMove.tension}
											/>
											{primaryMove.replyEdge ? (
												<InfoBlock
													label="Reply edge"
													text={primaryMove.replyEdge}
												/>
											) : null}
										</DetailsPanel>
									) : null}

									<div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] pt-4">
										<p className="m-0 text-[0.88rem] leading-relaxed text-[var(--ink-soft)]">
											Review, then paste into X when ready.
										</p>
										<button
											className={actionButtonClass}
											disabled={primaryMoveCopyGate.blocked}
											onClick={() => copyText(primaryMove.id, primaryMoveText)}
											type="button"
										>
											{copyButtonLabel({
												copied: copiedId === primaryMove.id,
												defaultLabel: "Copy reviewed draft",
												gate: primaryMoveCopyGate,
											})}
										</button>
									</div>
									{copyGateReasonText(primaryMoveCopyGate) ? (
										<p className="m-0 text-[0.84rem] font-medium leading-relaxed text-[var(--alert)]">
											{copyGateReasonText(primaryMoveCopyGate)}
										</p>
									) : null}
								</article>

								<div className="grid content-start gap-3">
									<div className="rounded-[16px] bg-[var(--panel-strong)] p-4 shadow-[inset_0_0_0_1px_var(--line)]">
										<p className={cx(eyebrowClass, "mb-2")}>Why it surfaced</p>
										<ol className="m-0 grid gap-2 pl-5 text-[0.9rem] leading-relaxed text-[var(--ink-soft)]">
											<li>
												Artifact and claim readiness ranked ahead of raw score.
											</li>
											<li>Grounded in source evidence below.</li>
											<li>
												Has a visible tension, goal, and manual review boundary.
											</li>
										</ol>
									</div>
									<EvidenceList
										defaultOpen={sectionDensity === "full"}
										items={primaryMove.evidence}
									/>
								</div>
							</div>
						) : (
							<p className="m-0 text-[var(--ink-soft)]">
								{totalActionCount > 0
									? "No recommended moves match the current filters. Adjust account or goal filters to bring drafts back."
									: "Sync both accounts, then the clearest draft or reply will appear here."}
							</p>
						)}

						<div className="grid gap-3">
							<div>
								<h4 className="m-0 text-sm font-medium text-[var(--ink)]">
									Next-best options
								</h4>
								<p className={cx(timestampClass, "m-0 mt-1")}>
									Filtered by account and engagement goal, ranked by local
									signal. Use these when the main pick does not fit today's
									post.
								</p>
							</div>
							<div className="grid gap-2">
								{nextMoves.slice(1).map((move, index) => (
									<article
										className="grid min-w-0 gap-3 rounded-[14px] bg-[color:color-mix(in_srgb,var(--panel-strong)_82%,transparent)] p-3.5 shadow-[inset_0_0_0_1px_var(--line)] min-[760px]:grid-cols-[56px_minmax(0,1fr)_auto]"
										key={`${move.kind}-${move.id}`}
									>
										<div className="flex items-center gap-2">
											<span className="grid size-9 place-items-center rounded-full bg-[var(--accent-soft)] text-sm font-medium text-[var(--accent)]">
												{index + 2}
											</span>
										</div>
										<div className="min-w-0">
											<p className="m-0 text-sm font-medium text-[var(--ink)]">
												{move.kind}: {move.title}
											</p>
											<p className="m-0 mt-1 break-words text-[0.92rem] leading-relaxed text-[var(--ink)]">
												{move.text}
											</p>
											<p className="m-0 mt-1 break-words text-[0.86rem] leading-relaxed text-[var(--ink-soft)]">
												{move.action}
											</p>
										</div>
										<PriorityBadge
											priority={move.priority}
											score={move.score}
											topPickEligible={move.topPickEligible}
										/>
									</article>
								))}
								{nextMoves.length <= 1 ? (
									<p className="m-0 rounded-[14px] bg-[var(--panel-strong)] p-3 text-sm text-[var(--ink-soft)] shadow-[inset_0_0_0_1px_var(--line)]">
										No backup moves match the current filters.
									</p>
								) : null}
							</div>
						</div>
					</section>
				) : null}

				{contentFocus === "review" ? (
					<section
						className={cx(surfaceCardClass, "grid gap-4 p-5 scroll-mt-4")}
						id="loop-digest"
					>
						<div className="flex items-start justify-between gap-4 max-[760px]:flex-col">
							<div>
								<h3 className="m-0 font-display text-[1.55rem]">
									40-loop digest
								</h3>
								<p className={cx(eyebrowClass, "mt-1")}>
									What this pass changed about the workflow
								</p>
							</div>
							<p className="m-0 max-w-[46ch] text-sm leading-relaxed text-[var(--ink-soft)]">
								Use this as the compact taste map after choosing a draft. The
								dashboard should make decisions faster, not create more reading.
							</p>
						</div>
						<div className="grid gap-3 min-[860px]:grid-cols-2">
							<ContentLoopDigestList
								title="UI/UX loop rules"
								items={UI_LOOP_DIGEST}
							/>
							<ContentLoopDigestList
								title="Tone/voice loop rules"
								items={VOICE_LOOP_DIGEST}
							/>
						</div>
					</section>
				) : null}

				<section className="grid gap-3 min-[860px]:grid-cols-4">
					<Metric label="Project mentions" value={counts.projectMentions} />
					<Metric label="Project unreplied" value={counts.projectUnreplied} />
					<Metric label="Personal mentions" value={counts.personalMentions} />
					<Metric label="Personal people" value={counts.personalPeople} />
				</section>

				{contentFocus === "voice" && voicePairs.length ? (
					<section
						className={cx(surfaceCardClass, "grid gap-4 p-5 scroll-mt-4")}
						id="voice-bridge"
					>
						<div className="flex items-start justify-between gap-4 max-[760px]:flex-col">
							<div>
								<h3 className="m-0 font-display text-[1.55rem]">
									Voice bridge
								</h3>
								<p className={cx(eyebrowClass, "mt-1")}>
									Personal scout read to project-safe translation
								</p>
							</div>
							<p className="m-0 max-w-[46ch] text-sm leading-relaxed text-[var(--ink-soft)]">
								Use this to keep @williamclay sharp and exploratory while
								@vantaprivacy stays calmer, artifact-backed, and review-safe.
							</p>
						</div>
						<div className="grid gap-3 min-[980px]:grid-cols-3">
							{voicePairs.map(({ pair, personal, project }) => (
								<VoiceBridgeCard
									key={`${personal.id}-${project.id}`}
									personalText={personal.text}
									projectText={project.text}
									rationale={pair}
									risk={
										project.artifactNeeded && project.artifactNeeded !== "none"
											? `Needs artifact: ${project.artifactNeeded}`
											: "Risk: manual review, no unsafe claims"
									}
									tension={personal.tension ?? project.tension}
								/>
							))}
						</div>
					</section>
				) : null}

				{contentFocus === "signals" || contentFocus === "queues" ? (
					<section
						className={cx(
							"grid items-start gap-4",
							contentFocus === "queues" && "min-[980px]:grid-cols-[1.2fr_1fr]",
						)}
					>
						{contentFocus === "signals" ? (
							<div
								className={cx(surfaceCardClass, "grid gap-3 p-5 scroll-mt-4")}
								id="signals"
							>
								<div>
									<h3 className="m-0 font-display text-[1.55rem]">
										Why these topics are worth using
									</h3>
									<p className={cx(eyebrowClass, "mt-1")}>What to build from</p>
								</div>
								{workflow?.pillars.map((pillar, index) => (
									<article
										key={`${pillar.title}-${pillar.topic}`}
										className={cx(
											"grid gap-3 rounded-[16px] bg-[var(--panel)] p-4 shadow-[inset_0_0_0_1px_var(--line)]",
											index === 0 &&
												"shadow-[inset_0_0_0_1px_var(--line),0_18px_44px_var(--shadow)]",
										)}
									>
										<div className="flex items-start justify-between gap-3">
											<div>
												<p className="m-0 text-sm font-medium text-[var(--ink)]">
													{pillar.title}
												</p>
												<p className="m-0 mt-1 text-[0.85rem] uppercase tracking-[0.12em] text-[var(--ink-soft)]">
													{pillar.topic}
												</p>
											</div>
											<PriorityBadge
												priority={pillar.priority ?? "medium"}
												score={pillar.score ?? 0}
												topPickEligible={false}
											/>
										</div>
										<p className="m-0 text-[0.94rem] leading-relaxed">
											{pillar.angle}
										</p>
										<DetailsPanel
											defaultOpen={sectionDensity === "full"}
											summary="Use this signal"
										>
											<InfoBlock
												label="Next"
												text={
													pillar.nextAction ?? "Turn into a manual content lane"
												}
											/>
											<InfoBlock
												label="Why"
												text={
													pillar.whyItMatters ??
													"Keeps the project account grounded in actual audience interest."
												}
											/>
											<EvidenceList
												defaultOpen={sectionDensity === "full"}
												items={pillar.sourceEvidence ?? [pillar.sourceSignal]}
											/>
										</DetailsPanel>
									</article>
								))}
								<EngagementTargetsPanel
									targets={workflow?.engagementTargets ?? []}
								/>
							</div>
						) : null}

						{contentFocus === "queues" ? (
							<div
								className={cx(surfaceCardClass, "grid gap-3 p-5 scroll-mt-4")}
								id="project-drafts"
							>
								<div>
									<h3 className="m-0 font-display text-[1.55rem]">
										Project-account drafts
									</h3>
									<p className={cx(eyebrowClass, "mt-1")}>
										@vantaprivacy review and copy
									</p>
								</div>
								<ArtifactQueuePanel items={artifactQueue} />
								{visibleProjectDrafts.map((draft) => (
									<ProjectDraftCard
										copied={copiedId === draft.id}
										copyText={copyText}
										defaultOpen={sectionDensity === "full"}
										draft={draft}
										key={draft.id}
									/>
								))}
								{filteredProjectDrafts.length === 0 ? (
									<EmptyPanel text="No project drafts match the current filters." />
								) : null}
								{sectionDensity === "scan" &&
								filteredProjectDrafts.length > visibleProjectDrafts.length ? (
									<EmptyPanel
										text={`Scan view is showing ${visibleProjectDrafts.length} of ${filteredProjectDrafts.length} project drafts. Switch to Expanded view to see all.`}
									/>
								) : null}
							</div>
						) : null}

						{contentFocus === "queues" ? (
							<div
								className={cx(surfaceCardClass, "grid gap-3 p-5 scroll-mt-4")}
								id="replies"
							>
								<div>
									<h3 className="m-0 font-display text-[1.55rem]">
										Replies worth answering
									</h3>
									<p className={cx(eyebrowClass, "mt-1")}>
										Prompt from inbound
									</p>
								</div>
								{filteredReplyPrompts.length ? (
									visibleReplyPrompts.map((prompt) => (
										<ReplyPromptCard
											copied={copiedId === prompt.tweetId}
											copyText={copyText}
											defaultOpen={sectionDensity === "full"}
											key={prompt.tweetId}
											prompt={prompt}
										/>
									))
								) : (
									<p className="m-0 text-[var(--ink-soft)]">
										No high-signal project replies match the current filters.
									</p>
								)}
								{sectionDensity === "scan" &&
								filteredReplyPrompts.length > visibleReplyPrompts.length ? (
									<EmptyPanel
										text={`Scan view is showing ${visibleReplyPrompts.length} of ${filteredReplyPrompts.length} replies. Switch to Expanded view to see all.`}
									/>
								) : null}
							</div>
						) : null}
					</section>
				) : null}

				{contentFocus === "training" ? (
					<TrainingPanel training={workflow?.training} />
				) : null}

				{contentFocus === "queues" ? (
					<section
						className={cx(surfaceCardClass, "grid gap-4 p-5 scroll-mt-4")}
						id="personal-drafts"
					>
						<div className="flex items-start justify-between gap-4 max-[760px]:flex-col">
							<div>
								<h3 className="m-0 font-display text-[1.55rem]">
									Personal scout drafts
								</h3>
								<p className={cx(eyebrowClass, "mt-1")}>
									Personal voice: test the taste before it becomes Vanta copy
								</p>
							</div>
							<p className="m-0 max-w-[48ch] text-sm leading-relaxed text-[var(--ink-soft)]">
								These use the same For You signal, but keep the voice more
								human: pattern notes, AI/wallet observations, and founder taste.
							</p>
						</div>
						<div className="grid gap-3 min-[900px]:grid-cols-3">
							{visiblePersonalDrafts.map((draft) => (
								<PersonalDraftCard
									copied={copiedId === draft.id}
									copyText={copyText}
									defaultOpen={sectionDensity === "full"}
									draft={draft}
									key={draft.id}
								/>
							))}
							{filteredPersonalDrafts.length === 0 ? (
								<EmptyPanel text="No Clay scout drafts match the current filters." />
							) : null}
							{sectionDensity === "scan" &&
							filteredPersonalDrafts.length > visiblePersonalDrafts.length ? (
								<EmptyPanel
									text={`Scan view is showing ${visiblePersonalDrafts.length} of ${filteredPersonalDrafts.length} personal drafts. Switch to Expanded view to see all.`}
								/>
							) : null}
						</div>
					</section>
				) : null}
			</div>
		</main>
	);
}

function ProjectDraftCard({
	copied,
	copyText,
	defaultOpen,
	draft,
}: {
	copied: boolean;
	copyText: (id: string, text: string) => void;
	defaultOpen: boolean;
	draft: ProjectContentWorkflow["postDrafts"][number];
}) {
	const gate = copyGateForDraft(draft);
	const gateReason = copyGateReasonText(gate);
	return (
		<article className="grid min-w-0 gap-3 rounded-[16px] border border-[var(--line)] bg-[color:color-mix(in_srgb,var(--panel-strong)_76%,transparent)] p-4">
			<div className="flex items-start justify-between gap-3">
				<p className="m-0 text-[0.82rem] uppercase tracking-[0.12em] text-[var(--ink-soft)]">
					{draft.archetype}
				</p>
				<PriorityBadge
					priority={draft.priority ?? "medium"}
					score={draft.score ?? 0}
					topPickEligible={isTopPickEligible({
						artifactNeeded: draft.artifactNeeded,
						kind: "Project",
						reviewChecklist: draft.reviewChecklist,
					})}
				/>
			</div>
			<p className="m-0 break-words text-[1rem] leading-relaxed">
				{draft.text}
			</p>
			<DraftDetailGroup
				artifactNeeded={draft.artifactNeeded}
				defaultOpen={defaultOpen}
				engagementGoal={draft.engagementGoal}
				engagementPattern={draft.engagementPattern}
				evidence={draft.sourceEvidence ?? [draft.sourceSignal]}
				nextAction={draft.nextAction ?? "Review and queue manually"}
				replyEdge={draft.replyEdge ?? "No reply edge recorded yet."}
				reviewChecklist={
					draft.reviewChecklist ?? [
						{ label: "Manual posting only", passed: true },
						{
							label: "Review source and claims before posting",
							passed: false,
						},
					]
				}
				tension={draft.tension}
				summary="Risk & evidence"
				why={
					draft.whyItMatters ??
					"Turns personal-account topic heat into project language."
				}
			/>
			<div className="flex items-center justify-between gap-3">
				<span className={cx(timestampClass, copyGateWarningClass(gate))}>
					{characterCountLabel(gate)}
				</span>
				<button
					className={actionButtonClass}
					disabled={gate.blocked}
					onClick={() => copyText(draft.id, draft.text)}
					type="button"
				>
					{copyButtonLabel({
						copied,
						defaultLabel: "Copy for manual review",
						gate,
					})}
				</button>
			</div>
			{gateReason ? (
				<p className="m-0 text-[0.84rem] font-medium leading-relaxed text-[var(--alert)]">
					{gateReason}
				</p>
			) : null}
		</article>
	);
}

function ReplyPromptCard({
	copied,
	copyText,
	defaultOpen,
	prompt,
}: {
	copied: boolean;
	copyText: (id: string, text: string) => void;
	defaultOpen: boolean;
	prompt: ProjectContentWorkflow["replyPrompts"][number];
}) {
	const gate = copyGateForReply(prompt.suggestedReply);
	const gateReason = copyGateReasonText(gate);
	return (
		<article className="grid min-w-0 gap-3 rounded-[16px] border border-[var(--line)] bg-[color:color-mix(in_srgb,var(--panel-strong)_76%,transparent)] p-4">
			<p className="m-0 text-sm font-medium text-[var(--ink)]">
				@{prompt.authorHandle}
			</p>
			<p className="m-0 break-words text-[0.95rem] leading-relaxed">
				{prompt.suggestedReply}
			</p>
			<div className="flex items-center justify-between gap-3">
				<PriorityBadge
					priority={prompt.priority ?? "medium"}
					score={prompt.score ?? 0}
				/>
				<span className={cx(timestampClass, copyGateWarningClass(gate))}>
					{characterCountLabel(gate)}
				</span>
			</div>
			<p className={cx(timestampClass, "m-0")}>
				{prompt.nextAction ?? "Review reply manually"}
			</p>
			<QuickReviewChips
				artifactNeeded="source context"
				evidenceCount={prompt.sourceEvidence?.length ?? 1}
				reviewChecklist={
					prompt.reviewChecklist ?? [
						{ label: "Manual posting only", passed: true },
						{ label: "Human reply review", passed: false },
						{ label: "Source text treated as untrusted", passed: true },
					]
				}
			/>
			<DetailsPanel defaultOpen={defaultOpen} summary="Reason and evidence">
				<InfoBlock
					label="Why"
					text={
						prompt.whyItMatters ?? "Project mention worth answering manually."
					}
				/>
				<EvidenceList
					defaultOpen={defaultOpen}
					items={prompt.sourceEvidence ?? [prompt.prompt]}
				/>
			</DetailsPanel>
			{gateReason ? (
				<p className="m-0 text-[0.84rem] font-medium leading-relaxed text-[var(--alert)]">
					{gateReason}
				</p>
			) : null}
			<button
				className={actionButtonClass}
				disabled={gate.blocked}
				onClick={() => copyText(prompt.tweetId, prompt.suggestedReply)}
				type="button"
			>
				{copyButtonLabel({
					copied,
					defaultLabel: "Copy reply for review",
					gate,
				})}
			</button>
		</article>
	);
}

function PersonalDraftCard({
	copied,
	copyText,
	defaultOpen,
	draft,
}: {
	copied: boolean;
	copyText: (id: string, text: string) => void;
	defaultOpen: boolean;
	draft: ProjectContentWorkflow["personalPostDrafts"][number];
}) {
	const gate = copyGateForDraft(draft);
	const gateReason = copyGateReasonText(gate);
	return (
		<article className="grid min-w-0 gap-3 rounded-[16px] border border-[var(--line)] bg-[color:color-mix(in_srgb,var(--panel-strong)_76%,transparent)] p-4">
			<div className="flex items-start justify-between gap-3">
				<p className="m-0 text-[0.82rem] uppercase tracking-[0.12em] text-[var(--ink-soft)]">
					{draft.archetype}
				</p>
				<PriorityBadge
					priority={draft.priority ?? "medium"}
					score={draft.score ?? 0}
				/>
			</div>
			<p className="m-0 break-words text-[1rem] leading-relaxed">
				{draft.text}
			</p>
			<DraftDetailGroup
				artifactNeeded={draft.artifactNeeded}
				defaultOpen={defaultOpen}
				engagementGoal={draft.engagementGoal}
				engagementPattern={draft.engagementPattern}
				evidence={draft.sourceEvidence ?? [draft.sourceSignal]}
				nextAction={draft.nextAction ?? "Review for @williamclay"}
				replyEdge={draft.replyEdge ?? "No reply edge recorded yet."}
				reviewChecklist={draft.reviewChecklist}
				tension={draft.tension}
				summary="Risk & evidence"
				why={
					draft.whyItMatters ??
					"Turns live timeline interest into personal-account pattern recognition."
				}
			/>
			<div className="flex items-center justify-between gap-3">
				<span className={cx(timestampClass, copyGateWarningClass(gate))}>
					{characterCountLabel(gate)}
				</span>
				<button
					className={actionButtonClass}
					disabled={gate.blocked}
					onClick={() => copyText(draft.id, draft.text)}
					type="button"
				>
					{copyButtonLabel({
						copied,
						defaultLabel: "Copy personal draft for review",
						gate,
					})}
				</button>
			</div>
			{gateReason ? (
				<p className="m-0 text-[0.84rem] font-medium leading-relaxed text-[var(--alert)]">
					{gateReason}
				</p>
			) : null}
		</article>
	);
}

function FilterButton({
	active,
	label,
	onClick,
}: {
	active: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			aria-pressed={active}
			className={cx(
				"min-h-10 rounded-full border px-3.5 py-2 text-sm font-medium capitalize transition duration-180 active:scale-[0.96]",
				active
					? "border-[var(--line-strong)] bg-[var(--ink)] text-white shadow-[0_12px_28px_var(--shadow)]"
					: "border-[var(--line)] bg-[var(--panel)] text-[var(--ink-soft)] hover:border-[var(--line-strong)] hover:text-[var(--ink)]",
			)}
			onClick={onClick}
			type="button"
		>
			{label}
		</button>
	);
}

function FocusButton({
	active,
	count,
	label,
	onClick,
}: {
	active: boolean;
	count: number;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			aria-pressed={active}
			className={cx(
				"min-h-10 rounded-full border px-3.5 py-2 text-sm font-medium transition duration-180 active:scale-[0.96]",
				active
					? "border-[var(--line-strong)] bg-[var(--ink)] text-white shadow-[0_12px_28px_var(--shadow)]"
					: "border-[var(--line)] bg-[var(--panel)] text-[var(--ink-soft)] hover:border-[var(--line-strong)] hover:text-[var(--ink)]",
			)}
			onClick={onClick}
			type="button"
		>
			{label}{" "}
			<span className="tabular-nums text-current opacity-70">({count})</span>
		</button>
	);
}

function SelectControl({
	label,
	onChange,
	options,
	value,
}: {
	label: string;
	onChange: (value: string) => void;
	options: readonly [string, string][];
	value: string;
}) {
	return (
		<label className="grid min-w-[150px] gap-1">
			<span className={cx(timestampClass, "m-0 text-[0.76rem]")}>{label}</span>
			<select
				className="min-h-10 rounded-[12px] border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium text-[var(--ink)] outline-none transition-[border-color,box-shadow] duration-180 focus:border-[var(--line-strong)] focus:shadow-[0_0_0_3px_var(--accent-soft)]"
				onChange={(event) => onChange(event.target.value)}
				value={value}
			>
				{options.map(([optionValue, optionLabel]) => (
					<option key={optionValue} value={optionValue}>
						{optionLabel}
					</option>
				))}
			</select>
		</label>
	);
}

function WorkflowStep({ index, label }: { index: number; label: string }) {
	return (
		<div className="flex items-center gap-3 rounded-[16px] bg-[var(--panel-strong)] p-3 shadow-[inset_0_0_0_1px_var(--line)]">
			<span className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--accent-soft)] text-xs font-semibold tabular-nums text-[var(--accent)]">
				{index}
			</span>
			<p className="m-0 text-sm font-medium text-[var(--ink)]">{label}</p>
		</div>
	);
}

function WorkflowStat({ label, value }: { label: string; value: number }) {
	return (
		<div className="rounded-[16px] bg-[var(--panel-strong)] p-3 shadow-[inset_0_0_0_1px_var(--line)]">
			<p className={cx(timestampClass, "m-0 text-[0.78rem]")}>{label}</p>
			<p className="m-0 mt-1 font-display text-2xl tabular-nums leading-none">
				{value}
			</p>
		</div>
	);
}

function SourceBoundaryRail({
	age,
	freshness,
	quality,
	source,
}: {
	age: string;
	freshness: string;
	quality?: string;
	source?: string;
}) {
	const items = [
		["Read-only source bounds", "Local Birdclaw data"],
		["Sample quality", quality ?? "Small local sample; mostly mentions"],
		["Snapshot caveat", source ?? "Small local sample; partial X visibility"],
		["Source freshness", freshness],
		["Source age", age],
		["No X write actions", "Manual clipboard workflow"],
		["Untrusted social text", "Review claims before posting"],
	] as const;

	return (
		<section
			aria-label="Source and publishing boundaries"
			className="grid gap-2 rounded-[18px] bg-[color:color-mix(in_srgb,var(--panel-strong)_82%,transparent)] p-3 shadow-[inset_0_0_0_1px_var(--line)] min-[760px]:grid-cols-2 min-[1040px]:grid-cols-7"
		>
			{items.map(([label, value]) => (
				<div className="min-w-0" key={label}>
					<p className="m-0 text-[0.72rem] font-medium uppercase tracking-[0.1em] text-[var(--ink-soft)]">
						{label}
					</p>
					<p className="m-0 mt-1 break-words text-sm font-medium leading-snug text-[var(--ink)]">
						{value}
					</p>
				</div>
			))}
		</section>
	);
}

function EmptyPanel({ text }: { text: string }) {
	return (
		<p className="m-0 rounded-[16px] bg-[var(--panel-strong)] p-4 text-sm leading-relaxed text-[var(--ink-soft)] shadow-[inset_0_0_0_1px_var(--line)]">
			{text}
		</p>
	);
}

function Metric({ label, value }: { label: string; value: number }) {
	return (
		<div className="rounded-[16px] border border-[var(--line)] bg-[color:color-mix(in_srgb,var(--panel-strong)_76%,transparent)] p-4">
			<p className="m-0 text-[0.78rem] uppercase tracking-[0.12em] text-[var(--ink-soft)]">
				{label}
			</p>
			<p className="m-0 mt-2 font-display text-3xl tabular-nums leading-none">
				{value}
			</p>
		</div>
	);
}

function ContentLoopDigestList({
	items,
	title,
}: {
	items: readonly string[];
	title: string;
}) {
	return (
		<div className="grid gap-3 rounded-[16px] bg-[var(--panel-strong)] p-4 shadow-[inset_0_0_0_1px_var(--line)]">
			<h4 className="m-0 text-sm font-semibold text-[var(--ink)]">{title}</h4>
			<ul className="m-0 grid gap-2 pl-5 text-[0.92rem] leading-relaxed text-[var(--ink-soft)]">
				{items.map((item) => (
					<li key={item}>{item}</li>
				))}
			</ul>
		</div>
	);
}

function VoiceBridgeCard({
	personalText,
	projectText,
	rationale,
	risk,
	tension,
}: {
	personalText: string;
	projectText: string;
	rationale?: {
		artifactNeeded: string;
		projectTranslation: string;
		proofBoundary: string;
		scoutMechanism: string;
	};
	risk: string;
	tension?: string;
}) {
	return (
		<article className="grid min-w-0 gap-3 rounded-[16px] bg-[var(--panel-strong)] p-4 shadow-[inset_0_0_0_1px_var(--line)]">
			<div className="grid gap-2">
				<p className={cx(eyebrowClass, "mb-0")}>@williamclay scout read</p>
				<p className="m-0 break-words text-[0.95rem] leading-relaxed text-[var(--ink)]">
					{personalText}
				</p>
			</div>
			<div className="h-px bg-[var(--line)]" />
			<div className="grid gap-2 rounded-[12px] bg-[var(--panel)] p-3 shadow-[inset_0_0_0_1px_var(--line)]">
				<p className={cx(eyebrowClass, "mb-0")}>Scout translation rationale</p>
				<p className="m-0 text-[0.86rem] leading-relaxed text-[var(--ink-soft)]">
					<span className="font-medium text-[var(--ink)]">
						Scout mechanism:
					</span>{" "}
					{rationale?.scoutMechanism ?? tension ?? "source mechanism"}
				</p>
				<p className="m-0 text-[0.86rem] leading-relaxed text-[var(--ink-soft)]">
					<span className="font-medium text-[var(--ink)]">
						Project translation:
					</span>{" "}
					{rationale?.projectTranslation ??
						"turn the scout read into receipt and permission language"}
				</p>
				<p className="m-0 text-[0.86rem] leading-relaxed text-[var(--ink-soft)]">
					<span className="font-medium text-[var(--ink)]">Proof boundary:</span>{" "}
					{rationale?.proofBoundary ??
						"prove enough for the right counterparty; keep source context local"}
				</p>
			</div>
			<div className="h-px bg-[var(--line)]" />
			<div className="grid gap-2">
				<p className={cx(eyebrowClass, "mb-0")}>
					@vantaprivacy project translation
				</p>
				<p className="m-0 break-words text-[0.95rem] leading-relaxed text-[var(--ink)]">
					{projectText}
				</p>
			</div>
			<div className="flex flex-wrap gap-2">
				{tension ? (
					<span className="rounded-full bg-[var(--panel)] px-2.5 py-1 text-[0.76rem] font-medium text-[var(--ink-soft)] shadow-[inset_0_0_0_1px_var(--line)]">
						Tension: {tension}
					</span>
				) : null}
				<span className="break-words rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-[0.76rem] font-medium text-[var(--accent)]">
					{risk}
				</span>
				{rationale?.artifactNeeded ? (
					<span className="break-words rounded-full bg-[var(--panel)] px-2.5 py-1 text-[0.76rem] font-medium text-[var(--ink-soft)] shadow-[inset_0_0_0_1px_var(--line)]">
						Artifact: {rationale.artifactNeeded}
					</span>
				) : null}
			</div>
		</article>
	);
}

function MoveDecisionBrief({
	artifactNeeded,
	kind,
	voiceTarget,
}: {
	artifactNeeded?: string;
	kind: string;
	voiceTarget: string;
}) {
	const items = [
		["Job", kind === "Personal" ? "Scout taste" : "Publish/reply review"],
		[
			"Voice split",
			kind === "Personal" ? "Personal, sharper" : "Project, calm",
		],
		["Artifact before copy", artifactActionLabel(artifactNeeded, kind)],
		["Proof boundary", proofBoundaryLabel(kind)],
		["Local-only action", "Edit, copy, paste manually"],
	] as const;

	return (
		<section
			aria-label="Decision brief"
			className="grid gap-3 rounded-[16px] bg-[var(--panel-strong)] p-4 shadow-[inset_0_0_0_1px_var(--line)]"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className={cx(eyebrowClass, "mb-0")}>Decision brief</p>
				<span className="rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-[0.76rem] font-medium text-[var(--accent)]">
					Manual review lane
				</span>
			</div>
			<div className="grid gap-2 min-[720px]:grid-cols-5">
				{items.map(([label, value]) => (
					<div
						className="min-w-0 rounded-[12px] bg-[var(--panel)] p-2.5 shadow-[inset_0_0_0_1px_var(--line)]"
						key={label}
					>
						<p className="m-0 text-[0.72rem] font-medium uppercase tracking-[0.1em] text-[var(--ink-soft)]">
							{label}
						</p>
						<p className="m-0 mt-1 break-words text-sm font-medium leading-snug text-[var(--ink)]">
							{value}
						</p>
					</div>
				))}
			</div>
			<p className="m-0 text-[0.88rem] leading-relaxed text-[var(--ink-soft)]">
				<span className="font-medium text-[var(--ink)]">Voice check:</span>{" "}
				{voiceTarget}
			</p>
		</section>
	);
}

function AlgorithmFitPanel({
	fit,
	targets,
}: {
	fit?: ProjectContentWorkflow["postDrafts"][number]["algorithmFit"];
	targets: ProjectContentWorkflow["engagementTargets"];
}) {
	const topTarget = targets[0];
	if (!fit && !topTarget) return null;
	const items = fit
		? [
				["Candidate path", fit.candidatePath],
				["Ranking signal", fit.rankingSignal],
				["Target reader", fit.targetReader],
				["Travel reason", fit.whyItCanTravel],
				["Normal-human read", fit.normalHumanWhy],
			]
		: [];

	return (
		<section
			aria-label="Algorithm fit"
			className="grid gap-3 rounded-[16px] bg-[color:color-mix(in_srgb,var(--accent-soft)_34%,var(--panel-strong))] p-4 shadow-[inset_0_0_0_1px_var(--line)]"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className={cx(eyebrowClass, "mb-0")}>Algorithm fit</p>
				<span className="rounded-full bg-[var(--panel)] px-2.5 py-1 text-[0.76rem] font-medium text-[var(--ink-soft)] shadow-[inset_0_0_0_1px_var(--line)]">
					Candidate + ranking read
				</span>
			</div>
			{items.length ? (
				<div className="grid gap-2 min-[720px]:grid-cols-2">
					{items.map(([label, value]) => (
						<div
							className="min-w-0 rounded-[12px] bg-[var(--panel)] p-2.5 shadow-[inset_0_0_0_1px_var(--line)]"
							key={label}
						>
							<p className="m-0 text-[0.72rem] font-medium uppercase tracking-[0.1em] text-[var(--ink-soft)]">
								{label}
							</p>
							<p className="m-0 mt-1 break-words text-sm font-medium leading-snug text-[var(--ink)]">
								{value}
							</p>
						</div>
					))}
				</div>
			) : null}
			{topTarget ? (
				<p className="m-0 text-[0.88rem] leading-relaxed text-[var(--ink-soft)]">
					<span className="font-medium text-[var(--ink)]">
						Actual engaged target:
					</span>{" "}
					@{topTarget.handle} ({topTarget.niche}) - {topTarget.reason}
				</p>
			) : (
				<p className="m-0 text-[0.88rem] leading-relaxed text-[var(--ink-soft)]">
					No warm engaged target is visible in this local slice yet; treat the
					algorithm read as directional until the archive gets fresher.
				</p>
			)}
			{fit?.source ? (
				<p className="m-0 text-[0.8rem] leading-relaxed text-[var(--ink-soft)]">
					{fit.source}
				</p>
			) : null}
		</section>
	);
}

function EngagementTargetsPanel({
	targets,
}: {
	targets: ProjectContentWorkflow["engagementTargets"];
}) {
	const visibleTargets = targets.slice(0, 4);
	return (
		<section
			aria-label="Actual engaged people"
			className="grid gap-3 rounded-[16px] bg-[color:color-mix(in_srgb,var(--accent-soft)_34%,var(--panel-strong))] p-4 shadow-[inset_0_0_0_1px_var(--line)]"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div>
					<p className={cx(eyebrowClass, "mb-1")}>Actual engaged people</p>
					<h4 className="m-0 text-sm font-semibold text-[var(--ink)]">
						Who the next post should be useful to
					</h4>
				</div>
				<span className="rounded-full bg-[var(--panel)] px-2.5 py-1 text-[0.76rem] font-medium tabular-nums text-[var(--ink-soft)] shadow-[inset_0_0_0_1px_var(--line)]">
					{targets.length} local targets
				</span>
			</div>
			{visibleTargets.length ? (
				<div className="grid gap-2 min-[860px]:grid-cols-2">
					{visibleTargets.map((target) => (
						<article
							className="grid min-w-0 gap-2 rounded-[12px] bg-[var(--panel)] p-3 shadow-[inset_0_0_0_1px_var(--line)]"
							key={target.handle}
						>
							<div className="flex flex-wrap items-start justify-between gap-2">
								<div>
									<p className="m-0 text-sm font-medium text-[var(--ink)]">
										@{target.handle}
									</p>
									<p className="m-0 text-[0.82rem] text-[var(--ink-soft)]">
										{target.displayName}
									</p>
								</div>
								<span className="rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-[0.76rem] font-medium tabular-nums text-[var(--accent)]">
									{target.score}
								</span>
							</div>
							<p className="m-0 text-[0.88rem] leading-relaxed text-[var(--ink)]">
								{target.niche}
							</p>
							<p className="m-0 break-words text-[0.82rem] leading-relaxed text-[var(--ink-soft)]">
								{target.evidence}
							</p>
							<p className="m-0 break-words text-[0.82rem] leading-relaxed text-[var(--ink-soft)]">
								{target.nextAction}
							</p>
						</article>
					))}
				</div>
			) : (
				<p className="m-0 text-sm leading-relaxed text-[var(--ink-soft)]">
					No warm engaged targets in this local slice yet. Sync newer mentions,
					likes, bookmarks, and home-timeline data before treating this as
					audience truth.
				</p>
			)}
		</section>
	);
}

function TrainingPanel({
	training,
}: {
	training?: ProjectContentWorkflow["training"];
}) {
	const accounts = training?.accounts ?? [];
	return (
		<section
			className={cx(surfaceCardClass, "grid gap-5 p-5 scroll-mt-4")}
			id="training"
		>
			<div className="flex items-start justify-between gap-4 max-[760px]:flex-col">
				<div>
					<h3 className="m-0 font-display text-[1.55rem]">
						What good tweets are
					</h3>
					<p className={cx(eyebrowClass, "mt-1")}>
						Training loop for personal and project accounts
					</p>
				</div>
				<p className="m-0 max-w-[50ch] text-sm leading-relaxed text-[var(--ink-soft)]">
					This trains judgment, not autoposting. Birdclaw maps public X
					recommendation mechanics into local account-specific rules, then keeps
					every public action manual.
				</p>
			</div>
			<div className="grid gap-3 min-[900px]:grid-cols-[1fr_1.1fr]">
				<div className="grid content-start gap-3 rounded-[16px] bg-[color:color-mix(in_srgb,var(--accent-soft)_32%,var(--panel-strong))] p-4 shadow-[inset_0_0_0_1px_var(--line)]">
					<div>
						<p className={cx(eyebrowClass, "mb-1")}>Source model</p>
						<p className="m-0 text-sm leading-relaxed text-[var(--ink)]">
							{training?.source ??
								"Training appears after the local content workflow loads."}
						</p>
					</div>
					{training?.algorithmPrinciples?.length ? (
						<div className="grid gap-2">
							<p className="m-0 text-sm font-semibold text-[var(--ink)]">
								Algorithm principles
							</p>
							<ul className="m-0 grid gap-2 pl-5 text-[0.9rem] leading-relaxed text-[var(--ink-soft)]">
								{training.algorithmPrinciples.map((principle) => (
									<li key={principle}>{principle}</li>
								))}
							</ul>
						</div>
					) : null}
					{training?.limits?.length ? (
						<div className="grid gap-2">
							<p className="m-0 text-sm font-semibold text-[var(--ink)]">
								Training limits
							</p>
							<ul className="m-0 grid gap-2 pl-5 text-[0.9rem] leading-relaxed text-[var(--ink-soft)]">
								{training.limits.map((limit) => (
									<li key={limit}>{limit}</li>
								))}
							</ul>
						</div>
					) : null}
				</div>
				<div className="grid gap-3">
					{accounts.length ? (
						accounts.map((account) => (
							<AccountTrainingCard account={account} key={account.handle} />
						))
					) : (
						<EmptyPanel text="Training will appear once the content workflow loads both account lanes." />
					)}
				</div>
			</div>
		</section>
	);
}

function AccountTrainingCard({
	account,
}: {
	account: ProjectContentWorkflow["training"]["accounts"][number];
}) {
	const visiblePasses = account.algorithmPasses.slice(0, 6);
	const visibleScorecard = account.scorecard.slice(0, 4);
	const visibleRules = account.goodTweetRules.slice(0, 5);
	const visibleDrills = account.drills.slice(0, 4);
	const visibleAntiPatterns = account.antiPatterns.slice(0, 4);
	const visibleExamples = account.exampleTransformations.slice(0, 2);
	return (
		<article className="grid min-w-0 gap-4 rounded-[16px] bg-[var(--panel-strong)] p-4 shadow-[inset_0_0_0_1px_var(--line)]">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<p className={cx(eyebrowClass, "mb-1")}>{account.handle}</p>
					<h4 className="m-0 font-display text-[1.35rem] leading-tight">
						{account.title}
					</h4>
					<p className="m-0 mt-2 text-sm leading-relaxed text-[var(--ink-soft)]">
						{account.northStar}
					</p>
				</div>
				<span className="rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-[0.76rem] font-medium text-[var(--accent)]">
					{account.accountRole.replace(/_/g, " ")}
				</span>
			</div>
			<div className="rounded-[14px] bg-[var(--panel)] p-3 shadow-[inset_0_0_0_1px_var(--line)]">
				<p className={cx(eyebrowClass, "mb-1")}>Good tweet definition</p>
				<p className="m-0 text-[0.95rem] leading-relaxed text-[var(--ink)]">
					{account.goodTweetDefinition}
				</p>
			</div>
			<div className="grid gap-3 min-[980px]:grid-cols-2">
				<div className="grid gap-2">
					<p className="m-0 text-sm font-semibold text-[var(--ink)]">
						Algorithm passes
					</p>
					<div className="grid gap-2">
						{visiblePasses.map((pass) => (
							<TrainingPassCard pass={pass} key={pass.id} />
						))}
					</div>
				</div>
				<div className="grid content-start gap-3">
					<div className="grid gap-2">
						<p className="m-0 text-sm font-semibold text-[var(--ink)]">
							Scorecard
						</p>
						<div className="grid gap-2">
							{visibleScorecard.map((item) => (
								<div
									className="grid gap-1 rounded-[12px] bg-[var(--panel)] p-3 shadow-[inset_0_0_0_1px_var(--line)]"
									key={item.label}
								>
									<div className="flex flex-wrap items-center justify-between gap-2">
										<p className="m-0 text-sm font-medium text-[var(--ink)]">
											{item.label}
										</p>
										<span className="rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-[0.76rem] font-medium tabular-nums text-[var(--accent)]">
											{item.score}
										</span>
									</div>
									<p className="m-0 text-[0.84rem] leading-relaxed text-[var(--ink-soft)]">
										{item.target}
									</p>
									<p className="m-0 break-words text-[0.8rem] leading-relaxed text-[var(--ink-soft)]">
										{item.evidence}
									</p>
								</div>
							))}
						</div>
					</div>
					<div className="grid gap-2 rounded-[12px] bg-[var(--panel)] p-3 shadow-[inset_0_0_0_1px_var(--line)]">
						<p className="m-0 text-sm font-semibold text-[var(--ink)]">
							Training drills
						</p>
						<ul className="m-0 grid gap-2 pl-5 text-[0.86rem] leading-relaxed text-[var(--ink-soft)]">
							{visibleDrills.map((drill) => (
								<li key={drill}>{drill}</li>
							))}
						</ul>
					</div>
					<div className="grid gap-2 rounded-[12px] bg-[var(--panel)] p-3 shadow-[inset_0_0_0_1px_var(--line)]">
						<p className="m-0 text-sm font-semibold text-[var(--ink)]">
							Anti-patterns
						</p>
						<ul className="m-0 grid gap-2 pl-5 text-[0.86rem] leading-relaxed text-[var(--ink-soft)]">
							{visibleAntiPatterns.map((pattern) => (
								<li key={pattern}>{pattern}</li>
							))}
						</ul>
					</div>
				</div>
			</div>
			<DetailsPanel defaultOpen summary="Rules and rewrites">
				<div className="grid gap-3 min-[860px]:grid-cols-2">
					<div>
						<p className="m-0 text-sm font-semibold text-[var(--ink)]">
							Good-tweet rules
						</p>
						<ul className="m-0 mt-2 grid gap-2 pl-5 text-[0.86rem] leading-relaxed text-[var(--ink-soft)]">
							{visibleRules.map((rule) => (
								<li key={rule}>{rule}</li>
							))}
						</ul>
					</div>
					<div className="grid gap-2">
						<p className="m-0 text-sm font-semibold text-[var(--ink)]">
							Example rewrites
						</p>
						{visibleExamples.map((example) => (
							<div
								className="grid gap-1 rounded-[12px] bg-[var(--panel)] p-3 shadow-[inset_0_0_0_1px_var(--line)]"
								key={`${example.before}-${example.after}`}
							>
								<p className="m-0 text-[0.82rem] leading-relaxed text-[var(--ink-soft)]">
									<span className="font-medium text-[var(--ink)]">Before:</span>{" "}
									{example.before}
								</p>
								<p className="m-0 text-[0.82rem] leading-relaxed text-[var(--ink-soft)]">
									<span className="font-medium text-[var(--ink)]">After:</span>{" "}
									{example.after}
								</p>
								<p className="m-0 text-[0.8rem] leading-relaxed text-[var(--ink-soft)]">
									{example.why}
								</p>
							</div>
						))}
					</div>
				</div>
			</DetailsPanel>
		</article>
	);
}

function TrainingPassCard({
	pass,
}: {
	pass: ProjectContentWorkflow["training"]["accounts"][number]["algorithmPasses"][number];
}) {
	return (
		<div className="grid gap-2 rounded-[12px] bg-[var(--panel)] p-3 shadow-[inset_0_0_0_1px_var(--line)]">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div>
					<p className="m-0 text-sm font-medium text-[var(--ink)]">
						{pass.label}
					</p>
					<p className="m-0 mt-1 text-[0.78rem] uppercase tracking-[0.1em] text-[var(--ink-soft)]">
						{pass.status.replace(/_/g, " ")}
					</p>
				</div>
				<span className="rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-[0.76rem] font-medium tabular-nums text-[var(--accent)]">
					{pass.score}
				</span>
			</div>
			<InfoBlock label="Mechanic" text={pass.algorithmMechanic} />
			<InfoBlock label="Account rule" text={pass.accountRule} />
			<InfoBlock label="Evidence" text={pass.evidence} />
			<InfoBlock label="Drill" text={pass.drill} />
		</div>
	);
}

function ArtifactWorkbench({
	gate,
	move,
	voicePair,
}: {
	gate: ReturnType<typeof copyGateForText>;
	move: {
		artifactNeeded?: string;
		kind: string;
		title: string;
	};
	voicePair?: {
		artifactNeeded: string;
		projectTranslation: string;
		proofBoundary: string;
		scoutMechanism: string;
	};
}) {
	const artifact =
		move.artifactNeeded && move.artifactNeeded !== "none"
			? move.artifactNeeded
			: move.kind === "Reply"
				? "source context"
				: "Not required";
	const handoff = voicePair
		? `Scout read -> proof-safe project artifact: ${voicePair.scoutMechanism} -> ${voicePair.projectTranslation}`
		: "Scout read -> proof-safe project artifact";
	const items = [
		["Required artifact", artifact],
		["Copy gate", gate.label === "ready" ? "Ready" : gate.label],
		["Distribution handoff", handoff],
	] as const;

	return (
		<section
			aria-label="Artifact Workbench"
			className="grid gap-3 rounded-[16px] bg-[color:color-mix(in_srgb,var(--accent-soft)_42%,var(--panel-strong))] p-4 shadow-[inset_0_0_0_1px_var(--line)]"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className={cx(eyebrowClass, "mb-0")}>Artifact Workbench</p>
				<span className="rounded-full bg-[var(--panel)] px-2.5 py-1 text-[0.76rem] font-medium text-[var(--ink-soft)] shadow-[inset_0_0_0_1px_var(--line)]">
					{move.kind}: {move.title}
				</span>
			</div>
			<div className="grid gap-2 min-[760px]:grid-cols-3">
				{items.map(([label, value]) => (
					<div
						className="min-w-0 rounded-[12px] bg-[var(--panel)] p-2.5 shadow-[inset_0_0_0_1px_var(--line)]"
						key={label}
					>
						<p className="m-0 text-[0.72rem] font-medium uppercase tracking-[0.1em] text-[var(--ink-soft)]">
							{label}
						</p>
						<p className="m-0 mt-1 break-words text-sm font-medium leading-snug text-[var(--ink)]">
							{value}
						</p>
					</div>
				))}
			</div>
			<p className="m-0 text-[0.88rem] leading-relaxed text-[var(--ink-soft)]">
				Workbench status is local-only: gather evidence, inspect the boundary,
				then copy manually if the gate allows it.
			</p>
		</section>
	);
}

function ProofBoundaryMatrix({
	boundary,
}: {
	boundary: {
		betaLimit: string;
		canProve: string;
		missingArtifact: string;
		staysPrivate: string;
	};
}) {
	const items = [
		["Public claim", "Can prove"],
		["Counterparty can verify", boundary.canProve],
		["Stays local", boundary.staysPrivate],
		["Missing artifact", boundary.missingArtifact],
		["Beta limit", boundary.betaLimit],
	] as const;

	return (
		<section
			aria-label="Check before copy"
			className="grid gap-3 rounded-[16px] bg-[var(--panel-strong)] p-4 shadow-[inset_0_0_0_1px_var(--line)]"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className={cx(eyebrowClass, "mb-0")}>Proof Boundary Matrix</p>
				<span className="text-[0.78rem] font-medium text-[var(--ink-soft)]">
					Check before copy
				</span>
			</div>
			<div className="grid gap-2 min-[760px]:grid-cols-5">
				{items.map(([label, value]) => (
					<div
						className="min-w-0 rounded-[12px] bg-[var(--panel)] p-2.5 shadow-[inset_0_0_0_1px_var(--line)]"
						key={label}
					>
						<p className="m-0 text-[0.72rem] font-medium uppercase tracking-[0.1em] text-[var(--ink-soft)]">
							{label}
						</p>
						<p className="m-0 mt-1 break-words text-sm font-medium leading-snug text-[var(--ink)]">
							{value}
						</p>
					</div>
				))}
			</div>
		</section>
	);
}

function ArtifactQueuePanel({ items }: { items: ArtifactQueueItem[] }) {
	const visibleItems = items.slice(0, 4);
	return (
		<section
			aria-label="Artifact queue"
			className="grid gap-3 rounded-[16px] bg-[color:color-mix(in_srgb,var(--accent-soft)_36%,var(--panel-strong))] p-4 shadow-[inset_0_0_0_1px_var(--line)]"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div>
					<p className={cx(eyebrowClass, "mb-1")}>Artifact queue</p>
					<h4 className="m-0 text-sm font-semibold text-[var(--ink)]">
						Proof artifacts needed before copy
					</h4>
				</div>
				<span className="rounded-full bg-[var(--panel)] px-2.5 py-1 text-[0.76rem] font-medium tabular-nums text-[var(--ink-soft)] shadow-[inset_0_0_0_1px_var(--line)]">
					{items.length} local checks
				</span>
			</div>
			{visibleItems.length ? (
				<div className="grid gap-2">
					{visibleItems.map((item) => (
						<article
							className="grid gap-2 rounded-[12px] bg-[var(--panel)] p-3 shadow-[inset_0_0_0_1px_var(--line)]"
							key={`${item.kind}-${item.id}`}
						>
							<div className="flex flex-wrap items-start justify-between gap-2">
								<p className="m-0 text-sm font-medium text-[var(--ink)]">
									{item.kind}: {item.title}
								</p>
								<span className="rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-[0.76rem] font-medium text-[var(--accent)]">
									Copy gate: {item.copyGateLabel}
								</span>
							</div>
							<p className="m-0 break-words text-[0.88rem] leading-relaxed text-[var(--ink-soft)]">
								{item.artifactNeeded}
							</p>
							<p className="m-0 break-words text-[0.82rem] leading-relaxed text-[var(--ink-soft)]">
								{item.proofBoundary.canProve}
							</p>
						</article>
					))}
				</div>
			) : (
				<p className="m-0 text-sm leading-relaxed text-[var(--ink-soft)]">
					No artifact-blocked items match these filters.
				</p>
			)}
		</section>
	);
}

function PriorityBadge({
	priority,
	score,
	topPickEligible = true,
}: {
	priority: string;
	score: number;
	topPickEligible?: boolean;
}) {
	const priorityLabel =
		score >= 25 && topPickEligible
			? "Top pick"
			: score >= 25
				? "Needs artifact"
				: priority === "high"
					? "Strong signal"
					: priority === "medium"
						? "Useful backup"
						: "Fallback";
	const ariaLabel =
		priorityLabel === "Top pick"
			? `Top pick, local score ${score} out of 100`
			: priorityLabel === "Needs artifact"
				? `Needs artifact before top pick, local score ${score} out of 100`
				: priority === "medium"
					? `Useful backup, local score ${score} out of 100`
					: priority === "high"
						? `Strong signal, local score ${score} out of 100`
						: `Fallback, local score ${score} out of 100`;
	return (
		<span
			aria-label={ariaLabel}
			className="shrink-0 rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-[0.76rem] font-medium text-[var(--accent)]"
			title={ariaLabel}
		>
			{priorityLabel}
		</span>
	);
}

function isTopPickEligible({
	artifactNeeded,
	kind,
	reviewChecklist,
}: {
	artifactNeeded?: string;
	kind: string;
	reviewChecklist?: { label: string; passed: boolean }[];
}) {
	if (kind !== "Project") return true;
	const hasConcreteArtifact = Boolean(
		artifactNeeded && artifactNeeded !== "none",
	);
	const passedClaimCheck = Boolean(
		reviewChecklist?.some(
			(item) => /unsafe|claim/i.test(item.label) && item.passed,
		),
	);
	return hasConcreteArtifact && passedClaimCheck;
}

function InfoBlock({ label, text }: { label: string; text: string }) {
	return (
		<p className="m-0 text-[0.88rem] leading-relaxed text-[var(--ink-soft)]">
			<span className="font-medium text-[var(--ink)]">{label}:</span> {text}
		</p>
	);
}

function PublishReadinessStrip({
	artifactNeeded,
	compact,
	kind,
}: {
	artifactNeeded?: string;
	compact?: boolean;
	kind: string;
}) {
	const artifactStatus =
		artifactNeeded && artifactNeeded !== "none"
			? artifactNeeded
			: kind === "Reply"
				? "source context"
				: "no artifact required";
	const items = [
		["Manual-only boundary", "Copy action only"],
		["Artifact check", artifactStatus],
		["Claim check", "Human review required"],
		["Source bounds", "Local signals; X text untrusted"],
	] as const;
	const compactItems = [
		["Manual", "Clipboard only"],
		[
			"Artifact",
			artifactStatus === "no artifact required"
				? "Not required"
				: `Needs ${artifactStatus}`,
		],
	] as const;

	return (
		<section
			aria-label="Publish readiness"
			className={cx(
				"grid gap-2 rounded-[16px] bg-[color:color-mix(in_srgb,var(--accent-soft)_58%,var(--panel-strong))] p-3 shadow-[inset_0_0_0_1px_var(--line)]",
				compact && "rounded-[14px] p-2.5",
			)}
		>
			{compact ? null : (
				<div className="flex flex-wrap items-center justify-between gap-2">
					<p className={cx(eyebrowClass, "mb-0")}>Publish readiness</p>
					<span className="rounded-full bg-[var(--panel)] px-2.5 py-1 text-[0.76rem] font-medium text-[var(--accent)] shadow-[inset_0_0_0_1px_var(--line)]">
						Manual review gate
					</span>
				</div>
			)}
			<div
				className={cx(
					"grid gap-2",
					compact ? "min-[560px]:grid-cols-2" : "min-[760px]:grid-cols-4",
				)}
			>
				{(compact ? compactItems : items).map(([label, value]) => (
					<div
						className="min-w-0 rounded-[12px] bg-[var(--panel)] p-2.5 shadow-[inset_0_0_0_1px_var(--line)]"
						key={label}
					>
						<p className="m-0 text-[0.72rem] font-medium uppercase tracking-[0.1em] text-[var(--ink-soft)]">
							{label}
						</p>
						<p className="m-0 mt-1 break-words text-sm font-medium leading-snug text-[var(--ink)]">
							{value}
						</p>
					</div>
				))}
			</div>
		</section>
	);
}

function DraftMeta({
	artifactNeeded,
	engagementGoal,
	engagementPattern,
	tension,
}: {
	artifactNeeded?: string;
	engagementGoal?: string;
	engagementPattern?: string;
	tension?: string;
}) {
	const chips = [
		["Engagement", engagementGoal],
		["Angle", engagementPattern?.replace(/_/g, " ")],
		["Tension", tension],
		["Needs artifact", artifactNeeded === "none" ? undefined : artifactNeeded],
	].filter((item): item is [string, string] => Boolean(item[1]));

	if (!chips.length) return null;

	return (
		<div className="flex flex-wrap gap-2">
			{chips.map(([label, value]) => (
				<span
					className={cx(
						"break-words rounded-full bg-[var(--panel)] px-2.5 py-1 text-[0.76rem] font-medium text-[var(--ink-soft)] shadow-[inset_0_0_0_1px_var(--line)]",
						label === "Needs artifact" &&
							value !== "none" &&
							"bg-[var(--accent-soft)] text-[var(--accent)]",
					)}
					key={`${label}-${value}`}
				>
					{label}: {value}
				</span>
			))}
		</div>
	);
}

function DetailsPanel({
	children,
	defaultOpen,
	summary,
}: {
	children: ReactNode;
	defaultOpen?: boolean;
	summary: string;
}) {
	return (
		<details
			className="group rounded-[14px] bg-[var(--panel-strong)] p-3 shadow-[inset_0_0_0_1px_var(--line)]"
			open={defaultOpen}
		>
			<summary className="min-h-10 cursor-pointer list-none rounded-[10px] text-sm font-medium text-[var(--ink)] outline-none transition-[color,transform] duration-180 marker:hidden focus-visible:shadow-[0_0_0_3px_var(--accent-soft)] active:scale-[0.96] [&::-webkit-details-marker]:hidden">
				<span className="inline-flex w-full items-center justify-between gap-3">
					<span>{summary}</span>
					<span
						aria-hidden="true"
						className="text-[1.05rem] leading-none text-[var(--ink-soft)] transition-transform duration-180 group-open:rotate-45"
					>
						+
					</span>
				</span>
			</summary>
			<div className="grid gap-3 pt-3">{children}</div>
		</details>
	);
}

function ReviewChecklist({
	items,
}: {
	items: { label: string; passed: boolean }[];
}) {
	return (
		<div className="flex flex-wrap gap-2">
			{items.map((item) => (
				<span
					className={cx(
						"rounded-full px-2.5 py-1 text-[0.76rem] font-medium",
						item.passed
							? "bg-[var(--accent-soft)] text-[var(--accent)]"
							: "bg-[var(--alert-soft)] text-[var(--alert)]",
					)}
					key={item.label}
				>
					{item.passed ? "Pass" : "Check"}: {item.label}
				</span>
			))}
		</div>
	);
}

function QuickReviewChips({
	artifactNeeded,
	evidenceCount,
	reviewChecklist,
}: {
	artifactNeeded?: string;
	evidenceCount: number;
	reviewChecklist: { label: string; passed: boolean }[];
}) {
	const requiresArtifact = Boolean(artifactNeeded && artifactNeeded !== "none");
	const needsClaimReview = reviewChecklist.some(
		(item) => !item.passed || /claim|review/i.test(item.label),
	);
	const items = [
		["Manual only", "Copy gate"],
		["Artifact", requiresArtifact ? artifactNeeded : "Not required"],
		["Evidence", `${evidenceCount} source${evidenceCount === 1 ? "" : "s"}`],
		["Claim check", needsClaimReview ? "Review" : "Passed"],
	].filter((item): item is [string, string] => Boolean(item[1]));

	return (
		<div className="flex flex-wrap gap-2" aria-label="Quick review status">
			{items.map(([label, value]) => (
				<span
					className={cx(
						"break-words rounded-full bg-[var(--panel)] px-2.5 py-1 text-[0.76rem] font-medium text-[var(--ink-soft)] shadow-[inset_0_0_0_1px_var(--line)]",
						(label === "Artifact" && requiresArtifact) ||
							(label === "Claim check" && needsClaimReview)
							? "bg-[var(--accent-soft)] text-[var(--accent)]"
							: undefined,
					)}
					key={`${label}-${value}`}
				>
					{label}: {value}
				</span>
			))}
		</div>
	);
}

function DraftDetailGroup({
	artifactNeeded,
	defaultOpen,
	engagementGoal,
	engagementPattern,
	evidence,
	nextAction,
	replyEdge,
	reviewChecklist,
	summary = "Risk & evidence",
	tension,
	why,
}: {
	artifactNeeded?: string;
	defaultOpen?: boolean;
	engagementGoal?: string;
	engagementPattern?: string;
	evidence: string[];
	nextAction: string;
	replyEdge: string;
	reviewChecklist: { label: string; passed: boolean }[];
	summary?: string;
	tension?: string;
	why: string;
}) {
	return (
		<div className="grid gap-2">
			<QuickReviewChips
				artifactNeeded={artifactNeeded}
				evidenceCount={evidence.length}
				reviewChecklist={reviewChecklist}
			/>
			<DetailsPanel defaultOpen={defaultOpen} summary={summary}>
				<DraftMeta
					artifactNeeded={artifactNeeded}
					engagementGoal={engagementGoal}
					engagementPattern={engagementPattern}
					tension={tension}
				/>
				<InfoBlock label="Next" text={nextAction} />
				<InfoBlock label="Why this should work" text={why} />
				<InfoBlock label="Reply edge" text={replyEdge} />
				<EvidenceList defaultOpen={defaultOpen} items={evidence} />
				<ReviewChecklist items={reviewChecklist} />
			</DetailsPanel>
		</div>
	);
}

function EvidenceList({
	defaultOpen,
	items,
}: {
	defaultOpen?: boolean;
	items: string[];
}) {
	return (
		<details className="grid gap-1.5" open={defaultOpen}>
			<summary className={cx(timestampClass, "m-0 min-h-8 cursor-pointer")}>
				Evidence ({items.length})
			</summary>
			<div className="grid gap-1.5 pt-1">
				{items.map((item) => (
					<p
						className="m-0 break-words rounded-[12px] bg-[var(--panel)] px-3 py-2 text-[0.82rem] leading-relaxed text-[var(--ink-soft)] shadow-[inset_0_0_0_1px_var(--line)]"
						key={item}
					>
						{item}
					</p>
				))}
			</div>
		</details>
	);
}
