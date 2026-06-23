import type { RuntimeServices } from "./runtime-services";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

function normalizeBaseUrl(value: string | undefined) {
	const raw = value?.trim();
	if (!raw) return DEFAULT_OPENAI_BASE_URL;
	return raw.replace(/\/+$/, "");
}

export function resolveOpenAIBaseUrl(runtime?: RuntimeServices) {
	const value =
		runtime?.env("BIRDCLAW_OPENAI_BASE_URL") ??
		runtime?.env("OPENAI_BASE_URL") ??
		process.env.BIRDCLAW_OPENAI_BASE_URL ??
		process.env.OPENAI_BASE_URL;
	return normalizeBaseUrl(value);
}

export function resolveOpenAIApiKey(runtime?: RuntimeServices) {
	return (
		runtime?.env("OPENAI_API_KEY") ??
		process.env.OPENAI_API_KEY ??
		""
	).trim();
}

export function isDefaultOpenAIBaseUrl(baseUrl: string) {
	return baseUrl === DEFAULT_OPENAI_BASE_URL;
}

export function openAIEndpoint(baseUrl: string, path: string) {
	return `${baseUrl}/${path.replace(/^\/+/, "")}`;
}

export function openAIHeaders(apiKey: string) {
	return {
		...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
		"content-type": "application/json",
	};
}

export function requireOpenAICredentials(apiKey: string, baseUrl: string) {
	if (!apiKey && isDefaultOpenAIBaseUrl(baseUrl)) {
		throw new Error("OPENAI_API_KEY is not set");
	}
}
