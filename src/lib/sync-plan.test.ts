import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { runEffectPromise } from "./effect-runtime";
import { runSyncPlanEffect, type SyncPlanPageContext } from "./sync-plan";

describe("runSyncPlanEffect", () => {
	it("collects pages and reports exhaustion", async () => {
		const pages = [
			{ items: ["one"], next: "page-2" },
			{ items: ["two"], next: undefined },
		];
		const result = await runEffectPromise(
			runSyncPlanEffect({
				fetchPage: ({ pageIndex }) => Effect.succeed(pages[pageIndex]!),
				getItemCount: (page) => page.items.length,
				getNextCursor: (page) => page.next,
			}),
		);

		expect(result).toMatchObject({
			complete: true,
			fetched: 2,
			stopReason: "exhausted",
		});
		expect(result.pages).toEqual(pages);
	});

	it("breaks repeated cursor loops", async () => {
		const result = await runEffectPromise(
			runSyncPlanEffect({
				fetchPage: ({ cursor }) =>
					Effect.succeed({ items: [cursor ?? "first"], next: "same" }),
				getNextCursor: (page) => page.next,
			}),
		);

		expect(result).toMatchObject({
			complete: false,
			nextCursor: "same",
			stopReason: "repeated-cursor",
		});
		expect(result.pages).toHaveLength(2);
	});

	it("reports a repeated cursor before a coincident page limit", async () => {
		const result = await runEffectPromise(
			runSyncPlanEffect({
				initialCursor: "same",
				maxPages: 1,
				fetchPage: () => Effect.succeed({ next: "same" }),
				getNextCursor: (page) => page.next,
			}),
		);

		expect(result.stopReason).toBe("repeated-cursor");
		expect(result.nextCursor).toBe("same");
	});

	it("persists each page and reports page-limit cursors", async () => {
		type Page = { items: Array<string | undefined>; next: string };
		const persistPage = vi.fn(
			(_context: SyncPlanPageContext<Page>) => Effect.void,
		);
		const result = await runEffectPromise(
			runSyncPlanEffect({
				initialCursor: "start",
				maxPages: 2,
				fetchPage: ({ cursor }) =>
					Effect.succeed({
						items: [cursor],
						next: cursor === "start" ? "second" : "third",
					}),
				getItemCount: (page) => page.items.length,
				getNextCursor: (page) => page.next,
				persistPage,
			}),
		);

		expect(result.stopReason).toBe("page-limit");
		expect(result.nextCursor).toBe("third");
		expect(result.fetched).toBe(2);
		expect(persistPage).toHaveBeenCalledTimes(2);
		expect(persistPage.mock.calls[1]?.[0]).toEqual(
			expect.objectContaining({
				cursor: "second",
				nextCursor: "third",
				done: true,
			}),
		);
	});

	it("returns partial pages when a later fetch fails", async () => {
		const result = await runEffectPromise(
			runSyncPlanEffect({
				allowPartialFailure: true,
				fetchPage: ({ pageIndex }) =>
					pageIndex === 0
						? Effect.succeed({ next: "resume" })
						: Effect.fail(new Error("rate limited")),
				getNextCursor: (page) => page.next,
			}),
		);

		expect(result.stopReason).toBe("error");
		expect(result.nextCursor).toBe("resume");
		expect(result.pages).toHaveLength(1);
		expect(result.error).toEqual(new Error("rate limited"));
	});

	it("fails when the first fetch fails", async () => {
		await expect(
			runEffectPromise(
				runSyncPlanEffect({
					allowPartialFailure: true,
					fetchPage: () => Effect.fail(new Error("offline")),
					getNextCursor: () => undefined,
				}),
			),
		).rejects.toThrow("offline");
	});
});
