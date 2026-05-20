import { Effect } from "effect";
import { getNativeDb } from "./db";
import { runEffectPromise } from "./effect-runtime";
import { scoreInboxItemWithOpenAIEffect } from "./openai";
import { listDmConversations, listTimelineItems } from "./queries";
import type { InboxItem, InboxQuery, InboxResponse } from "./types";

function heuristicSummary(kind: InboxItem["entityKind"]) {
	return kind === "dm"
		? "Ranked from reply pressure, influence, and recency."
		: "Ranked from mention urgency, influence, and specificity.";
}

function getHeuristicScoreForMention(
	item: ReturnType<typeof listTimelineItems>[number],
) {
	const influence = Math.min(
		32,
		Math.round(Math.log10(item.author.followersCount + 10) * 18),
	);
	const specificityBoost = item.text.includes("?") ? 8 : 0;
	return Math.max(0, Math.min(100, 44 + influence + specificityBoost));
}

function getHeuristicScoreForDm(
	item: ReturnType<typeof listDmConversations>[number],
) {
	const unreadBoost = Math.min(15, item.unreadCount * 5);
	const replyBoost = item.needsReply ? 12 : 0;
	return Math.max(
		0,
		Math.min(
			100,
			34 + Math.round(item.influenceScore * 0.32) + unreadBoost + replyBoost,
		),
	);
}

function readStoredScores() {
	const db = getNativeDb();
	const rows = db
		.prepare(
			`
      select entity_kind, entity_id, model, score, summary, reasoning, updated_at
      from ai_scores
      `,
		)
		.all() as Array<Record<string, unknown>>;

	return new Map(
		rows.map((row) => [
			`${row.entity_kind}:${row.entity_id}`,
			{
				model: String(row.model),
				score: Number(row.score),
				summary: String(row.summary),
				reasoning: String(row.reasoning),
				updatedAt: String(row.updated_at),
			},
		]),
	);
}

export function listInboxItems({
	kind = "mixed",
	account,
	minScore = 0,
	hideLowSignal = false,
	limit = 20,
}: InboxQuery = {}): InboxResponse {
	const storedScores = readStoredScores();
	const items: InboxItem[] = [];

	if (kind === "mixed" || kind === "mentions") {
		for (const mention of listTimelineItems({
			resource: "mentions",
			account,
			replyFilter: "unreplied",
			limit: 50,
		})) {
			const scoreKey = `mention:${mention.id}`;
			const stored = storedScores.get(scoreKey);
			items.push({
				id: scoreKey,
				entityId: mention.id,
				entityKind: "mention",
				accountId: mention.accountId,
				accountHandle: mention.accountHandle,
				title: `Mention from ${mention.author.displayName}`,
				text: mention.text,
				createdAt: mention.createdAt,
				needsReply: !mention.isReplied,
				influenceScore: Math.round(
					Math.log10(mention.author.followersCount + 10) * 24,
				),
				participant: mention.author,
				source: stored ? "openai" : "heuristic",
				score: stored?.score ?? getHeuristicScoreForMention(mention),
				summary: stored?.summary ?? heuristicSummary("mention"),
				reasoning:
					stored?.reasoning ??
					`@${mention.author.handle} · ${mention.author.followersCount} followers`,
			});
		}
	}

	if (kind === "mixed" || kind === "dms") {
		for (const dm of listDmConversations({
			account,
			replyFilter: "unreplied",
			sort: "followers",
			limit: 50,
		})) {
			const scoreKey = `dm:${dm.id}`;
			const stored = storedScores.get(scoreKey);
			items.push({
				id: scoreKey,
				entityId: dm.id,
				entityKind: "dm",
				accountId: dm.accountId,
				accountHandle: dm.accountHandle,
				title: `DM from ${dm.participant.displayName}`,
				text: dm.lastMessagePreview,
				createdAt: dm.lastMessageAt,
				needsReply: dm.needsReply,
				influenceScore: dm.influenceScore,
				participant: dm.participant,
				source: stored ? "openai" : "heuristic",
				score: stored?.score ?? getHeuristicScoreForDm(dm),
				summary: stored?.summary ?? heuristicSummary("dm"),
				reasoning:
					stored?.reasoning ??
					`@${dm.participant.handle} · ${dm.participant.followersCount} followers`,
			});
		}
	}

	const lowSignalFloor = hideLowSignal ? Math.max(40, minScore) : minScore;
	const filtered = items
		.filter((item) => item.score >= lowSignalFloor)
		.sort((left, right) => {
			if (right.score !== left.score) return right.score - left.score;
			return (
				new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
			);
		})
		.slice(0, limit);

	return {
		items: filtered,
		stats: {
			total: filtered.length,
			openai: filtered.filter((item) => item.source === "openai").length,
			heuristic: filtered.filter((item) => item.source === "heuristic").length,
		},
	};
}

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function trySync<T>(try_: () => T) {
	return Effect.try({
		try: try_,
		catch: toError,
	});
}

export function scoreInboxEffect({
	kind = "mixed",
	account,
	limit = 8,
}: Pick<InboxQuery, "kind" | "account" | "limit"> = {}) {
	return Effect.gen(function* () {
		const db = yield* trySync(() => getNativeDb());
		const items = yield* trySync(
			() => listInboxItems({ kind, account, limit }).items,
		);
		const results = [];

		for (const item of items) {
			const scored = yield* scoreInboxItemWithOpenAIEffect({
				entityKind: item.entityKind,
				title: item.title,
				text: item.text,
				influenceScore: item.influenceScore,
				participant: {
					handle: item.participant.handle,
					displayName: item.participant.displayName,
					bio: item.participant.bio,
					followersCount: item.participant.followersCount,
				},
			});

			yield* trySync(() =>
				db
					.prepare(
						`
      insert into ai_scores (
        entity_kind, entity_id, model, score, summary, reasoning, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?)
      on conflict(entity_kind, entity_id) do update set
        model = excluded.model,
        score = excluded.score,
        summary = excluded.summary,
        reasoning = excluded.reasoning,
        updated_at = excluded.updated_at
      `,
					)
					.run(
						item.entityKind,
						item.entityId,
						scored.model,
						scored.score,
						scored.summary,
						scored.reasoning,
						new Date().toISOString(),
					),
			);

			results.push({
				id: item.id,
				score: scored.score,
				source: "openai",
			});
		}

		return {
			ok: true,
			scored: results.length,
			items: results,
		};
	});
}

export function scoreInbox(
	options: Pick<InboxQuery, "kind" | "account" | "limit"> = {},
) {
	return runEffectPromise(scoreInboxEffect(options));
}
