import { Data, Effect } from "effect";
import { z } from "zod";
import { runEffectPromise } from "./effect-runtime";
import type {
	DmConversationItem,
	DmMessageItem,
	QueryEnvelope,
	QueryResponse,
	TimelineItem,
} from "./types";
import type {
	WebSyncJobSnapshot,
	WebSyncKind,
	WebSyncOptions,
	WebSyncResponse,
} from "./web-sync";

const jsonRecordSchema = z.object({}).passthrough();
const resourceKindSchema = z.enum(["home", "mentions", "authored", "dms"]);
const webSyncKindSchema = z.enum([
	"timeline",
	"mentions",
	"likes",
	"bookmarks",
	"dms",
]);

const queryEnvelopeSchema = z
	.object({
		accounts: z.array(jsonRecordSchema),
		archives: z.array(jsonRecordSchema),
		transport: z
			.object({
				statusText: z.string(),
			})
			.passthrough(),
		stats: z.object({
			home: z.number(),
			mentions: z.number(),
			dms: z.number(),
			needsReply: z.number(),
			inbox: z.number(),
		}),
	})
	.transform((value) => value as unknown as QueryEnvelope);

const queryResponseSchema = z
	.object({
		resource: resourceKindSchema,
		items: z.array(jsonRecordSchema),
		selectedConversation: z
			.object({
				conversation: jsonRecordSchema,
				messages: z.array(jsonRecordSchema),
			})
			.nullish(),
	})
	.transform(
		(value) =>
			({
				...value,
				items: value.items as unknown as Array<
					TimelineItem | DmConversationItem
				>,
				selectedConversation: value.selectedConversation
					? {
							conversation: value.selectedConversation
								.conversation as unknown as DmConversationItem,
							messages: value.selectedConversation
								.messages as unknown as DmMessageItem[],
						}
					: value.selectedConversation,
			}) as QueryResponse,
	);

const webSyncResponseSchema = z
	.object({
		ok: z.boolean(),
		kind: webSyncKindSchema,
		accountId: z.string().optional(),
		summary: z.string(),
		steps: z.array(jsonRecordSchema),
		startedAt: z.string().optional(),
		finishedAt: z.string().optional(),
		inProgress: z.boolean().optional(),
		backup: z.unknown().optional(),
		error: z.string().optional(),
	})
	.transform((value) => value as unknown as WebSyncResponse);

const webSyncJobSchema = z
	.object({
		id: z.string(),
		kind: webSyncKindSchema,
		accountId: z.string().optional(),
		status: z.enum(["running", "succeeded", "failed"]),
		startedAt: z.string(),
		finishedAt: z.string().optional(),
		summary: z.string(),
		inProgress: z.boolean(),
		result: webSyncResponseSchema.optional(),
		error: z.string().optional(),
	})
	.transform((value) => value as unknown as WebSyncJobSnapshot);

const actionResponseSchema = jsonRecordSchema;
const SYNC_POLL_INTERVAL_MS = 500;

export class ApiFetchError extends Data.TaggedError("ApiFetchError")<{
	readonly message: string;
	readonly status?: number;
	readonly cause?: unknown;
}> {}

function responseMessage(data: unknown, fallback: string) {
	if (data && typeof data === "object") {
		const record = data as {
			message?: unknown;
			error?: unknown;
			summary?: unknown;
		};
		if (typeof record.message === "string") return record.message;
		if (typeof record.error === "string") return record.error;
		if (typeof record.summary === "string") return record.summary;
	}
	return fallback;
}

function apiFetchErrorFromCause(cause: unknown, fallbackMessage: string) {
	if (cause instanceof DOMException && cause.name === "AbortError") {
		return cause;
	}
	if (cause instanceof ApiFetchError) return cause;
	if (cause instanceof Error) {
		return new ApiFetchError({ message: cause.message, cause });
	}
	if (typeof cause === "string") {
		return new ApiFetchError({ message: cause, cause });
	}
	return new ApiFetchError({ message: fallbackMessage, cause });
}

