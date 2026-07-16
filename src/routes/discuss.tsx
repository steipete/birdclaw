import { createFileRoute } from "@tanstack/react-router";
import {
	ChevronDown,
	CheckCircle2,
	Loader2,
	RefreshCw,
	Search,
	Sparkles,
} from "lucide-react";
import {
	type FormEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { MarkdownViewer } from "#/components/MarkdownViewer";
import { useNdjsonRun } from "#/components/useNdjsonRun";
import type {
	SearchDiscussionContext,
	SearchDiscussionRunResult,
	SearchDiscussionSource,
	SearchDiscussionStreamEvent,
} from "#/lib/search-discussion";
import {
	isTerminalStreamEvent,
	searchDiscussionStreamEventSchema,
} from "#/lib/client-stream-contracts";
import type { TweetSearchMode } from "#/lib/tweet-search-live";
import {
	type DiscussRouteSearch,
	type RouteSearchChange,
	validateDiscussSearch,
} from "#/lib/route-search";
import {
	cx,
	errorCopyClass,
	pageHeaderActionsClass,
	pageHeaderClass,
	pageHeaderRowClass,
	pageSubtitleClass,
	pageTitleClass,
	primaryButtonClass,
	searchFieldIconClass,
	searchFieldInputClass,
	searchFieldShellClass,
	secondaryButtonClass,
	selectFieldClass,
	textFieldClass,
} from "#/lib/ui";

export const Route = createFileRoute("/discuss")({
	component: DiscussRoute,
	validateSearch: validateDiscussSearch,
});

const sources: Array<{ value: SearchDiscussionSource; label: string }> = [
	{ value: "search", label: "Live search" },
	{ value: "all", label: "All local" },
	{ value: "home", label: "Home" },
	{ value: "mentions", label: "Mentions" },
	{ value: "authored", label: "Authored" },
	{ value: "likes", label: "Likes" },
	{ value: "bookmarks", label: "Bookmarks" },
];

const modes: Array<{ value: TweetSearchMode; label: string }> = [
	{ value: "auto", label: "Auto" },
	{ value: "bird", label: "Bird" },
	{ value: "xurl", label: "xurl" },
	{ value: "local", label: "Local" },
];
const DISCUSS_SEARCH_LIMIT = 20_000;
const DISCUSS_MAX_PAGES = 200;

function discussionPrematureEofError() {
	return new Error(
		"Discussion connection closed before completion. Retry to continue.",
	);
}

function discussionStreamError(cause: unknown) {
	return cause instanceof Error ? cause.message : "Discussion failed";
}

function discussionUrl(
	query: string,
	options: {
		source: SearchDiscussionSource;
		mode: TweetSearchMode;
		includeDms: boolean;
		question: string;
		refresh: boolean;
	},
) {
	const url = new URL("/api/search-discussion", window.location.origin);
	url.searchParams.set("query", query);
	url.searchParams.set("source", options.source);
	url.searchParams.set("mode", options.mode);
	url.searchParams.set("includeDms", String(options.includeDms));
	url.searchParams.set("limit", String(DISCUSS_SEARCH_LIMIT));
	url.searchParams.set("maxPages", String(DISCUSS_MAX_PAGES));
	if (options.question.trim()) {
		url.searchParams.set("question", options.question.trim());
	}
	if (options.refresh) {
		url.searchParams.set("refresh", "true");
	}
	return url;
}

function DropdownField<T extends string>({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: T;
	options: Array<{ value: T; label: string }>;
	onChange: (value: T) => void;
}) {
	return (
		<label className="relative min-w-0">
			<span className="pointer-events-none absolute left-3 top-1.5 z-10 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-soft)]">
				{label}
			</span>
			<select
				aria-label={label}
				className={cx(
					selectFieldClass,
					"h-[54px] rounded-2xl bg-[var(--bg)] pb-1 pl-3 pr-9 pt-5 font-semibold text-[var(--ink)]",
				)}
				value={value}
				onChange={(event) => onChange(event.currentTarget.value as T)}
			>
				{options.map((item) => (
					<option key={item.value} value={item.value}>
						{item.label}
					</option>
				))}
			</select>
			<ChevronDown
				aria-hidden="true"
				className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-[var(--ink-soft)]"
				strokeWidth={2}
			/>
		</label>
	);
}

function formatCounts(context: SearchDiscussionContext | null) {
	if (!context) return "Live keyword search with local memory.";
	const counts = context.counts;
	const live = context.liveSearch
		? context.liveSearch.ok
			? `${context.liveSearch.source} ${String(context.liveSearch.count)} fetched`
			: `${context.liveSearch.source} failed`
		: "local";
	return [
		live,
		`${String(counts.search)} search`,
		`${String(counts.home + counts.mentions + counts.authored)} timeline`,
		`${String(counts.likes + counts.bookmarks)} saved`,
		context.includeDms ? `${String(counts.dms)} DMs` : null,
	]
		.filter(Boolean)
		.join(" · ");
}

function useDiscussionStream(
	query: string,
	source: SearchDiscussionSource,
	mode: TweetSearchMode,
	includeDms: boolean,
	question: string,
) {
	const [markdown, setMarkdown] = useState("");
	const [context, setContext] = useState<SearchDiscussionContext | null>(null);
	const [result, setResult] = useState<SearchDiscussionRunResult | null>(null);

	const onStart = useCallback(() => {
		setMarkdown("");
		setContext(null);
		setResult(null);
	}, []);
	const request = useCallback(
		(signal: AbortSignal, refresh: boolean) => {
			const trimmed = query.trim();
			return fetch(
				discussionUrl(trimmed, {
					source,
					mode,
					includeDms,
					question,
					refresh,
				}),
				{ signal },
			);
		},
		[includeDms, mode, query, question, source],
	);
	const onEvent = useCallback((event: SearchDiscussionStreamEvent) => {
		if (event.type === "start") setContext(event.context);
		else if (event.type === "delta") {
			setMarkdown((current) => current + event.delta);
		} else if (event.type === "done") {
			setResult(event.result);
			setContext(event.result.context);
			setMarkdown(event.result.markdown);
		} else if (event.type === "error") throw new Error(event.error);
	}, []);
	const {
		error,
		loading,
		run: runStream,
	} = useNdjsonRun({
		schema: searchDiscussionStreamEventSchema,
		request,
		onStart,
		onEvent,
		isTerminal: isTerminalStreamEvent,
		errorLabel: "Discussion request failed",
		emptyBodyMessage: "Discussion request failed: empty response body",
		prematureEofError: discussionPrematureEofError,
		formatError: discussionStreamError,
	});
	const run = useCallback(
		(refresh = false) => {
			if (query.trim()) runStream(refresh);
		},
		[query, runStream],
	);

	return { context, error, loading, markdown, result, run };
}

function DiscussRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<DiscussRouteView
			searchState={search}
			onSearchChange={(next, options) =>
				void navigate({ search: next, replace: options?.replace })
			}
		/>
	);
}

