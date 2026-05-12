// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const getAnalyticsSummaryMock = vi.fn();
const buildProjectContentWorkflowMock = vi.fn();
const maybeAutoUpdateBackupMock = vi.fn();

vi.mock("#/lib/analytics", () => ({
	getAnalyticsSummary: () => getAnalyticsSummaryMock(),
}));

vi.mock("#/lib/content-workflow", () => ({
	buildProjectContentWorkflow: (...args: unknown[]) =>
		buildProjectContentWorkflowMock(...args),
	VANTA_FORBIDDEN_CONTENT_CLAIMS: [
		"production-ready",
		"anonymous",
		"untraceable",
	],
}));

vi.mock("#/lib/backup", () => ({
	maybeAutoUpdateBackup: () => maybeAutoUpdateBackupMock(),
}));

import { Route } from "./content-workflow";

const GET = getRouteHandler(Route, "GET");

describe("content workflow api route", () => {
	const tempDirs: string[] = [];

	function validProjectDraft(id = "vanta-draft-from-engine") {
		return {
			approvedToPost: false,
			artifactNeeded: "receipt field map",
			id,
			proofBoundary: {
				betaLimit: "manual review before public use",
				canProve: "receipt fields can be checked",
				missingArtifact: "receipt field map",
				staysPrivate: "private workflow context stays local",
			},
			reviewChecklist: [{ label: "Manual posting only", passed: true }],
			sourceEvidence: ["local Vanta content engine export"],
			text: "receipts should explain enough for the counterparty",
		};
	}

	function validPersonalDraft(id = "personal-draft-from-engine") {
		return {
			...validProjectDraft(id),
			artifactNeeded: "none",
			text: "payment is becoming access control",
		};
	}

	function writeExport(name: string, overrides: Record<string, unknown> = {}) {
		const tempDir = mkdtempSync(path.join(tmpdir(), "birdclaw-content-"));
		tempDirs.push(tempDir);
		const exportPath = path.join(tempDir, name);
		writeFileSync(
			exportPath,
			JSON.stringify({
				schemaVersion: "vanta-content-engine.v1",
				manualPostingOnly: true,
				dashboardBridge: { status: "export_ready_manual_integration" },
				personalPostDrafts: [validPersonalDraft()],
				postDrafts: [validProjectDraft()],
				voiceBridgePairs: [
					{
						personalDraftId: "personal-draft-from-engine",
						projectDraftId: "vanta-draft-from-engine",
					},
				],
				...overrides,
			}),
		);
		return exportPath;
	}

	beforeEach(() => {
		getAnalyticsSummaryMock.mockReset();
		buildProjectContentWorkflowMock.mockReset();
		maybeAutoUpdateBackupMock.mockReset();
		maybeAutoUpdateBackupMock.mockResolvedValue({ skipped: true });
		delete process.env.VANTA_CONTENT_ENGINE_EXPORT;
		delete process.env.BIRDCLAW_CONTENT_ENGINE_EXPORT;
	});

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			rmSync(tempDir, { force: true, recursive: true });
		}
	});

	it("returns a local manual-only project content workflow", async () => {
		const analytics = { accounts: [{ handle: "@vantaprivacy" }] };
		const workflow = {
			manualPostingOnly: true,
			postDrafts: [{ text: "private settlement needs receipts" }],
		};
		getAnalyticsSummaryMock.mockReturnValue(analytics);
		buildProjectContentWorkflowMock.mockReturnValue(workflow);

		const response = await GET({
			request: new Request("http://localhost/api/content-workflow"),
		});

		expect(maybeAutoUpdateBackupMock).toHaveBeenCalled();
		expect(buildProjectContentWorkflowMock).toHaveBeenCalledWith(analytics);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(workflow);
	});

	it("merges a local Vanta content engine export when configured", async () => {
		const exportPath = writeExport("content-engine-export.json");
		process.env.VANTA_CONTENT_ENGINE_EXPORT = exportPath;

		const analytics = { accounts: [{ handle: "@vantaprivacy" }] };
		const workflow = {
			manualPostingOnly: true,
			personalPostDrafts: [{ id: "personal-base", text: "base" }],
			postDrafts: [{ id: "project-base", text: "base" }],
			voiceBridgePairs: [
				{
					personalDraftId: "personal-base",
					projectDraftId: "project-base",
				},
			],
		};
		getAnalyticsSummaryMock.mockReturnValue(analytics);
		buildProjectContentWorkflowMock.mockReturnValue(workflow);

		const response = await GET({
			request: new Request("http://localhost/api/content-workflow"),
		});
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.contentEngineBridge).toMatchObject({
			exportPath,
			importedPersonalDrafts: 1,
			importedProjectDrafts: 1,
			schemaVersion: "vanta-content-engine.v1",
			status: "loaded",
		});
		expect(body.postDrafts.map((draft: { id: string }) => draft.id)).toEqual([
			"project-base",
			"vanta-draft-from-engine",
		]);
		expect(
			body.personalPostDrafts.map((draft: { id: string }) => draft.id),
		).toEqual(["personal-base", "personal-draft-from-engine"]);
		expect(body.voiceBridgePairs).toContainEqual({
			personalDraftId: "personal-draft-from-engine",
			projectDraftId: "vanta-draft-from-engine",
		});
	});

	it("filters unsafe local Vanta content engine drafts", async () => {
		const exportPath = writeExport("unsafe-export.json", {
			postDrafts: [
				validProjectDraft("safe-project"),
				{ ...validProjectDraft("approved-project"), approvedToPost: true },
				{
					...validProjectDraft("long-project"),
					text: "x".repeat(281),
				},
				{
					...validProjectDraft("unsafe-project"),
					text: "Vanta is production-ready now.",
				},
				{
					...validProjectDraft("no-proof-project"),
					proofBoundary: {},
				},
				{
					...validProjectDraft("partial-proof-project"),
					proofBoundary: {
						canProve: "receipt fields can be checked",
						staysPrivate: "private workflow context stays local",
					},
				},
			],
			voiceBridgePairs: [
				{
					personalDraftId: "personal-draft-from-engine",
					projectDraftId: "safe-project",
				},
				{
					personalDraftId: "personal-draft-from-engine",
					projectDraftId: "unsafe-project",
				},
			],
		});
		process.env.VANTA_CONTENT_ENGINE_EXPORT = exportPath;
		getAnalyticsSummaryMock.mockReturnValue({ accounts: [] });
		buildProjectContentWorkflowMock.mockReturnValue({
			manualPostingOnly: true,
			personalPostDrafts: [],
			postDrafts: [],
			voiceBridgePairs: [],
		});

		const response = await GET({
			request: new Request("http://localhost/api/content-workflow"),
		});
		const body = await response.json();

		expect(body.postDrafts.map((draft: { id: string }) => draft.id)).toEqual([
			"safe-project",
		]);
		expect(body.contentEngineBridge).toMatchObject({
			importedProjectDrafts: 1,
		});
		expect(body.voiceBridgePairs).toEqual([
			{
				personalDraftId: "personal-draft-from-engine",
				projectDraftId: "safe-project",
			},
		]);
	});

	it("falls back to the next configured export when the first export is malformed", async () => {
		const badPath = writeExport("bad-export.json");
		writeFileSync(badPath, "{ malformed json");
		const fallbackPath = writeExport("fallback-export.json", {
			postDrafts: [validProjectDraft("fallback-project")],
			voiceBridgePairs: [
				{
					personalDraftId: "personal-draft-from-engine",
					projectDraftId: "fallback-project",
				},
			],
		});
		process.env.VANTA_CONTENT_ENGINE_EXPORT = badPath;
		process.env.BIRDCLAW_CONTENT_ENGINE_EXPORT = fallbackPath;
		getAnalyticsSummaryMock.mockReturnValue({ accounts: [] });
		buildProjectContentWorkflowMock.mockReturnValue({
			manualPostingOnly: true,
			personalPostDrafts: [],
			postDrafts: [],
			voiceBridgePairs: [],
		});

		const response = await GET({
			request: new Request("http://localhost/api/content-workflow"),
		});
		const body = await response.json();

		expect(body.contentEngineBridge).toMatchObject({
			exportPath: fallbackPath,
			importedProjectDrafts: 1,
			status: "loaded",
		});
		expect(body.postDrafts.map((draft: { id: string }) => draft.id)).toEqual([
			"fallback-project",
		]);
	});
});
