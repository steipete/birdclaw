const DISCORD_MAX_MESSAGE_LENGTH = 2000;

export interface DiscordNotifyResult {
	ok: boolean;
	messageCount: number;
	error?: string;
}

function splitContent(content: string, maxLength: number): string[] {
	const chunks: string[] = [];
	let remaining = content.trim();
	while (remaining.length > 0) {
		if (remaining.length <= maxLength) {
			chunks.push(remaining);
			break;
		}
		let splitAt = remaining.lastIndexOf("\n\n", maxLength);
		if (splitAt === -1) {
			splitAt = remaining.lastIndexOf("\n", maxLength);
		}
		if (splitAt === -1 || splitAt < maxLength / 2) {
			splitAt = remaining.lastIndexOf(" ", maxLength);
		}
		if (splitAt === -1 || splitAt < 100) {
			splitAt = maxLength;
		}
		chunks.push(remaining.slice(0, splitAt).trim());
		remaining = remaining.slice(splitAt).trim();
	}
	return chunks;
}

export async function sendDiscordMessage(
	content: string,
	webhookUrl: string,
	signal?: AbortSignal,
): Promise<DiscordNotifyResult> {
	const chunks = splitContent(content, DISCORD_MAX_MESSAGE_LENGTH);
	let ok = true;
	let lastError: string | undefined;

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		try {
			const response = await fetch(webhookUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: chunk }),
				signal,
			});
			if (!response.ok) {
				ok = false;
				const body = await response.text().catch(() => "");
				lastError = `HTTP ${response.status}: ${body.slice(0, 200)}`;
			}
		} catch (error) {
			ok = false;
			lastError = error instanceof Error ? error.message : String(error);
		}
	}

	return { ok, messageCount: chunks.length, ...(lastError ? { error: lastError } : {}) };
}
