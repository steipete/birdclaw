// @vitest-environment node
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const maybeAutoUpdateBackupMock = vi.fn();
const streamPeriodDigestMock = vi.fn();

vi.mock("#/lib/backup", () => ({
	maybeAutoUpdateBackup: () => maybeAutoUpdateBackupMock(),
	maybeAutoUpdateBackupEffect: () =>
		Effect.promise(() => Promise.resolve(maybeAutoUpdateBackupMock())),
}));
vi.mock("#/lib/period-digest", () => ({
	normalizeDigestLanguage: (value: string | undefined) => {
		if (!value) return undefined;
		if (value === "ZH-cn") return "zh-CN";
		throw new Error(
			"Digest language must be a valid Unicode locale identifier",
		);
	},
	streamPeriodDigest: (...args: unknown[]) => streamPeriodDigestMock(...args),
	streamPeriodDigestEffect: (...args: unknown[]) =>
		Effect.promise(() => streamPeriodDigestMock(...args)),
}));

import { Route } from "./period-digest";

const GET = getRouteHandler(Route, "GET");

describe("api period digest route", () => {
	beforeEach(() => {
		maybeAutoUpdateBackupMock.mockReset();
		streamPeriodDigestMock.mockReset();
		maybeAutoUpdateBackupMock.mockResolvedValue({ skipped: true });
		streamPeriodDigestMock.mockImplementation(
			async (
				_options: unknown,
				handlers?: {
					onEvent?: (event: unknown) => void;
				},
			) => {
				handlers?.onEvent?.({ type: "delta", delta: "# Week\n" });
				handlers?.onEvent?.({
					type: "done",
					result: {
						markdown: "# Week",
						model: "gpt-5.5",
						cached: false,
						serviceTier: "priority",
						context: {
							window: { label: "Week" },
							counts: { home: 1, mentions: 0, links: 0, dms: 0 },
							includeDms: true,
							tweets: [],
						},
						digest: { actionItems: [] },
					},
				});
			},
		);
	});

	it("streams NDJSON and passes query options to the digest runner", async () => {
		const response = await GET({
			request: new Request(
				"http://localhost/api/period-digest?period=week&since=2026-05-01&until=2026-05-16&account=acct_primary&includeDms=yes&refresh=1&model=litellm-reasoner&language=ZH-cn&maxTweets=42&maxLinks=7",
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
		expect(streamPeriodDigestMock).toHaveBeenCalledWith(
			{
				period: "week",
				since: "2026-05-01",
				until: "2026-05-16",
				account: "acct_primary",
				includeDms: true,
				refresh: true,
				model: "litellm-reasoner",
				language: "zh-CN",
				maxTweets: 42,
				maxLinks: 7,
				liveSync: false,
				liveSyncMode: "xurl",
				liveTimelineLimit: undefined,
				liveTimelineMaxPages: undefined,
				signal: expect.any(AbortSignal),
			},
			expect.objectContaining({ onEvent: expect.any(Function) }),
		);
	});

	it("enables bounded live refresh only when requested", async () => {
		const response = await GET({
			request: new Request(
				"http://localhost/api/period-digest?period=24h&liveSync=true&liveMode=xurl",
			),
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toContain('"type":"done"');
		expect(streamPeriodDigestMock).toHaveBeenCalledWith(
			expect.objectContaining({
				period: "24h",
				liveSync: true,
				liveSyncMode: "xurl",
			}),
			expect.objectContaining({ onEvent: expect.any(Function) }),
		);
	});

	it("rejects invalid language tags before starting a digest", async () => {
		const response = await GET({
			request: new Request(
				"http://localhost/api/period-digest?language=not_a_locale",
			),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			ok: false,
			error: "Digest language must be a valid Unicode locale identifier",
		});
		expect(maybeAutoUpdateBackupMock).not.toHaveBeenCalled();
		expect(streamPeriodDigestMock).not.toHaveBeenCalled();
	});

	it("opens the stream before backup auto-update completes", async () => {
		let resolveBackup: ((value: unknown) => void) | undefined;
		maybeAutoUpdateBackupMock.mockReturnValue(
			new Promise((resolve) => {
				resolveBackup = resolve;
			}),
		);

		const response = await GET({
			request: new Request("http://localhost/api/period-digest?period=today"),
		});
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();

		const first = await reader!.read();
		const text = new TextDecoder().decode(first.value);
		expect(text).toContain('"type":"status"');
		expect(text).toContain("Preparing local archive");
		expect(streamPeriodDigestMock).not.toHaveBeenCalled();

		resolveBackup?.({ skipped: true });
		await reader!.cancel();
	});

	it("emits an error event when the digest runner rejects", async () => {
		streamPeriodDigestMock.mockRejectedValueOnce(new Error("no api key"));

		const response = await GET({
			request: new Request("http://localhost/api/period-digest?maxTweets=nope"),
		});

		expect(await response.text()).toContain('"error":"no api key"');
		expect(streamPeriodDigestMock).toHaveBeenCalledWith(
			expect.objectContaining({
				includeDms: false,
				refresh: false,
				maxTweets: undefined,
			}),
			expect.any(Object),
		);
	});
});
