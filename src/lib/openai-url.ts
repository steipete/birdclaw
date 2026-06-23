const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

export function openAIEndpoint(path: string, baseUrl?: string) {
	const base = baseUrl?.trim() || DEFAULT_OPENAI_BASE_URL;
	const normalizedBase = base.endsWith("/") ? base : `${base}/`;
	const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
	return new URL(normalizedPath, normalizedBase).toString();
}
