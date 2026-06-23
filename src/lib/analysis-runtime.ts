import { Effect } from "effect";
import { tryPromise } from "./effect-runtime";
import {
	readOpenAIResponseStreamEffect,
	requestOpenAIResponseEffect,
} from "./openai-response-runtime";
import {
	defaultRuntimeServices,
	type RuntimeServices,
} from "./runtime-services";

const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_REASONING_EFFORT = "low";
const DEFAULT_SERVICE_TIER = "priority";
const DEFAULT_DELIMITER_PATTERN = /\n---\s*\n/;

export type AnalysisReasoningEffort = "minimal" | "low" | "medium" | "high";
export type AnalysisServiceTier = "default" | "flex" | "priority";

export interface AnalysisModelOptions {
	model?: string;
	reasoningEffort?: AnalysisReasoningEffort;
	serviceTier?: AnalysisServiceTier;
}

export interface AnalysisModelSettings {
	model: string;
	reasoningEffort: AnalysisReasoningEffort;
	serviceTier: AnalysisServiceTier;
}

export interface HybridAnalysisResult<T> {
	value: T;
	markdown: string;
	rawText: string;
	responseId?: string;
	usage?: unknown;
}

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

export function resolveAnalysisModelSettings(
	options: AnalysisModelOptions,
	runtime: RuntimeServices = defaultRuntimeServices,
): AnalysisModelSettings {
	return {
		model: options.model ?? runtime.env("BIRDCLAW_AI_MODEL") ?? DEFAULT_MODEL,
		reasoningEffort:
			options.reasoningEffort ??
			(runtime.env(
				"BIRDCLAW_OPENAI_REASONING_EFFORT",
			) as AnalysisReasoningEffort) ??
			DEFAULT_REASONING_EFFORT,
		serviceTier:
			options.serviceTier ??
			(runtime.env("BIRDCLAW_OPENAI_SERVICE_TIER") as AnalysisServiceTier) ??
			DEFAULT_SERVICE_TIER,
	};
}

export function createAnalysisRequestBody({
	settings,
	system,
	prompt,
	stream,
	maxOutputTokens = 7000,
}: {
	settings: AnalysisModelSettings;
	system: string;
	prompt: string;
	stream: boolean;
	maxOutputTokens?: number;
}) {
	return {
		model: settings.model,
		reasoning: { effort: settings.reasoningEffort },
		service_tier: settings.serviceTier,
		store: false,
		...(stream ? { stream: true } : {}),
		max_output_tokens: maxOutputTokens,
		input: [
			{ role: "system", content: system },
			{ role: "user", content: prompt },
		],
	};
}

export function parseHybridAnalysis<T>({
	rawText,
	parse,
	fallback,
	delimiterPattern = DEFAULT_DELIMITER_PATTERN,
}: {
	rawText: string;
	parse: (value: unknown) => T;
	fallback: (markdown: string) => T;
	delimiterPattern?: RegExp;
}) {
	const [markdownPart, jsonPart] = rawText.split(delimiterPattern);
	const markdown = (markdownPart ?? rawText).trim();
	const candidate = jsonPart?.slice(
		jsonPart.indexOf("{"),
		jsonPart.lastIndexOf("}") + 1,
	);
	if (candidate?.startsWith("{")) {
		try {
			return { markdown, value: parse(JSON.parse(candidate)) };
		} catch {
			return { markdown, value: fallback(markdown) };
		}
	}
	return { markdown, value: fallback(markdown) };
}

export function extractOpenAIResponseText(payload: Record<string, unknown>) {
	if (typeof payload.output_text === "string") {
		return payload.output_text;
	}
	const output = Array.isArray(payload.output) ? payload.output : [];
	const parts: string[] = [];
	for (const item of output) {
		if (!item || typeof item !== "object") continue;
		const content = (item as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const record = block as Record<string, unknown>;
			if (typeof record.text === "string") parts.push(record.text);
		}
	}
	return parts.join("");
}

export function readHybridAnalysisStreamEffect<T>(
	response: Response,
	{
		parse,
		fallback,
		onDelta,
		delimiterPattern = DEFAULT_DELIMITER_PATTERN,
	}: {
		parse: (value: unknown) => T;
		fallback: (markdown: string) => T;
		onDelta?: (delta: string) => void;
		delimiterPattern?: RegExp;
	},
): Effect.Effect<HybridAnalysisResult<T>, Error> {
	return Effect.gen(function* () {
		const stream = yield* readOpenAIResponseStreamEffect(response, {
			delimiterPattern,
			onDelta,
		});
		const parsed = parseHybridAnalysis({
			rawText: stream.rawText,
			parse,
			fallback,
			delimiterPattern,
		});
		return {
			...parsed,
			rawText: stream.rawText,
			...(stream.responseId ? { responseId: stream.responseId } : {}),
			...(stream.usage === undefined ? {} : { usage: stream.usage }),
		};
	});
}

export function streamHybridAnalysisEffect<T>({
	body,
	signal,
	runtime = defaultRuntimeServices,
	parse,
	fallback,
	onDelta,
	delimiterPattern = DEFAULT_DELIMITER_PATTERN,
}: {
	body: unknown;
	signal?: AbortSignal;
	runtime?: RuntimeServices;
	parse: (value: unknown) => T;
	fallback: (markdown: string) => T;
	onDelta?: (delta: string) => void;
	delimiterPattern?: RegExp;
}): Effect.Effect<HybridAnalysisResult<T>, Error> {
	return Effect.gen(function* () {
		const response = yield* requestOpenAIResponseEffect({
			body,
			signal,
			runtime,
		});
		return yield* readHybridAnalysisStreamEffect(response, {
			parse,
			fallback,
			onDelta,
			delimiterPattern,
		});
	});
}

export function requestHybridAnalysisEffect<T>({
	body,
	signal,
	runtime = defaultRuntimeServices,
	parse,
	fallback,
	delimiterPattern = DEFAULT_DELIMITER_PATTERN,
}: {
	body: unknown;
	signal?: AbortSignal;
	runtime?: RuntimeServices;
	parse: (value: unknown) => T;
	fallback: (markdown: string) => T;
	delimiterPattern?: RegExp;
}): Effect.Effect<HybridAnalysisResult<T>, Error> {
	return Effect.gen(function* () {
		const response = yield* requestOpenAIResponseEffect({
			body,
			signal,
			runtime,
		});
		const payload = (yield* tryPromise(() => response.json()).pipe(
			Effect.mapError(toError),
		)) as Record<string, unknown>;
		const rawText = extractOpenAIResponseText(payload);
		if (!rawText) {
			return yield* Effect.fail(new Error("OpenAI returned no output text"));
		}
		const parsed = parseHybridAnalysis({
			rawText,
			parse,
			fallback,
			delimiterPattern,
		});
		return { ...parsed, rawText };
	});
}
