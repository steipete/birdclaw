import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	getModel,
	type AssistantMessage,
	type ThinkingLevel,
} from "@earendil-works/pi-ai";
import {
	getOAuthApiKey,
	type OAuthCredentials,
} from "@earendil-works/pi-ai/oauth";
import { streamSimpleOpenAICodexResponses } from "@earendil-works/pi-ai/openai-codex-responses";
import type { RuntimeServices } from "./runtime-services";

const PI_CODEX_PROVIDER = "openai-codex";
const DEFAULT_PI_CODEX_MODEL = "gpt-5.5";
const DEFAULT_PI_CODEX_REASONING = "low";
type PiCodexReasoning = ThinkingLevel;
type PiCodexModelId =
	| "gpt-5.3-codex-spark"
	| "gpt-5.4"
	| "gpt-5.4-mini"
	| "gpt-5.5";

interface PiAuthFile {
	[PI_CODEX_PROVIDER]?: ({ type?: string } & OAuthCredentials) | undefined;
	[key: string]: unknown;
}

function runtimeEnv(runtime: RuntimeServices | undefined, name: string) {
	return runtime?.env(name) ?? process.env[name];
}

export function isPiCodexProviderEnabled(runtime?: RuntimeServices) {
	const provider = runtimeEnv(runtime, "BIRDCLAW_AI_PROVIDER")?.trim();
	return provider === "pi-codex" || provider === "openai-codex";
}

function piAgentDir(runtime?: RuntimeServices) {
	return (
		runtimeEnv(runtime, "PI_CODING_AGENT_DIR")?.trim() ||
		path.join(os.homedir(), ".pi", "agent")
	);
}

function piAuthPath(runtime?: RuntimeServices) {
	return (
		runtimeEnv(runtime, "BIRDCLAW_PI_AUTH_PATH")?.trim() ||
		path.join(piAgentDir(runtime), "auth.json")
	);
}

export function resolvePiCodexModel(runtime?: RuntimeServices) {
	return (
		runtimeEnv(runtime, "BIRDCLAW_AI_MODEL")?.trim() ||
		runtimeEnv(runtime, "BIRDCLAW_OPENAI_MODEL")?.trim() ||
		DEFAULT_PI_CODEX_MODEL
	);
}

export function resolvePiCodexReasoning(runtime?: RuntimeServices) {
	return (runtimeEnv(runtime, "BIRDCLAW_OPENAI_REASONING_EFFORT")?.trim() ||
		DEFAULT_PI_CODEX_REASONING) as PiCodexReasoning;
}

async function readPiAuth(runtime?: RuntimeServices) {
	const authPath = piAuthPath(runtime);
	let parsed: PiAuthFile;
	try {
		parsed = JSON.parse(await readFile(authPath, "utf8")) as PiAuthFile;
	} catch (error) {
		throw new Error(
			`Missing Pi Codex credentials at ${authPath}. Run pi, /login, then select ChatGPT Plus/Pro (Codex).`,
			{ cause: error },
		);
	}
	const credential = parsed[PI_CODEX_PROVIDER];
	if (!credential?.access || !credential.refresh || !credential.expires) {
		throw new Error(
			`Missing openai-codex credentials in ${authPath}. Run pi, /login, then select ChatGPT Plus/Pro (Codex).`,
		);
	}
	return { authPath, parsed, credential };
}

export async function getPiCodexApiKey(runtime?: RuntimeServices) {
	const { authPath, parsed, credential } = await readPiAuth(runtime);
	const result = await getOAuthApiKey(PI_CODEX_PROVIDER, {
		[PI_CODEX_PROVIDER]: credential,
	});
	if (!result) {
		throw new Error("Missing openai-codex credentials");
	}
	if (result.newCredentials !== credential) {
		parsed[PI_CODEX_PROVIDER] = {
			...result.newCredentials,
			type: "oauth",
		};
		await writeFile(authPath, `${JSON.stringify(parsed, null, 2)}\n`, {
			mode: 0o600,
		});
	}
	return result.apiKey;
}

function messageText(message: AssistantMessage) {
	return message.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("");
}

export async function completePiCodexText({
	system,
	prompt,
	model,
	reasoning,
	signal,
	runtime,
}: {
	system?: string;
	prompt: string;
	model?: string;
	reasoning?: PiCodexReasoning;
	signal?: AbortSignal;
	runtime?: RuntimeServices;
}) {
	const apiKey = await getPiCodexApiKey(runtime);
	const resolvedModel = getModel(
		PI_CODEX_PROVIDER,
		(model || resolvePiCodexModel(runtime)) as PiCodexModelId,
	);
	const stream = streamSimpleOpenAICodexResponses(
		resolvedModel,
		{
			systemPrompt: system,
			messages: [
				{
					role: "user",
					content: prompt,
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey,
			reasoning: reasoning || resolvePiCodexReasoning(runtime),
			signal,
			transport: "sse",
			maxRetries: 0,
		},
	);
	const message = await stream.result();
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		throw new Error(message.errorMessage || "Pi Codex request failed");
	}
	const text = messageText(message);
	if (!text) throw new Error("Pi Codex returned no text");
	return {
		text,
		model: resolvedModel.id,
		responseId: message.responseId,
		usage: message.usage,
	};
}

function extractInput(body: unknown) {
	const record =
		body && typeof body === "object" ? (body as Record<string, unknown>) : {};
	const input = Array.isArray(record.input) ? record.input : [];
	const system = input
		.filter(
			(item): item is Record<string, unknown> =>
				Boolean(item) && typeof item === "object",
		)
		.filter((item) => item.role === "system")
		.map((item) => String(item.content ?? ""))
		.join("\n\n");
	const prompt = input
		.filter(
			(item): item is Record<string, unknown> =>
				Boolean(item) && typeof item === "object",
		)
		.filter((item) => item.role !== "system")
		.map((item) => String(item.content ?? ""))
		.join("\n\n");
	return {
		system: system || undefined,
		prompt: prompt || JSON.stringify(body),
		stream: record.stream === true,
		model: typeof record.model === "string" ? record.model : undefined,
		reasoning:
			record.reasoning &&
			typeof record.reasoning === "object" &&
			"effort" in record.reasoning &&
			typeof (record.reasoning as { effort?: unknown }).effort === "string"
				? ((record.reasoning as { effort: string }).effort as PiCodexReasoning)
				: undefined,
	};
}

function sseEvent(value: Record<string, unknown>) {
	return `data: ${JSON.stringify(value)}\n\n`;
}

export async function createPiCodexResponse(
	body: unknown,
	signal?: AbortSignal,
) {
	const request = extractInput(body);
	const result = await completePiCodexText({
		system: request.system,
		prompt: request.prompt,
		model: request.model,
		reasoning: request.reasoning,
		signal,
	});
	if (!request.stream) {
		return new Response(
			JSON.stringify({
				id: result.responseId,
				model: result.model,
				output_text: result.text,
				usage: result.usage,
			}),
			{ headers: { "content-type": "application/json" } },
		);
	}
	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			controller.enqueue(
				encoder.encode(
					sseEvent({ type: "response.output_text.delta", delta: result.text }),
				),
			);
			controller.enqueue(
				encoder.encode(
					sseEvent({
						type: "response.completed",
						response: {
							id: result.responseId,
							model: result.model,
							usage: result.usage,
						},
					}),
				),
			);
			controller.close();
		},
	});
	return new Response(stream, {
		headers: { "content-type": "text/event-stream" },
	});
}
