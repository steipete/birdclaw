import type {
	AnalysisModelSettings,
	HybridAnalysisResult,
} from "./analysis-runtime";
import { writeSyncCache, type SyncCacheEntry } from "./sync-cache";

export type AnalysisReport<Context, Value, Key extends string> = {
	context: Context;
	markdown: string;
	model: string;
	reasoningEffort: string;
	serviceTier: string;
	cached: boolean;
	updatedAt: string;
} & Record<Key, Value>;

export type AnalysisEvent<Result extends { context: unknown }> =
	| { type: "start"; context: Result["context"]; cached: boolean }
	| { type: "delta"; delta: string }
	| { type: "done"; result: Result }
	| { type: "error"; error: string };
export type AnalysisStatus = { type: "status"; label: string; detail?: string };
export interface AnalysisHandlers<Event> {
	onDelta?: (delta: string) => void;
	onEvent?: (event: Event) => void;
}

type CachedReport<Value, Key extends string> = {
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
