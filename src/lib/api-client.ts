import { z } from "zod";
import type {
	DmConversationItem,
	DmMessageItem,
	QueryEnvelope,
	QueryResponse,
	TimelineItem,
} from "./types";
import type { WebSyncKind, WebSyncResponse } from "./web-sync";

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
		summary: z.string(),
		steps: z.array(jsonRecordSchema),
		startedAt: z.string().optional(),
		finishedAt: z.string().optional(),
		inProgress: z.boolean().optional(),
		backup: z.unknown().optional(),
		error: z.string().optional(),
	})
	.transform((value) => value as unknown as WebSyncResponse);

const actionResponseSchema = jsonRecordSchema;

export class ApiFetchError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "ApiFetchError";
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

async function readJson(response: Response) {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

export async function fetchJson<T>(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	schema: z.ZodType<T>,
	fallbackMessage: string,
): Promise<T> {
	const response = await fetch(input, init);
	const data = await readJson(response);
	if (!response.ok) {
		throw new ApiFetchError(
			responseMessage(data, fallbackMessage),
			response.status,
		);
	}

	const parsed = schema.safeParse(data);
	if (!parsed.success) {
		throw new ApiFetchError(fallbackMessage);
	}
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

export function postAction(body: Record<string, unknown>) {
	return fetchJson(
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

export function postSync(kind: WebSyncKind) {
	return fetchJson(
		"/api/sync",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind }),
		},
		webSyncResponseSchema,
		"Sync failed",
	);
}
