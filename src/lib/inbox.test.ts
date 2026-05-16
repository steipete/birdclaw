// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { listInboxItems, scoreInbox } from "./inbox";

const scoreMock = vi.fn();

vi.mock("./openai", async () => {
	const { Effect } = await import("effect");
	return {
		scoreInboxItemWithOpenAI: (...args: unknown[]) => scoreMock(...args),
		scoreInboxItemWithOpenAIEffect: (...args: unknown[]) =>
			Effect.tryPromise(() => scoreMock(...args)),
	};
});

const tempRoots: string[] = [];

function setupTempHome() {
	const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-inbox-"));
	tempRoots.push(tempRoot);
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
}

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	scoreMock.mockReset();

	for (const tempRoot of tempRoots.splice(0)) {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

describe("inbox", () => {
	it("filters mixed items by score floor", () => {
		setupTempHome();

		const result = listInboxItems({
			kind: "mixed",
			hideLowSignal: true,
			minScore: 75,
		});

		expect(result.items.map((item) => item.entityKind)).toContain("mention");
		expect(result.items[0]?.entityKind).toBe("dm");
		expect(result.stats.heuristic).toBeGreaterThan(1);
	});

	it("prefers stored OpenAI scores when present", () => {
		setupTempHome();
		const db = getNativeDb();
		db.prepare(
			`
      insert into ai_scores (
        entity_kind, entity_id, model, score, summary, reasoning, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?)
      `,
		).run(
			"dm",
			"dm_001",
			"gpt-test",
			12,
			"Low signal",
			"Stored score",
			new Date().toISOString(),
		);

		const result = listInboxItems({ kind: "dms", hideLowSignal: false });

		expect(result.items[0]?.source).toBe("heuristic");
		expect(result.items.at(-1)?.id).toBe("dm:dm_001");
		expect(result.items.at(-1)?.source).toBe("openai");
	});

	it("writes fresh OpenAI scores back to sqlite", async () => {
		setupTempHome();
		scoreMock.mockResolvedValue({
			model: "gpt-test",
			score: 66,
			summary: "Worth it",
			reasoning: "Specific ask",
		});

		const result = await scoreInbox({ kind: "mentions", limit: 1 });
		const row = getNativeDb()
			.prepare(
				"select score, summary, reasoning from ai_scores where entity_kind = 'mention' and entity_id = 'tweet_004'",
			)
			.get() as
			| {
					score: number;
					summary: string;
					reasoning: string;
			  }
			| undefined;

		expect(result.ok).toBe(true);
		expect(result.scored).toBe(1);
		expect(row).toEqual({
			score: 66,
			summary: "Worth it",
			reasoning: "Specific ask",
		});
	});

	it("exposes inbox scoring as a lazy Effect program", async () => {
		setupTempHome();
		scoreMock.mockResolvedValue({
			model: "gpt-test",
			score: 66,
			summary: "Worth it",
			reasoning: "Specific ask",
		});
		const { scoreInboxEffect } = await import("./inbox");

		const effect = scoreInboxEffect({ kind: "mentions", limit: 1 });
		expect(scoreMock).not.toHaveBeenCalled();
		await expect(Effect.runPromise(effect)).resolves.toMatchObject({
			ok: true,
			scored: 1,
		});
	});
});
