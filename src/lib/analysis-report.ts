import { Effect } from "effect";
import {
	createAnalysisRequestBody,
	requestHybridAnalysisEffect,
	streamHybridAnalysisEffect,
	resolveAnalysisModelSettings,
	type AnalysisModelOptions,
	type AnalysisModelSettings,
	type HybridAnalysisResult,
} from "./analysis-runtime";
import { trySync } from "./effect-runtime";
import {
	readSyncCache,
	writeSyncCache,
	type SyncCacheEntry,
} from "./sync-cache";

export type AnalysisReport<Context, Value, Key extends string> = {
	context: Context;
	markdown: string;
	model: string;
	reasoningEffort: string;
	serviceTier: string;
	cached: boolean;
	updatedAt: string;
} & Record<Key, Value>;

export type AnalysisEvent<
	Result extends { context: unknown },
	Context = Result["context"],
> =
	| { type: "start"; context: Context; cached: boolean }
	| { type: "delta"; delta: string }
	| { type: "done"; result: Result }
	| { type: "error"; error: string };
export type AnalysisStatus = { type: "status"; label: string; detail?: string };
export interface AnalysisHandlers<Event> {
	onDelta?: (delta: string) => void;
	onEvent?: (event: Event) => void;
}

export function analysisReportCacheKey(
	namespace: string,
	options: AnalysisModelOptions,
	hash: string,
) {
	const { model, reasoningEffort, serviceTier } =
		resolveAnalysisModelSettings(options);
	return [namespace, model, reasoningEffort, serviceTier, hash].join(":");
}

export type CachedReport<Value, Key extends string> = {
	markdown: string;
	model: string;
	reasoningEffort: string;
	serviceTier: string;
} & Record<Key, Value>;

export function cachedAnalysisReport<Context, Value, Key extends string>(
	cached: SyncCacheEntry<CachedReport<NoInfer<Value>, NoInfer<Key>>>,
	context: Context,
	key: Key,
	parse: (value: unknown) => Value,
): AnalysisReport<Context, Value, Key> {
	const { markdown, model, reasoningEffort, serviceTier } = cached.value;
	return {
		context,
		[key]: parse(cached.value[key]),
		markdown,
		model,
		reasoningEffort,
		serviceTier,
		cached: true,
		updatedAt: cached.updatedAt,
	} as AnalysisReport<Context, Value, Key>;
}

export function readAnalysisReport<Context, Value, Key extends string>(
	cacheKey: string,
	context: Context,
	key: Key,
	parse: (value: unknown) => Value,
) {
	const cached = readSyncCache<CachedReport<Value, Key>>(cacheKey);
	return cached ? cachedAnalysisReport(cached, context, key, parse) : null;
}

interface GenerateReportOptions<Context, Value, Key extends string> {
	context: Context;
	key: Key;
	cacheKey: () => string;
	options: AnalysisModelOptions & { signal?: AbortSignal };
	system: string;
	prompt: () => string;
	parse: (value: unknown) => Value;
	fallback: (markdown: string) => Value;
	delivery?: "stream" | "complete";
	handlers: AnalysisHandlers<
		AnalysisEvent<
			AnalysisReport<Context, NoInfer<Value>, NoInfer<Key>>,
			Context
		>
	>;
	onStart?: () => void;
	enrichContext?: (value: Value) => Context;
	onSaved?: (
		result: AnalysisReport<Context, NoInfer<Value>, NoInfer<Key>>,
	) => void;
}

export function generateAnalysisReportEffect<
	Context,
	Value,
	Key extends string,
>({
	context,
	key,
	cacheKey,
	options,
	system,
	prompt,
	parse,
	fallback,
	delivery = "stream",
	handlers,
	onStart,
	enrichContext,
	onSaved,
}: GenerateReportOptions<Context, Value, Key>): Effect.Effect<
	AnalysisReport<Context, Value, Key>,
	Error
> {
	return Effect.gen(function* () {
		handlers.onEvent?.({ type: "start", context, cached: false });
		onStart?.();
		const request = {
			body: createAnalysisRequestBody({
				settings: resolveAnalysisModelSettings(options),
				system,
				prompt: prompt(),
				stream: delivery === "stream",
			}),
			signal: options.signal,
			parse,
			fallback,
			onDelta: (delta: string) => emitAnalysisDelta(handlers, delta),
		};
		const response = yield* delivery === "stream"
			? streamHybridAnalysisEffect(request)
			: requestHybridAnalysisEffect(request);
		const result = yield* trySync(() => {
			const reportContext = enrichContext
				? enrichContext(response.value)
				: context;
			const result = saveAnalysisReport(
				cacheKey(),
				reportContext,
				key,
				response,
				resolveAnalysisModelSettings(options),
				delivery === "stream",
			);
			onSaved?.(result);
			if (delivery === "stream") handlers.onEvent?.({ type: "done", result });
			return result;
		});
		if (delivery === "complete") {
			emitAnalysisDelta(handlers, result.markdown);
			handlers.onEvent?.({ type: "done", result });
		}
		return result;
	});
}

export function saveAnalysisReport<Context, Value, Key extends string>(
	cacheKey: string,
	context: Context,
	key: Key,
	stream: HybridAnalysisResult<Value>,
	settings: AnalysisModelSettings,
	includeUsage = false,
): AnalysisReport<Context, Value, Key> {
	const value = { [key]: stream.value, markdown: stream.markdown, ...settings };
	const updatedAt = writeSyncCache(cacheKey, {
		...value,
		...(includeUsage
			? { usage: stream.usage, responseId: stream.responseId }
			: {}),
	});
	return { ...value, context, cached: false, updatedAt } as AnalysisReport<
		Context,
		Value,
		Key
	>;
}

export function emitAnalysisDelta(
	handlers: AnalysisHandlers<{ type: "delta"; delta: string }>,
	delta: string,
) {
	handlers.onDelta?.(delta);
	handlers.onEvent?.({ type: "delta", delta });
}

export function emitCachedAnalysis<
	Result extends { context: unknown; markdown: string },
>(result: Result, handlers: AnalysisHandlers<AnalysisEvent<Result>>) {
	handlers.onEvent?.({ type: "start", context: result.context, cached: true });
	emitAnalysisDelta(handlers, result.markdown);
	handlers.onEvent?.({ type: "done", result });
}
