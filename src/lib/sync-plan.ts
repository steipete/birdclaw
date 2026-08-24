import { Effect } from "effect";

export type PaginationStopReason =
	| "boundary"
	| "exhausted"
	| "item-limit"
	| "page-limit"
	| "repeated-cursor";

export interface PaginationPageContext<Page> {
	cursor?: string;
	fetched: number;
	page: Page;
	pageIndex: number;
	pageNumber: number;
	stopReason?: PaginationStopReason;
	done: boolean;
}

export type SyncPlanStopReason = PaginationStopReason | "error";

export interface SyncPlanPageContext<Page> extends Omit<
	PaginationPageContext<Page>,
	"stopReason"
> {
	nextCursor?: string;
	stopReason?: SyncPlanStopReason;
}

export interface SyncPlanResult<Page, ErrorType> {
	complete: boolean;
	fetched: number;
	nextCursor?: string;
	pages: Page[];
	stopReason: SyncPlanStopReason;
	error?: ErrorType;
}

function normalizeCursor(value: string | null | undefined) {
	const normalized = value?.trim();
	return normalized || undefined;
}

export function runSyncPlanEffect<Page, FetchError, PageError = never>({
	fetchPage,
	getItemCount,
	getNextCursor,
	initialCursor,
	maxItems,
	maxPages,
	onPage,
	pageDelayMs,
	persistPage,
	shouldStop,
	allowPartialFailure = false,
}: {
	fetchPage: (context: {
		cursor?: string;
		fetched: number;
		pageIndex: number;
	}) => Effect.Effect<Page, FetchError>;
	getItemCount?: (page: Page) => number;
	getNextCursor: (page: Page) => string | null | undefined;
	initialCursor?: string;
	maxItems?: number;
	maxPages?: number;
	onPage?: (context: SyncPlanPageContext<Page>) => void;
	pageDelayMs?: number;
	persistPage?: (
		context: SyncPlanPageContext<Page>,
	) => Effect.Effect<void, PageError>;
	shouldStop?: (
		context: Omit<SyncPlanPageContext<Page>, "done" | "nextCursor">,
	) => boolean;
	allowPartialFailure?: boolean;
}): Effect.Effect<SyncPlanResult<Page, FetchError>, FetchError | PageError> {
	return Effect.gen(function* () {
		const pages: Page[] = [];
		const seenCursors = new Set<string>();
		let cursor = normalizeCursor(initialCursor);
		let fetched = 0;
		const pageLimit =
			maxPages === undefined ? Number.POSITIVE_INFINITY : Math.max(1, maxPages);
		const itemLimit =
			maxItems === undefined ? Number.POSITIVE_INFINITY : Math.max(1, maxItems);

		if (cursor) seenCursors.add(cursor);

		while (pages.length < pageLimit) {
			const pageIndex = pages.length;
			const outcome = yield* fetchPage({ cursor, fetched, pageIndex }).pipe(
				Effect.map((page) => ({ ok: true as const, page })),
				Effect.catchAll((error) =>
					Effect.succeed({ ok: false as const, error }),
				),
			);
			if (!outcome.ok) {
				if (!allowPartialFailure || pages.length === 0) {
					return yield* Effect.fail(outcome.error);
				}
				return {
					complete: false,
					fetched,
					...(cursor ? { nextCursor: cursor } : {}),
					pages,
					stopReason: "error",
					error: outcome.error,
				};
			}

			const page = outcome.page;
			pages.push(page);
			fetched += Math.max(0, getItemCount?.(page) ?? 0);
			const nextCursor = normalizeCursor(getNextCursor(page));
			const baseContext = {
				cursor,
				fetched,
				page,
				pageIndex,
				pageNumber: pageIndex + 1,
			};
			let stopReason: PaginationStopReason | undefined;

			if (!nextCursor) {
				stopReason = "exhausted";
			} else if (shouldStop?.(baseContext)) {
				stopReason = "boundary";
			} else if (fetched >= itemLimit) {
				stopReason = "item-limit";
			} else if (seenCursors.has(nextCursor)) {
				stopReason = "repeated-cursor";
			} else if (pages.length >= pageLimit) {
				stopReason = "page-limit";
			}

			const context: SyncPlanPageContext<Page> = {
				...baseContext,
				...(nextCursor ? { nextCursor } : {}),
				done: Boolean(stopReason),
				...(stopReason ? { stopReason } : {}),
			};
			if (persistPage) {
				yield* persistPage(context);
			}
			onPage?.(context);

			if (stopReason) {
				return {
					complete:
						stopReason === "exhausted" ||
						stopReason === "boundary" ||
						stopReason === "item-limit",
					fetched,
					...(nextCursor ? { nextCursor } : {}),
					pages,
					stopReason,
				};
			}

			cursor = nextCursor;
			seenCursors.add(nextCursor!);
			if (typeof pageDelayMs === "number" && pageDelayMs > 0) {
				yield* Effect.sleep(pageDelayMs);
			}
		}

		return {
			complete: false,
			fetched,
			...(cursor ? { nextCursor: cursor } : {}),
			pages,
			stopReason: "page-limit",
		};
	});
}