function readJsonEffect(response: Response) {
	return Effect.promise(() => response.json().catch(() => null as unknown));
}

function runApiEffect<T, E>(effect: Effect.Effect<T, E>) {
	return runEffectPromise(effect);
}

export function fetchJsonEffect<T>(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	schema: z.ZodType<T>,
	fallbackMessage: string,
) {
	return Effect.gen(function* () {
		const response = yield* Effect.tryPromise({
			try: () => fetch(input, init),
			catch: (cause) => apiFetchErrorFromCause(cause, fallbackMessage),
		});
		const data = yield* readJsonEffect(response);
		if (!response.ok) {
			return yield* Effect.fail(
				new ApiFetchError({
					message: responseMessage(data, fallbackMessage),
					status: response.status,
				}),
			);
		}

		const parsed = schema.safeParse(data);
		if (!parsed.success) {
			return yield* Effect.fail(
				new ApiFetchError({
					message: fallbackMessage,
					cause: parsed.error,
				}),
			);
		}
		return parsed.data;
	});
}

export function fetchJson<T>(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	schema: z.ZodType<T>,
	fallbackMessage: string,
): Promise<T> {
	return runApiEffect(fetchJsonEffect(input, init, schema, fallbackMessage));
}

export function fetchQueryEnvelope(init?: RequestInit) {
	return runApiEffect(fetchQueryEnvelopeEffect(init));
}

export function fetchQueryEnvelopeEffect(init?: RequestInit) {
	return fetchJsonEffect(
		"/api/status",
		init,
		queryEnvelopeSchema,
		"Status unavailable",
	);
}

export function fetchQueryResponse(
	input: RequestInfo | URL,
	init?: RequestInit,
) {
	return runApiEffect(fetchQueryResponseEffect(input, init));
}

export function fetchQueryResponseEffect(
	input: RequestInfo | URL,
	init?: RequestInit,
) {
	return fetchJsonEffect(input, init, queryResponseSchema, "Query unavailable");
}

export function postAction(body: Record<string, unknown>) {
	return runApiEffect(postActionEffect(body));
}

export function postActionEffect(body: Record<string, unknown>) {
	return fetchJsonEffect(
		"/api/action",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
		actionResponseSchema,
		"Action failed",
	);
}

export function postSync(
	kind: WebSyncKind,
	accountId?: string,
	options: WebSyncOptions = {},
) {
	return runApiEffect(postSyncEffect(kind, accountId, options));
}

export function postSyncEffect(
	kind: WebSyncKind,
	accountId?: string,
	options: WebSyncOptions = {},
) {
	return fetchJsonEffect(
		"/api/sync",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				kind,
				...(accountId ? { accountId } : {}),
				...options,
			}),
		},
		webSyncJobSchema,
		"Sync failed",
	).pipe(Effect.flatMap(waitForWebSyncJobEffect));
}

function fetchSyncJobEffect(id: string) {
	const url = new URL("/api/sync", window.location.origin);
	url.searchParams.set("id", id);
	return fetchJsonEffect(
		url,
		undefined,
		webSyncJobSchema,
		"Sync status unavailable",
	);
}

export function waitForWebSyncJobEffect(job: WebSyncJobSnapshot) {
	return Effect.gen(function* () {
		let current = job;
		while (current.inProgress) {
			yield* Effect.sleep(SYNC_POLL_INTERVAL_MS);
			current = yield* fetchSyncJobEffect(current.id);
		}

		if (!current.result) {
			return yield* Effect.fail(
				new ApiFetchError({ message: current.error ?? current.summary }),
			);
		}
		if (!current.result.ok) {
			return yield* Effect.fail(
				new ApiFetchError({
					message: current.result.error ?? current.result.summary,
				}),
			);
		}
		return current.result;
	});
}

export function waitForWebSyncJob(job: WebSyncJobSnapshot) {
	return runApiEffect(waitForWebSyncJobEffect(job));
}