export function DiscussRouteView({
	searchState: controlledSearch,
	onSearchChange,
}: {
	searchState?: DiscussRouteSearch;
	onSearchChange?: RouteSearchChange<DiscussRouteSearch>;
} = {}) {
	const [localSearch, setLocalSearch] = useState(() =>
		validateDiscussSearch({}),
	);
	const searchState = controlledSearch ?? localSearch;
	const updateSearch: RouteSearchChange<DiscussRouteSearch> = (
		next,
		options,
	) => (onSearchChange ? onSearchChange(next, options) : setLocalSearch(next));
	const { q: query, question, source, mode, includeDms } = searchState;
	const [submittedQuery, setSubmittedQuery] = useState("");
	const pendingSubmitRef = useRef(false);
	const { context, error, loading, markdown, result, run } =
		useDiscussionStream(submittedQuery, source, mode, includeDms, question);
	const sourceLabel = useMemo(
		() => formatCounts(result?.context ?? context),
		[context, result],
	);

	function submit(event: FormEvent) {
		event.preventDefault();
		const trimmed = query.trim();
		if (!trimmed) return;
		pendingSubmitRef.current = true;
		setSubmittedQuery(trimmed);
		if (trimmed === submittedQuery) {
			pendingSubmitRef.current = false;
			run(false);
		}
	}

	useEffect(() => {
		if (!submittedQuery || !pendingSubmitRef.current) return;
		pendingSubmitRef.current = false;
		run(false);
	}, [run, submittedQuery]);

	return (
		<div className="flex min-h-screen flex-col">
			<header className={pageHeaderClass}>
				<div className={pageHeaderRowClass}>
					<div className="min-w-0">
						<h1 className={pageTitleClass}>Discuss</h1>
						<p className={pageSubtitleClass}>{sourceLabel}</p>
					</div>
					<div className={pageHeaderActionsClass}>
						<button
							type="button"
							className={secondaryButtonClass}
							onClick={() => run(true)}
							disabled={loading || !submittedQuery}
						>
							<RefreshCw
								className={cx("size-4", loading && "animate-spin")}
								aria-hidden="true"
							/>
							Refresh
						</button>
					</div>
				</div>
				<form
					className="grid gap-2 px-4 pb-3 md:grid-cols-[minmax(220px,1fr)_minmax(180px,0.8fr)_auto]"
					onSubmit={submit}
				>
					<label className={searchFieldShellClass}>
						<Search className={searchFieldIconClass} strokeWidth={2} />
						<input
							className={searchFieldInputClass}
							placeholder="Keywords"
							value={query}
							onChange={(event) =>
								updateSearch(
									{ ...searchState, q: event.currentTarget.value },
									{ replace: true },
								)
							}
						/>
					</label>
					<input
						className={textFieldClass}
						placeholder="Optional question"
						value={question}
						onChange={(event) =>
							updateSearch(
								{
									...searchState,
									question: event.currentTarget.value,
								},
								{ replace: true },
							)
						}
					/>
					<button
						type="submit"
						className={primaryButtonClass}
						disabled={loading || !query.trim()}
					>
						<Sparkles className="size-4" aria-hidden="true" />
						Discuss
					</button>
					<div className="grid gap-2 md:col-span-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
						<DropdownField
							label="Source"
							options={sources}
							value={source}
							onChange={(value) =>
								updateSearch({ ...searchState, source: value })
							}
						/>
						<DropdownField
							label="Mode"
							options={modes}
							value={mode}
							onChange={(value) =>
								updateSearch({ ...searchState, mode: value })
							}
						/>
						<label className="inline-flex h-[54px] items-center gap-2 rounded-2xl border border-[var(--line)] bg-[var(--bg)] px-3 text-[13px] font-medium text-[var(--ink-soft)]">
							<input
								type="checkbox"
								checked={includeDms}
								onChange={(event) =>
									updateSearch({
										...searchState,
										includeDms: event.currentTarget.checked,
									})
								}
							/>
							DMs
						</label>
					</div>
				</form>
			</header>

			{error ? <div className={errorCopyClass}>{error}</div> : null}

			<div className="border-b border-[var(--line)] px-4 py-2 text-[13px] text-[var(--ink-soft)]">
				<span className="inline-flex items-center gap-1">
					{loading ? (
						<Loader2 className="size-4 animate-spin" aria-hidden="true" />
					) : markdown ? (
						<CheckCircle2 className="size-4" aria-hidden="true" />
					) : (
						<Sparkles className="size-4" aria-hidden="true" />
					)}
					{loading
						? "Searching and streaming"
						: result
							? `${result.cached ? "Cached" : "Ready"} · ${result.context.query}`
							: "Ready"}
				</span>
			</div>

			{markdown ? (
				<MarkdownViewer
					context={result?.context ?? context}
					markdown={markdown}
				/>
			) : (
				<div className="px-4 py-5 text-[14px] text-[var(--ink-soft)]">
					{loading ? "Waiting for the first tokens..." : "Search to begin."}
				</div>
			)}
		</div>
	);
}
