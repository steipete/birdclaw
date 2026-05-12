import { createFileRoute } from "@tanstack/react-router";
import { existsSync, readFileSync } from "node:fs";
import { getAnalyticsSummary } from "#/lib/analytics";
import { maybeAutoUpdateBackup } from "#/lib/backup";
import {
	buildProjectContentWorkflow,
	VANTA_FORBIDDEN_CONTENT_CLAIMS,
} from "#/lib/content-workflow";

const CONTENT_ENGINE_SCHEMA_VERSION = "vanta-content-engine.v1";
const DEFAULT_VANTA_CONTENT_ENGINE_EXPORT =
	"/Users/clay/Documents/New project 13/content-engine/exports/birdclaw-content-lanes.json";

type DraftWithId = { id?: unknown; text?: unknown };
type OverlayProofBoundary = {
	betaLimit?: unknown;
	canProve?: unknown;
	missingArtifact?: unknown;
	staysPrivate?: unknown;
};
type OverlayDraft = DraftWithId & {
	accountHandle?: unknown;
	approvedToPost?: unknown;
	artifactNeeded?: unknown;
	body?: unknown;
	proofBoundary?: OverlayProofBoundary;
	reviewChecklist?: unknown;
	sourceEvidence?: unknown;
};
type VoiceBridgeWithIds = {
	personalDraftId?: unknown;
	projectDraftId?: unknown;
};
type ContentEngineExport = {
	schemaVersion?: unknown;
	manualPostingOnly?: unknown;
	dashboardBridge?: unknown;
	postDrafts?: unknown;
	personalPostDrafts?: unknown;
	voiceBridgePairs?: unknown;
};
type ProjectContentWorkflow = ReturnType<typeof buildProjectContentWorkflow>;

function json(data: unknown) {
	return new Response(JSON.stringify(data), {
		headers: {
			"content-type": "application/json",
		},
	});
}

function contentEngineExportPaths() {
	return [
		process.env.VANTA_CONTENT_ENGINE_EXPORT,
		process.env.BIRDCLAW_CONTENT_ENGINE_EXPORT,
		process.env.NODE_ENV === "test"
			? undefined
			: DEFAULT_VANTA_CONTENT_ENGINE_EXPORT,
	].filter((value): value is string => Boolean(value));
}

function readContentEngineExport() {
	for (const candidatePath of contentEngineExportPaths()) {
		if (!existsSync(candidatePath)) continue;
		try {
			const parsed = JSON.parse(
				readFileSync(candidatePath, "utf8"),
			) as ContentEngineExport;
			if (
				parsed.schemaVersion === CONTENT_ENGINE_SCHEMA_VERSION &&
				parsed.manualPostingOnly === true
			) {
				return {
					path: candidatePath,
					parsed,
				};
			}
		} catch {
			continue;
		}
	}
	return null;
}

function textHasUnsafeClaim(value: string) {
	const normalized = value.toLowerCase();
	return VANTA_FORBIDDEN_CONTENT_CLAIMS.some((claim) =>
		normalized.includes(claim),
	);
}

function hasCompleteProofBoundary(boundary: OverlayProofBoundary | undefined) {
	return (
		typeof boundary?.canProve === "string" &&
		typeof boundary.staysPrivate === "string" &&
		typeof boundary.missingArtifact === "string" &&
		typeof boundary.betaLimit === "string"
	);
}

function safeOverlayDraft(
	value: unknown,
	accountHandle?: "@williamclay",
): OverlayDraft | null {
	if (!value || typeof value !== "object") return null;
	const draft = value as OverlayDraft;
	const text = typeof draft.text === "string" ? draft.text : null;
	if (typeof draft.id !== "string") return null;
	if (!text || text.length > 280 || textHasUnsafeClaim(text)) return null;
	if (draft.approvedToPost !== false) return null;
	if (typeof draft.artifactNeeded !== "string") return null;
	if (!Array.isArray(draft.sourceEvidence) || draft.sourceEvidence.length === 0)
		return null;
	if (
		!Array.isArray(draft.reviewChecklist) ||
		draft.reviewChecklist.length === 0
	)
		return null;
	if (!hasCompleteProofBoundary(draft.proofBoundary)) return null;

	return {
		...draft,
		...(accountHandle ? { accountHandle } : {}),
		body: typeof draft.body === "string" ? draft.body : text,
	};
}

