import type { z } from "zod";
import {
	actionResponseSchemaFor,
	type ActionRequest,
	type ActionResponseFor,
	queryEnvelopeSchema,
	queryResponseSchema,
	webSyncJobSchema,
} from "./api-contracts";
import {
	defaultRuntimeServices,
	type RuntimeServices,
} from "./runtime-services";
import type {
	WebSyncJobSnapshot,
	WebSyncKind,
	WebSyncOptions,
} from "./web-sync";

const SYNC_POLL_INTERVAL_MS = 500;

export class ApiFetchError extends Error {
	readonly _tag = "ApiFetchError";
	readonly status?: number;

	constructor(options: { message: string; status?: number; cause?: unknown }) {
		super(options.message, { cause: options.cause });
		this.name = "ApiFetchError";
		this.status = options.status;
	}
}

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
	if (cause instanceof DOMException && cause.name === "AbortError")
		return cause;
	if (cause instanceof ApiFetchError) return cause;
	if (cause instanceof Error)
		return new ApiFetchError({ message: cause.message, cause });
	if (typeof cause === "string")
		return new ApiFetchError({ message: cause, cause });
	return new ApiFetchError({ message: fallbackMessage, cause });
}

export async function fetchJson<T>(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	schema: z.ZodType<T>,
	fallbackMessage: string,
	runtime: RuntimeServices = defaultRuntimeServices,
): Promise<T> {
	let response: Response;
	try {
		response = await (init === undefined
			? runtime.fetch(input)
			: runtime.fetch(input, init));
	} catch (cause) {
		if (init?.signal?.aborted && cause === init.signal.reason) throw cause;
		throw apiFetchErrorFromCause(cause, fallbackMessage);
	}
	const data: unknown = await response.json().catch(() => null);
	if (!response.ok)
		throw new ApiFetchError({
			message: responseMessage(data, fallbackMessage),
			status: response.status,
		});
	const parsed = schema.safeParse(data);
	if (!parsed.success)
		throw new ApiFetchError({ message: fallbackMessage, cause: parsed.error });
	return parsed.data;
}

export function fetchQueryEnvelope(init?: RequestInit) {
	return fetchJson(
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
	return fetchJson(input, init, queryResponseSchema, "Query unavailable");
}

export function postAction<K extends ActionRequest["kind"]>(
	body: Extract<ActionRequest, { kind: K }>,
): Promise<ActionResponseFor<K>> {
	return fetchJson(
		"/api/action",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
		actionResponseSchemaFor(body.kind),
		"Action failed",
	);
}

export async function postSync(
	kind: WebSyncKind,
	accountId?: string,
	options: WebSyncOptions = {},
) {
	let current: WebSyncJobSnapshot = await fetchJson(
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
	);
	while (current.inProgress) {
		await new Promise<void>((resolve) =>
			setTimeout(resolve, SYNC_POLL_INTERVAL_MS),
		);
		const url = new URL("/api/sync", window.location.origin);
		url.searchParams.set("id", current.id);
		current = await fetchJson(
			url,
			undefined,
			webSyncJobSchema,
			"Sync status unavailable",
		);
	}
	if (!current.result)
		throw new ApiFetchError({ message: current.error ?? current.summary });
	if (!current.result.ok)
		throw new ApiFetchError({
			message: current.result.error ?? current.result.summary,
		});
	return current.result;
}
