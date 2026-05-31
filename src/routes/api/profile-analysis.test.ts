// @vitest-environment node
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const maybeAutoUpdateBackupMock = vi.fn();
const streamProfileAnalysisMock = vi.fn();

vi.mock("#/lib/backup", () => ({
	maybeAutoUpdateBackup: () => maybeAutoUpdateBackupMock(),
	maybeAutoUpdateBackupEffect: () =>
		Effect.promise(() => Promise.resolve(maybeAutoUpdateBackupMock())),
}));
vi.mock("#/lib/profile-analysis", () => ({
	streamProfileAnalysisEffect: (...args: unknown[]) =>
		Effect.promise(() => streamProfileAnalysisMock(...args)),
}));

import { Route } from "./profile-analysis";

const GET = getRouteHandler(Route, "GET");

describe("api profile analysis route", () => {
	beforeEach(() => {
		maybeAutoUpdateBackupMock.mockReset();
		streamProfileAnalysisMock.mockReset();
		maybeAutoUpdateBackupMock.mockResolvedValue({ skipped: true });
		streamProfileAnalysisMock.mockImplementation(
			async (
				_options: unknown,
				handlers?: {
					onEvent?: (event: unknown) => void;
				},
			) => {
				handlers?.onEvent?.({ type: "status", label: "Fetching" });
				handlers?.onEvent?.({
					type: "done",
					result: {
						markdown: "# Alice",
						model: "gpt-5.5",
						cached: false,
						serviceTier: "priority",
						context: { handle: "alice", counts: { tweets: 1 } },
						analysis: { title: "Alice" },
					},
				});
			},
		);
	});

	it("streams NDJSON and passes profile backfill options", async () => {
		const response = await GET({
			request: new Request(
				"http://localhost/api/profile-analysis?handle=alice&refresh=1&model=gpt-5.5&maxTweets=42&maxPages=7&maxConversations=3&maxConversationPages=2",
			),
		});

		expect(response.headers.get("content-type")).toContain(
			"application/x-ndjson",
		);
		expect(await response.text()).toContain('"type":"done"');
		expect(maybeAutoUpdateBackupMock).toHaveBeenCalledWith();
		expect(streamProfileAnalysisMock).toHaveBeenCalledWith(
			{
				handle: "alice",
				refresh: true,
				model: "gpt-5.5",
				maxTweets: 42,
				maxPages: 7,
				maxConversations: 3,
				maxConversationPages: 2,
				account: undefined,
				signal: expect.any(AbortSignal),
			},
			expect.objectContaining({ onEvent: expect.any(Function) }),
		);
	});

	it("passes zero-valued throttle controls through", async () => {
		const response = await GET({
			request: new Request(
				"http://localhost/api/profile-analysis?handle=alice&conversationDelayMs=0&rateLimitRetryMs=0&rateLimitRetries=0",
			),
		});

		await response.text();
		expect(streamProfileAnalysisMock).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationDelayMs: 0,
				rateLimitRetryMs: 0,
				rateLimitMaxRetries: 0,
			}),
			expect.objectContaining({ onEvent: expect.any(Function) }),
		);
	});
});
