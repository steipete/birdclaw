import { Effect } from "effect";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import {
	openAIEndpoint,
	openAIHeaders,
	requireOpenAICredentials,
	resolveOpenAIApiKey,
	resolveOpenAIBaseUrl,
} from "./openai-config";
import {
	completePiCodexText,
	isPiCodexProviderEnabled,
	resolvePiCodexModel,
} from "./pi-codex";

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
		if (isPiCodexProviderEnabled()) {
			const model = resolvePiCodexModel();
			const result = yield* tryPromise(() =>
				completePiCodexText({
					system:
						"You rank inbound Twitter mentions and DMs for Peter Steinberger. Return JSON only with keys score, summary, reasoning. Score 0-100. High score means worth replying soon. Prefer specific, actionable, novel, high-signal items. Penalize generic praise, low-context asks, and low-signal chatter. summary max 18 words. reasoning max 28 words.",
					prompt: JSON.stringify(input),
					model,
				}),
			).pipe(Effect.mapError(toError));
			const parsed = yield* trySync(
				() =>
					JSON.parse(result.text) as {
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
		}
		const apiKey = resolveOpenAIApiKey();
		const baseUrl = resolveOpenAIBaseUrl();
		try {
			requireOpenAICredentials(apiKey, baseUrl);
		} catch (error) {
			return yield* Effect.fail(toError(error));
		}

		const model = process.env.BIRDCLAW_OPENAI_MODEL || "gpt-5.5";
		const response = yield* tryPromise(() =>
			fetch(openAIEndpoint(baseUrl, "chat/completions"), {
				method: "POST",
				headers: openAIHeaders(apiKey),
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