function safeOverlayDrafts(overlay: unknown, accountHandle?: "@williamclay") {
	if (!Array.isArray(overlay)) return [];
	return overlay.flatMap((draft) => {
		const safeDraft = safeOverlayDraft(draft, accountHandle);
		return safeDraft ? [safeDraft] : [];
	});
}

function mergeById<T extends DraftWithId>(base: T[], overlay: unknown): T[] {
	if (!Array.isArray(overlay)) return base;
	const merged = new Map<string, T>();
	for (const item of base) {
		if (typeof item.id === "string") merged.set(item.id, item);
	}
	for (const item of overlay) {
		if (!item || typeof item !== "object") continue;
		const draft = item as T;
		if (typeof draft.id === "string") merged.set(draft.id, draft);
	}
	return [...merged.values()];
}

function idsFor<T extends DraftWithId>(drafts: T[]) {
	return new Set(
		drafts.flatMap((draft) => (typeof draft.id === "string" ? [draft.id] : [])),
	);
}

function voiceBridgeKey(item: VoiceBridgeWithIds) {
	if (
		typeof item.personalDraftId !== "string" ||
		typeof item.projectDraftId !== "string"
	) {
		return null;
	}
	return `${item.personalDraftId}:${item.projectDraftId}`;
}

function mergeVoiceBridgePairs<T extends VoiceBridgeWithIds>(
	base: T[],
	overlay: unknown,
	allowedPersonalDraftIds?: Set<string>,
	allowedProjectDraftIds?: Set<string>,
): T[] {
	if (!Array.isArray(overlay)) return base;
	const merged = new Map<string, T>();
	for (const item of base) {
		const key = voiceBridgeKey(item);
		if (key) merged.set(key, item);
	}
	for (const item of overlay) {
		if (!item || typeof item !== "object") continue;
		const pair = item as T;
		const key = voiceBridgeKey(pair);
		if (
			allowedPersonalDraftIds &&
			typeof pair.personalDraftId === "string" &&
			!allowedPersonalDraftIds.has(pair.personalDraftId)
		) {
			continue;
		}
		if (
			allowedProjectDraftIds &&
			typeof pair.projectDraftId === "string" &&
			!allowedProjectDraftIds.has(pair.projectDraftId)
		) {
			continue;
		}
		if (key) merged.set(key, pair);
	}
	return [...merged.values()];
}

function withContentEngineExport(workflow: ProjectContentWorkflow) {
	const contentEngineExport = readContentEngineExport();
	if (!contentEngineExport) return workflow;
	const overlay = contentEngineExport.parsed;
	const personalOverlayDrafts = safeOverlayDrafts(
		overlay.personalPostDrafts,
		"@williamclay",
	);
	const projectOverlayDrafts = safeOverlayDrafts(overlay.postDrafts);
	const personalPostDrafts = mergeById(
		workflow.personalPostDrafts,
		personalOverlayDrafts,
	);
	const postDrafts = mergeById(workflow.postDrafts, projectOverlayDrafts);

	return {
		...workflow,
		contentEngineBridge: {
			exportPath: contentEngineExport.path,
			schemaVersion: overlay.schemaVersion,
			status: "loaded",
			dashboardBridge: overlay.dashboardBridge ?? null,
			importedPersonalDrafts: personalOverlayDrafts.length,
			importedProjectDrafts: projectOverlayDrafts.length,
		},
		personalPostDrafts,
		postDrafts,
		voiceBridgePairs: mergeVoiceBridgePairs(
			workflow.voiceBridgePairs,
			overlay.voiceBridgePairs,
			idsFor(personalPostDrafts),
			idsFor(postDrafts),
		),
	};
}

export const Route = createFileRoute("/api/content-workflow")({
	server: {
		handlers: {
			GET: async () => {
				await maybeAutoUpdateBackup();
				return json(
					withContentEngineExport(
						buildProjectContentWorkflow(getAnalyticsSummary()),
					),
				);
			},
		},
	},
});
