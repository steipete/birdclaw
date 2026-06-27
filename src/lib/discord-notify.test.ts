import { afterEach, describe, expect, it, vi } from "vitest";
import { sendDiscordMessage } from "./discord-notify";

describe("Discord notification", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("suppresses Discord link preview embeds for webhook messages", async () => {
		const fetch = vi.fn(async () => new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetch);

		await sendDiscordMessage(
			"Digest with a link: https://x.com/jack/status/20",
			"https://discord-webhook.invalid/api/webhooks/1/token",
		);

		expect(fetch).toHaveBeenCalledWith(
			"https://discord-webhook.invalid/api/webhooks/1/token",
			expect.objectContaining({
				body: JSON.stringify({
					content: "Digest with a link: https://x.com/jack/status/20",
					flags: 4,
				}),
			}),
		);
	});
});
