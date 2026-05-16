import { Effect } from "effect";
import { runEffectPromise, tryPromise } from "./effect-runtime";

export interface OpenAIInboxScore {
	score: number;
	summary: string;
	reasoning: string;
	model: string;
}

export interface OpenAIInboxInput {
	entityKind: "mention" | "dm";
	title: string;
	text: string;
	participant: {
		handle: string;
		displayName: string;
		bio: string;
		followersCount: number;
	};
	influenceScore: number;
}

function clampScore(value: number) {
	return Math.max(0, Math.min(100, Math.round(value)));
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

export function scoreInboxItemWithOpenAIEffect(
	input: OpenAIInboxInput,
): Effect.Effect<OpenAIInboxScore, Error> {
	return Effect.gen(function* () {
		const apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) {
			return yield* Effect.fail(new Error("OPENAI_API_KEY is not set"));
		}

		const model = process.env.BIRDCLAW_OPENAI_MODEL || "gpt-5.2";
		const response = yield* tryPromise(() =>
			fetch("https://api.openai.com/v1/chat/completions", {
				method: "POST",
				headers: {
					authorization: `Bearer ${apiKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model,
					response_format: { type: "json_object" },
					messages: [
						{
							role: "system",
							content:
								"You rank inbound Twitter mentions and DMs for Peter Steinberger. Return JSON only with keys score, summary, reasoning. Score 0-100. High score means worth replying soon. Prefer specific, actionable, novel, high-signal items. Penalize generic praise, low-context asks, and low-signal chatter. summary max 18 words. reasoning max 28 words.",
						},
						{
							role: "user",
							content: JSON.stringify(input),
						},
					],
				}),
			}),
		).pipe(Effect.mapError(toError));

		if (!response.ok) {
			return yield* Effect.fail(
				new Error(`OpenAI request failed: ${response.status}`),
			);
		}

		const payload = (yield* tryPromise(() => response.json()).pipe(
			Effect.mapError(toError),
		)) as {
			choices?: Array<{
				message?: {
					content?: string;
				};
			}>;
		};

		const content = payload.choices?.[0]?.message?.content;
		if (!content) {
			return yield* Effect.fail(new Error("OpenAI returned no content"));
		}

		const parsed = yield* trySync(
			() =>
				JSON.parse(content) as {
					score?: number;
					summary?: string;
					reasoning?: string;
				},
		);

		return {
			model,
			score: clampScore(parsed.score ?? 0),
			summary: String(parsed.summary ?? "No summary"),
			reasoning: String(parsed.reasoning ?? "No reasoning"),
		};
	});
}

export function scoreInboxItemWithOpenAI(
	input: OpenAIInboxInput,
): Promise<OpenAIInboxScore> {
	return runEffectPromise(scoreInboxItemWithOpenAIEffect(input));
}
