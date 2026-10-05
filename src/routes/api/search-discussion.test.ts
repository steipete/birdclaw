// @vitest-environment node
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";
import { useTestHome } from "#/test/test-home";

const maybeAutoUpdateBackupMock = vi.fn();
const streamSearchDiscussionMock = vi.fn();

vi.mock("#/lib/backup", () => ({
	requestBackupAutoUpdate: () => maybeAutoUpdateBackupMock(),
}));
vi.mock("#/lib/search-discussion", () => ({
	streamSearchDiscussionEffect: (...args: unknown[]) =>
		Effect.promise(() => streamSearchDiscussionMock(...args)),
}));

import { Route } from "./search-discussion";

const GET = getRouteHandler(Route, "GET");

describe("api search discussion route", () => {
	useTestHome();
	beforeEach(() => {
		delete process.env.BIRDCLAW_PREFERRED_TRANSPORT;
		maybeAutoUpdateBackupMock.mockReset();
		streamSearchDiscussionMock.mockReset();
		maybeAutoUpdateBackupMock.mockResolvedValue({ skipped: true });
		streamSearchDiscussionMock.mockImplementation(
			async (
				_options: unknown,
				handlers?: {
					onEvent?: (event: unknown) => void;
				},
			) => {
				handlers?.onEvent?.({ type: "delta", delta: "# Search\n" });
				handlers?.onEvent?.({
					type: "done",
					result: {
						markdown: "# Search",
						model: "gpt-5.5",
						cached: false,
						serviceTier: "priority",
						context: {
							query: "ChatGPT",
							source: "search",
							includeDms: true,
							counts: {
								search: 3,
								home: 0,
								mentions: 0,
								authored: 0,
								likes: 0,
								bookmarks: 0,
								dms: 0,
							},
							tweets: [],
						},
						discussion: { title: "Search" },
					},
				});
			},
		);
	});

	it.each([
		[undefined, undefined, "xurl"],
		["bird", undefined, "auto"],
		["xurl", undefined, "auto"],
		["bird", "xurl", "xurl"],
		[undefined, "auto", "auto"],
	])(
		"uses preference %s and explicit mode %s as %s",
		async (preferred, explicit, expected) => {
			if (preferred) process.env.BIRDCLAW_PREFERRED_TRANSPORT = preferred;
			const url = new URL(
				"http://localhost/api/search-discussion?query=fixture",
			);
			if (explicit) url.searchParams.set("mode", explicit);
			const response = await GET({ request: new Request(url) });
			await response.text();
			expect(streamSearchDiscussionMock).toHaveBeenCalledWith(
				expect.objectContaining({ mode: expected }),
				expect.any(Object),
			);
		},
	);

	it("streams NDJSON and passes query options to the discussion runner", async () => {
		const response = await GET({
			request: new Request(
				"http://localhost/api/search-discussion?query=ChatGPT&source=home&mode=bird&account=acct_primary&includeDms=yes&since=2026-05-01&until=2026-05-16&question=themes&originalsOnly=1&hideLowQuality=true&refresh=1&model=gpt-5.5&limit=42&maxPages=7",
			),
		});

		expect(response.headers.get("content-type")).toContain(
			"application/x-ndjson",
		);
		expect(response.headers.get("cache-control")).toBe(
			"no-store, no-transform",
		);
		expect(await response.text()).toContain('"type":"done"');
		expect(maybeAutoUpdateBackupMock).toHaveBeenCalledWith();
		expect(streamSearchDiscussionMock).toHaveBeenCalledWith(
			{
				query: "ChatGPT",
				account: "acct_primary",
				source: "home",
				mode: "bird",
				includeDms: true,
				since: "2026-05-01",
				until: "2026-05-16",
				question: "themes",
				originalsOnly: true,
				hideLowQuality: true,
				refresh: true,
				model: "gpt-5.5",
				limit: 42,
				maxPages: 7,
				signal: expect.any(AbortSignal),
				prefetchAvatars: true,
			},
			expect.objectContaining({ onEvent: expect.any(Function) }),
		);
	});

	it("defaults invalid query options and emits runner errors", async () => {
		streamSearchDiscussionMock.mockRejectedValueOnce(new Error("live failed"));

		const response = await GET({
			request: new Request(
				"http://localhost/api/search-discussion?source=bad&mode=bad&includeDms=no&limit=50000&maxPages=nope",
			),
		});

		expect(await response.text()).toContain('"error":"live failed"');
		expect(streamSearchDiscussionMock).toHaveBeenCalledWith(
			expect.objectContaining({
				query: "",
				source: "search",
				mode: "xurl",
				includeDms: false,
				limit: 20000,
				maxPages: undefined,
				prefetchAvatars: true,
			}),
			expect.any(Object),
		);
	});
});
